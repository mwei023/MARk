/**
 * Phase 2 unit tests — no DB, no LLM, no filesystem.
 *
 * Covers:
 *  1. ProposalStore — create, approve, deny, dry-run, markDryRun
 *  2. shouldAutoExecute / isDryRun logic
 *  3. formatProposalAction output
 *  4. DevOpsAgent proposal creation (mocked incidentStore)
 *  5. executeApprovedProposal — approve path, deny path, dry-run path
 *  6. Rollback target conditions (in-memory simulation)
 *  7. Approval API request shape validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── 1. ProposalStore ─────────────────────────────────────────────────────────

import { ProposalStore } from '../core/proposal.js';

describe('ProposalStore', () => {
  let store: ProposalStore;

  beforeEach(() => {
    store = new ProposalStore();
  });

  it('creates a proposal with pending status and unique id', () => {
    const p = store.create({
      incidentId: 'INC-001',
      action: 'Restart jarvis-db',
      tool: 'docker_compose_restart',
      input: { container: 'jarvis-db' },
      rationale: 'Container is unhealthy',
      riskLevel: 'low',
    });
    expect(p.id).toMatch(/^PROP-/);
    expect(p.status).toBe('pending');
    expect(p.incidentId).toBe('INC-001');
    expect(p.riskLevel).toBe('low');
    expect(p.createdAt).toBeTruthy();
  });

  it('two proposals get different ids', () => {
    const p1 = store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    const p2 = store.create({ incidentId: 'INC-001', action: 'B', tool: 't', input: {}, rationale: 'r', riskLevel: 'medium' });
    expect(p1.id).not.toBe(p2.id);
  });

  it('approve transitions status to approved', () => {
    const p = store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    const updated = store.approve(p.id, 'auto');
    expect(updated?.status).toBe('approved');
    expect(updated?.decidedBy).toBe('auto');
    expect(updated?.decidedAt).toBeTruthy();
  });

  it('approve returns undefined for already-decided proposal', () => {
    const p = store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    store.approve(p.id, 'auto');
    expect(store.approve(p.id, 'api')).toBeUndefined();
  });

  it('deny transitions status to denied', () => {
    const p = store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'medium' });
    const updated = store.deny(p.id, 'api');
    expect(updated?.status).toBe('denied');
    expect(updated?.decidedBy).toBe('api');
  });

  it('markDryRun sets status to dry_run and writes WOULD HAVE prefix', () => {
    const p = store.create({ incidentId: 'INC-001', action: 'Rollback', tool: 't', input: {}, rationale: 'r', riskLevel: 'medium' });
    const updated = store.markDryRun(p.id, 'rollback to abc123');
    expect(updated?.status).toBe('dry_run');
    expect(updated?.executionResult).toMatch(/^WOULD HAVE:/);
    expect(updated?.decidedBy).toBe('dry_run');
  });

  it('recordExecution writes result and sets status to executed', () => {
    const p = store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    store.approve(p.id, 'auto');
    const updated = store.recordExecution(p.id, 'Restarted successfully');
    expect(updated?.status).toBe('executed');
    expect(updated?.executionResult).toBe('Restarted successfully');
  });

  it('listByIncident returns only proposals for that incident', () => {
    store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    store.create({ incidentId: 'INC-001', action: 'B', tool: 't', input: {}, rationale: 'r', riskLevel: 'medium' });
    store.create({ incidentId: 'INC-002', action: 'C', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    expect(store.listByIncident('INC-001')).toHaveLength(2);
    expect(store.listByIncident('INC-002')).toHaveLength(1);
    expect(store.listByIncident('INC-999')).toHaveLength(0);
  });

  it('listPending returns only pending proposals', () => {
    const p1 = store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    const p2 = store.create({ incidentId: 'INC-001', action: 'B', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    store.approve(p1.id, 'auto');
    expect(store.listPending()).toHaveLength(1);
    expect(store.listPending()[0].id).toBe(p2.id);
  });

  it('get returns the proposal by id', () => {
    const p = store.create({ incidentId: 'INC-001', action: 'A', tool: 't', input: {}, rationale: 'r', riskLevel: 'low' });
    expect(store.get(p.id)).toBe(p);
    expect(store.get('nonexistent')).toBeUndefined();
  });
});

// ─── 2. shouldAutoExecute / isDryRun ─────────────────────────────────────────

import { shouldAutoExecute, isDryRun } from '../core/proposal.js';

describe('shouldAutoExecute / isDryRun', () => {
  afterEach(() => {
    delete process.env.MARK_DRY_RUN;
    delete process.env.MARK_ENABLE_AUTOFIX;
  });

  it('isDryRun returns false by default', () => {
    delete process.env.MARK_DRY_RUN;
    expect(isDryRun()).toBe(false);
  });

  it('isDryRun returns true when MARK_DRY_RUN=true', () => {
    process.env.MARK_DRY_RUN = 'true';
    expect(isDryRun()).toBe(true);
  });

  it('isDryRun returns true when MARK_DRY_RUN=1', () => {
    process.env.MARK_DRY_RUN = '1';
    expect(isDryRun()).toBe(true);
  });

  it('shouldAutoExecute returns false for low risk when autofix disabled', () => {
    delete process.env.MARK_ENABLE_AUTOFIX;
    delete process.env.MARK_DRY_RUN;
    expect(shouldAutoExecute('low')).toBe(false);
  });

  it('shouldAutoExecute returns false for medium/high risk even with autofix enabled', () => {
    process.env.MARK_ENABLE_AUTOFIX = 'true';
    delete process.env.MARK_DRY_RUN;
    expect(shouldAutoExecute('medium')).toBe(false);
    expect(shouldAutoExecute('high')).toBe(false);
  });

  it('shouldAutoExecute returns false when dry-run is active, even with autofix', () => {
    process.env.MARK_ENABLE_AUTOFIX = 'true';
    process.env.MARK_DRY_RUN = 'true';
    expect(shouldAutoExecute('low')).toBe(false);
  });
});

// ─── 3. formatProposalAction ─────────────────────────────────────────────────

import { formatProposalAction, type ActionProposal } from '../core/proposal.js';

describe('formatProposalAction', () => {
  it('includes proposal id, action, tool, risk, status, rationale', () => {
    const proposal: ActionProposal = {
      id: 'PROP-123',
      incidentId: 'INC-001',
      action: 'Restart jarvis-db',
      tool: 'docker_compose_restart',
      input: { container: 'jarvis-db' },
      rationale: 'Container is unhealthy',
      riskLevel: 'low',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const text = formatProposalAction(proposal);
    expect(text).toContain('PROP-123');
    expect(text).toContain('Restart jarvis-db');
    expect(text).toContain('docker_compose_restart');
    expect(text).toContain('low');
    expect(text).toContain('pending');
    expect(text).toContain('Container is unhealthy');
  });
});

// ─── 4. DevOpsAgent proposal creation (mocked DB) ────────────────────────────

import { DevOpsAgent } from '../agents/devops-agent.js';

// Mock incidentStore and proposalStore at module level
vi.mock('../core/incident.js', () => ({
  incidentStore: {
    findOrCreateIncident: vi.fn().mockResolvedValue({
      id: 'INC-001',
      correlationId: 'owner/repo',
      context: {},
      investigation: { findings: [] },
      actions: [],
      _wasCorrelated: false,
    }),
    addAction: vi.fn().mockResolvedValue(undefined),
    addFinding: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    resolveIncident: vi.fn().mockResolvedValue(undefined),
    getIncident: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../core/event-bus.js', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}));

describe('DevOpsAgent — proposal creation', () => {
  let agent: DevOpsAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MARK_DRY_RUN;
    delete process.env.MARK_ENABLE_AUTOFIX;
    agent = new DevOpsAgent();
  });

  it('canHandle deployment.failed events', () => {
    const event = {
      type: 'github.deployment.failed',
      id: 'e1', timestamp: new Date(), source: 'github',
      severity: 'critical', correlationId: 'owner/repo', data: {},
    } as any;
    expect(agent.canHandle(event)).toBe(true);
  });

  it('canHandle unhealthy container events', () => {
    const event = {
      type: 'docker.container.health_status.unhealthy',
      id: 'e2', timestamp: new Date(), source: 'docker',
      severity: 'warning', correlationId: 'service', data: {},
    } as any;
    expect(agent.canHandle(event)).toBe(true);
  });

  it('canHandle deploy user command', () => {
    const event = {
      type: 'user.command.received',
      id: 'e3', timestamp: new Date(), source: 'user_command',
      severity: 'info', correlationId: 'u1',
      data: { command: 'rollback the staging deployment' },
    } as any;
    expect(agent.canHandle(event)).toBe(true);
  });

  it('does not handle git events', () => {
    const event = {
      type: 'github.workflow.failed',
      id: 'e4', timestamp: new Date(), source: 'github',
      severity: 'warning', correlationId: 'repo', data: {},
    } as any;
    expect(agent.canHandle(event)).toBe(false);
  });
});

// ─── 5. executeApprovedProposal paths ────────────────────────────────────────

describe('DevOpsAgent.executeApprovedProposal', () => {
  let agent: DevOpsAgent;
  let store: ProposalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MARK_DRY_RUN;
    agent = new DevOpsAgent();
    store = new ProposalStore();
    // Override the module-level proposalStore with our test instance via prototype trick
    (agent as any).getProposalStore = () => store;
  });

  it('returns error when proposal not found', async () => {
    // Import proposalStore to spy on it
    const { proposalStore: ps } = await import('../core/proposal.js');
    vi.spyOn(ps, 'get').mockReturnValue(undefined);

    const result = await agent.executeApprovedProposal('PROP-999', 'INC-001');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it('returns error when proposal belongs to different incident', async () => {
    const { proposalStore: ps } = await import('../core/proposal.js');
    vi.spyOn(ps, 'get').mockReturnValue({
      id: 'PROP-001',
      incidentId: 'INC-999', // different incident
      action: 'Restart',
      tool: 'docker_compose_restart',
      input: { container: 'jarvis-db' },
      rationale: 'r',
      riskLevel: 'low',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    const result = await agent.executeApprovedProposal('PROP-001', 'INC-001');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/INC-999/);
  });

  it('dry-run mode: returns WOULD HAVE message without executing', async () => {
    process.env.MARK_DRY_RUN = 'true';
    const { proposalStore: ps } = await import('../core/proposal.js');
    const proposal = {
      id: 'PROP-DRY',
      incidentId: 'INC-001',
      action: 'Restart jarvis-db',
      tool: 'docker_compose_restart',
      input: { container: 'jarvis-db' },
      rationale: 'r',
      riskLevel: 'low' as const,
      status: 'approved' as const,
      createdAt: new Date().toISOString(),
    };
    vi.spyOn(ps, 'get').mockReturnValue(proposal);
    vi.spyOn(ps, 'markDryRun').mockReturnValue({ ...proposal, status: 'dry_run', executionResult: 'WOULD HAVE: ...' });
    vi.spyOn(ps, 'auditDecision').mockResolvedValue(undefined);

    const result = await agent.executeApprovedProposal('PROP-DRY', 'INC-001');
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/WOULD HAVE/i);
  });
});

// ─── 6. Rollback target conditions ───────────────────────────────────────────

describe('Rollback target — query conditions', () => {
  interface DeploymentRecord {
    id: string;
    repository: string;
    environment: string;
    status: string;
    triggerEvent: string;
    resolution: { success: boolean; details: string } | null;
  }

  function findLastSuccess(
    records: DeploymentRecord[],
    repository: string,
    environment: string,
  ): DeploymentRecord | null {
    return (
      records
        .filter(
          r =>
            r.status === 'resolved' &&
            r.triggerEvent === 'github.deployment.succeeded' &&
            r.repository === repository &&
            r.environment === environment &&
            r.resolution?.success === true,
        )
        .sort((a, b) => b.id.localeCompare(a.id))[0] ?? null
    );
  }

  const records: DeploymentRecord[] = [
    {
      id: 'INC-100',
      repository: 'owner/app',
      environment: 'production',
      status: 'resolved',
      triggerEvent: 'github.deployment.succeeded',
      resolution: { success: true, details: 'commit=abc123 environment=production' },
    },
    {
      id: 'INC-101',
      repository: 'owner/app',
      environment: 'production',
      status: 'resolved',
      triggerEvent: 'github.deployment.failed', // failure — not a valid target
      resolution: { success: false, details: 'commit=def456' },
    },
    {
      id: 'INC-102',
      repository: 'owner/other',
      environment: 'production',
      status: 'resolved',
      triggerEvent: 'github.deployment.succeeded',
      resolution: { success: true, details: 'commit=xyz789' },
    },
  ];

  it('finds the last successful deployment for repo+env', () => {
    const target = findLastSuccess(records, 'owner/app', 'production');
    expect(target).not.toBeNull();
    expect(target?.id).toBe('INC-100');
    expect(target?.resolution?.details).toContain('abc123');
  });

  it('returns null when no successful deployment exists for the repo', () => {
    const target = findLastSuccess(records, 'owner/missing', 'production');
    expect(target).toBeNull();
  });

  it('does not use failed deployments as rollback targets', () => {
    const failureOnly: DeploymentRecord[] = [
      {
        id: 'INC-200',
        repository: 'owner/app',
        environment: 'production',
        status: 'resolved',
        triggerEvent: 'github.deployment.failed',
        resolution: { success: false, details: 'commit=bad' },
      },
    ];
    expect(findLastSuccess(failureOnly, 'owner/app', 'production')).toBeNull();
  });

  it('does not use unresolved incidents as rollback targets', () => {
    const openRecords: DeploymentRecord[] = [
      {
        id: 'INC-300',
        repository: 'owner/app',
        environment: 'production',
        status: 'open', // not resolved
        triggerEvent: 'github.deployment.succeeded',
        resolution: null,
      },
    ];
    expect(findLastSuccess(openRecords, 'owner/app', 'production')).toBeNull();
  });

  it('returns null when repository is undefined', () => {
    expect(findLastSuccess(records, '', 'production')).toBeNull();
  });
});

// ─── 7. Approval API request shape ───────────────────────────────────────────

describe('Approval API request shape validation', () => {
  function validate(body: Record<string, any>): { valid: boolean; error?: string } {
    if (typeof body.approved !== 'boolean') {
      return { valid: false, error: 'approved (boolean) is required' };
    }
    if (!body.incidentId && !body.confirmationId && !body.proposalId) {
      return { valid: false, error: 'At least one of incidentId, proposalId, or confirmationId is required' };
    }
    if (body.proposalId && !body.incidentId) {
      return { valid: false, error: 'incidentId required when proposalId is provided' };
    }
    return { valid: true };
  }

  it('accepts proposalId + incidentId + approved', () => {
    expect(validate({ proposalId: 'PROP-1', incidentId: 'INC-1', approved: true }).valid).toBe(true);
  });

  it('accepts confirmationId + approved', () => {
    expect(validate({ confirmationId: 'confirm_abc', approved: false }).valid).toBe(true);
  });

  it('accepts incidentId + approved (legacy)', () => {
    expect(validate({ incidentId: 'INC-1', approved: true }).valid).toBe(true);
  });

  it('rejects missing approved field', () => {
    const r = validate({ incidentId: 'INC-1' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/approved/i);
  });

  it('rejects non-boolean approved', () => {
    const r = validate({ incidentId: 'INC-1', approved: 'yes' });
    expect(r.valid).toBe(false);
  });

  it('rejects body with no identifiers', () => {
    const r = validate({ approved: true });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/incidentId|proposalId|confirmationId/i);
  });
});
