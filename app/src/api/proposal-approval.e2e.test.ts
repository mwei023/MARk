import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { incidentStore } from '../core/incident.js';
import { opsMemory } from '../core/ops-memory.js';
import { proposalStore } from '../core/proposal.js';
import { agentRuntime } from '../core/agent-runtime.js';

describe('proposal approval API', () => {
  let server: Server;
  let baseUrl: string;
  let app: any;
  const resolved: Array<{ incidentId: string; details: string }> = [];
  const actions: Array<{ incidentId: string; action: string; details: string }> = [];
  const findings: Array<{ incidentId: string; finding: string }> = [];
  const verified: string[] = [];
  const incidents = new Map<string, any>();
  let originalFindOrCreate: any;
  let originalUpdateStatus: any;
  let originalDevOpsLookup: any;
  let originalWorkflowLookup: any;
  let originalMarkVerified: any;

  beforeAll(async () => {
    process.env.MARK_NO_SERVER = 'true';
    ({ app } = await import('./server-v2.js'));
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Keep this HTTP test hermetic: proposals live in the process cache and
    // incident mutations are captured below instead of requiring Postgres.
    (proposalStore as any).loadedFromDb = true;
    (opsMemory as any).save = async () => undefined;
    originalWorkflowLookup = opsMemory.findUnverifiedForWorkflow.bind(opsMemory);
    originalMarkVerified = opsMemory.markVerified.bind(opsMemory);
    (opsMemory as any).findUnverifiedForWorkflow = async (_repository: string, _branch?: string, commit?: string) =>
      commit === 'abc123' ? 'INC-HTTP-10' : undefined;
    (opsMemory as any).markVerified = async (incidentId: string) => {
      verified.push(incidentId);
    };
    originalFindOrCreate = incidentStore.findOrCreateIncident.bind(incidentStore);
    originalUpdateStatus = incidentStore.updateStatus.bind(incidentStore);
    (incidentStore as any).findOrCreateIncident = async (input: any) => {
      const incident = {
        id: `INC-HTTP-${incidents.size + 10}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        actions: [],
        ...input,
      };
      incidents.set(incident.id, incident);
      return { ...incident, _wasCorrelated: false };
    };
    (incidentStore as any).addAction = async (incidentId: string, action: any) => {
      actions.push({ incidentId, action: action.action, details: action.details });
    };
    (incidentStore as any).addFinding = async (incidentId: string, finding: string) => {
      findings.push({ incidentId, finding });
    };
    (incidentStore as any).resolveIncident = async (incidentId: string, resolution: any) => {
      resolved.push({ incidentId, details: resolution.details });
      const incident = incidents.get(incidentId);
      if (incident) incident.status = 'resolved';
    };
    (incidentStore as any).updateStatus = async (incidentId: string, status: string) => {
      const incident = incidents.get(incidentId);
      if (incident) incident.status = status;
    };

    const devOps = agentRuntime.getAgent('devops-agent') as any;
    if (!devOps) throw new Error('DevOpsAgent was not registered');
    originalDevOpsLookup = devOps.findLastSuccessfulDeployment;
    devOps.findLastSuccessfulDeployment = async () => ({
      commit: 'abc123',
      environment: 'production',
      incidentId: 'INC-KNOWN-GOOD',
    });
  });

  afterEach(() => {
    resolved.length = 0;
    actions.length = 0;
    findings.length = 0;
    incidents.clear();
    verified.length = 0;
  });

  afterAll(async () => {
    (incidentStore as any).findOrCreateIncident = originalFindOrCreate;
    (incidentStore as any).updateStatus = originalUpdateStatus;
    (opsMemory as any).findUnverifiedForWorkflow = originalWorkflowLookup;
    (opsMemory as any).markVerified = originalMarkVerified;
    const devOps = agentRuntime.getAgent('devops-agent') as any;
    if (devOps && originalDevOpsLookup) devOps.findLastSuccessfulDeployment = originalDevOpsLookup;
    delete process.env.MARK_NO_SERVER;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function approve(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const response = await fetch(`${baseUrl}/api/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }

  it('routes a GitHub deployment failure into a rollback proposal and approval', async () => {
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'deployment_status' },
      body: JSON.stringify({
        repository: { id: 9, full_name: 'owner/api' },
        deployment: { id: 77, environment: 'production', sha: 'def456' },
        deployment_status: { state: 'failure', description: 'release failed' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'received' });

    const incident = [...incidents.values()][0];
    expect(incident?.triggerEvent).toBe('github.deployment.failed');
    const proposal = proposalStore.listByIncident(incident.id)[0];
    expect(proposal?.status).toBe('pending');
    expect(proposal?.input.targetCommit).toBe('abc123');

    const result = await approve({ incidentId: incident.id, proposalId: proposal.id, approved: true });
    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(proposalStore.get(proposal.id)?.status).toBe('executed');
    expect(incident.status).toBe('resolved');

    const completion = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run' },
      body: JSON.stringify({
        repository: { id: 9, full_name: 'owner/api' },
        workflow: { name: 'deploy' },
        workflow_run: { id: 78, conclusion: 'success', head_sha: 'abc123', head_branch: 'main' },
      }),
    });
    expect(completion.status).toBe(200);
    expect(verified).toEqual(['INC-HTTP-10']);
  });

  it('approves, executes, audits, and resolves a rollback proposal', async () => {
    const proposal = proposalStore.create({
      incidentId: 'INC-HTTP-1',
      action: 'Rollback owner/api to commit abc123',
      tool: 'docker_compose_rollback',
      input: { repository: 'owner/api', environment: 'production', targetCommit: 'abc123' },
      rationale: 'Last known-good deployment',
      riskLevel: 'medium',
    });

    const result = await approve({ incidentId: 'INC-HTTP-1', proposalId: proposal.id, approved: true });

    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(result.json.execution.message).toMatch(/Rollback initiated/);
    expect(proposalStore.get(proposal.id)?.status).toBe('executed');
    expect(resolved).toEqual([{ incidentId: 'INC-HTTP-1', details: expect.stringContaining('abc123') }]);
    expect(actions.some(action => action.action === 'proposal_executed')).toBe(true);
    expect(findings.some(finding => finding.finding.includes('Proposal executed'))).toBe(true);
  });

  it('denies a proposal without executing or resolving it', async () => {
    const proposal = proposalStore.create({
      incidentId: 'INC-HTTP-2',
      action: 'Rollback owner/api to commit def456',
      tool: 'docker_compose_rollback',
      input: { repository: 'owner/api', environment: 'production', targetCommit: 'def456' },
      rationale: 'test denial',
      riskLevel: 'medium',
    });

    const result = await approve({ incidentId: 'INC-HTTP-2', proposalId: proposal.id, approved: false });

    expect(result.status).toBe(200);
    expect(result.json.proposal.status).toBe('denied');
    expect(resolved).toHaveLength(0);
    expect(actions.some(action => action.action === 'proposal_denied')).toBe(true);
  });
});
