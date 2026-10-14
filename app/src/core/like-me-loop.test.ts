import assert from 'node:assert/strict';
import { LikeMeLoop, matchGlob, defaultPermissionGate } from './like-me-loop';

const run = async (): Promise<void> => {
  assert.equal(matchGlob('*', 'anything'), true);
  assert.equal(matchGlob('git status*', 'git status --short'), true);
  assert.equal(matchGlob('rm -rf*', 'rm -rf /tmp/x'), true);
  assert.equal(defaultPermissionGate.evaluate('system.machine_info'), 'allow');
  assert.equal(defaultPermissionGate.evaluate('rm -rf /'), 'deny');

  const loop = new LikeMeLoop();
  await loop.ensureInit();

  const planPreview = loop.preview('check machine health', 'plan');
  assert.ok(planPreview.plan.steps.length >= 0);
  assert.equal(planPreview.mode, 'plan');
  // Plan mode must never allow mutating without block.
  for (const step of planPreview.steps) {
    if (step.risk === 'mutating' || step.risk === 'privileged' || step.risk === 'financial') {
      assert.equal(step.blocked, true);
    }
  }

  // Per-container descriptors carry their own names: the kernel resolver
  // routes an exact container name with no input inference and no missing
  // inputs. A vague goal ("restart api") must fail honestly instead of
  // guessing. Falls back gracefully when the daemon is unreachable.
  const restartPlan = loop.preview('restart jarvis-db container', 'plan');
  if (restartPlan.steps[0]?.toolId === 'container.restart.jarvis-db') {
    assert.deepEqual(restartPlan.plan.steps[0]?.input, {});
    assert.equal(restartPlan.validation.valid, true);
    assert.equal(restartPlan.steps[0]?.blocked, true);

    const restartBuild = loop.preview('restart jarvis-db container', 'build');
    assert.equal(restartBuild.steps[0]?.needsConfirm, true);
    assert.equal(restartBuild.steps[0]?.blocked, false);
  } else {
    assert.ok(
      restartPlan.validation.valid === false || restartPlan.steps.length === 0,
      'without a live daemon the plan must fail honestly, never guess a container',
    );
  }

  const planOnly = await loop.execute('check machine health', { mode: 'plan' });
  assert.equal(planOnly.executed, false);

  // A vague goal must never silently guess a container.
  const vaguePlan = loop.preview('restart api container', 'plan');
  const guessed =
    vaguePlan.steps[0]?.toolId === 'system.container_restart' &&
    (vaguePlan.plan.steps[0]?.input as Record<string, unknown>)?.container === 'jarvis-api';
  assert.equal(guessed, false, 'must not infer jarvis-api from "api"');

  console.log(
    'Like-Me loop OK:',
    `plan steps=${planPreview.steps.length}`,
    `restart tool=${restartPlan.steps[0]?.toolId ?? 'none'}`,
    `restart plan valid=${restartPlan.validation.valid}`,
  );
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
