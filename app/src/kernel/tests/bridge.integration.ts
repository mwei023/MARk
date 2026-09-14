import {
  markKernelBridge,
} from '../bridge';

async function main(): Promise<void> {
  const status = await markKernelBridge.initialize();

  if (!status.initialized) {
    throw new Error('Expected kernel bridge to be initialized');
  }

  if (!status.discoveredTools.includes('system.machine_info')) {
    throw new Error(
      'Expected system.machine_info to be discovered by the bridge',
    );
  }

  const context = markKernelBridge.createContext({
    actorId: 'bridge.integration-test',
    source: 'system',
  });

  const result = await markKernelBridge.execute(
    {
      id: 'bridge-machine-info',
      toolId: 'system.machine_info',
      input: {},
      contextId: context.id,
      requestedBy: context.actorId,
      reason: 'Verify bridge execution',
    },
    context,
  );

  if (result.status !== 'succeeded') {
    throw new Error(
      `Expected successful execution, received: ${result.status}`,
    );
  }

  if (!result.observations?.some(
    observation => observation.subject === 'local-machine',
  )) {
    throw new Error(
      'Expected a local-machine observation from system.machine_info',
    );
  }

  console.log('PASS: kernel bridge integration test');
  console.log(`Initialized: ${status.initialized}`);
  console.log(`Discovered tools: ${status.discoveredTools.length}`);
  console.log(`Action status: ${result.status}`);
  console.log(
    `Observations returned: ${result.observations?.length ?? 0}`,
  );
}

main().catch(error => {
  console.error('FAIL: kernel bridge integration test');
  console.error(error);
  process.exitCode = 1;
});
