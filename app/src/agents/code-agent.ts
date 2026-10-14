/**
 * CodeAgent: Mark's coding agent. Owns LLM-driven source repair.
 *
 * Separation from GitAgent is deliberate: triage/investigation is
 * read-mostly and deterministic; code repair mutates source with its own
 * budgets (attempts, cloud calls, file size) and its own verification
 * (error count must drop, otherwise revert). Different risk, different
 * tools, different agent.
 *
 * Flow: `code.repair.requested` { repository, localPath?, maxErrors? } →
 * repair loop → per-outcome findings → `code.repair.completed` with summary.
 * Completion is verified, not assumed: after the loop the agent recounts
 * repo errors and only resolves when zero remain.
 */
import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';
import { repositoryRegistry } from '../repositories/registry';
import { collectEslintErrors, repairLintErrors, repairOneError, LintError, RepairOutcome, RepairRunContext } from './code-repair';
import { consolidateBranches } from './branch-consolidate';
import { opsObjective } from '../ops/objective';

const execFilePromise = promisify(execFile);

export class CodeAgent extends Agent {
  constructor() {
    super('code-agent');
  }

  canHandle(event: Event): boolean {
    return event.type === 'code.repair.requested';
  }

  async handle(event: Event): Promise<void> {
    const data = event.data as Record<string, any>;
    const repoRef = data.repository || data.repo || data.localPath;
    const resolved = repositoryRegistry.resolve(repoRef, data.localPath);
    const repoPath = resolved?.localPath || data.localPath;
    const fullName = resolved?.fullName || repoRef || 'unknown-repository';
    const incidentId = typeof data.incidentId === 'string' ? data.incidentId : undefined;

    console.log(`[CodeAgent] Repair requested for ${fullName}`);

    const find = async (text: string): Promise<void> => {
      if (incidentId) await incidentStore.addFinding(incidentId, text);
    };

    if (!repoPath || !existsSync(repoPath)) {
      await find(
        'Code repair skipped: no local checkout available. ' +
        'Remedy (your steps): register the repo with a localPath and re-fire code.repair.requested.',
      );
      await this.complete(event, fullName, incidentId, false, 'no local checkout');
      return;
    }

    const maxErrors = Number.isFinite(Number(data.maxErrors)) ? Number(data.maxErrors) : config.markRepairMaxErrors;
    // Snapshot user dirt BEFORE repairs: a fixed file the user also touched
    // is excluded from push (co-authored work stays theirs, noted).
    const preexisting = await this.snapshotDirtyFiles(repoPath);
    // Consolidation requests merge fix branches with evidence-decided
    // conflicts instead of repairing. Same agent, same audit trail.
    if (Array.isArray(data.branches) && data.branches.length > 0) {
      await this.handleConsolidation(event, fullName, repoPath, incidentId, data.branches as string[]);
      return;
    }
    // Targeted requests name exact error sites; otherwise repair the first
    // N errors found. Either way one shared cloud budget for the run.
    const ctx: RepairRunContext = { cloudCalls: 0, maxCloudCalls: config.markRepairMaxCloudCalls };
    const report = async (o: RepairOutcome): Promise<void> => {
      if (!o.target.file) return;
      await find(
        `Repair ${o.fixed ? 'FIXED' : 'open'} ${o.target.file}:${o.target.line} [${o.target.ruleId}] via ${o.via ?? 'none'}: ${o.detail.slice(0, 220)}`,
      );
    };
    try {
      const outcomes: RepairOutcome[] = [];
      const targets = Array.isArray(data.targets) ? (data.targets as LintError[]).slice(0, Math.max(maxErrors, 1)) : null;
      if (targets && targets.length > 0) {
        for (const target of targets) {
          const outcome = await repairOneError(repoPath, target, { maxFileLines: config.markRepairMaxFileLines, ctx });
          outcomes.push(outcome);
          await report(outcome);
        }
      } else {
        const summary = await repairLintErrors(repoPath, {
          maxErrors,
          maxFileLines: config.markRepairMaxFileLines,
          maxCloudCalls: config.markRepairMaxCloudCalls,
          onOutcome: report,
        });
        outcomes.push(...summary.outcomes.filter((o) => o.target.file));
      }
      const fixed = outcomes.filter((o) => o.fixed).length;
      const attempted = outcomes.length;
      const skipped = outcomes.filter((o) => o.skipped).length;
      try { opsObjective.record('incident.investigated'); } catch { /* objective never fails a run */ }
      if (fixed > 0) {
        try { opsObjective.record('incident.fix_proposed'); } catch { /* never fails a run */ }
      }

      if (incidentId) {
        try {
          await incidentStore.addAction(incidentId, {
            timestamp: new Date(),
            agent: this.name,
            action: 'code_repair_run',
            tool: 'llm',
            result: fixed > 0 ? 'success' : 'failure',
            details: `Attempted ${attempted}, fixed ${fixed}, skipped ${skipped}.`,
          });
        } catch { /* incident trail is best-effort when no incident store */ }
      }

      // Verified completion: recount repo-wide. Resolve only on zero.
      let remaining = -1;
      try {
        remaining = (await collectEslintErrors(repoPath)).length;
      } catch (err) {
        await find(`Final verification failed safely: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
      // Gate 3/3 (new): repo-level check via safest script (typecheck > lint).
      // Best-effort and reported, never blocking resolve on unrelated failures.
      try {
        const { readFileSync: readPkg, existsSync: existsPkg } = await import('node:fs');
        if (existsPkg(`${repoPath}/package.json`)) {
          const scripts = Object.keys(JSON.parse(readPkg(`${repoPath}/package.json`, 'utf8'))?.scripts ?? {});
          const gate = scripts.includes('typecheck') ? 'typecheck' : scripts.includes('lint') ? 'lint' : null;
          if (gate) {
            const { execFile: execGate } = await import('node:child_process');
            const { promisify: promGate } = await import('node:util');
            try {
              await promGate(execGate)('npm', ['run', gate], { cwd: repoPath, timeout: 120000 });
              await find(`Verification gate 3/3: npm run ${gate} passed.`);
            } catch (gateErr) {
              const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
              await find(`Verification gate 3/3: npm run ${gate} FAILED (non-blocking): ${msg.slice(0, 200)}`);
            }
          }
        }
      } catch {
        // Gate 3/3 is informational only.
      }
      const done = fixed > 0 && remaining === 0;
      // Push is explicit, never default: the request must carry push:true
      // (plus dry-run off). Pushed branches are the audit trail.
      let pushedBranch: string | null = null;
      if (fixed > 0 && data.push === true && !config.markDryRun) {
        pushedBranch = await this.pushFixes(repoPath, incidentId, outcomes.filter((o) => o.fixed), preexisting);
      }
      await find(
        done
          ? `Repair complete and verified: ${fixed} error(s) fixed, ${remaining} remain repo-wide. ` +
            `Verification ladder: eslint recount 0 (gate 1/2) + per-error tsc no-regression gate (gate 2/2, enforced in repairOneError). ` +
            `Scoped tests remain yours to run (gate 3/3 not automated in this run).`
          : `Repair run finished: fixed ${fixed}/${attempted}, ${remaining >= 0 ? remaining : '?'} error(s) remain repo-wide.` +
            (pushedBranch ? ` Progress pushed to ${pushedBranch}.` : ' Needs another run or your action.'),
      );
      if (incidentId) {
        if (done) {
          await incidentStore.resolveIncident(incidentId, {
            action: 'Repaired lint errors',
            success: true,
            details: `CodeAgent fixed ${fixed} error(s); verification recount is zero.`,
          });
        } else {
          await incidentStore.updateStatus(incidentId, 'open');
        }
      }
      await this.complete(event, fullName, incidentId, done, `${fixed}/${attempted} fixed, ${remaining} remain${pushedBranch ? `, pushed ${pushedBranch}` : ''}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[CodeAgent] Repair run failed:', msg);
      await find(`Repair run failed safely: ${msg.slice(0, 200)}`);
      if (incidentId) await incidentStore.updateStatus(incidentId, 'escalated');
      await this.complete(event, fullName, incidentId, false, `run failed: ${msg.slice(0, 120)}`);
    } finally {
      try {
        console.log(`[CodeAgent] Completed repair for ${fullName}`);
      } catch { /* logging never fails a run */ }
    }
  }

  private async snapshotDirtyFiles(repoPath: string): Promise<Set<string>> {
    try {
      const { stdout } = await execFilePromise('git', ['-C', repoPath, 'status', '--porcelain'], { timeout: 15000 });
      return new Set(stdout.split('\n').map(l => l.slice(3).trim().split(' -> ').pop() as string).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /**
   * Commit verified fixes on their own branch and push. Only files with a
   * verified fix are staged — never the whole tree. Failures are findings,
   * never silent.
   */
  private async pushFixes(repoPath: string, incidentId: string | undefined, fixed: RepairOutcome[], preexisting: Set<string>): Promise<string | null> {
    const files = [...new Set(fixed.map((o) => o.target.file).filter(Boolean))];
    if (files.length === 0) return null;
    const branchName = `auto-fix/code-${Date.now()}`;
    const find = async (text: string): Promise<void> => {
      if (incidentId) await incidentStore.addFinding(incidentId, text);
    };
    // Exclude files the user had already touched: co-authored work stays
    // theirs. If nothing Mark-only remains, there is nothing safe to push.
    const coauthored = files.filter(f => preexisting.has(f));
    const own = files.filter(f => !preexisting.has(f));
    if (coauthored.length > 0) {
      await find(`Hygiene: excluded ${coauthored.length} co-authored file(s) from push (${coauthored.slice(0, 5).join(', ')}) — merge Mark's branch yourself to combine.`);
    }
    if (own.length === 0) return null;
    try {
      await execFilePromise('git', ['-C', repoPath, 'checkout', '-b', branchName], { timeout: 15000 });
      await execFilePromise('git', ['-C', repoPath, 'add', '--', ...own], { timeout: 15000 });
      await execFilePromise(
        'git',
        ['-C', repoPath, 'commit', '-m', `auto-fix: repair ${own.length} file(s) (${fixed.length} lint errors)`],
        { timeout: 15000 },
      );
      await execFilePromise('git', ['-C', repoPath, 'push', '-u', 'origin', branchName], { timeout: 120000 });
      await find(`CodeAgent pushed ${branchName} with ${own.length} fixed file(s): ${own.slice(0, 5).join(', ')}.`);
      return branchName;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await find(`CodeAgent push failed safely on ${branchName}: ${msg.slice(0, 200)}. Fixes remain committed locally on that branch.`);
      return null;
    }
  }

  /**
   * Consolidate fix branches: merge oldest-first, resolve conflicts by
   * eslint-count evidence, verify the tree, push one branch. Every decision
   * lands in the incident trail.
   */
  private async handleConsolidation(
    event: Event,
    fullName: string,
    repoPath: string,
    incidentId: string | undefined,
    branches: string[],
  ): Promise<void> {
    const find = async (text: string): Promise<void> => {
      if (incidentId) await incidentStore.addFinding(incidentId, text);
    };
    console.log(`[CodeAgent] Consolidating ${branches.length} branches for ${fullName}`);
    try {
      const result = await consolidateBranches(repoPath, branches);
      await find(`Consolidation pushed ${result.branch}: merged ${result.merged.length} branch(es)` +
        (result.conflicted.length > 0 ? `, evidence-resolved conflicts in ${result.conflicted.length}` : ', no conflicts') +
        (result.skipped.length > 0 ? `, skipped ${result.skipped.length} (${result.skipped.join(', ')})` : '') +
        `. Final lint: ${result.lintErrorsAfter} errors.`);
      for (const r of result.resolutions.slice(0, 8)) {
        await find(`Conflict ${r.file}: kept ${r.winner} (${r.oursErrors} vs ${r.theirsErrors} errors).`);
      }
      for (const note of result.notes.slice(-3)) await find(`Consolidation note: ${note.slice(0, 200)}`);
      if (incidentId) {
        await incidentStore.addAction(incidentId, {
          timestamp: new Date(),
          agent: this.name,
          action: 'consolidate_branches',
          tool: 'git',
          result: 'success',
          details: `Merged ${result.merged.length} branches into ${result.branch}; lint ${result.lintErrorsAfter} errors.`,
        });
        await incidentStore.resolveIncident(incidentId, {
          action: 'Consolidated fix branches',
          success: true,
          details: `Pushed ${result.branch}`,
        });
      }
      await this.complete(event, fullName, incidentId, true, `consolidated ${result.merged.length} branches into ${result.branch}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[CodeAgent] Consolidation failed:', msg);
      await find(`Consolidation failed safely: ${msg.slice(0, 200)}. Branches untouched on origin.`);
      if (incidentId) await incidentStore.updateStatus(incidentId, 'escalated');
      await this.complete(event, fullName, incidentId, false, `consolidation failed: ${msg.slice(0, 120)}`);
    } finally {
      try {
        console.log(`[CodeAgent] Completed consolidation for ${fullName}`);
      } catch { /* logging never fails a run */ }
    }
  }

  private async complete(
    event: Event,
    repository: string,
    incidentId: string | undefined,
    done: boolean,
    summary: string,
  ): Promise<void> {
    try {
      if (done) {
        opsObjective.record('incident.fix_verified');
        opsObjective.record('incident.resolved');
      } else {
        opsObjective.record('incident.escalated');
      }
    } catch { /* objective never fails a run */ }
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'code-agent',
      type: 'code.repair.completed',
      severity: done ? 'info' : 'warning',
      correlationId: event.correlationId || repository,
      data: { repository, incidentId, done, summary },
    } as any);
  }
}
