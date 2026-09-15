import assert from 'node:assert/strict';

import {
  MARKKernel,
} from '../kernel';

import {
  systemMachineInfoTool,
  systemMachineInfoImplementation,
} from '../providers/system-tools';

import {
  ExecutionPlan,
  KernelPlanner,
} from '../planner';

import {
  ToolDescriptor,
} from '../types';

async function run() {
  const kernel = new MARKKernel();

  kernel.registerTool(systemMachineInfoTool);
  kernel.registerImplementation(systemMachineInfoImplementation);

  // A. Goal -> plan
  const plan = kernel.planGoal('Tell me about this machine');

  assert.ok(plan, 'Expected plan to exist');
  assert.equal(plan.goal, 'Tell me about this machine');
  assert.equal(plan.steps.length, 1, 'Expected a one-step plan');
  assert.equal(
    plan.steps[0].toolId,
    systemMachineInfoTool.id,
    'Expected step toolId to equal system.machine_info',
  );
  assert.deepEqual(
    plan.steps[0].dependsOn,
    [],
    'Expected step dependsOn to be empty',
  );
  assert.ok(
    plan.successCriteria.length > 0,
    'Expected success criteria to be defined',
  );

  console.log('PASS (A): Goal -> plan produces structured ExecutionPlan');
  console.log(`Plan ID: ${plan.id}`);
  console.log(`Steps: ${plan.steps.length}`);
  console.log(`Step 0 Tool: ${plan.steps[0].toolId}`);

  // B. Plan validation succeeds for a valid discovered tool
  const validResult = kernel.validatePlan(plan);
  assert.equal(
    validResult.valid,
    true,
    'Expected valid plan to pass validation',
  );
  assert.equal(
    validResult.errors.length,
    0,
    'Expected no errors for valid plan',
  );

  console.log('PASS (B): Plan validation succeeds for valid discovered tool');

  // C. Unknown tool is rejected
  const unknownToolPlan: ExecutionPlan = {
    id: 'plan_unknown_test',
    goal: 'Run unknown tool',
    steps: [
      {
        id: 'step_1',
        toolId: 'nonexistent.tool.id',
        input: {},
        dependsOn: [],
      },
    ],
    successCriteria: ['Complete unknown tool'],
  };

  const unknownValidation = kernel.validatePlan(unknownToolPlan);
  assert.equal(
    unknownValidation.valid,
    false,
    'Expected unknown tool plan to fail validation',
  );
  assert.ok(
    unknownValidation.errors.some(e => e.code === 'NONEXISTENT_TOOL'),
    'Expected NONEXISTENT_TOOL error code',
  );

  console.log('PASS (C): Unknown tool is rejected');

  // D. Missing dependency is rejected
  const missingDepPlan: ExecutionPlan = {
    id: 'plan_missing_dep_test',
    goal: 'Run step with missing dependency',
    steps: [
      {
        id: 'step_1',
        toolId: systemMachineInfoTool.id,
        input: {},
        dependsOn: ['step_nonexistent'],
      },
    ],
    successCriteria: ['Complete step with dependency'],
  };

  const missingDepValidation = kernel.validatePlan(missingDepPlan);
  assert.equal(
    missingDepValidation.valid,
    false,
    'Expected missing dependency plan to fail validation',
  );
  assert.ok(
    missingDepValidation.errors.some(e => e.code === 'MISSING_DEPENDENCY'),
    'Expected MISSING_DEPENDENCY error code',
  );

  console.log('PASS (D): Missing dependency is rejected');

  // E. Dependency cycle is rejected
  const cyclePlan: ExecutionPlan = {
    id: 'plan_cycle_test',
    goal: 'Run steps with circular dependencies',
    steps: [
      {
        id: 'step_a',
        toolId: systemMachineInfoTool.id,
        input: {},
        dependsOn: ['step_b'],
      },
      {
        id: 'step_b',
        toolId: systemMachineInfoTool.id,
        input: {},
        dependsOn: ['step_a'],
      },
    ],
    successCriteria: ['Complete cyclic steps'],
  };

  const cycleValidation = kernel.validatePlan(cyclePlan);
  assert.equal(
    cycleValidation.valid,
    false,
    'Expected cyclic plan to fail validation',
  );
  assert.ok(
    cycleValidation.errors.some(e => e.code === 'DEPENDENCY_CYCLE'),
    'Expected DEPENDENCY_CYCLE error code',
  );

  console.log('PASS (E): Dependency cycle is rejected');

  // Additional validations: Duplicate step IDs rejected
  const duplicateStepPlan: ExecutionPlan = {
    id: 'plan_dup_test',
    goal: 'Duplicate steps',
    steps: [
      {
        id: 'step_dup',
        toolId: systemMachineInfoTool.id,
        input: {},
        dependsOn: [],
      },
      {
        id: 'step_dup',
        toolId: systemMachineInfoTool.id,
        input: {},
        dependsOn: [],
      },
    ],
    successCriteria: [],
  };
  const dupValidation = kernel.validatePlan(duplicateStepPlan);
  assert.equal(dupValidation.valid, false);
  assert.ok(dupValidation.errors.some(e => e.code === 'DUPLICATE_STEP_ID'));
  console.log('PASS: Duplicate step IDs rejected');

  // Additional validations: Unavailable tool rejected
  const unavailableTool: ToolDescriptor = {
    ...systemMachineInfoTool,
    id: 'system.unavailable_tool',
    available: false,
  };
  kernel.registerTool(unavailableTool);
  const unavailablePlan: ExecutionPlan = {
    id: 'plan_unavail_test',
    goal: 'Run unavailable tool',
    steps: [
      {
        id: 'step_unavail',
        toolId: 'system.unavailable_tool',
        input: {},
        dependsOn: [],
      },
    ],
    successCriteria: [],
  };
  const unavailValidation = kernel.validatePlan(unavailablePlan);
  assert.equal(unavailValidation.valid, false);
  assert.ok(unavailValidation.errors.some(e => e.code === 'UNAVAILABLE_TOOL'));
  console.log('PASS: Unavailable tool rejected');

  // Additional validations: Missing required input rejected
  const toolWithRequiredInput: ToolDescriptor = {
    id: 'test.required_input_tool',
    name: 'Tool With Required Input',
    description: 'Requires target filename input',
    version: '1.0.0',
    domain: 'test',
    risk: 'read',
    available: true,
    provider: 'test',
    requiredPermissions: [],
    supportedResourceKinds: ['file'],
    reversible: true,
    metadata: {},
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The target filename',
        },
      },
      required: ['filename'],
    },
  };
  kernel.registerTool(toolWithRequiredInput);
  const missingInputPlan: ExecutionPlan = {
    id: 'plan_missing_input_test',
    goal: 'Execute tool without required input',
    steps: [
      {
        id: 'step_req',
        toolId: 'test.required_input_tool',
        input: {},
        dependsOn: [],
      },
    ],
    successCriteria: [],
  };
  const missingInputValidation = kernel.validatePlan(missingInputPlan);
  assert.equal(missingInputValidation.valid, false);
  assert.ok(
    missingInputValidation.errors.some(e => e.code === 'MISSING_REQUIRED_INPUT'),
  );
  console.log('PASS: Missing required input rejected');

  // Standalone planner abstraction receiving ToolDescriptor[] directly
  const standalonePlanner = new KernelPlanner([systemMachineInfoTool]);
  const standalonePlan = standalonePlanner.plan('Tell me about this machine');
  assert.ok(standalonePlan);
  assert.equal(standalonePlan.steps.length, 1);
  assert.equal(standalonePlan.steps[0].toolId, systemMachineInfoTool.id);
  console.log('PASS: Standalone planner abstraction with ToolDescriptor[] produces ExecutionPlan');

  // Plan execution through kernel
  const context = kernel.createContext({
    userId: 'test-user',
    source: 'cli',
  });
  const planExecResult = await kernel.executePlan(plan, context);
  assert.equal(planExecResult.status, 'succeeded');
  assert.equal(planExecResult.stepResults.length, 1);
  assert.ok(planExecResult.observations.length > 0);
  console.log('PASS: Kernel executes structured plan successfully');
}

run().catch(error => {
  console.error('FAIL: planner test');
  console.error(error);
  process.exit(1);
});
