import assert from 'node:assert/strict';
import { AgentRuntime } from './agent-runtime';
import { EventBus, eventBus as globalBus } from './event-bus';
import { Gateway } from './gateway';
import { GitAgent } from '../agents/git-agent';
import { GitHubWebhookHandler } from '../webhooks/github';
import { incidentStore, Incident, IncidentAction } from './incident';
import { policyEngine } from './policies';
import { repositoryRegistry } from '../repositories/registry';

const run = async (): Promise<void> => {
  process.env.MARK_SMART = 'off';
  delete process.env.MARK_ENABLE_AUTOFIX;

  // Policies: reads are automatic, prod mutations need approval.
  assert.equal(policyEngine.evaluate({ agentName: 'git-agent', action: 'fetch_logs', risk: 'low' }), 'auto');
  assert.equal(policyEngine.evaluate({ agentName: 'git-agent', action: 'fetch_diff', risk: 'low' }), 'auto');
  assert.equal(
    policyEngine.evaluate({ agentName: 'devops-agent', action: 'restart', risk: 'medium', environment: 'production' }),
    'confirm',
  );

  repositoryRegistry.register({
    id: 'e2e/MARk',
    provider: 'github',
    owner: 'e2e',
    name: 'MARk',
    fullName: 'e2e/MARk',
    localPath: '/home/mwei/jarvis-core',
    defaultBranch: 'main',
    enabled: true,
    source: 'config',
  });

  // In-memory incident backend (no Postgres in test).
  const incidents = new Map<string, Incident>();
  const origCreate = incidentStore.createIncident.bind(incidentStore);
  const origFindOrCreate = incidentStore.findOrCreateIncident.bind(incidentStore);
  const origAdd = incidentStore.addAction.bind(incidentStore);
  const origFinding = incidentStore.addFinding.bind(incidentStore);
  const origStatus = incidentStore.updateStatus.bind(incidentStore);
  const origResolve = incidentStore.resolveIncident.bind(incidentStore);
  const origGet = incidentStore.getIncident.bind(incidentStore);

  (incidentStore as any).createIncident = async (input: any) => {
    const inc = { id: `INC-E2E-${incidents.size + 1}`, createdAt: new Date(), updatedAt: new Date(), actions: [], ...input };
    incidents.set(inc.id, inc);
    return inc;
  };
  (incidentStore as any).findOrCreateIncident = async (input: any) => {
    const existing = [...incidents.values()].find(inc =>
      inc.status !== 'resolved' && inc.correlationId === input.correlationId && inc.triggerEvent === input.triggerEvent);
    if (existing) return { ...existing, _wasCorrelated: true };
    const inc = await (incidentStore as any).createIncident({ ...input, status: 'investigating' });
    return { ...inc, _wasCorrelated: false };
  };
  (incidentStore as any).addAction = async (id: string, action: IncidentAction) => {
    incidents.get(id)?.actions.push(action);
  };
  (incidentStore as any).addFinding = async (id: string, finding: string) => {
    const inc = incidents.get(id);
    if (!inc) return;
    inc.investigation ??= { findings: [] };
    inc.investigation.findings ??= [];
    inc.investigation.findings.push(finding);
  };
  (incidentStore as any).updateStatus = async (id: string, status: Incident['status']) => {
    const inc = incidents.get(id);
    if (inc) inc.status = status;
  };
  (incidentStore as any).resolveIncident = async () => {};
  (incidentStore as any).getIncident = async (id: string) => incidents.get(id) ?? null;

  try {
    const bus = new EventBus();
    const gateway = new Gateway();
    const agents = new AgentRuntime();
    agents.registerAgent(new GitAgent());
    const unsubscribeAgents = bus.subscribeAll(event => agents.handleEvent(event));

    const escalations: any[] = [];
    bus.subscribe('agent.action.failed', async e => {
      escalations.push(e);
    });
    // GitAgent emits escalation on the singleton bus; observe both.
    const unsubGlobal = globalBus.subscribe('agent.action.failed', async e => {
      escalations.push(e);
    });

    const handler = new GitHubWebhookHandler(bus);
    const events = (handler as any).parseGitHubEvent('workflow_run', {
      repository: { id: 9, full_name: 'e2e/MARk' },
      workflow: { name: 'ci' },
      workflow_run: { id: 999, conclusion: 'failure', head_sha: 'abc123', head_branch: 'main', jobs_url: 'https://x/j', html_url: 'https://x/w' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'github.workflow.failed');

    const decision = gateway.classify(events[0]);
    assert.equal(decision.path, 'agent');
    assert.equal(decision.agent, 'git-agent');

    // Exercise the same awaited event path used by webhook handlers. The
    // assertion below must not run until the wildcard operational dispatcher
    // has finished the GitAgent investigation.
    await bus.emit(events[0]);

    assert.equal(incidents.size, 1);
    const inc = [...incidents.values()][0];
    assert.equal(inc.triggerEvent, 'github.workflow.failed');
    assert.equal(inc.assignedAgent, 'git-agent');
    assert.equal(inc.context.repository, 'e2e/MARk');
    // fetch_logs + fetch_diff + suggest_fix (+ auto_fix_deferred when auto-fixable)
    assert.ok(inc.actions.length >= 3, `expected >=3 actions, got ${inc.actions.length}`);
    assert.equal(inc.status, 'open');
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].data.incidentId, inc.id);

    // Approval loop is connected: request -> grant resolves true, request -> deny resolves false.
    const p1 = agents.requestApproval(inc.id, 'rollback', 'test');
    await agents.grantApproval(inc.id);
    assert.equal(await p1, true);

    const p2 = agents.requestApproval(inc.id, 'rollback', 'test');
    await agents.denyApproval(inc.id);
    assert.equal(await p2, false);

    console.log('PASS: github.workflow.failed -> git-agent -> incident + audit + escalation + approval.');
    unsubscribeAgents();
    unsubGlobal();
  } finally {
    (incidentStore as any).createIncident = origCreate;
    (incidentStore as any).findOrCreateIncident = origFindOrCreate;
    (incidentStore as any).addAction = origAdd;
    (incidentStore as any).addFinding = origFinding;
    (incidentStore as any).updateStatus = origStatus;
    (incidentStore as any).resolveIncident = origResolve;
    (incidentStore as any).getIncident = origGet;
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
