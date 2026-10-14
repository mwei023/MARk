import assert from 'node:assert/strict';

import {
  MARKKernel,
  scoreCompatibility,
  validatePlan,
} from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();
  const registry = (kernel as unknown as { toolRegistry: Parameters<typeof validatePlan>[1] }).toolRegistry;

  // 1. Declared output path passes validation.
  const good = validatePlan(
    {
      id: 'plan-compat-good',
      goal: 'Read hostname then list its directory',
      steps: [
        { id: 'producer', toolId: 'system.machine_info', input: {}, dependsOn: [] },
        {
          id: 'consumer',
          toolId: 'fs.directory_list',
          input: { path: '$steps.producer.output.hostname' },
          dependsOn: ['producer'],
        },
      ],
      successCriteria: [],
    },
    registry,
  );
  assert.equal(good.valid, true, `declared path should validate: ${JSON.stringify(good.errors)}`);

  // 2. Undeclared output path fails with a clear code.
  const bad = validatePlan(
    {
      id: 'plan-compat-bad',
      goal: 'Reference a field that does not exist',
      steps: [
        { id: 'producer', toolId: 'system.machine_info', input: {}, dependsOn: [] },
        {
          id: 'consumer',
          toolId: 'fs.directory_list',
          input: { path: '$steps.producer.output.no_such_field' },
          dependsOn: ['producer'],
        },
      ],
      successCriteria: [],
    },
    registry,
  );
  assert.equal(bad.valid, false);
  assert.ok(
    bad.errors.some(e => e.code === 'UNDECLARED_OUTPUT_PATH'),
    `expected UNDECLARED_OUTPUT_PATH, got ${JSON.stringify(bad.errors)}`,
  );

  // 3. Reference to an unknown step fails.
  const missing = validatePlan(
    {
      id: 'plan-compat-missing',
      goal: 'Reference a step that is not in the plan',
      steps: [
        {
          id: 'only',
          toolId: 'fs.directory_list',
          input: { path: '$steps.ghost.output.hostname' },
          dependsOn: [],
        },
      ],
      successCriteria: [],
    },
    registry,
  );
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(e => e.code === 'MISSING_DEPENDENCY'));

  // 4. Compatibility scoring is type-driven, not app-driven.
  assert.deepEqual(scoreCompatibility({ type: 'string' }, { type: 'string' }).compatible, true);
  assert.deepEqual(scoreCompatibility({ type: 'string' }, { type: 'number' }).compatible, false);
  assert.deepEqual(scoreCompatibility({ type: 'unknown' }, { type: 'string' }).compatible, true);

  // 5. Schemaless producer warns instead of failing (backward compatible).
  kernel.registerTool({
    id: 'test.schemaless',
    name: 'Schemaless probe',
    description: 'No output contract.',
    version: '1.0.0',
    domain: 'testing',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    capabilities: ['testing'],
    supportedResourceKinds: ['unknown'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'compat-test',
  } as never);
  const schemaless = validatePlan(
    {
      id: 'plan-compat-schemaless',
      goal: 'Ref a schemaless producer',
      steps: [
        { id: 'producer', toolId: 'test.schemaless', input: {}, dependsOn: [] },
        {
          id: 'consumer',
          toolId: 'fs.directory_list',
          input: { path: '$steps.producer.output.anything' },
          dependsOn: ['producer'],
        },
      ],
      successCriteria: [],
    },
    registry,
  );
  assert.equal(schemaless.valid, true);
  assert.ok((schemaless.warnings ?? []).length > 0);

  console.log('PASS: plan compatibility (declared, undeclared, unknown, scoring, schemaless)');
}

main().catch(error => {
  console.error('FAIL: plan compatibility');
  console.error(error);
  process.exitCode = 1;
});
