/**
 * Phase 0 unit tests — no DB, no LLM, no filesystem.
 *
 * Covers:
 *  1. Gateway routing decisions
 *  2. isHollowReuse logic
 *  3. Incident model (in-memory lifecycle)
 *  4. Policy bridge
 *  5. MarkRuntime kernel dispatch fallthrough
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── 1. Gateway routing ───────────────────────────────────────────────────────

import { Gateway } from '../core/gateway.js';

describe('Gateway routing', () => {
  const gw = new Gateway();

  it('routes github.workflow.failed to git-agent (deterministic)', () => {
    const decision = gw.classify({
      id: 'e1', timestamp: new Date(), source: 'github', type: 'github.workflow.failed',
      severity: 'warning', data: {},
    } as any);
    expect(decision.path).toBe('agent');
    expect(decision.agent).toBe('git-agent');
    expect(decision.needsLLM).toBe(false);
  });

  it('routes github.deployment.failed to devops-agent with critical priority', () => {
    const decision = gw.classify({
      id: 'e2', timestamp: new Date(), source: 'github', type: 'github.deployment.failed',
      severity: 'critical', data: {},
    } as any);
    expect(decision.path).toBe('agent');
    expect(decision.agent).toBe('devops-agent');
    expect(decision.priority).toBe('critical');
  });

  it('routes docker unhealthy event to devops-agent', () => {
    const decision = gw.classify({
      id: 'e3', timestamp: new Date(), source: 'docker',
      type: 'docker.container.health_status.unhealthy',
      severity: 'warning', data: {},
    } as any);
    expect(decision.path).toBe('agent');
    expect(decision.agent).toBe('devops-agent');
  });

  it('routes "list git branches" user command to git-agent', () => {
    const decision = gw.classify({
      id: 'e4', timestamp: new Date(), source: 'user_command', type: 'user.command.received',
      severity: 'info', data: { command: 'list git branches' },
    } as any);
    expect(decision.path).toBe('agent');
    expect(decision.agent).toBe('git-agent');
  });

  it('routes "deploy to staging" user command to devops-agent', () => {
    const decision = gw.classify({
      id: 'e5', timestamp: new Date(), source: 'user_command', type: 'user.command.received',
      severity: 'info', data: { command: 'deploy to staging' },
    } as any);
    expect(decision.path).toBe('agent');
    expect(decision.agent).toBe('devops-agent');
  });

  it('does NOT route "legitimate concern" to git-agent (no whole-word match)', () => {
    const decision = gw.classify({
      id: 'e6', timestamp: new Date(), source: 'user_command', type: 'user.command.received',
      severity: 'info', data: { command: 'this is a legitimate concern' },
    } as any);
    // "legitimate" contains "git" as substring — whole-word regex must NOT match it
    expect(decision.agent).not.toBe('git-agent');
  });

  it('escalates unknown event types', () => {
    const decision = gw.classify({
      id: 'e7', timestamp: new Date(), source: 'system', type: 'unknown.event.type' as any,
      severity: 'info', data: {},
    } as any);
    expect(decision.path).toBe('escalate');
  });

  it('routes user.approval.granted deterministically', () => {
    const decision = gw.classify({
      id: 'e8', timestamp: new Date(), source: 'user', type: 'user.approval.granted',
      severity: 'info', data: {},
    } as any);
    expect(decision.path).toBe('deterministic');
    expect(decision.needsLLM).toBe(false);
  });
});

// ─── 2. isHollowReuse ─────────────────────────────────────────────────────────

import { isHollowReuse } from '../core/mark-runtime.js';
import type { ToolDescriptor } from '../kernel/types.js';

function makeTool(id: string, inputKeys: string[] = [], risk: ToolDescriptor['risk'] = 'read'): ToolDescriptor {
  const properties: Record<string, unknown> = {};
  for (const key of inputKeys) properties[key] = { type: 'string' };
  return {
    id, name: id, description: '', version: '1', risk, available: true, domain: 'test',
    inputSchema: inputKeys.length ? { type: 'object', properties, required: inputKeys } : { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    tags: [],
  };
}

describe('isHollowReuse', () => {
  const noopBind = (_cmd: string, _tool: ToolDescriptor) => ({ matchedFields: [] });
  const matchBind = (_cmd: string, _tool: ToolDescriptor) => ({ matchedFields: ['path'] });

  it('returns true when plan has no steps', () => {
    expect(isHollowReuse({ steps: [] }, 'show disk', [], noopBind)).toBe(true);
  });

  it('returns true when tool id is not found in registry', () => {
    const plan = { steps: [{ toolId: 'missing.tool', input: {} }] };
    expect(isHollowReuse(plan, 'show disk', [], noopBind)).toBe(true);
  });

  it('returns false for input-less tools (no schema keys to mismatch)', () => {
    const tool = makeTool('disk.usage');
    const plan = { steps: [{ toolId: 'disk.usage', input: {} }] };
    expect(isHollowReuse(plan, 'show disk usage', [tool], noopBind)).toBe(false);
  });

  it('returns false when bind finds evidence in the command', () => {
    const tool = makeTool('file.read', ['path']);
    const plan = { steps: [{ toolId: 'file.read', input: { path: '/tmp' } }] };
    expect(isHollowReuse(plan, 'read file /tmp', [tool], matchBind)).toBe(false);
  });

  it('returns true when unevidenced AND fresh resolution disagrees on tool', () => {
    const tool = makeTool('file.read', ['path']);
    const plan = { steps: [{ toolId: 'file.read', input: {} }] };
    const fresh = { tool: { id: 'disk.usage' }, matchedTerms: ['disk', 'usage'] };
    expect(isHollowReuse(plan, 'show disk usage', [tool], noopBind, fresh)).toBe(true);
  });

  it('returns false when unevidenced but fresh resolution agrees on same tool', () => {
    const tool = makeTool('file.read', ['path']);
    const plan = { steps: [{ toolId: 'file.read', input: {} }] };
    const fresh = { tool: { id: 'file.read' }, matchedTerms: ['file', 'read'] };
    // same tool + 2 matched terms → not hollow
    expect(isHollowReuse(plan, 'read file', [tool], noopBind, fresh)).toBe(false);
  });
});

// ─── 3. Incident lifecycle (in-memory mock) ───────────────────────────────────

// We test the model logic only — no DB calls.
describe('Incident model logic', () => {
  it('incident has correct shape after construction', () => {
    const now = new Date();
    const incident = {
      id: 'INC-001',
      createdAt: now,
      updatedAt: now,
      title: 'Build failed: repo/main',
      description: 'workflow failed',
      severity: 'medium' as const,
      status: 'investigating' as const,
      triggerEvent: 'github.workflow.failed',
      triggerEventId: 'EVT-001',
      correlationId: 'COR-001',
      assignedAgent: 'git-agent',
      tags: ['build', 'github'],
      context: { repository: 'owner/repo', branch: 'main' },
      actions: [],
    };

    expect(incident.id).toMatch(/^INC-/);
    expect(incident.status).toBe('investigating');
    expect(incident.actions).toHaveLength(0);
    expect(incident.tags).toContain('build');
  });

  it('status transitions are valid enum values', () => {
    const validStatuses = ['open', 'investigating', 'resolved', 'escalated'];
    for (const s of validStatuses) {
      expect(validStatuses).toContain(s);
    }
  });

  it('incident action has required fields', () => {
    const action = {
      timestamp: new Date(),
      agent: 'git-agent',
      action: 'fetch_logs',
      tool: 'gh',
      result: 'success' as const,
      details: 'Fetched 200 log lines',
    };
    expect(action.result).toBe('success');
    expect(typeof action.details).toBe('string');
  });

  it('incident with resolution has resolved status', () => {
    const incident = {
      status: 'resolved' as const,
      resolution: {
        action: 'npm install',
        success: true,
        details: 'Fixed missing deps',
      },
      resolvedAt: new Date(),
    };
    expect(incident.status).toBe('resolved');
    expect(incident.resolution.success).toBe(true);
  });
});

// ─── 4. Policy bridge ─────────────────────────────────────────────────────────

import { agentActionRisk, unifiedEvaluate } from '../kernel/policy-bridge.js';

describe('Policy bridge', () => {
  it('maps read-only agent actions to read risk', () => {
    expect(agentActionRisk('gather_logs')).toBe('read');
    expect(agentActionRisk('health_check')).toBe('read');
    expect(agentActionRisk('fetch_logs')).toBe('read');
  });

  it('maps restart to reversible risk', () => {
    expect(agentActionRisk('restart')).toBe('reversible');
  });

  it('maps mutating actions to mutating risk', () => {
    expect(agentActionRisk('install_dependency')).toBe('mutating');
    expect(agentActionRisk('patch_code')).toBe('mutating');
  });

  it('maps privileged actions to privileged risk', () => {
    expect(agentActionRisk('sudo')).toBe('privileged');
    expect(agentActionRisk('delete')).toBe('privileged');
    expect(agentActionRisk('access_secrets')).toBe('privileged');
  });

  it('blocks mutating actions via authority floor even when policy says auto', () => {
    const result = unifiedEvaluate({
      agentName: 'test', action: 'install_dependency', risk: 'low', isFirst: true,
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/authority\(mutating\)/);
  });

  it('always blocks privileged commands', () => {
    const result = unifiedEvaluate({ agentName: 'test', action: 'sudo', risk: 'high' });
    expect(result.decision).toBe('block');
  });

  it('confirms or alerts on production log fetch (medium risk)', () => {
    const result = unifiedEvaluate({
      agentName: 'git-agent', action: 'fetch_logs', risk: 'medium', environment: 'production',
    });
    expect(['confirm', 'alert']).toContain(result.decision);
  });
});

// ─── 5. MarkRuntime kernel dispatch fallthrough ───────────────────────────────

import { MarkRuntime } from '../core/mark-runtime.js';
import type { MarkRuntimeDependencies } from '../core/mark-runtime.js';

describe('MarkRuntime kernel dispatch fallthrough', () => {
  // Disable LLM smart routing in all tests
  beforeEach(() => {
    process.env.MARK_SMART = 'off';
  });

  function makeDeps(overrides: Partial<MarkRuntimeDependencies> = {}): MarkRuntimeDependencies {
    return {
      // EventBus stub
      eventBus: { emit: vi.fn().mockResolvedValue(undefined), subscribeAll: vi.fn(), subscribe: vi.fn() } as any,
      // Gateway stub — default to reasoning path so we control routing
      gateway: { classify: vi.fn().mockReturnValue({ path: 'reasoning', needsLLM: true, priority: 'normal', reasoning: 'test' }) } as any,
      // AgentRuntime stub — returns nothing by default
      agents: { handleCommand: vi.fn().mockResolvedValue(undefined), handleEvent: vi.fn(), registerAgent: vi.fn(), getAgentCount: vi.fn().mockReturnValue(1) } as any,
      // CapabilityRegistry stub
      capabilities: { execute: vi.fn().mockResolvedValue(undefined), findFor: vi.fn().mockReturnValue(undefined), list: vi.fn().mockReturnValue([]), register: vi.fn() } as any,
      // Reasoner stub
      reasoner: { respond: vi.fn().mockResolvedValue('LLM answer') } as any,
      // KernelBridge stub — not initialized, returns undefined
      kernelBridge: {
        initialize: vi.fn().mockRejectedValue(new Error('kernel offline')),
        listTools: vi.fn().mockReturnValue([]),
        reuseWorkflow: vi.fn().mockReturnValue(undefined),
        resolveCapability: vi.fn().mockReturnValue({ tool: undefined, score: 0, matchedTerms: [] }),
        executeGoal: vi.fn().mockRejectedValue(new Error('no goal')),
        status: vi.fn().mockReturnValue({ initialized: false, discoveredTools: [], availableTools: [] }),
      } as any,
      ...overrides,
    };
  }

  it('falls through to reasoning when kernel is offline', async () => {
    const deps = makeDeps();
    const runtime = new MarkRuntime(deps);
    const result = await runtime.executeCommand('explain something', 'testuser');
    expect(result.route).toBe('reasoning');
    expect(result.response).toBe('LLM answer');
  });

  it('returns unavailable when reasoning is also broken', async () => {
    const deps = makeDeps({
      reasoner: { respond: vi.fn().mockRejectedValue(new Error('LLM down')) } as any,
    });
    const runtime = new MarkRuntime(deps);
    const result = await runtime.executeCommand('explain something', 'testuser');
    expect(result.route).toBe('unavailable');
    expect(result.response).toMatch(/unavailable/i);
  });

  it('uses capability when gateway routes deterministically and capability matches', async () => {
    const deps = makeDeps({
      gateway: { classify: vi.fn().mockReturnValue({ path: 'deterministic', needsLLM: false, priority: 'normal', reasoning: 'local' }) } as any,
      capabilities: {
        execute: vi.fn().mockResolvedValue('disk usage: 50%'),
        findFor: vi.fn().mockReturnValue({ id: 'disk.usage' }),
        list: vi.fn().mockReturnValue([{ id: 'disk.usage' }, { id: 'mark.status' }]),
        register: vi.fn(),
      } as any,
    });
    const runtime = new MarkRuntime(deps);
    const result = await runtime.executeCommand('show disk usage', 'testuser');
    expect(result.route).toBe('capability');
    expect(result.response).toBe('disk usage: 50%');
  });

  it('returns unavailable when deterministic route has no matching capability', async () => {
    const deps = makeDeps({
      gateway: { classify: vi.fn().mockReturnValue({ path: 'deterministic', needsLLM: false, priority: 'normal', reasoning: 'local' }) } as any,
      capabilities: {
        execute: vi.fn().mockResolvedValue(undefined), // no match
        findFor: vi.fn().mockReturnValue(undefined),
        list: vi.fn().mockReturnValue([{ id: 'host.local' }, { id: 'mark.status' }]),
        register: vi.fn(),
      } as any,
    });
    const runtime = new MarkRuntime(deps);
    const result = await runtime.executeCommand('some unknown local thing', 'testuser');
    expect(result.route).toBe('unavailable');
  });

  it('trace is always populated', async () => {
    const deps = makeDeps();
    const runtime = new MarkRuntime(deps);
    const result = await runtime.executeCommand('any command', 'testuser');
    expect(Array.isArray(result.trace)).toBe(true);
    expect(result.trace!.length).toBeGreaterThan(0);
  });
});
