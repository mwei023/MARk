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
import { config } from '../config.js';
import { repositoryRegistry } from '../repositories/registry';
import { collectEslintErrors, repairLintErrors, repairOneError, LintError, RepairOutcome, RepairRunContext } from './code-repair';

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
      const done = fixed > 0 && remaining === 0;
      await find(
        done
          ? `Repair complete and verified: ${fixed} error(s) fixed, ${remaining} remain repo-wide.`
          : `Repair run finished: fixed ${fixed}/${attempted}, ${remaining >= 0 ? remaining : '?'} error(s) remain repo-wide. Needs another run or your action.`,
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
      await this.complete(event, fullName, incidentId, done, `${fixed}/${attempted} fixed, ${remaining} remain`);
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

  private async complete(
    event: Event,
    repository: string,
    incidentId: string | undefined,
    done: boolean,
    summary: string,
  ): Promise<void> {
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
