import { describe, it, expect } from 'vitest';
import { CapabilityResolver } from './capability-resolver.js';
import { ToolRegistry } from './tool-registry.js';
import {
  systemContainerListTool,
  systemContainerLogsTool,
  systemServiceLogsTool,
  systemServiceStatusTool,
  systemContainerLogsImplementation,
  systemServiceStatusImplementation,
} from './providers/system-tools.js';

function resolverWithLogs() {
  const registry = new ToolRegistry();
  registry.registerMany([
    systemContainerListTool, systemContainerLogsTool,
    systemServiceLogsTool, systemServiceStatusTool,
  ]);
  return new CapabilityResolver({ toolRegistry: registry });
}

const ctx = { workingDirectory: '/tmp', userId: 'test', source: 'system' } as any;
const act = (toolId: string, input: Record<string, unknown>) =>
  ({ id: 'ACT-test', toolId, input, requestedBy: 'test', createdAt: new Date().toISOString() }) as any;

describe('log/status tool routing', () => {
  it('claims log phrasings over restart-family-shaped rivals', () => {
    const r = resolverWithLogs();
    // Verb coverage (show/tail/logs) must beat name-rarity rivals: the
    // companion live check proves it against the full 299-tool catalog.
    for (const goal of ['show me the minio container logs', 'tail the ios-minio logs', 'show Mousepad service logs']) {
      expect(r.resolve(goal).tool?.id).toBe('system.container_logs');
    }
  });

  it('refuses hostile names and tails without a shell', async () => {
    for (const input of [
      { container: 'x; rm -rf /' }, { container: '' }, { container: '../evil' },
    ]) {
      await expect(systemContainerLogsImplementation.execute({
        action: act('system.container_logs', input), context: ctx,
      } as any)).rejects.toThrow(/invalid container name/);
    }
    await expect(systemServiceStatusImplementation.execute({
      action: act('system.service_status', { service: 'a|b' }), context: ctx,
    } as any)).rejects.toThrow(/invalid service name/);
  });
});
