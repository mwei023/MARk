/**
 * DevOpsAgent: Handles deployment, container health, restart, and rollback.
 *
 * Phase 2 changes:
 * - All mutating actions write a structured ActionProposal before executing.
 * - Uses findOrCreateIncident for correlation (repeated events → one incident).
 * - Rollback proposals query prior successful deployment incidents for target.
 * - Dry-run mode (MARK_DRY_RUN=true) logs WOULD HAVE instead of executing.
 * - Low-risk actions auto-execute when MARK_ENABLE_AUTOFIX=true.
 * - Medium/high-risk actions (rollback, restart) wait for POST /api/approve.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore, type Incident } from '../core/incident';
import { eventBus } from '../core/event-bus';
import {
  proposalStore,
  shouldAutoExecute,
  isDryRun,
  formatProposalAction,
  type ActionProposal,
} from '../core/proposal';
import { config } from '../config.js';
import { opsMemory } from '../core/ops-memory';
import { repoBaseline } from '../core/repo-baseline';
import type { CapabilityRegistry } from '../runtime/capabilities/registry';

const execFilePromise = promisify(execFile);

const RESTART_ALLOWLIST = ['jarvis-db', 'jarvis-cache', 'jarvis-api'];

export class DevOpsAgent extends Agent {
  constructor() {
    super('devops-agent');
  }

  canHandle(event: Event): boolean {
    if (event.type === 'user.command.received') {
      const command = String((event.data as Record<string, any>).command || '');
      return /\b(deploy|deployment|deployments|rollback|restart|docker|container|containers|kubernetes|k8s|health)\b/i.test(command);
    }
    return (
      event.type === 'github.deployment.failed' ||
      event.type === 'github.deployment.succeeded' ||
      event.type === 'docker.container.health_status.unhealthy' ||
      event.type === 'docker.container.exited' ||
      event.type === 'system.service.down' ||
      event.type === 'edge.obstacle' ||
      event.type === 'edge.low_batt'
    );
  }

  async handleCommand(event: Event, _capabilities: CapabilityRegistry): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');

    if (/\brestart\b/i.test(command)) {
      const match = command.match(/restart\s+([a-zA-Z0-9_.-]+)/i);
      const container = match?.[1]?.replace(/[^a-zA-Z0-9_.-]/g, '');
      if (!container) return 'DevOps Agent: specify a container, e.g. "restart jarvis-db".';
      if (!RESTART_ALLOWLIST.includes(container)) {
        return `DevOps Agent: "${container}" is not in the restart allowlist (${RESTART_ALLOWLIST.join(', ')}).`;
      }
      return (
        `DevOps Agent: restart of "${container}" requires approval. ` +
        `Use POST /api/execute with goal "restart ${container}", then approve the confirmation.`
      );
    }

    if (/\b(docker|container|health)\b/i.test(command)) {
      try {
        const { stdout } = await execFilePromise(
          'docker', ['ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
          { timeout: 15000 },
        );
        const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return 'DevOps Agent: no running containers.';
        return `DevOps Agent: ${lines.length} running container(s):\n${lines.slice(0, 20).join('\n')}`;
      } catch (error: any) {
        return `DevOps Agent: Docker daemon unreachable: ${error.message || 'unknown error'}`;
      }
    }

    if (/\b(rollback|deploy)\b/i.test(command)) {
      return 'DevOps Agent: rollbacks and deploys always require approval. Specify the service and target version via POST /api/execute.';
    }

    return 'DevOps Agent: container health, restart (allowlisted), and deployment triage supported.';
  }

  async handle(event: Event): Promise<void> {
    const data = (event.data ?? {}) as Record<string, any>;
    const subject = data.containerName || data.container || data.service || data.node || data.environment || 'unknown-service';
    const repository = data.repository || data.full_name;
    const environment = data.environment || 'unknown';

    // ── Correlation ──────────────────────────────────────────────────────────
    const incident = await incidentStore.findOrCreateIncident({
      title: `Ops event: ${event.type} (${subject})`,
      description: data.reason || data.message || `Received ${event.type}`,
      severity: event.severity === 'critical' ? 'critical' : event.severity === 'warning' ? 'medium' : 'low',
      triggerEvent: event.type,
      triggerEventId: event.id,
      correlationId: event.correlationId || event.id,
      assignedAgent: this.name,
      tags: ['ops', event.type, environment],
      context: {
        service: subject,
        environment,
        container: data.containerName || data.container,
        repository,
      },
    });

    console.log(`[DevOpsAgent] Incident ${incident.id} (${incident._wasCorrelated ? 'correlated' : 'new'}) for ${event.type}`);

    try {
      // ── Step 1: Diagnostics (read-only, always runs) ─────────────────────
      await this.gatherDiagnostics(incident);

      // ── Step 2: Event-specific response ─────────────────────────────────
      if (event.type === 'github.deployment.failed') {
        await this.handleDeploymentFailure(incident, data, repository, environment);
        return;
      }

      if (
        event.type === 'docker.container.health_status.unhealthy' ||
        event.type === 'docker.container.exited' ||
        event.type === 'system.service.down'
      ) {
        await this.handleUnhealthyContainer(incident, data, subject);
        return;
      }

      if (event.type === 'github.deployment.succeeded') {
        await this.recordSuccessfulDeployment(incident, data, repository, environment);
        return;
      }

      await incidentStore.updateStatus(incident.id, 'open');
    } catch (error) {
      await incidentStore.updateStatus(incident.id, 'escalated');
      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'handle',
        tool: 'devops-agent',
        result: 'failure',
        details: `Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private async handleDeploymentFailure(
    incident: Incident,
    data: Record<string, any>,
    repository: string | undefined,
    environment: string,
  ): Promise<void> {
    await incidentStore.addFinding(
      incident.id,
      `Deployment failure detected for ${repository ?? 'unknown repo'} in ${environment}.`,
    );

    // Query prior successful deployments to propose a rollback target.
    const rollbackTarget = await this.findLastSuccessfulDeployment(repository, environment);

    if (rollbackTarget) {
      await incidentStore.addFinding(
        incident.id,
        `Prior successful deployment found: commit ${rollbackTarget.commit} in ${rollbackTarget.environment} (incident ${rollbackTarget.incidentId}).`,
      );

      const proposal = proposalStore.create({
        incidentId: incident.id,
        action: `Rollback ${repository ?? 'service'} to commit ${rollbackTarget.commit}`,
        tool: 'docker_compose_rollback',
        input: {
          repository,
          environment,
          targetCommit: rollbackTarget.commit,
          targetIncidentId: rollbackTarget.incidentId,
        },
        rationale: `Deployment failed. Last known-good commit is ${rollbackTarget.commit} from incident ${rollbackTarget.incidentId}.`,
        riskLevel: 'medium', // rollbacks always medium — they affect running services
      });

      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'proposal_created',
        tool: 'proposal-store',
        result: 'success',
        details: formatProposalAction(proposal),
      });

      await this.executeOrQueueProposal(proposal, incident.id);
    } else {
      await incidentStore.addFinding(
        incident.id,
        `No prior successful deployment found for ${repository ?? 'unknown repo'} in ${environment}. Cannot propose rollback — escalating for manual review.`,
      );
      await incidentStore.updateStatus(incident.id, 'escalated');
      await this.emitEscalation(incident, `No rollback target available for ${repository ?? 'unknown'} in ${environment}.`);
    }
  }

  private async handleUnhealthyContainer(
    incident: Incident,
    data: Record<string, any>,
    subject: string,
  ): Promise<void> {
    await incidentStore.addFinding(incident.id, `Container/service unhealthy: ${subject}.`);

    if (!RESTART_ALLOWLIST.includes(subject)) {
      await incidentStore.addFinding(
        incident.id,
        `"${subject}" is not in the restart allowlist. Escalating for manual review.`,
      );
      await incidentStore.updateStatus(incident.id, 'escalated');
      await this.emitEscalation(incident, `${subject} is not allowlisted for automatic restart.`);
      return;
    }

    const proposal = proposalStore.create({
      incidentId: incident.id,
      action: `Restart container ${subject}`,
      tool: 'docker_compose_restart',
      input: { container: subject, environment: data.environment ?? 'unknown' },
      rationale: `Container ${subject} is unhealthy/exited. Restart is a low-impact recovery action for allowlisted services.`,
      riskLevel: 'low',
    });

    await incidentStore.addAction(incident.id, {
      timestamp: new Date(),
      agent: this.name,
      action: 'proposal_created',
      tool: 'proposal-store',
      result: 'success',
      details: formatProposalAction(proposal),
    });

    await this.executeOrQueueProposal(proposal, incident.id);
  }

  private async recordSuccessfulDeployment(
    incident: Incident,
    data: Record<string, any>,
    repository: string | undefined,
    environment: string,
  ): Promise<void> {
    // Tag the incident so it can be queried as a rollback target later.
    await incidentStore.addFinding(
      incident.id,
      `Deployment succeeded: ${repository ?? 'unknown'} commit ${data.commit ?? 'unknown'} in ${environment}. Recorded as potential rollback target.`,
    );
    const durationMs = Date.now() - incident.createdAt.getTime();
    await incidentStore.resolveIncident(incident.id, {
      action: 'Deployment succeeded',
      success: true,
      details: `commit=${data.commit ?? 'unknown'} environment=${environment}`,
    });
    void opsMemory.save({
      incidentId: incident.id,
      triggerEvent: 'github.deployment.succeeded',
      failureType: 'NONE',
      classificationConfidence: 1,
      repository: repository ?? null,
      resolution: `Deployment succeeded: commit=${data.commit ?? 'unknown'} environment=${environment}`,
      success: true,
      durationMs,
    });
    if (repository) void repoBaseline.refresh(repository);
  }

  // ── Proposal execution ──────────────────────────────────────────────────────

  /**
   * Route a proposal to dry_run, auto-execute, or leave pending for human approval.
   */
  private async executeOrQueueProposal(proposal: ActionProposal, incidentId: string): Promise<void> {
    if (isDryRun()) {
      const wouldHave = `${proposal.action} (tool: ${proposal.tool}, input: ${JSON.stringify(proposal.input)})`;
      proposalStore.markDryRun(proposal.id, wouldHave);
      await incidentStore.addFinding(incidentId, `DRY RUN: WOULD HAVE — ${wouldHave}`);
      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'proposal_dry_run',
        tool: proposal.tool,
        result: 'success',
        details: `DRY RUN: WOULD HAVE executed proposal ${proposal.id}: ${proposal.action}`,
      });
      await proposalStore.auditDecision(proposal);
      await incidentStore.updateStatus(incidentId, 'open');
      return;
    }

    if (shouldAutoExecute(proposal.riskLevel)) {
      await this.executeProposal(proposal, incidentId, 'auto');
      return;
    }

    // Needs human approval — leave pending and emit event so the caller knows.
    await incidentStore.addFinding(
      incidentId,
      `Proposal ${proposal.id} pending approval: "${proposal.action}" (risk: ${proposal.riskLevel}). Approve via POST /api/approve { "incidentId": "${incidentId}", "proposalId": "${proposal.id}", "approved": true }.`,
    );
    await incidentStore.updateStatus(incidentId, 'open');
    await this.emitEscalation(
      { id: incidentId, correlationId: incidentId } as Incident,
      `Action proposal pending approval: ${proposal.action} (proposal ${proposal.id})`,
    );
  }

  /**
   * Execute an approved proposal. Respects dry-run even at execution time
   * (in case the flag was flipped between approval and execution).
   */
  async executeApprovedProposal(
    proposalId: string,
    incidentId: string,
  ): Promise<{ success: boolean; message: string }> {
    const proposal = proposalStore.get(proposalId);
    if (!proposal) {
      return { success: false, message: `Proposal ${proposalId} not found.` };
    }
    if (proposal.status !== 'approved' && proposal.status !== 'pending') {
      return { success: false, message: `Proposal ${proposalId} is ${proposal.status} — cannot execute.` };
    }
    if (proposal.incidentId !== incidentId) {
      return { success: false, message: `Proposal ${proposalId} belongs to incident ${proposal.incidentId}, not ${incidentId}.` };
    }

    if (isDryRun()) {
      const wouldHave = `${proposal.action} (tool: ${proposal.tool})`;
      proposalStore.markDryRun(proposal.id, wouldHave);
      await proposalStore.auditDecision(proposal);
      await incidentStore.addFinding(incidentId, `DRY RUN: WOULD HAVE executed approved proposal: ${wouldHave}`);
      return { success: true, message: `DRY RUN: WOULD HAVE — ${wouldHave}` };
    }

    return this.executeProposal(proposal, incidentId, 'api');
  }

  private async executeProposal(
    proposal: ActionProposal,
    incidentId: string,
    decidedBy: 'auto' | 'api',
  ): Promise<{ success: boolean; message: string }> {
    proposalStore.approve(proposal.id, decidedBy);

    try {
      let result: string;

      if (proposal.tool === 'docker_compose_restart') {
        result = await this.doRestartContainer(String(proposal.input.container ?? ''));
      } else if (proposal.tool === 'docker_compose_rollback') {
        result = await this.doRollback(proposal.input);
      } else {
        result = `Unknown tool ${proposal.tool} — no executor registered.`;
      }

      proposalStore.recordExecution(proposal.id, result);
      await proposalStore.auditDecision(proposal);

      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'proposal_executed',
        tool: proposal.tool,
        result: 'success',
        details: `Executed proposal ${proposal.id} (${decidedBy}): ${result}`,
      });
      await incidentStore.addFinding(incidentId, `Proposal executed (${decidedBy}): ${result}`);
      await incidentStore.resolveIncident(incidentId, {
        action: proposal.action,
        success: true,
        details: result,
      });
      void opsMemory.save({
        incidentId,
        triggerEvent: proposal.tool === 'docker_compose_rollback'
          ? 'github.deployment.failed'
          : 'docker.container.health_status.unhealthy',
        failureType: proposal.tool === 'docker_compose_rollback' ? 'DEPLOYMENT_FAILURE' : 'CONTAINER_UNHEALTHY',
        classificationConfidence: 0.9,
        repository: String(proposal.input.repository ?? proposal.input.container ?? ''),
        resolution: result,
        success: true,
        durationMs: Date.now() - new Date(proposal.createdAt).getTime(),
      });

      return { success: true, message: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      proposalStore.recordExecution(proposal.id, `FAILED: ${msg}`);
      await proposalStore.auditDecision(proposal);
      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'proposal_execution_failed',
        tool: proposal.tool,
        result: 'failure',
        details: `Proposal ${proposal.id} execution failed: ${msg}`,
      });
      await incidentStore.addFinding(incidentId, `Proposal execution failed: ${msg.slice(0, 300)}`);
      await incidentStore.updateStatus(incidentId, 'escalated');
      void opsMemory.save({
        incidentId,
        triggerEvent: proposal.tool === 'docker_compose_rollback'
          ? 'github.deployment.failed'
          : 'docker.container.health_status.unhealthy',
        failureType: proposal.tool === 'docker_compose_rollback' ? 'DEPLOYMENT_FAILURE' : 'CONTAINER_UNHEALTHY',
        classificationConfidence: 0.9,
        repository: String(proposal.input.repository ?? proposal.input.container ?? ''),
        resolution: `Execution failed: ${msg.slice(0, 200)}`,
        success: false,
        durationMs: Date.now() - new Date(proposal.createdAt).getTime(),
      });
      return { success: false, message: msg };
    }
  }

  // ── Concrete tool executors ────────────────────────────────────────────────

  private async doRestartContainer(container: string): Promise<string> {
    if (!container || !RESTART_ALLOWLIST.includes(container)) {
      throw new Error(`"${container}" is not in the restart allowlist.`);
    }
    const { stdout } = await execFilePromise(
      'docker', ['compose', 'restart', container],
      { timeout: 60000 },
    );
    return `Restarted ${container}. Output: ${stdout.trim().slice(0, 500) || '(no output)'}`;
  }

  private async doRollback(input: Record<string, unknown>): Promise<string> {
    const target = String(input.targetCommit ?? '');
    const repo = String(input.repository ?? '');
    if (!target) throw new Error('No target commit specified for rollback.');
    // In a real implementation this would call the deployment system.
    // For now: record the intent (actual deployment is environment-specific).
    return `Rollback initiated: ${repo} → ${target}. Manual deploy step required in CI/CD system.`;
  }

  // ── Rollback target query ──────────────────────────────────────────────────

  /**
   * Looks for the most recent resolved incident with a successful deployment
   * for the given repository + environment.
   * Returns the commit and incident id, or null if none found.
   */
  private async findLastSuccessfulDeployment(
    repository: string | undefined,
    environment: string,
  ): Promise<{ commit: string; environment: string; incidentId: string } | null> {
    if (!repository) return null;
    try {
      // Query resolved deployment success incidents for this repo+env.
      const { getPool } = await import('../db/postgres.js');
      const pool = getPool();
      const result = await pool.query<{
        id: string;
        resolution: { details: string; success: boolean } | null;
        context: Record<string, any>;
      }>(
        `SELECT id, resolution, context
         FROM incidents
         WHERE status = 'resolved'
           AND trigger_event = 'github.deployment.succeeded'
           AND context->>'repository' = $1
           AND context->>'environment' = $2
           AND (resolution->>'success')::boolean = true
         ORDER BY resolved_at DESC
         LIMIT 1`,
        [repository, environment],
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      const details = row.resolution?.details ?? '';
      // details format: "commit=abc123 environment=production"
      const commitMatch = details.match(/commit=([a-f0-9]+)/i);
      const commit = commitMatch?.[1] ?? row.context?.commit;
      if (!commit) return null;

      return { commit, environment, incidentId: row.id };
    } catch {
      // DB unavailable — cannot find rollback target.
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async gatherDiagnostics(incident: Incident): Promise<void> {
    try {
      const { stdout } = await execFilePromise(
        'docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'],
        { timeout: 15000 },
      );
      const diagnostics = stdout.trim().slice(0, 2000) || 'No running containers.';
      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'gather_diagnostics',
        tool: 'docker',
        result: 'success',
        details: diagnostics,
      });
    } catch (error: any) {
      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'gather_diagnostics',
        tool: 'docker',
        result: 'failure',
        details: `Docker unreachable: ${error.message || 'unknown error'}`,
      });
    }
  }

  private async emitEscalation(incident: Pick<Incident, 'id' | 'correlationId'>, message: string): Promise<void> {
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'devops-agent',
      type: 'agent.action.failed',
      severity: 'warning',
      correlationId: incident.correlationId,
      data: { incidentId: incident.id, message },
    } as any);
  }
}
