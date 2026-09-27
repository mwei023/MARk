import { describe, it, expect } from 'vitest';
import { sysSandboxTools, sysSandboxImplementations } from './providers/sys-sandbox.js';

const impl = sysSandboxImplementations.find(i => i.toolId === 'sys.exec')!;
const ctx = { workingDirectory: process.cwd() } as any;
const run = async (command: string, cwd?: string) =>
  (await impl.execute({ action: { input: { command, cwd } }, context: { workingDirectory: process.cwd() } } as any)).output as any;

describe('sandboxed shell', () => {
  it('registers as diagnostic', () => {
    expect(sysSandboxTools.map(t => t.id)).toEqual(['sys.exec']);
    expect(sysSandboxTools[0].risk).toBe('diagnostic');
  });

  it('runs allowlisted reads', async () => {
    const out = await run('pwd');
    expect(out.ok).toBe(true);
    expect(out.output).toContain('app');
  });

  it('refuses writes, escalation, pipes, and unknown binaries', async () => {
    for (const cmd of ['sudo ls', 'rm -rf /tmp/x', 'ls | grep x', 'curl http://x', 'python3 -c 1', 'nope --x', 'git push', 'npm run deploy', 'echo $(whoami)']) {
      const out = await run(cmd);
      expect(out.ok).toBe(false, cmd);
    }
  });

  it('gates subcommands and cwd', async () => {
    expect((await run('git status')).ok).toBe(true);
    expect((await run('docker ps')).ok).toBe(true);
    expect((await run('ls', '../..')).ok).toBe(false);
  });
});
