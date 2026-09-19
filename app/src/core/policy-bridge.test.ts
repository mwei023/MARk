import assert from 'node:assert/strict';

import { agentActionRisk, unifiedEvaluate } from '../kernel/policy-bridge';

async function main(): Promise<void> {
  // A. Risk mapping covers the agent vocabulary.
  assert.equal(agentActionRisk('gather_logs'), 'read');
  assert.equal(agentActionRisk('health_check'), 'read');
  assert.equal(agentActionRisk('restart'), 'reversible');
  assert.equal(agentActionRisk('install_dependency'), 'mutating');
  assert.equal(agentActionRisk('patch_code'), 'mutating');
  assert.equal(agentActionRisk('sudo'), 'privileged');
  assert.equal(agentActionRisk('access_secrets'), 'privileged');
  assert.equal(agentActionRisk('delete'), 'privileged');
  console.log('PASS (A): agent actions map to kernel risk levels');

  // B. Stricter side wins: policy auto + authority deny = block.
  const blocked = unifiedEvaluate({
    agentName: 'test', action: 'install_dependency', risk: 'low', isFirst: true,
  });
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /authority\(mutating\)/);
  console.log('PASS (B): kernel deny floor blocks policy-auto install');

  // C. Explicit blocks stay blocked on both sides.
  const sudo = unifiedEvaluate({ agentName: 'test', action: 'sudo', risk: 'high' });
  assert.equal(sudo.decision, 'block');
  console.log('PASS (C): elevated commands blocked');

  // D. Medium-risk reads stay confirm-gated; low-risk reads are auto (policies.ts).
  const logs = unifiedEvaluate({ agentName: 'git-agent', action: 'fetch_logs', risk: 'medium', environment: 'production' });
  assert.ok(logs.decision === 'confirm' || logs.decision === 'alert');
  console.log('PASS (D): production log fetch still needs approval');

  console.log('PASS: policy bridge tests complete');
}

main().catch(error => {
  console.error('FAIL: policy bridge test');
  console.error(error);
  process.exitCode = 1;
});
