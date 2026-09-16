import assert from 'node:assert/strict';

import {
  KernelPlanner,
  MARKKernel,
  validatePlan,
} from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();
  const registry = (kernel as unknown as { toolRegistry: never }).toolRegistry as Parameters<typeof validatePlan>[1];
  const tools = kernel.listTools();

  const planner = new KernelPlanner({ toolRegistry: registry });

  // 1. A goal matching two native tools yields an explained 2-step chain.
  const plan = planner.planComposed(
    'Show local environment machine information and list the directory',
  );
  assert.equal(plan.steps.length, 2, `expected 2 steps, got ${JSON.stringify(plan.steps.map(s => s.toolId))}`);
  assert.ok(plan.explanation, 'expected an explanation of the connection');
  assert.deepEqual(plan.steps[1].dependsOn, [plan.steps[0].id]);

  const refs = JSON.stringify(plan.steps[1].input);
  assert.match(refs, /\$steps\./, 'consumer input should carry a step reference');

  const validation = validatePlan(plan, registry);
  assert.equal(validation.valid, true, `composed plan should validate: ${JSON.stringify(validation.errors)}`);

  // 2. End-to-end execution uses a producer whose output is genuinely a
  // directory path (type match alone cannot guarantee semantic fit —
  // e.g. hostname string is not a valid path — so the execution proof
  // uses an honest directory producer).
  kernel.registerTool({
    id: 'test.directory_producer',
    name: 'Directory producer',
    description: 'Produces a local directory path for directory listing workflows.',
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
    capabilities: ['directory', 'local-environment'],
    supportedResourceKinds: ['directory'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'composition-test',
  } as never);
  kernel.registerImplementation({
    toolId: 'test.directory_producer',
    async execute() {
      const output = { directory: process.cwd() };
      return {
        output,
        observations: [
          {
            id: `observation-${Date.now()}`,
            kind: 'file',
            source: 'composition-test',
            subject: output.directory,
            summary: `Produced directory ${output.directory}.`,
            data: output,
            confidence: 1,
            observedAt: new Date().toISOString(),
            relatedResourceIds: [],
          },
        ],
      };
    },
  });

  const directoryList = kernel.listTools().find(t => t.id === 'fs.directory_list')!;
  const directoryProducer = kernel.listTools().find(t => t.id === 'test.directory_producer')!;
  const execPlan = planner.planComposed(
    'Produce a local directory path and list the directory',
    [directoryProducer, directoryList],
  );
  assert.equal(execPlan.steps.length, 2);
  assert.equal(validatePlan(execPlan, registry).valid, true);

  const context = kernel.createContext({
    userId: 'composition-test',
    authorityProfile: 'default',
    source: 'system',
    metadata: {},
  });
  const report = await kernel.executePlanWithReport(execPlan, context);
  assert.equal(report.status, 'succeeded', `composed plan should execute: ${report.error ?? ''}`);

  // 3. Nonsense goal falls back gracefully (no crash, no bogus chain).
  const fallback = planner.planComposed('xyzzyqwack nonsense goal nothing matches here');
  assert.ok(fallback.steps.length <= 1, 'fallback should be 0-1 steps, never a bogus chain');

  // 4. Explicit tool list still works.
  const scoped = planner.planComposed(
    'Show local environment machine information and list the directory',
    tools,
  );
  assert.equal(scoped.steps.length, 2);

  console.log('PASS: plan composition (chain, explanation, execution, fallback)');
  console.log(`Chain: ${plan.steps[0].toolId} -> ${plan.steps[1].toolId}`);
  console.log(`Explanation: ${plan.explanation}`);
}

main().catch(error => {
  console.error('FAIL: plan composition');
  console.error(error);
  process.exitCode = 1;
});
