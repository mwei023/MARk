import assert from 'node:assert/strict';

import { MARKKernel, validatePlan } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  // Distinctive goal vocabulary so the shared memory singleton cannot
  // confuse this test with anything other tests saved.
  const TEACH_GOAL = 'Mileage drill: produce a zephyr directory path and list the zephyr directory';
  const RECALL_GOAL = 'Mileage drill recall: list the zephyr directory from the produced zephyr path';

  kernel.registerTool({
    id: 'test.zephyr_producer',
    name: 'Zephyr directory producer',
    description: 'Produces a zephyr directory path for zephyr listing drills.',
    version: '1.0.0',
    domain: 'testing',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: {
      type: 'object',
      properties: { directory: { type: 'string' } },
      required: ['directory'],
    },
    capabilities: ['zephyr', 'local-environment'],
    supportedResourceKinds: ['directory'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'mileage-test',
  } as never);
  kernel.registerImplementation({
    toolId: 'test.zephyr_producer',
    async execute() {
      const output = { directory: process.cwd() };
      return {
        output,
        observations: [
          {
            id: `observation-${Date.now()}`,
            kind: 'file',
            source: 'mileage-test',
            subject: output.directory,
            summary: `Produced zephyr directory ${output.directory}.`,
            data: output,
            confidence: 1,
            observedAt: new Date().toISOString(),
            relatedResourceIds: [],
          },
        ],
      };
    },
  });

  const registry = (kernel as unknown as { toolRegistry: Parameters<typeof validatePlan>[1] }).toolRegistry;
  const tools = kernel.listTools();
  const producer = tools.find(t => t.id === 'test.zephyr_producer')!;
  const directoryList = tools.find(t => t.id === 'fs.directory_list')!;

  // 1. Compose, validate, execute, then save the success as a workflow.
  const taught = kernel.planner.planComposed(TEACH_GOAL, [producer, directoryList]);
  assert.equal(taught.steps.length, 2);
  assert.equal(validatePlan(taught, registry).valid, true);

  const context = kernel.createContext({
    userId: 'mileage-test',
    authorityProfile: 'default',
    source: 'system',
    metadata: {},
  });
  const taughtReport = await kernel.executePlanWithReport(taught, context);
  assert.equal(taughtReport.status, 'succeeded', `teach plan failed: ${taughtReport.error ?? ''}`);

  const saved = kernel.saveWorkflow(taught);
  assert.ok(saved.id);
  assert.equal(saved.steps.length, 2);

  // 2. A paraphrased goal recalls the workflow and reuses it with fresh IDs.
  const recalled = kernel.recallWorkflows(RECALL_GOAL);
  assert.ok(recalled.length > 0, 'paraphrased goal should recall the workflow');
  assert.equal(recalled[0].id, saved.id);

  const reused = kernel.reuseWorkflow(RECALL_GOAL);
  assert.ok(reused, 'reuse should produce a plan');
  assert.notEqual(reused.plan.id, taught.id);
  assert.notDeepEqual(
    reused.plan.steps.map(s => s.id),
    taught.steps.map(s => s.id),
    'reused steps must carry fresh IDs',
  );
  assert.equal(validatePlan(reused.plan, registry).valid, true);

  const reusedReport = await kernel.executePlanWithReport(reused.plan, context);
  assert.equal(reusedReport.status, 'succeeded', `reused plan failed: ${reusedReport.error ?? ''}`);
  kernel.recordWorkflowOutcome(reused.workflowId, reusedReport.status === 'succeeded');

  const after = kernel.recallWorkflows(RECALL_GOAL)[0];
  assert.equal(after.useCount, 1);
  assert.equal(after.successCount, 1);

  // 3. Nonsense recalls nothing and reuses nothing.
  assert.equal(kernel.recallWorkflows('xyzzyqwack nothing matches this whatsoever').length, 0);
  assert.equal(kernel.reuseWorkflow('xyzzyqwack nothing matches this whatsoever'), undefined);

  console.log('PASS: mileage (teach, save, recall, reuse, execute, outcomes)');
  console.log(`Workflow ${saved.id}: useCount=${after.useCount} successCount=${after.successCount}`);
}

main().catch(error => {
  console.error('FAIL: mileage');
  console.error(error);
  process.exitCode = 1;
});
