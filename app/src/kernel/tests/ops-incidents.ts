import assert from 'node:assert/strict';

import { MARKKernel } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';
import { incidentStore } from '../../core/incident';

const fakeIncidents: any[] = [
  {
    id: 'INC-1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T01:00:00Z'),
    title: 'Build failed: example/repo',
    description: 'workflow failed',
    severity: 'low',
    status: 'open',
    triggerEvent: 'github.workflow.failed',
    triggerEventId: 'GH-1',
    correlationId: 'example/repo',
    assignedAgent: 'git-agent',
    tags: [],
    context: {},
    actions: [{ timestamp: new Date(), agent: 'git-agent', action: 'triage', tool: 'x', result: 'success', details: 'ok' }],
  },
];

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  assert.ok(kernel.listTools().some(t => t.id === 'incident.list_open'), 'incident tools discovered');
  assert.ok(kernel.listTools().some(t => t.id === 'incident.get'), 'incident get discovered');

  const originalList = incidentStore.getOpenIncidents.bind(incidentStore);
  const originalGet = incidentStore.getIncident.bind(incidentStore);
  try {
    (incidentStore as any).getOpenIncidents = async () => fakeIncidents;
    (incidentStore as any).getIncident = async (id: string) => fakeIncidents.find(i => i.id === id) ?? null;

    const context = () =>
      kernel.createContext({ userId: 'ops-test', authorityProfile: 'default', source: 'system', metadata: {} });

    // A. List returns the open incidents.
    const listed = await kernel.execute(
      { id: 'ops-1', toolId: 'incident.list_open', input: {}, requestedBy: 'ops-test', createdAt: new Date().toISOString() },
      context(),
    );
    assert.equal(listed.status, 'succeeded');
    assert.equal((listed.output as any).count, 1);
    assert.equal((listed.output as any).incidents[0].id, 'INC-1');
    console.log('PASS (A): incident.list_open returns open incidents');

    // B. Get returns the incident with its action trail.
    const got = await kernel.execute(
      { id: 'ops-2', toolId: 'incident.get', input: { id: 'INC-1' }, requestedBy: 'ops-test', createdAt: new Date().toISOString() },
      context(),
    );
    assert.equal(got.status, 'succeeded');
    assert.equal((got.output as any).actionCount, 1);
    console.log('PASS (B): incident.get returns details and action count');

    // C. Unknown id fails honestly, missing id rejected.
    const missing = await kernel.execute(
      { id: 'ops-3', toolId: 'incident.get', input: { id: 'INC-NOPE' }, requestedBy: 'ops-test', createdAt: new Date().toISOString() },
      context(),
    );
    assert.equal(missing.status, 'failed');
    assert.match(missing.error ?? '', /not found/);
    console.log('PASS (C): unknown incident id fails honestly');
  } finally {
    (incidentStore as any).getOpenIncidents = originalList;
    (incidentStore as any).getIncident = originalGet;
  }

  console.log('PASS: ops incident tests complete');
}

main().catch(error => {
  console.error('FAIL: ops incident test');
  console.error(error);
  process.exitCode = 1;
});
