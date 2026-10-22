/**
 * CICDAgent: Handles pipeline, build, test, and lint failures.
 * Bridges the gateway's `cicd-agent` route which previously had no implementation.
 *
 * This agent triages deterministically (classify + suggest + incident trail).
 * It never pushes code or re-triggers pipelines on its own; those need approval.
 */
import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';
import type { CapabilityRegistry } from '../runtime/capabilities/registry';

const execFilePromise = promisify(execFile);

export class CICDAgent extends Agent {
  constructor() {
    super('cicd-agent');
  }

  canHandle(event: Event): boolean {
    if (event.type === 'user.command.received') {
      const command = String((event.data as Record<string, any>).command || '');
      if (/\b(git|branch|branches|commit|commits|merge|rebase|pull request)\b/i.test(command)) return false;
      if (/\b(deploy|deployment|deployments|rollback|restart|docker|container|containers|kubernetes|k8s|health)\b/i.test(command)) return false;
      return /\b(pipeline|pipelines|build|builds|test|tests|testing|lint)\b/i.test(command);
    }
    return (
      event.type === 'ci.test.failed' ||
      event.type === 'ci.build.failed' ||
      event.type === 'ci.lint.failed' ||
      event.type === 'github.workflow.completed'
    );
  }

  async handleCommand(event: Event, _capabilities: CapabilityRegistry): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');
    if (/\bverif(y|ies|ied)\b/i.test(command)) {
      // Explicit "verify ..." order: run the repo's own build checks and
      // report PASS/FAIL. Read-only (no commit/push/pipeline triggers), so
      // no approval is needed — but the repo must be named explicitly, and
      // only discovered checks run (never an invented command). Observed
      // live: "verify builds and tests pass" was refused as needing
      // approval, so verification never happened at all.
      return this.verifyBuild(command);
    }
    return (
      `CICD Agent: triage only — I classify pipeline failures and open an incident with next steps. ` +
      `Re-running or mutating a pipeline needs approval. Request received: "${command.slice(0, 160)}"`
    );
  }

  /**
   * Run an explicitly named repo's own checks: `go build ./...` when go.mod
   * is present, otherwise the package.json verification script when one exists.
   * Each check runs at most 3 minutes; output is tailed, never dumped whole.
   */
  private async verifyBuild(command: string): Promise<string> {
    const abs = command.match(/(\/(?:tmp|home)\/[^\s"'`]+)/)?.[1]?.replace(/[.,;:]+$/, '');
    if (!abs || !existsSync(abs)) {
      return 'Which repository? Name it by absolute path and I will verify its build — e.g. "verify the build in /home/mwei/jarvis-core/app".';
    }
    const checks: Array<{ name: string; cwd: string; cmd: string; args: string[] }> = [];
    if (existsSync(`${abs}/go.mod`)) {
      // VCS stamping is metadata, not compilation. Disabling it lets MARK
      // verify unpacked source trees and temporary checkouts as well as Git
      // repositories; a missing .git directory must not turn a clean build
      // into a false failure.
      checks.push({ name: 'go build ./...', cwd: abs, cmd: 'go', args: ['build', '-buildvcs=false', './...'] });
    } else {
      const pkgDir = existsSync(`${abs}/app/package.json`) ? `${abs}/app` : abs;
      try {
        const scripts = Object.keys(JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))?.scripts ?? {});
        const check = scripts.includes('typecheck:mark') ? 'typecheck:mark'
          : scripts.includes('typecheck') ? 'typecheck'
          : scripts.includes('lint') ? 'lint'
          : scripts.includes('test') ? 'test'
          : scripts.includes('build') ? 'build'
          : null;
        if (check) checks.push({ name: `npm run ${check}`, cwd: pkgDir, cmd: 'npm', args: ['run', check] });
      } catch {
        // Unreadable package.json — reported below as "no known checks".
      }
    }
    if (checks.length === 0) {
      return `No known build checks on ${abs} (no go.mod, typecheck, lint, test, or build script). Nothing verified.`;
    }
    const lines = [`Verify ${abs}:`];
    let failed = 0;
    for (const c of checks) {
      const t0 = Date.now();
      try {
        await execFilePromise(c.cmd, c.args, { cwd: c.cwd, timeout: 180000 });
        lines.push(`  PASS ${c.name} (${Date.now() - t0}ms)`);
      } catch (err) {
        failed++;
        const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
        const tail = String(e.stdout ?? '') + String(e.stderr ?? '');
        const excerpt = tail.trim().split('\n').slice(-8).join('\n').slice(0, 800) || String(e.message ?? '').slice(0, 200);
        lines.push(`  FAIL ${c.name} (${Date.now() - t0}ms): ${excerpt}`);
      }
    }
    lines.push(failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`);
    return lines.join('\n');
  }

  async handle(event: Event): Promise<void> {
    const data = (event.data ?? {}) as Record<string, any>;
    const subject = data.pipeline || data.workflowName || data.repository || 'unknown-pipeline';

    const incident = await incidentStore.createIncident({
      title: `CI event: ${event.type} (${subject})`,
      description: data.failureMessage || data.message || `Received ${event.type}`,
      severity: event.severity === 'critical' ? 'critical' : 'low',
      status: 'investigating',
      triggerEvent: event.type,
      triggerEventId: event.id,
      correlationId: event.correlationId || event.id,
      assignedAgent: this.name,
      tags: ['ci', event.type],
      context: {
        pipeline: subject,
        repository: data.repository,
        branch: data.branch,
      },
    });

    try {
      const hint =
        event.type === 'ci.lint.failed'
          ? 'Run lint locally and fix auto-fixable issues before pushing.'
          : event.type === 'ci.test.failed'
            ? 'Run the failing test file locally to reproduce, then fix and re-run.'
            : 'Check the failed step logs, fix, and re-trigger the pipeline manually after review.';

      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'triage',
        tool: 'cicd-agent',
        result: 'success',
        details: hint,
      });
      await incidentStore.updateStatus(incident.id, 'open');

      await eventBus.emit({
        id: `EVT-${Date.now()}`,
        timestamp: new Date(),
        source: 'system',
        type: 'agent.action.failed',
        severity: 'info',
        correlationId: incident.correlationId,
        data: { incidentId: incident.id, message: `CI triage complete: ${hint}` },
      } as any);
    } catch (error) {
      await incidentStore.updateStatus(incident.id, 'escalated');
      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'handle',
        tool: 'cicd-agent',
        result: 'failure',
        details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
