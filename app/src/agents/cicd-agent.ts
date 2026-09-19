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
import type { CapabilityRegistry } from '../runtime/capabilities/registry';

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
    return (
      `CICD Agent: triage only — I classify pipeline failures and open an incident with next steps. ` +
      `Re-running or mutating a pipeline needs approval. Request received: "${command.slice(0, 160)}"`
    );
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
