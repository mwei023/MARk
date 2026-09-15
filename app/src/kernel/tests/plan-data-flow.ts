import assert from 'node:assert/strict';

import {
  MARKKernel,
} from '../kernel';

import {
  ExecutionPlan,
  PlanStepResult,
} from '../planner';

import {
  resolveInputReferences,
  StepReferenceError,
} from '../step-references';

import {
  systemMachineInfoTool,
  systemMachineInfoImplementation,
} from '../providers/system-tools';

import {
  ToolDescriptor,
} from '../types';

import {
  ToolImplementation,
} from '../executor';

/**
 * Minimal in-memory test fixtures. These are registered only in this test
 * setup, never as permanent native system capabilities.
 */

const testProduceTool: ToolDescriptor = {
  id: 'test.produce',
  name: 'Produce structured test data',
  description: 'Returns structured data for data-flow tests.',
  version: '1.0.0',
  domain: 'test',
  risk: 'read',
  available: true,
  provider: 'test',
  requiredPermissions: [],
  supportedResourceKinds: ['unknown'],
  reversible: true,
  metadata: {},
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const testProduceImplementation: ToolImplementation = {
  toolId: testProduceTool.id,

  async execute() {
    return {
      output: {
        data: {
          value: 'generated-value',
          nested: {
            count: 42,
          },
        },
      },
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'output',
          source: 'test.produce',
          subject: 'test.produce',
          summary: 'Produced structured test data.',
          data: {
            produced: true,
          },
          confidence: 1,
          observedAt: new Date().toISOString(),
          relatedResourceIds: [],
        },
      ],
    };
  },
};

const testConsumeTool: ToolDescriptor = {
  id: 'test.consume',
  name: 'Consume structured input',
  description: 'Accepts an input object and returns the received input.',
  version: '1.0.0',
  domain: 'test',
  risk: 'read',
  available: true,
  provider: 'test',
  requiredPermissions: [],
  supportedResourceKinds: ['unknown'],
  reversible: true,
  metadata: {},
  inputSchema: {
    type: 'object',
    properties: {
      machine: { type: 'object', description: 'Any machine-shaped value.' },
      payload: { type: 'object', description: 'Any payload-shaped value.' },
      input: { type: 'object', description: 'Any whole-result value.' },
      direct: { type: 'string', description: 'Optional static value.' },
    },
    required: [],
  },
};

const testConsumeImplementation: ToolImplementation = {
  toolId: testConsumeTool.id,

  async execute({ action }) {
    return {
      output: action.input,
      observations: [],
    };
  },
};

const testFailTool: ToolDescriptor = {
  id: 'test.fail',
  name: 'Always fail',
  description: 'Fails deterministically to test failure propagation.',
  version: '1.0.0',
  domain: 'test',
  risk: 'read',
  available: true,
  provider: 'test',
  requiredPermissions: [],
  supportedResourceKinds: ['unknown'],
  reversible: true,
  metadata: {},
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const testFailImplementation: ToolImplementation = {
  toolId: testFailTool.id,

  async execute() {
    throw new Error('test.fail always fails');
  },
};

function createKernel(): MARKKernel {
  const kernel = new MARKKernel();

  kernel.registerTool(testProduceTool);
  kernel.registerImplementation(testProduceImplementation);

  kernel.registerTool(testConsumeTool);
  kernel.registerImplementation(testConsumeImplementation);

  kernel.registerTool(testFailTool);
  kernel.registerImplementation(testFailImplementation);

  return kernel;
}

function createContext(kernel: MARKKernel) {
  return kernel.createContext({
    userId: 'plan-data-flow-test-user',
    source: 'cli',
  });
}

function stepReport(
  report: Awaited<
    ReturnType<MARKKernel['executePlanWithReport']>
  >,
  stepId: string,
): PlanStepResult {
  const step = report.steps.find(
    candidate => candidate.stepId === stepId,
  );

  assert.ok(
    step,
    `Expected report to contain step "${stepId}"`,
  );

  return step;
}

async function run() {
  /**
   * A. Static-input compatibility
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_static_inputs',
      goal: 'Execute tools with ordinary static inputs',
      steps: [
        {
          id: 'produce',
          toolId: 'test.produce',
          input: {},
          dependsOn: [],
        },
        {
          id: 'consume-static',
          toolId: 'test.consume',
          input: {
            direct: 'static-value',
          },
          dependsOn: [],
        },
      ],
      successCriteria: ['Both steps succeed'],
    };

    const result = await kernel.executePlan(plan, context);

    assert.equal(
      result.status,
      'succeeded',
      `Expected static-input plan to succeed: ${result.error ?? ''}`,
    );
    assert.equal(result.stepResults.length, 2);

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(report.status, 'succeeded');
    assert.equal(report.planId, 'plan_static_inputs');

    const consumed = stepReport(report, 'consume-static');
    assert.deepEqual(consumed.resolvedInput, {
      direct: 'static-value',
    });

    console.log('PASS (A): Static-input plans still execute successfully');
  }

  /**
   * B. Whole-result reference
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_whole_reference',
      goal: 'Consume a whole previous step output',
      steps: [
        {
          id: 'producer',
          toolId: 'test.produce',
          input: {},
          dependsOn: [],
        },
        {
          id: 'consumer',
          toolId: 'test.consume',
          input: {
            input: '$steps.producer',
          },
          dependsOn: ['producer'],
        },
      ],
      successCriteria: ['Consumer receives producer output'],
    };

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(report.status, 'succeeded');

    const consumer = stepReport(report, 'consumer');
    assert.equal(consumer.status, 'succeeded');
    assert.deepEqual(
      consumer.resolvedInput,
      {
        input: {
          data: {
            value: 'generated-value',
            nested: {
              count: 42,
            },
          },
        },
      },
      'Expected the whole producer output to be resolved into the consumer input',
    );
    assert.deepEqual(consumer.output, consumer.resolvedInput);

    console.log('PASS (B): Whole-result reference resolves the producer output');
  }

  /**
   * C. Nested-output reference
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_nested_reference',
      goal: 'Consume a nested property of a previous step output',
      steps: [
        {
          id: 'producer',
          toolId: 'test.produce',
          input: {},
          dependsOn: [],
        },
        {
          id: 'consumer',
          toolId: 'test.consume',
          input: {
            direct: '$steps.producer.output.data.nested.count',
          },
          dependsOn: ['producer'],
        },
      ],
      successCriteria: ['Consumer receives nested count'],
    };

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(report.status, 'succeeded');

    const consumer = stepReport(report, 'consumer');
    assert.equal(consumer.status, 'succeeded');

    assert.deepEqual(
      consumer.resolvedInput,
      {
        direct: 42,
      },
      'Expected the nested count to be resolved to the number 42',
    );

    console.log('PASS (C): Nested-output reference resolves to a scalar value');
  }

  /**
   * D. Recursive references inside objects and arrays
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_recursive_references',
      goal: 'Resolve references nested inside objects and arrays',
      steps: [
        {
          id: 'producer',
          toolId: 'test.produce',
          input: {},
          dependsOn: [],
        },
        {
          id: 'consumer',
          toolId: 'test.consume',
          input: {
            payload: {
              machine: '$steps.producer',
              values: [
                'static',
                '$steps.producer.output.data.value',
              ],
            },
          },
          dependsOn: ['producer'],
        },
      ],
      successCriteria: ['Nested references resolve recursively'],
    };

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(report.status, 'succeeded');

    const consumer = stepReport(report, 'consumer');
    assert.deepEqual(consumer.resolvedInput, {
      payload: {
        machine: {
          data: {
            value: 'generated-value',
            nested: {
              count: 42,
            },
          },
        },
        values: ['static', 'generated-value'],
      },
    });

    console.log('PASS (D): References resolve recursively inside objects and arrays');
  }

  /**
   * E. Missing reference fails clearly
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_missing_reference',
      goal: 'Reference a step that does not exist',
      steps: [
        {
          id: 'consumer',
          toolId: 'test.consume',
          input: {
            direct: '$steps.does-not-exist',
          },
          dependsOn: [],
        },
      ],
      successCriteria: [],
    };

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(report.status, 'failed');

    const consumer = stepReport(report, 'consumer');
    assert.equal(consumer.status, 'failed');
    assert.match(
      consumer.error ?? '',
      /does not exist in the plan|has not executed yet/,
      'Expected a clear missing-reference error',
    );

    // The resolver alone behaves identically.
    assert.throws(
      () =>
        resolveInputReferences(
          { direct: '$steps.does-not-exist' },
          [],
        ),
      StepReferenceError,
    );

    console.log('PASS (E): Missing reference fails clearly');
  }

  /**
   * F. Reference to an unsuccessful step is rejected
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_unsuccessful_reference',
      goal: 'Reference a failed step',
      steps: [
        {
          id: 'failing',
          toolId: 'test.fail',
          input: {},
          dependsOn: [],
        },
        {
          id: 'consumer',
          toolId: 'test.consume',
          input: {
            direct: '$steps.failing',
          },
          dependsOn: ['failing'],
        },
      ],
      successCriteria: [],
    };

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    const failing = stepReport(report, 'failing');
    assert.equal(failing.status, 'failed');

    const consumer = stepReport(report, 'consumer');
    assert.equal(
      consumer.status,
      'skipped',
      'Expected the dependent step to be skipped rather than execute with a broken reference',
    );

    // Direct resolver-level rejection: a failed snapshot cannot be referenced.
    assert.throws(
      () =>
        resolveInputReferences(
          { direct: '$steps.failing' },
          [
            {
              stepId: 'failing',
              status: 'failed',
              error: 'test.fail always fails',
            },
          ],
        ),
      (error: unknown) =>
        error instanceof StepReferenceError &&
        error.code === 'STEP_NOT_SUCCEEDED',
      'Expected STEP_NOT_SUCCEEDED for a reference to a failed step',
    );

    // Skipped snapshots are rejected the same way.
    assert.throws(
      () =>
        resolveInputReferences(
          { direct: '$steps.skipped-one' },
          [
            {
              stepId: 'skipped-one',
              status: 'skipped',
            },
          ],
        ),
      (error: unknown) =>
        error instanceof StepReferenceError &&
        error.code === 'STEP_NOT_SUCCEEDED',
    );

    console.log('PASS (F): References to failed or skipped steps are rejected');
  }

  /**
   * G. Dependency failure propagation
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_failure_propagation',
      goal: 'Skip dependents when a dependency fails',
      steps: [
        {
          id: 'failing',
          toolId: 'test.fail',
          input: {},
          dependsOn: [],
        },
        {
          id: 'dependent',
          toolId: 'test.consume',
          input: { direct: 'unused' },
          dependsOn: ['failing'],
        },
        {
          id: 'grandchild',
          toolId: 'test.consume',
          input: { direct: 'unused' },
          dependsOn: ['dependent'],
        },
      ],
      successCriteria: [],
    };

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(report.status, 'failed');

    const failing = stepReport(report, 'failing');
    assert.equal(failing.status, 'failed');
    assert.match(failing.error ?? '', /test.fail always fails/);
    assert.ok(!failing.output);

    const dependent = stepReport(report, 'dependent');
    assert.equal(dependent.status, 'skipped');
    assert.ok(!dependent.action, 'Skipped step must not execute');
    assert.ok(!dependent.result, 'Skipped step must have no ActionResult');
    assert.match(
      dependent.error ?? '',
      /required dependency "failing" did not succeed/,
    );

    const grandchild = stepReport(report, 'grandchild');
    assert.equal(
      grandchild.status,
      'skipped',
      'Transitive dependents are skipped too',
    );

    console.log('PASS (G): Failure propagation marks dependents as skipped');
  }

  /**
   * H. Independent step behavior
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'plan_independent_branch',
      goal: 'Independent branches are not blocked by another branch failure',
      steps: [
        {
          id: 'failing',
          toolId: 'test.fail',
          input: {},
          dependsOn: [],
        },
        {
          id: 'independent-producer',
          toolId: 'test.produce',
          input: {},
          dependsOn: [],
        },
        {
          id: 'independent-consumer',
          toolId: 'test.consume',
          input: {
            direct: '$steps.independent-producer.output.data.value',
          },
          dependsOn: ['independent-producer'],
        },
      ],
      successCriteria: [],
    };

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(
      report.status,
      'partial',
      'One failed branch plus one succeeded branch yields a partial plan',
    );

    assert.equal(stepReport(report, 'failing').status, 'failed');
    assert.equal(
      stepReport(report, 'independent-producer').status,
      'succeeded',
      'Independent steps still execute',
    );

    const consumer = stepReport(report, 'independent-consumer');
    assert.equal(consumer.status, 'succeeded');
    assert.deepEqual(consumer.resolvedInput, {
      direct: 'generated-value',
    });

    console.log('PASS (H): Independent steps execute despite an unrelated failure');
  }

  /**
   * I. Final execution report
   */
  {
    const kernel = createKernel();
    const context = createContext(kernel);

    const plan: ExecutionPlan = {
      id: 'diagnostic-plan',
      goal: 'Full structured data flow report',
      steps: [
        {
          id: 'inspect-machine',
          toolId: 'system.machine_info',
          input: {},
          dependsOn: [],
        },
        {
          id: 'consume-machine-info',
          toolId: 'test.consume',
          dependsOn: ['inspect-machine'],
          input: {
            machine: '$steps.inspect-machine',
          },
        },
      ],
      successCriteria: ['Machine info flows into the consumer'],
    };

    kernel.registerTool(systemMachineInfoTool);
    kernel.registerImplementation(systemMachineInfoImplementation);

    const report = await kernel.executePlanWithReport(
      plan,
      context,
    );

    assert.equal(report.status, 'succeeded');
    assert.equal(report.planId, 'diagnostic-plan');
    assert.equal(report.steps.length, 2);

    const inspected = stepReport(report, 'inspect-machine');
    assert.equal(inspected.status, 'succeeded');
    assert.ok(inspected.startedAt);
    assert.ok(inspected.completedAt);
    assert.ok(inspected.observations.length > 0);

    const consumer = stepReport(report, 'consume-machine-info');
    assert.equal(consumer.status, 'succeeded');
    assert.ok(
      consumer.resolvedInput,
      'Report contains resolved inputs',
    );
    assert.ok(
      consumer.output,
      'Report contains outputs/results',
    );

    const machine = (
      consumer.resolvedInput as {
        machine: { hostname: string };
      }
    ).machine;

    assert.equal(
      typeof machine.hostname,
      'string',
      'Consumer received the machine info output',
    );

    assert.ok(
      report.finalOutputs['inspect-machine'],
      'finalOutputs contains step outputs keyed by step ID',
    );
    assert.ok(report.startedAt);
    assert.ok(report.completedAt);

    console.log('PASS (I): Structured execution report carries full data flow');
  }

  /**
   * Resolver unit checks (generic behavior, independent of plan execution)
   */
  {
    // Non-reference strings are preserved unchanged.
    const untouched = resolveInputReferences(
      {
        plain: '$steps',
        prefixOnly: '$steps.',
        contains: 'value $steps.producer value',
        shellLike: '$(echo hello)',
        number: 5,
        bool: true,
        nil: null,
      },
      [],
    );

    assert.deepEqual(untouched, {
      plain: '$steps',
      prefixOnly: '$steps.',
      contains: 'value $steps.producer value',
      shellLike: '$(echo hello)',
      number: 5,
      bool: true,
      nil: null,
    });

    // Unknown segments produce clear PATH_NOT_RESOLVED errors.
    assert.throws(
      () =>
        resolveInputReferences(
          { direct: '$steps.producer.output.missing' },
          [
            {
              stepId: 'producer',
              status: 'succeeded',
              output: { data: { value: 'x' } },
            },
          ],
        ),
      (error: unknown) =>
        error instanceof StepReferenceError &&
        error.code === 'PATH_NOT_RESOLVED',
    );

    // Whole-result reference where the tool produced no dedicated output
    // falls back to the full ActionResult shape.
    const fallback = resolveInputReferences(
      { direct: '$steps.legacy.output' },
      [
        {
          stepId: 'legacy',
          status: 'succeeded',
          result: { status: 'succeeded', observations: [] },
        },
      ],
    );

    assert.deepEqual(fallback, {
      direct: { status: 'succeeded', observations: [] },
    });

    console.log('PASS: resolver preserves non-references and reports clear path errors');
  }

  console.log('PASS: plan data flow tests complete');
}

run().catch(error => {
  console.error('FAIL: plan data flow test');
  console.error(error);
  process.exit(1);
});
