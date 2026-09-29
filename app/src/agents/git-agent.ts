/**
 * GitAgent: Handles git operations, GitHub events, and build failure investigation.
 *
 * Phase 1 changes:
 * - fetch_logs returns a structured LogFetchResult — no fake data passed downstream
 * - classifyFailure delegates to failure-classifier.ts (confidence scores)
 * - investigation findings written back to incident after each tool step
 * - uses config.ts instead of scattered process.env
 */

import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';
import type { CapabilityRegistry } from '../runtime/capabilities/registry';
import { repositoryRegistry } from '../repositories/registry';
import {
  classifyFailure,
  formatClassificationFinding,
  isAutoFixable,
  type ClassificationResult,
} from '../core/failure-classifier';
import { config } from '../config.js';
import { opsMemory } from '../core/ops-memory';
import { repoBaseline } from '../core/repo-baseline';
import { interactionStream } from '../core/interaction';
import { hasProjectWord, findProjectDirs, rankedProjectDirs, spacedMention } from '../core/project-index';
import { opsObjective } from '../ops/objective';
import { repairEslintTypescriptSkew } from './dependency-repair';
import { repairLintErrors } from './code-repair';
import { assessWorldState, formatWorldState } from './repo-state';

const execFilePromise = promisify(execFile);

// ─── Structured log fetch result ─────────────────────────────────────────────

export type LogSource = 'gh_cli' | 'unavailable';

export interface LogFetchResult {
  /** Where the logs came from. Never faked. */
  source: LogSource;
  /** Raw log content — empty string when unavailable. */
  content: string;
  /** Human-readable reason when source is unavailable. */
  unavailableReason?: string;
  /** Number of characters in content. */
  length: number;
}

// ─── GitAgent ────────────────────────────────────────────────────────────────

export class GitAgent extends Agent {
  constructor() {
    super('git-agent');
    this.setupTools();
  }

  private setupTools(): void {
    // fetch_logs is no longer registered as an agent tool — it's called directly
    // by handle() because it must return a structured LogFetchResult, not a plain
    // string. The tool system passes strings; wrapping would lose the source tag.

    this.registerTool({
      name: 'fetch_diff',
      description: 'Get git diff for a commit',
      func: async (args) => {
        const repoRef = args.repo;
        const repo = repositoryRegistry.resolve(repoRef);
        const localPath = repo?.localPath || repoRef || process.cwd();
        if (!args.commit) return 'No commit specified.';
        try {
          const { stdout } = await execFilePromise(
            'git',
            ['-C', localPath, 'diff', `${args.commit}~1..${args.commit}`],
            { timeout: 15000 },
          );
          return stdout.trim() || 'No diff output (commit may not exist locally).';
        } catch (error) {
          return `Failed to fetch diff: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });

    this.registerTool({
      name: 'suggest_fix',
      description: 'Suggest a fix based on failure type',
      func: async (args) => {
        const failureType = String(args.failureType || '').toUpperCase();
        const fixes: Record<string, string> = {
          MISSING_DEPENDENCY: "Run 'npm install' to restore dependencies. Check for removed packages in recent commits.",
          TYPE_ERROR: "Review TypeScript errors with 'npm run typecheck'. Check recent type changes or missing @types packages.",
          LINT_FAILURE: "Run 'npm run lint:fix' to auto-correct linting issues. Review .eslintrc for rule changes.",
          TEST_FAILURE: "Run tests locally with 'npm test'. Check if recent changes broke assertions or snapshots.",
          BUILD_FAILURE: "Check build output carefully. Common causes: missing env vars, incompatible dep versions.",
          OOM_ERROR: "Build ran out of memory. Try increasing Node heap: NODE_OPTIONS='--max-old-space-size=4096'.",
          NETWORK_ERROR: "Network connectivity issue during build. Check if registry is reachable or if there are proxy settings.",
          TIMEOUT: "Build or test timed out. Check for hung processes, slow tests, or infinite loops.",
          PERMISSION_ERROR: "Permission denied during build. Check file ownership and CI runner permissions.",
        };
        return fixes[failureType] ?? 'No specific fix available. Manual investigation required.';
      },
    });
  }

  private resolveRepositoryContext(data: Record<string, any>): { repo: any; fullName: string; localPath?: string } {
    const repoRef = data.repository || data.repo || data.full_name || data.fullName || data.localPath;
    const resolved = repositoryRegistry.resolve(repoRef, data.localPath);
    const localPath = resolved?.localPath || data.localPath;
    const fullName = resolved?.fullName || repoRef || 'unknown-repository';
    return { repo: resolved, fullName, localPath };
  }

  canHandle(event: Event): boolean {
    if (event.type === 'user.command.received') {
      const command = String((event.data as Record<string, any>).command || '');
      // Matches handleCommand below: git operations, repo-status
      // questions (status/heads-up/repo), project references
      // ("institution OS project", "my portfolio"), AND known local
      // project directories by name ("check on institution OS" — the
      // gateway routes those here, and the preferred-agent lookup
      // requires canHandle to agree).
      // Kept in sync deliberately — canHandle gating what handleCommand
      // answers was the exact bug behind "git-agent not available" on
      // status questions.
      return /\b(git|branch|branches|commit|commits|merge|rebase|pull request|status|heads?\s?-?\s?up|repo\b|repository|repositories|project|projects|portfolio)\b/i.test(command) ||
        findProjectDirs(command).length > 0;
    }
    return [
      'github.workflow.failed',
      'github.workflow.completed',
      'github.push',
      'ci.test.failed',
      'ci.build.failed',
      'ci.lint.failed',
    ].includes(event.type);
  }

  async handleCommand(event: Event, capabilities: CapabilityRegistry): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');
    if (/\b(status|branch|commit)\b/i.test(command) || hasProjectWord(command) || findProjectDirs(command).length > 0) {
      // A status-style question OR a project reference names (or implies)
      // a repo: answer it with a heads-up instead of delegating to a
      // generic capability.
      const status = await this.answerRepoStatus(command);
      if (status) return status;
      const result = await capabilities.execute(command);
      return result ? `GitHub Agent: ${result}` : 'GitHub Agent could not find a local Git capability.';
    }
    return 'GitHub Agent received the request. GitHub webhook investigation is available for repository events.';
  }

  /**
   * "Heads up on <repo>": resolve (by name, owner/name, discovery scan,
   * local project directories, or session memory), then report git state
   * + checks + open incidents + remembered resolutions. Local project
   * dirs that match by name but have no remote get a checkout-level
   * heads-up without registry writes; multiple matches ask which one.
   * Returns null when no repo can be determined.
   */
  private async answerRepoStatus(command: string): Promise<string | null> {
    // Fresh mentions beat stale memory: "my portfolio" after an
    // institution-OS question must not return institution-IO. Session
    // memory (lastRepo) is consulted only when the command names nothing.
    const candidates = this.extractRepoRefs(command);
    let repo = null;
    for (const ref of candidates) {
      repo = repositoryRegistry.resolve(ref);
      if (repo) break;
    }
    if (repo) {
      interactionStream.setContext('lastRepo', repo.fullName);
      return this.repoHeadsUp(repo.fullName, repo.localPath);
    }
    // Local project fallback: "institution OS" (~/institution-os) vs the
    // operating system; "my portfolio" with no git remote. Ranked so an
    // exact spaced-name mention beats a bare substring ("my portfolio"
    // picks MyPortfolio over peter-mwei-portfolio).
    const dirs = rankedProjectDirs(command);
    const exact = dirs.filter(d => spacedMention(command, d.name));
    const fuzzy = dirs.filter(d => !spacedMention(command, d.name));
    // Exact mentions: registry hit wins, else direct local heads-up (an
    // exact directory mention is strong evidence — never skip it for a
    // fuzzy remote match).
    for (const d of exact) {
      repo = repositoryRegistry.resolve(d.name, d.localPath);
      if (repo) {
        interactionStream.setContext('lastRepo', repo.fullName);
        return this.repoHeadsUp(repo.fullName, repo.localPath);
      }
    }
    const exactProjectish = exact.filter(d => d.projectish);
    if (exactProjectish.length === 1) {
      interactionStream.setContext('lastRepo', exactProjectish[0].name);
      return this.repoHeadsUp(exactProjectish[0].name, exactProjectish[0].localPath);
    }
    if (exactProjectish.length > 1) {
      return `Which project? I found ${exactProjectish.slice(0, 5).map(d => d.name).join(', ')} — name one and I'll give you a heads-up.`;
    }
    // Fuzzy mentions: registry resolution only (no guessing at directories).
    for (const d of fuzzy) {
      repo = repositoryRegistry.resolve(d.name, d.localPath);
      if (repo) {
        interactionStream.setContext('lastRepo', repo.fullName);
        return this.repoHeadsUp(repo.fullName, repo.localPath);
      }
    }
    const remembered = interactionStream.getContext<string>('lastRepo');
    if (remembered) {
      repo = repositoryRegistry.resolve(remembered);
      if (repo) return this.repoHeadsUp(repo.fullName, repo.localPath);
      const redirs = rankedProjectDirs(remembered);
      if (redirs.length === 1 && redirs[0].projectish) {
        return this.repoHeadsUp(redirs[0].name, redirs[0].localPath);
      }
    }
    const projectish = dirs.filter(d => d.projectish);
    if (projectish.length === 1) {
      interactionStream.setContext('lastRepo', projectish[0].name);
      return this.repoHeadsUp(projectish[0].name, projectish[0].localPath);
    }
    if (projectish.length > 1) {
      return `Which project? I found ${projectish.slice(0, 5).map(d => d.name).join(', ')} — name one and I'll give you a heads-up.`;
    }
    if (dirs.length > 0) {
      return `I found ${dirs.slice(0, 5).map(d => d.name).join(', ')} but none looks like a project checkout — name a repository (owner/name) and I'll give you a heads-up, e.g. "status of mwei023/MARk".`;
    }
    return 'Which repository? Name it (owner/name or local name) and I will give you a heads-up — e.g. "status of mwei023/MARk".';
  }

  /** Heads-up lines for a resolved repo or a raw local checkout directory. */
  private async repoHeadsUp(fullName: string, localPath?: string): Promise<string> {
    const lines = [`Heads-up on ${fullName}${localPath ? ` (${localPath})` : ' (no local checkout)'}.`];
    if (localPath && existsSync(localPath)) {
      const log = await this.shellOut('git', ['-C', localPath, 'log', '--oneline', '-3']);
      if (log) lines.push(`Recent: ${log.split('\n').join(' | ').slice(0, 220)}`);
      const status = await this.shellOut('git', ['-C', localPath, 'status', '--porcelain']);
      lines.push(status === '' ? 'Tree: clean.' : status === null ? 'Tree: unknown.' : `Tree has uncommitted changes: ${status.split('\n').slice(0, 4).join(', ').slice(0, 160)}`);
      try {
        const pkg = JSON.parse(readFileSync(`${localPath}/package.json`, 'utf8'));
        const scripts = Object.keys(pkg?.scripts ?? {});
        lines.push(scripts.length > 0 ? `Checks: ${scripts.join(', ')}.` : 'No npm scripts declared.');
      } catch {
        lines.push('No readable package.json.');
      }
    }
    try {
      const open = await incidentStore.getOpenIncidents();
      const mine = open.filter(i => (i.context as Record<string, unknown>)?.repository === fullName);
      lines.push(mine.length > 0 ? `Open incidents: ${mine.length} (${mine.slice(0, 3).map(i => `${i.id} ${i.status}`).join('; ')}).` : 'No open incidents.');
    } catch {
      lines.push('Incident store unreachable.');
    }
    try {
      const prior = await opsMemory.recall('github.workflow.failed', 'UNKNOWN', fullName);
      if (prior) lines.push(`Remembered: "${prior.record.resolution.slice(0, 160)}" (${prior.matchReason}).`);
    } catch { /* memory is best-effort here */ }
    return lines.join('\n');
  }

  /**
   * Ordered repo-name candidates: owner/name pairs, then "called|named X",
   * then words matching a registered repo name. Tried in order; first
   * resolution wins. Never returns filler words as candidates.
   */
  private extractRepoRefs(command: string): string[] {
    const out: string[] = [];
    for (const m of command.matchAll(/([\w.-]+\/[\w.-]+)/g)) out.push(m[1]);
    for (const m of command.matchAll(/(?:called|named)\s+([A-Za-z0-9_.-]+)/gi)) out.push(m[1]);
    const known = repositoryRegistry.list();
    for (const word of command.match(/[A-Za-z0-9_.-]+/g) ?? []) {
      const hit = known.find(r => r.name.toLowerCase() === word.toLowerCase());
      if (hit && !out.includes(hit.fullName)) out.push(hit.fullName);
    }
    return out;
  }

  /** Small read-only shell helper for status answers. Never throws. */
  private async shellOut(bin: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFilePromise(bin, args, { timeout: 15000 });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async handle(event: Event): Promise<void> {
    const data = event.data as Record<string, any>;
    const repositoryContext = this.resolveRepositoryContext(data);

    if (!repositoryContext.fullName || repositoryContext.fullName === 'unknown-repository') {
      console.warn('[GitAgent] Missing repository in event');
      return;
    }

    console.log(`[GitAgent] Handling ${event.type} for ${repositoryContext.fullName}`);

    // ── Fix verification: workflow succeeded after an auto-fix branch ────────
    // If a prior incident for this repo was resolved by an auto-fix, mark it verified.
    if (event.type === 'github.workflow.completed') {
      // Awaited deliberately: fire-and-forget lets later reads race the
      // write (proven live). One indexed query; correctness over 50ms.
      // (Was: `void opsMemory.markVerified ? ...` — void on the condition
      // made it always falsy, so verification never ran at all.)
      await this.verifyPriorFix(repositoryContext.fullName, data.branch);
      return;
    }

    // ── Correlation: look for an existing open incident before creating a new one
    const incident = await incidentStore.findOrCreateIncident({
      title: `Build failed: ${repositoryContext.fullName}`,
      description: data.failureMessage || 'GitHub workflow failed',
      severity: event.severity === 'critical' ? 'critical' : event.severity === 'warning' ? 'medium' : 'low',
      triggerEvent: event.type,
      triggerEventId: event.id,
      correlationId: event.correlationId || event.id,
      assignedAgent: this.name,
      tags: ['build', 'github', data.branch || 'unknown-branch'],
      context: {
        repository: repositoryContext.fullName,
        repositoryId: repositoryContext.repo?.id,
        localPath: repositoryContext.localPath,
        commit: data.commit,
        branch: data.branch,
        workflowName: data.workflowName,
      },
    });

    console.log(`[GitAgent] Incident ${incident.id} (${incident._wasCorrelated ? 'correlated' : 'new'})`);
    try { opsObjective.record(incident._wasCorrelated ? 'incident.investigated' : 'incident.seen'); } catch { /* objective never fails a run */ }

    try {
      // ── Memory recall: surface prior resolution if available ─────────────
      const priorResolution = await opsMemory.recall(
        event.type,
        'UNKNOWN', // pre-classification; refined after classify step
        repositoryContext.fullName,
      );
      if (priorResolution) {
        const mins = Math.round(priorResolution.record.durationMs / 60000);
        await incidentStore.addFinding(
          incident.id,
          `Prior resolution found (${priorResolution.matchReason}): "${priorResolution.record.resolution}" ` +
          `resolved in ~${mins}min. Confidence: ${(priorResolution.record.classificationConfidence * 100).toFixed(0)}%. ` +
          `Verified ${priorResolution.record.verifiedCount} time(s).`,
        );
      }

      // ── Anomaly check ─────────────────────────────────────────────────────
      const anomaly = await repoBaseline.checkAnomaly(repositoryContext.fullName);
      if (anomaly) {
        await incidentStore.addFinding(incident.id, `Anomaly detected: ${anomaly.summary}`);
      }

      // ── Step 1: Fetch real logs ──────────────────────────────────────────────
      const logFetch = await this.fetchLogs(data.runId, repositoryContext.fullName);

      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'fetch_logs',
        tool: 'gh_cli',
        result: logFetch.source === 'gh_cli' ? 'success' : 'failure',
        details: logFetch.source === 'gh_cli'
          ? `Fetched ${logFetch.length} chars from GitHub Actions run ${data.runId}`
          : `Logs unavailable: ${logFetch.unavailableReason}`,
      });

      // ── Step 2: Classify failure ─────────────────────────────────────────────
      // Prefer real CI logs; when unavailable (e.g. repos without Actions),
      // fall back to failure text carried in the event itself before giving up.
      let classification: ClassificationResult;
      let classificationSource: 'ci_logs' | 'event_text' | 'none' = 'none';
      let eventText = '';
      if (logFetch.source !== 'unavailable' && logFetch.length > 0) {
        classification = classifyFailure(logFetch.content);
        classificationSource = 'ci_logs';
      } else {
        eventText = [data.failureMessage, data.message]
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .join('\n');
        if (eventText.length > 0) {
          classification = classifyFailure(eventText);
          classificationSource = 'event_text';
        } else {
          classification = { type: 'UNKNOWN', confidence: 0, signals: [], raw: '' };
        }
      }

      const classificationFinding = classificationSource === 'ci_logs'
        ? formatClassificationFinding(classification, logFetch.length)
        : classificationSource === 'event_text'
          ? `${formatClassificationFinding(classification, eventText.length)} (source: event failure text; CI logs unavailable: ${logFetch.unavailableReason})`
          : `Log fetch unavailable (${logFetch.unavailableReason}). Cannot classify failure automatically.`;

      await incidentStore.addFinding(incident.id, classificationFinding);
      try { opsObjective.record('incident.investigated'); } catch { /* objective never fails a run */ }

      // ── Step 3: Fetch diff ───────────────────────────────────────────────────
      if (data.commit) {
        const diffResult = await this.executeTool(
          'fetch_diff',
          { repo: repositoryContext.fullName, commit: data.commit },
          { environment: 'production', risk: 'low' },
        );
        if (diffResult.success) {
          await incidentStore.addAction(incident.id, diffResult.action);
          const lines = diffResult.result.split('\n').length;
          await incidentStore.addFinding(
            incident.id,
            `Diff retrieved for commit ${data.commit}: ${lines} lines changed.`,
          );
        }
      }

      // ── Step 4: Suggest fix ──────────────────────────────────────────────────
      const fixResult = await this.executeTool(
        'suggest_fix',
        { failureType: classification.type },
        { environment: 'production', risk: 'low' },
      );
      if (fixResult.success) {
        await incidentStore.addAction(incident.id, fixResult.action);
        await incidentStore.addFinding(incident.id, `Suggested fix: ${fixResult.result}`);
      }

      // ── Step 5: Auto-fix or investigate ──────────────────────────────────────
      if (isAutoFixable(classification.type) && classification.confidence >= 0.5) {
        await this.attemptAutoFix(incident.id, classification.type, data, repositoryContext, incident.createdAt, classification);
      } else {
        await incidentStore.updateStatus(incident.id, 'open');
        const unclassified = classification.type === 'UNKNOWN' || classification.confidence < 0.25;
        // Below the auto-fix threshold, a LINT verdict is a guess, not a
        // diagnosis (e.g. a crashing linter scores LINT on the word
        // "eslint" alone). Give it the same investigation a miss gets —
        // probes may upgrade it to a diagnosed toolchain issue.
        const weakLint = classification.type === 'LINT_FAILURE' && classification.confidence < 0.5;
        if (unclassified || weakLint) {
          // A miss starts an investigation, not a dead end. Probes run
          // read-only against the local checkout; if they pinpoint a cause
          // the incident stays open with a remedy, otherwise it escalates
          // with the probe trail attached.
          const diagnosisText = logFetch.source !== 'unavailable' && logFetch.length > 0
            ? logFetch.content
            : [data.failureMessage, data.message]
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .join('\n');
          await this.investigateUnknown(
            incident.id, incident.correlationId, data, repositoryContext, diagnosisText, incident.createdAt,
          );
        } else {
          // Classified but manual: attach the same read-only probe trail
          // (git evidence + repo map + lint baseline) so the handoff names
          // real files and states verification ground truth. Best-effort:
          // probe failure never blocks the manual-intervention event.
          try {
            const probePath = repositoryContext.localPath || (typeof data.repository === 'string' ? data.repository : '');
            if (probePath && existsSync(probePath)) {
              const probeText = logFetch.source !== 'unavailable' && logFetch.length > 0
                ? logFetch.content
                : [data.failureMessage, data.message]
                  .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
                  .join('\n');
              await this.collectProbesViaPlanner(incident.id, probePath, data.commit, probeText, '');
            }
          } catch { /* probes are best-effort evidence, never fatal */ }
          await eventBus.emit({
            id: `EVT-${Date.now()}`,
            timestamp: new Date(),
            source: 'git-agent',
            type: 'agent.action.failed',
            severity: 'warning',
            correlationId: incident.correlationId,
            data: {
              incidentId: incident.id,
              message: `Build failure requires manual intervention: ${classification.type} (confidence ${(classification.confidence * 100).toFixed(0)}%)`,
              suggestion: fixResult.result,
            },
          } as any);
        }
      }
    } catch (error) {
      console.error('[GitAgent] Error handling event:', error);
      await incidentStore.updateStatus(incident.id, 'escalated');
      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'handle',
        tool: 'git-agent',
        result: 'failure',
        details: `Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      // Completion receipt: every run ends with its terminal state on record.
      // Supervisors (human or harness) watch this line, not the silence.
      try {
        const final = await incidentStore.getIncident(incident.id);
        console.log(`[GitAgent] Completed ${incident.id} status=${final?.status ?? 'unknown'}`);
      } catch {
        console.log(`[GitAgent] Completed ${incident.id} status=unverifiable`);
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fetch real GitHub Actions logs via the gh CLI.
   * Returns a structured result — never returns fake/simulated log content.
   */
  async fetchLogs(runId: string | undefined, repo: string | undefined): Promise<LogFetchResult> {
    if (!runId || !repo) {
      return {
        source: 'unavailable',
        content: '',
        unavailableReason: `Missing required arguments: ${!runId ? 'runId' : 'repo'}`,
        length: 0,
      };
    }

    try {
      const { stdout } = await execFilePromise(
        'gh',
        ['run', 'view', String(runId), '--repo', repo, '--log'],
        { timeout: 20000 },
      );
      const content = stdout.trim().slice(0, 8000);
      if (content.length < 20) {
        return {
          source: 'unavailable',
          content: '',
          unavailableReason: 'gh CLI returned empty output',
          length: 0,
        };
      }
      return { source: 'gh_cli', content, length: content.length };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        source: 'unavailable',
        content: '',
        unavailableReason: `gh CLI failed: ${reason.slice(0, 200)}`,
        length: 0,
      };
    }
  }

  // ── Investigation: pinpoint the cause of an unclassified failure ─────────
  //
  // Read-only probes against the local checkout, bounded by count and
  // timeout. Every probe result becomes an incident finding. Deterministic
  // diagnosis rules map probe evidence to a cause + remedy. A diagnosed
  // incident stays open with actionable steps; only a clean miss escalates,
  // and then with the full probe trail attached.

  /** Maximum investigation probes per incident (hard budget). */
  private static readonly MAX_PROBES = 5;
  private static readonly PROBE_TIMEOUT_MS = 15000;

  private async runProbe(
    incidentId: string, label: string, bin: string, args: string[], cwd: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await execFilePromise(bin, args, { cwd, timeout: GitAgent.PROBE_TIMEOUT_MS });
      const out = stdout.trim().slice(0, 1200);
      await incidentStore.addFinding(incidentId, `Probe ${label}: ${out || '(empty output)'}`);
      return out;
    } catch (err) {
      // npm ls and friends exit non-zero while still printing evidence —
      // keep whatever stdout survived before calling the probe unavailable.
      const partial = String((err as { stdout?: unknown }).stdout ?? '').trim().slice(0, 1200);
      if (partial) {
        await incidentStore.addFinding(incidentId, `Probe ${label} (exit non-zero, output kept): ${partial}`);
        return partial;
      }
      await incidentStore.addFinding(incidentId, `Probe ${label} unavailable in this checkout.`);
      return null;
    }
  }

  // ── Planner-driven investigation ─────────────────────────────────────────
  //
  // The same probes GitAgent used to hardcode, composed as a kernel plan:
  // deterministic template first ("deterministic first"), LLM proposal when
  // smart mode is on ("LLM last"), validator as guardrail, kernel executor
  // running each step with its authority policy. Any failure returns null
  // and the caller falls back to the legacy inline probes — never worse.
  private async collectProbesViaPlanner(
    incidentId: string,
    repoPath: string,
    commit: string | undefined,
    classifyText: string,
    worldSummary: string,
  ): Promise<{
    gitLog: string | null; gitStatus: string | null; pkgScripts: string;
    hasChecks: boolean; depTree: string | null; planId: string;
    repoMap: string | null; verifyLint: string | null;
  } | null> {
    try {
      const { markKernelBridge } = await import('../kernel/bridge.js');
      await markKernelBridge.initialize();
      const stepId = (n: number): string => `probe-step-${Date.now()}-${n}` as never;

      const buildTemplate = (): Record<string, unknown> => ({
        id: `plan-${Date.now()}` as never,
        goal: `Investigate build failure evidence for local checkout ${repoPath}`,
        steps: [
          { id: stepId(1), toolId: 'investigate.git_log', input: { repoPath, n: 5 }, dependsOn: [] },
          { id: stepId(2), toolId: 'investigate.git_status', input: { repoPath }, dependsOn: [] },
          { id: stepId(3), toolId: 'investigate.package_scripts', input: { repoPath }, dependsOn: [] },
          { id: stepId(4), toolId: 'investigate.toolchain', input: { repoPath }, dependsOn: [] },
          { id: stepId(5), toolId: 'repo.map', input: { repoPath, limit: 50 }, dependsOn: [] },
          { id: stepId(6), toolId: 'ops.verify_lint', input: { repoPath }, dependsOn: [] },
          ...(commit
            ? [{ id: stepId(7), toolId: 'investigate.diff_stat', input: { repoPath, commit }, dependsOn: [] }]
            : []),
        ],
        successCriteria: ['evidence collected for diagnosis'],
        explanation: 'Deterministic investigation template (planner-composed, validator-checked).',
      });

      let plan: Record<string, unknown> | null = null;
      let source = 'template';
      if (config.markSmart !== 'off') {
        try {
          const smart = await markKernelBridge.planGoalSmart(
            `Investigate build failure for repository checkout ${repoPath}: gather recent commits, working tree status, package scripts, toolchain versions, then classify: ${classifyText.slice(0, 200)}. Current state: ${worldSummary.slice(0, 300)}`,
          );
          if (smart && markKernelBridge.validatePlan(smart.plan).valid) {
            plan = smart.plan as unknown as Record<string, unknown>;
            source = `llm-${smart.source}`;
          }
        } catch { /* fall through to template */ }
      }
      if (!plan) {
        plan = buildTemplate();
        const validation = markKernelBridge.validatePlan(plan as never);
        if (!validation.valid) return null;
      }

      const report = await Promise.race([
        markKernelBridge.executePlanWithReport(plan as never, {
          userId: config.defaultUser,
          source: 'api',
          workingDirectory: repoPath,
        } as never),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('plan timeout')), 90000)),
      ]);
      const byTool = new Map<string, Record<string, unknown>>();
      for (const step of report.steps ?? []) {
        const out = (step as { toolId: string; output?: unknown }).output;
        if (out && typeof out === 'object') byTool.set((step as { toolId: string }).toolId, out as Record<string, unknown>);
      }
      const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
      const gitLog = str(byTool.get('investigate.git_log')?.commits);
      const gitStatus = str(byTool.get('investigate.git_status')?.status);
      const scriptsOut = byTool.get('investigate.package_scripts');
      const pkgScripts = typeof scriptsOut?.scripts === 'string' ? scriptsOut.scripts : '';
      const hasChecks = scriptsOut?.hasChecks === true;
      const toolchainOut = byTool.get('investigate.toolchain');
      const depTree = str(toolchainOut?.deps);
      // Semantic map: what source files exist (unfamiliar-codebase orientation).
      const mapOut = byTool.get('repo.map');
      const mapFiles = Array.isArray(mapOut?.files) ? (mapOut.files as unknown[]).filter(f => typeof f === 'string') as string[] : [];
      const repoMap = mapFiles.length > 0
        ? `${mapOut?.count ?? mapFiles.length} source file(s): ${mapFiles.slice(0, 12).join(', ')}${(mapOut?.truncated ? '…' : '') || (mapFiles.length > 12 ? '…' : '')}`
        : null;
      // Verification gate: lint error count at investigation time (baseline
      // for any later fix — improvement must move this number down).
      const lintOut = byTool.get('ops.verify_lint');
      const verifyLint = typeof lintOut?.errors === 'number'
        ? `${lintOut.errors} eslint error(s)${lintOut.ok === false ? ` (probe: ${String(lintOut.reason ?? 'unavailable').slice(0, 120)})` : ''}`
        : (typeof lintOut?.reason === 'string' ? `unavailable (${lintOut.reason.slice(0, 120)})` : null);

      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'investigate_plan',
        tool: 'kernel-planner',
        result: 'success',
        details: `Executed investigation plan ${(plan as { id: string }).id} (source: ${source}, ${(report.steps ?? []).length} steps) via kernel executor.`,
      });
      await incidentStore.addFinding(incidentId, `Probe git-log (planned): ${gitLog ?? '(unavailable)'}`);
      await incidentStore.addFinding(incidentId, `Probe git-status (planned): ${gitStatus ?? '(unavailable)'}`);
      await incidentStore.addFinding(incidentId, `Probe package-scripts (planned): ${pkgScripts || '(unavailable)'}`);
      await incidentStore.addFinding(incidentId, `Probe installed-deps (planned): ${(depTree ?? '(unavailable)').slice(0, 600)}`);
      await incidentStore.addFinding(incidentId, `Probe repo-map (planned): ${repoMap ?? '(unavailable — no source files listed)'}`);
      await incidentStore.addFinding(incidentId, `Probe verify-lint (planned): ${verifyLint ?? '(unavailable)'}`);
      return { gitLog, gitStatus, pkgScripts, hasChecks, depTree, planId: (plan as { id: string }).id, repoMap, verifyLint };
    } catch {
      return null;
    }
  }

  private async investigateUnknown(
    incidentId: string,
    correlationId: string,
    eventData: Record<string, any>,
    repositoryContext: { repo: any; fullName: string; localPath?: string },
    diagnosisText: string,
    incidentCreatedAt?: Date,
  ): Promise<void> {
    const repoPath = repositoryContext.localPath || eventData.repository;
    if (!repoPath || !existsSync(repoPath)) {
      await incidentStore.addFinding(
        incidentId,
        'Investigation skipped: no local checkout of this repository is available. ' +
        'Register the repo with a localPath (or run where the clone exists) to enable probes. ' +
        'Remedy: clone the repo at the failing commit and re-fire the event.',
      );
      await incidentStore.updateStatus(incidentId, 'escalated');
      await eventBus.emit({
        id: `EVT-${Date.now()}`,
        timestamp: new Date(),
        source: 'git-agent',
        type: 'agent.action.failed',
        severity: 'warning',
        correlationId,
        data: {
          incidentId,
          message: 'Build failure could not be classified and no local checkout exists for investigation. Escalating.',
        },
      } as any);
      return;
    }

    await incidentStore.addAction(incidentId, {
      timestamp: new Date(),
      agent: this.name,
      action: 'investigate_unknown',
      tool: 'shell',
      result: 'success',
      details: `Running up to ${GitAgent.MAX_PROBES} read-only probes in ${repoPath}`,
    });

    // State first: what is true about this repo before any conclusion.
    // Probes, diagnosis, and repairs all condition on this assessment.
    const worldState = await assessWorldState(repoPath);
    await incidentStore.addFinding(incidentId, formatWorldState(worldState));

    // Planner first: compose the probes as a kernel plan (template, or LLM
    // proposal when smart). Any failure falls back to the legacy inline
    // probes below — the investigation never gets less than it had.
    const planned = await this.collectProbesViaPlanner(
      incidentId, repoPath, eventData.commit, diagnosisText, formatWorldState(worldState),
    );
    let gitLog: string | null;
    let gitStatus: string | null;
    let pkgScripts: string;
    let hasCheckScripts: boolean;
    let depTree: string | null;
    if (planned) {
      ({ gitLog, gitStatus, pkgScripts, hasChecks: hasCheckScripts, depTree } = planned);
    } else {
      // Legacy inline probes (fallback).
      // P1: recent history — what changed just before the failure.
      gitLog = await this.runProbe(incidentId, 'git-log', 'git', ['-C', repoPath, 'log', '--oneline', '-5'], repoPath);
      // P2: dirty tree — uncommitted changes are a prime suspect.
      gitStatus = await this.runProbe(incidentId, 'git-status', 'git', ['-C', repoPath, 'status', '--porcelain'], repoPath);
      // P3: toolchain — node/npm versions anchor dependency diagnoses.
      await this.runProbe(incidentId, 'toolchain', 'node', ['-e', "console.log('node '+process.version)"], repoPath);
      // P4: declared scripts + dependency surface for missing-dep checks.
      pkgScripts = '';
      hasCheckScripts = false;
      try {
        const pkg = JSON.parse(readFileSync(`${repoPath}/package.json`, 'utf8'));
        pkgScripts = Object.keys(pkg?.scripts ?? {}).join(', ');
        hasCheckScripts = Boolean(pkg?.scripts?.lint ?? pkg?.scripts?.test ?? pkg?.scripts?.typecheck);
        await incidentStore.addFinding(incidentId, `Probe package-scripts: ${pkgScripts || '(no scripts)'}`);
      } catch {
        await incidentStore.addFinding(incidentId, 'Probe package-scripts unavailable (no readable package.json).');
      }
      // P5: installed versions of the usual suspects (exit code ignored).
      depTree = await this.runProbe(
        incidentId, 'installed-deps', 'npm', ['ls', 'eslint', 'typescript', 'vite', '--depth=0'], repoPath,
      );
    }

    // ── Deterministic diagnosis ──────────────────────────────────────────
    const ruleMatch = diagnosisText.match(/Error while loading rule '([^']+)'/);
    const missingMod = diagnosisText.match(/Cannot find module '([^']+)'/);
    const unknownRule = diagnosisText.match(/Definition for rule '([^']+)' was not found/);
    let diagnosed = false;
    let repairOutcome: 'resolved' | 'repaired-open' | 'failed' | null = null;

    if (ruleMatch && depTree) {
      const rule = ruleMatch[1];
      const versions = depTree.split('\n').filter(l => /eslint|typescript|invalid|extraneous|deduped/i.test(l)).slice(0, 6).join('; ');
      await incidentStore.addFinding(
        incidentId,
        `Diagnosis: toolchain mismatch — the linter crashes loading rule '${rule}' before checking any code, ` +
        `so no source change can fix this. Installed: ${versions || 'see probe output'}. ` +
        `Remedy (your steps): align the eslint + @typescript-eslint pair (e.g. npm i -D eslint@<same-major> @typescript-eslint/eslint-plugin@<same-major>), ` +
        `delete node_modules + lockfile churn, reinstall, and re-run the failing command.`,
      );
      diagnosed = true;
      // Mark does the remedy itself when auto-fix is enabled: deterministic
      // version repair on its own branch, verified by lint exit code.
      if (config.markEnableAutofix && !config.markDryRun) {
        repairOutcome = await this.repairToolchainSkew(incidentId, eventData, repositoryContext, incidentCreatedAt ?? new Date());
      } else if (!config.markEnableAutofix) {
        await incidentStore.addFinding(
          incidentId,
          'Skew auto-repair deferred (set MARK_ENABLE_AUTOFIX=true to allow). The remedy above is yours to run.',
        );
      }
    } else if (missingMod) {
      const mod = missingMod[1];
      let declared = false;
      try {
        const pkg = JSON.parse(readFileSync(`${repoPath}/package.json`, 'utf8'));
        declared = Boolean(pkg?.dependencies?.[mod] ?? pkg?.devDependencies?.[mod]);
      } catch { /* probe already recorded */ }
      if (!declared) {
        const installFirst = !worldState.hasNodeModules
          ? ' Dependencies are not installed in this checkout, so run npm install BEFORE anything else — the module may simply be uninstalled rather than undeclared.'
          : '';
        await incidentStore.addFinding(
          incidentId,
          `Diagnosis: missing dependency '${mod}' — required at runtime but absent from package.json.${installFirst} ` +
          `Remedy (your steps): run npm install ${mod} in the repo, commit the lockfile change, and re-run.`,
        );
        diagnosed = true;
      }
    }
    if (gitStatus && gitStatus.trim() && !diagnosed) {
      const files = gitStatus.trim().split('\n').slice(0, 5).join(', ');
      await incidentStore.addFinding(
        incidentId,
        `Observation: working tree has uncommitted changes (${files}). ` +
        `These did not go through CI — commit or stash them, then re-run the failing command to isolate.`,
      );
    }
    if (unknownRule && !diagnosed) {
      const rule = unknownRule[1];
      let installed = '';
      try {
        const meta = JSON.parse(readFileSync(`${repoPath}/node_modules/@typescript-eslint/eslint-plugin/package.json`, 'utf8'));
        installed = typeof meta?.version === 'string' ? ` (installed plugin: ${meta.version})` : '';
      } catch { /* version unknown is itself informative */ }
      await incidentStore.addFinding(
        incidentId,
        `Diagnosis: stale rule reference — config enables '${rule}' but the loaded plugin does not export it${installed}. ` +
        `Rule IDs are renamed/removed across plugin majors (e.g. ban-types died in v8; no-unsafe-* need a type-aware parser). ` +
        `Remedy (your steps): align plugin major with the config (upgrade @typescript-eslint or drop/rename the stale rule), ` +
        `and stop linting bundled output (dev-dist/): add it to eslint ignores.`,
      );
      diagnosed = true;
    }
    if (!hasCheckScripts && !diagnosed) {
      await incidentStore.addFinding(
        incidentId,
        `Diagnosis: this repo has no automated checks (no lint/test/typecheck scripts; only: ${pkgScripts || 'none'}). ` +
        `A CI failure here cannot come from code checks — suspect the pipeline itself (install, build, deploy steps). ` +
        `Remedy (your steps): add a lint or test script so failures become diagnosable, and inspect the workflow file for non-code steps.`,
      );
      diagnosed = true;
    }
    void gitLog;
    void pkgScripts;

    if (diagnosed) {
      // A repair that already resolved must not be overwritten back to open.
      if (repairOutcome !== 'resolved') {
        await incidentStore.updateStatus(incidentId, 'open');
      }
      await eventBus.emit({
        id: `EVT-${Date.now()}`,
        timestamp: new Date(),
        source: 'git-agent',
        type: 'agent.action.failed',
        severity: 'warning',
        correlationId,
        data: {
          incidentId,
          message: repairOutcome === 'resolved'
            ? 'Failure cause pinpointed and repaired by investigation; incident resolved.'
            : 'Failure cause pinpointed by investigation; remedy recorded on the incident. Needs your action.',
        },
      } as any);
      return;
    }

    // Clean miss: escalate, but with the probe trail attached instead of a shrug.
    await incidentStore.addFinding(
      incidentId,
      'Investigation complete: probes ran but no diagnosis rule matched. ' +
      'Remedy (your steps): paste the probe findings above plus the full failing command output when asking for help — ' +
      'that is the evidence a human needs to pinpoint this.',
    );
    await incidentStore.updateStatus(incidentId, 'escalated');
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'git-agent',
      type: 'agent.action.failed',
      severity: 'warning',
      correlationId,
      data: {
        incidentId,
        message: 'Build failure could not be classified or diagnosed after investigation. Escalating with probe trail.',
      },
    } as any);
  }

  /**
   * Mark performs the toolchain-skew remedy itself: own branch, deterministic
   * version repair, lint-exit verification, commit + push. Any failure lands
   * as a finding and the incident stays open — never a silent drop.
   */
  /**
   * Snapshot dirty files BEFORE Mark's work starts. At commit time, only
   * files outside this set may be staged — the user's uncommitted work is
   * never swept into an auto-fix commit.
   */
  private async snapshotDirtyFiles(repoPath: string): Promise<Set<string>> {
    try {
      const { stdout } = await execFilePromise('git', ['-C', repoPath, 'status', '--porcelain'], { timeout: 15000 });
      return new Set(stdout.split('\n').map(l => l.slice(3).trim().split(' -> ').pop() as string).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /**
   * Stage only Mark's own changes: everything modified except the
   * pre-existing dirty set, optionally restricted to an allow-list.
   * Returns staged file list (empty = nothing real).
   */
  private async stageOwnChangesOnly(
    repoPath: string, incidentId: string, preexisting: Set<string>, allowOnly?: string[],
  ): Promise<string[]> {
    const { stdout } = await execFilePromise('git', ['-C', repoPath, 'status', '--porcelain'], { timeout: 15000 });
    const current = stdout.split('\n').map(l => l.slice(3).trim().split(' -> ').pop() as string).filter(Boolean);
    const skippedUser = current.filter(f => preexisting.has(f));
    let own = current.filter(f => !preexisting.has(f));
    if (allowOnly) own = own.filter(f => allowOnly.includes(f));
    if (skippedUser.length > 0) {
      await incidentStore.addFinding(
        incidentId,
        `Hygiene: left ${skippedUser.length} pre-existing dirty file(s) unstaged (${skippedUser.slice(0, 5).join(', ')}) — your uncommitted work stays yours.`,
      );
    }
    if (own.length > 0) {
      await execFilePromise('git', ['-C', repoPath, 'add', '--', ...own], { timeout: 15000 });
    }
    return own;
  }

  private async repairToolchainSkew(
    incidentId: string,
    eventData: Record<string, any>,
    repositoryContext: { repo: any; fullName: string; localPath?: string },
    incidentCreatedAt: Date,
  ): Promise<'resolved' | 'repaired-open' | 'failed'> {
    const repoPath = repositoryContext.localPath || eventData.repository;
    if (!repoPath || !existsSync(repoPath)) return 'failed';
    const branchName = `auto-fix/deps-${Date.now()}`;
    try {
      await execFilePromise('git', ['-C', repoPath, 'checkout', '-b', branchName], { timeout: 15000 });
      const preexisting = await this.snapshotDirtyFiles(repoPath);
      const result = await repairEslintTypescriptSkew(repoPath);
      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'auto_fix_toolchain',
        tool: 'npm',
        result: result.applied ? 'success' : 'failure',
        details: `${result.detail}. ${result.applied ? `Ran ${result.command}; lint exit after: ${result.lintExitAfter}` : result.notes.join(' ')}`.slice(0, 400),
      });
      for (const note of result.notes.slice(0, 3)) {
        await incidentStore.addFinding(incidentId, `Toolchain repair: ${note}`);
      }
      if (!result.applied) {
        await incidentStore.addFinding(incidentId, `Toolchain repair could not apply on ${branchName}; remedy steps above are yours to run.`);
        return 'failed';
      }
      const { stdout: changed } = await execFilePromise('git', ['-C', repoPath, 'status', '--porcelain', 'package.json', 'package-lock.json'], { timeout: 15000 });
      if (!changed.trim()) {
        await incidentStore.addFinding(incidentId, `Toolchain repair ran on ${branchName} but produced no package changes.`);
        return 'failed';
      }
      const staged = await this.stageOwnChangesOnly(repoPath, incidentId, preexisting, ['package.json', 'package-lock.json']);
      if (staged.length === 0) {
        await incidentStore.addFinding(incidentId, `Toolchain repair on ${branchName} produced no committable package changes (user dirt excluded).`);
        return 'failed';
      }
      await execFilePromise('git', ['-C', repoPath, 'commit', '-m', 'auto-fix: align eslint toolchain versions'], { timeout: 15000 });
      await execFilePromise('git', ['-C', repoPath, 'push', '-u', 'origin', branchName], { timeout: 120000 });
      await incidentStore.addFinding(incidentId, `Toolchain repaired and pushed ${branchName} (lint exit ${result.lintExitAfter}).`);
      const skewResolved = (result.lintExitAfter ?? 2) <= 1;
      if (skewResolved) {
        await incidentStore.resolveIncident(incidentId, {
          action: 'Auto-fixed toolchain skew',
          success: true,
          details: `Repaired versions and pushed ${branchName}`,
        });
      }
      void opsMemory.save({
        incidentId,
        triggerEvent: eventData.triggerEvent ?? 'github.workflow.failed',
        failureType: 'BUILD_FAILURE',
        classificationConfidence: 0,
        repository: repositoryContext.fullName,
        resolution: `Toolchain skew repair pushed ${branchName}`,
        success: skewResolved,
        durationMs: Date.now() - incidentCreatedAt.getTime(),
      });
      void repoBaseline.refresh(repositoryContext.fullName);
      return skewResolved ? 'resolved' : 'repaired-open';
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'auto_fix_toolchain',
        tool: 'npm',
        result: 'failure',
        details: `Toolchain repair failed: ${msg.slice(0, 300)}`,
      });
      await incidentStore.addFinding(incidentId, `Toolchain auto-repair failed (${msg.slice(0, 200)}). The manual remedy above still applies.`);
      return 'failed';
    }
  }

  private async attemptAutoFix(
    incidentId: string,
    failureType: string,
    eventData: Record<string, any>,
    repositoryContext: { repo: any; fullName: string; localPath?: string },
    incidentCreatedAt: Date,
    classification: ClassificationResult,
  ): Promise<void> {
    if (!config.markEnableAutofix) {
      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'auto_fix_deferred',
        tool: 'git',
        result: 'success',
        details: `Auto-fix for ${failureType} deferred (set MARK_ENABLE_AUTOFIX=true to allow).`,
      });
      await incidentStore.addFinding(
        incidentId,
        `Auto-fix deferred: ${failureType} is auto-fixable but MARK_ENABLE_AUTOFIX is not enabled.`,
      );
      // Save to memory as an unsuccessful attempt so stats are accurate.
      void opsMemory.save({
        incidentId,
        triggerEvent: eventData.triggerEvent ?? 'github.workflow.failed',
        failureType,
        classificationConfidence: classification.confidence,
        repository: repositoryContext.fullName,
        resolution: `Auto-fix deferred (MARK_ENABLE_AUTOFIX not set)`,
        success: false,
        durationMs: Date.now() - incidentCreatedAt.getTime(),
      });
      await incidentStore.updateStatus(incidentId, 'open');
      return;
    }

    const repoPath = repositoryContext.localPath || eventData.repository || process.cwd();

    try {
      if (failureType === 'MISSING_DEPENDENCY') {
        const branchName = `auto-fix/deps-${Date.now()}`;
        await execFilePromise('git', ['-C', repoPath, 'checkout', '-b', branchName], { timeout: 15000 });
        await execFilePromise('npm', ['install'], { cwd: repoPath, timeout: 120000 });
        await incidentStore.addAction(incidentId, {
          timestamp: new Date(),
          agent: this.name,
          action: 'auto_fix_dependencies',
          tool: 'git',
          result: 'success',
          details: `Created branch ${branchName} and ran npm install`,
        });
        await incidentStore.addFinding(incidentId, `Auto-fix applied: created ${branchName}, ran npm install.`);
        const durationMs = Date.now() - incidentCreatedAt.getTime();
        await incidentStore.resolveIncident(incidentId, {
          action: 'Auto-fixed dependencies',
          success: true,
          details: `Branch ${branchName} created with npm install`,
        });
        void opsMemory.save({
          incidentId,
          triggerEvent: eventData.triggerEvent ?? 'github.workflow.failed',
          failureType,
          classificationConfidence: classification.confidence,
          repository: repositoryContext.fullName,
          resolution: `Created branch ${branchName} and ran npm install`,
          success: true,
          durationMs,
        });
        void repoBaseline.refresh(repositoryContext.fullName);
      } else if (failureType === 'LINT_FAILURE') {
        const branchName = `auto-fix/lint-${Date.now()}`;
        await execFilePromise('git', ['-C', repoPath, 'checkout', '-b', branchName], { timeout: 15000 });
        // Snapshot user dirt BEFORE Mark touches anything.
        const lintPreexisting = await this.snapshotDirtyFiles(repoPath);
        // Repair readiness: lint tooling needs installed dependencies. Fill
        // the gap first (recorded) instead of failing mid-repair.
        const readiness = await assessWorldState(repoPath);
        if (!readiness.hasNodeModules && readiness.hasPackageJson && !config.markDryRun) {
          try {
            await execFilePromise('npm', ['install', '--no-audit', '--no-fund'], { cwd: repoPath, timeout: 300000 });
            await incidentStore.addFinding(incidentId, `Readiness: installed dependencies on ${branchName} before repairing (node_modules was missing).`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await incidentStore.addAction(incidentId, {
              timestamp: new Date(),
              agent: this.name,
              action: 'auto_fix_prepare',
              tool: 'npm',
              result: 'failure',
              details: `Readiness install failed: ${msg.slice(0, 200)}`,
            });
            await incidentStore.addFinding(incidentId, `Cannot repair: dependencies failed to install (${msg.slice(0, 160)}). Remedy is yours: install manually and re-fire.`);
            await incidentStore.updateStatus(incidentId, 'open');
            return;
          }
        } else if (!readiness.repairReady && !config.markDryRun) {
          await incidentStore.addFinding(incidentId, `Cannot repair: ${readiness.blockers.join('; ')}. Remedy is yours: fix readiness and re-fire.`);
          await incidentStore.updateStatus(incidentId, 'open');
          return;
        }
        // Prefer the repo's own lint:fix script; fall back to local eslint --fix.
        let lintCmd: string[] = ['run', 'lint:fix'];
        let lintLabel = 'npm run lint:fix';
        try {
          const pkg = JSON.parse(readFileSync(`${repoPath}/package.json`, 'utf8'));
          if (!pkg?.scripts?.['lint:fix']) {
            lintCmd = ['--no-install', 'eslint', '.', '--fix'];
            lintLabel = 'npx eslint . --fix';
          }
        } catch {
          // No readable package.json: fall back to local eslint directly.
          lintCmd = ['--no-install', 'eslint', '.', '--fix'];
          lintLabel = 'npx eslint . --fix';
        }
        const lintBin = lintCmd[0] === 'run' ? 'npm' : 'npx';
        // eslint exits non-zero when unfixable errors remain — that is not a
        // failed fix run. Capture the exit and inspect the working tree after.
        let lintExitCode = 0;
        if (config.markDryRun) {
          console.log(`[GitAgent] DRY RUN — WOULD HAVE: run ${lintLabel}, commit, and push ${branchName} in ${repoPath}`);
        } else {
          try {
            await execFilePromise(lintBin, lintCmd, { cwd: repoPath, timeout: 120000 });
          } catch (err) {
            const code = (err as { code?: unknown }).code;
            lintExitCode = typeof code === 'number' ? code : 1;
          }
          // Residue the deterministic fixer cannot touch goes to the bounded
          // LLM repair loop (verify-or-revert per error). Failures here are
          // recorded, never thrown — the tree inspection below still runs.
          if (lintExitCode !== 0 && config.markRepairMaxErrors > 0) {
            try {
              const summary = await repairLintErrors(repoPath, {
                maxErrors: config.markRepairMaxErrors,
                maxFileLines: config.markRepairMaxFileLines,
              });
              await incidentStore.addAction(incidentId, {
                timestamp: new Date(),
                agent: this.name,
                action: 'auto_fix_llm_repair',
                tool: 'llm',
                result: summary.fixed > 0 ? 'success' : 'failure',
                details: `LLM repair: attempted ${summary.attempted}, fixed ${summary.fixed}, skipped ${summary.skipped}.`,
              });
              for (const outcome of summary.outcomes.slice(0, 5)) {
                if (!outcome.target.file) continue;
                await incidentStore.addFinding(
                  incidentId,
                  `LLM repair ${outcome.fixed ? 'fixed' : 'did not fix'} ${outcome.target.file}:${outcome.target.line} [${outcome.target.ruleId}]: ${outcome.detail.slice(0, 200)}`,
                );
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await incidentStore.addFinding(incidentId, `LLM repair loop failed safely: ${msg.slice(0, 200)}`);
            }
          }
        }
        const { stdout: changedFiles } = config.markDryRun
          ? { stdout: '' }
          : await execFilePromise('git', ['-C', repoPath, 'status', '--porcelain'], { timeout: 15000 });
        if (!changedFiles.trim()) {
          await incidentStore.addAction(incidentId, {
            timestamp: new Date(),
            agent: this.name,
            action: 'auto_fix_lint',
            tool: 'linter',
            result: 'success',
            details: config.markDryRun
              ? `Dry run: would have run ${lintLabel} on ${branchName}`
              : `Ran ${lintLabel} on ${branchName}; no automatic changes (remaining errors need manual fixes).`,
          });
          await incidentStore.addFinding(
            incidentId,
            `Auto-fix ran ${lintLabel} on ${branchName} but it produced no changes. Remaining lint errors require manual fixes.`,
          );
          const noChangeMs = Date.now() - incidentCreatedAt.getTime();
          await incidentStore.updateStatus(incidentId, 'open');
          void opsMemory.save({
            incidentId,
            triggerEvent: eventData.triggerEvent ?? 'github.workflow.failed',
            failureType,
            classificationConfidence: classification.confidence,
            repository: repositoryContext.fullName,
            resolution: `Ran ${lintLabel} on ${branchName}; no automatic changes`,
            success: false,
            durationMs: noChangeMs,
          });
          void repoBaseline.refresh(repositoryContext.fullName);
          return;
        }
        const staged = await this.stageOwnChangesOnly(repoPath, incidentId, lintPreexisting);
        // Lockfile churn is not a fix: discard package-lock.json unless
        // package.json changed alongside it (real dependency change).
        if (staged.includes('package-lock.json') && !staged.includes('package.json')) {
          try {
            await execFilePromise('git', ['-C', repoPath, 'restore', '--staged', 'package-lock.json'], { timeout: 15000 });
            await execFilePromise('git', ['-C', repoPath, 'checkout', '--', 'package-lock.json'], { timeout: 15000 });
            await incidentStore.addFinding(incidentId, 'Hygiene: discarded package-lock.json churn (installer version drift, not a fix).');
          } catch {
            // Best-effort hygiene; the emptiness check below still applies.
          }
        }
        // Nothing real to commit (no changes, only churn, or only user dirt).
        const { stdout: stagedAfter } = await execFilePromise('git', ['-C', repoPath, 'diff', '--cached', '--name-only'], { timeout: 15000 });
        if (!stagedAfter.trim()) {
          await incidentStore.addFinding(
            incidentId,
            `Auto-fix on ${branchName} produced no committable source changes. Remaining lint errors require manual fixes.`,
          );
          await incidentStore.updateStatus(incidentId, 'open');
          return;
        }
        await execFilePromise(
          'git',
          ['-C', repoPath, 'commit', '-m', `auto-fix: lint corrections (${failureType})`],
          { timeout: 15000 },
        );
        await execFilePromise('git', ['-C', repoPath, 'push', '-u', 'origin', branchName], { timeout: 60000 });
        // A non-zero lint exit means errors remain after the fix — pushed
        // partial progress stays open instead of resolving.
        const fullyFixed = lintExitCode === 0;
        await incidentStore.addAction(incidentId, {
          timestamp: new Date(),
          agent: this.name,
          action: 'auto_fix_lint',
          tool: 'linter',
          result: 'success',
          details: `Ran ${lintLabel} and pushed ${branchName}${fullyFixed ? '' : ` (lint still exits ${lintExitCode}; errors remain)}`}`,
        });
        await incidentStore.addFinding(
          incidentId,
          fullyFixed
            ? `Auto-fix applied: ran ${lintLabel} and pushed ${branchName}.`
            : `Auto-fix partially applied: ran ${lintLabel} and pushed ${branchName}, but lint still reports errors (exit ${lintExitCode}). Manual fixes required on top of this branch.`,
        );
        const durationMs = Date.now() - incidentCreatedAt.getTime();
        if (fullyFixed) {
          await incidentStore.resolveIncident(incidentId, {
            action: 'Auto-fixed linting',
            success: true,
            details: `Ran ${lintLabel} and pushed ${branchName}`,
          });
        } else {
          await incidentStore.updateStatus(incidentId, 'open');
        }
        void opsMemory.save({
          incidentId,
          triggerEvent: eventData.triggerEvent ?? 'github.workflow.failed',
          failureType,
          classificationConfidence: classification.confidence,
          repository: repositoryContext.fullName,
          resolution: fullyFixed
            ? `Ran ${lintLabel} and pushed ${branchName}`
            : `Ran ${lintLabel} and pushed ${branchName}; errors remain`,
          success: fullyFixed,
          durationMs,
        });
        void repoBaseline.refresh(repositoryContext.fullName);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'auto_fix_failed',
        tool: 'git',
        result: 'failure',
        details: `Auto-fix attempt failed: ${msg}`,
      });
      await incidentStore.addFinding(incidentId, `Auto-fix failed: ${msg.slice(0, 200)}`);
      void opsMemory.save({
        incidentId,
        triggerEvent: eventData.triggerEvent ?? 'github.workflow.failed',
        failureType,
        classificationConfidence: classification.confidence,
        repository: repositoryContext.fullName,
        resolution: `Auto-fix failed: ${msg.slice(0, 200)}`,
        success: false,
        durationMs: Date.now() - incidentCreatedAt.getTime(),
      });
      await incidentStore.updateStatus(incidentId, 'escalated');
    }
  }

  /**
   * When a workflow succeeds on a branch that looks like an auto-fix branch
   * (prefix: auto-fix/), look up the corresponding incident and mark it verified.
   */
  private async verifyPriorFix(repository: string, branch: string | undefined): Promise<void> {
    if (!branch?.startsWith('auto-fix/')) return;
    try {
      const pool = (await import('../db/postgres.js')).getPool();
      // Find a resolved incident for this repo whose auto-fix branch matches
      const result = await pool.query<{ incident_id: string }>(
        `SELECT incident_id FROM ops_incident_memory
         WHERE repository = $1 AND success = true AND verified = false
         ORDER BY created_at DESC LIMIT 1`,
        [repository],
      );
      if (result.rows.length > 0) {
        await opsMemory.markVerified(result.rows[0].incident_id);
        console.log(`[GitAgent] Marked fix verified for incident ${result.rows[0].incident_id} (${repository} ${branch})`);
      }
    } catch (err) {
      console.debug('[GitAgent] verifyPriorFix failed:', err instanceof Error ? err.message : String(err));
    }
  }
}
