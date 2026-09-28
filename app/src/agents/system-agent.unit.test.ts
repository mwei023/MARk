import { describe, it, expect } from 'vitest';
import { Gateway } from '../core/gateway.js';
import { SystemAgent } from './system-agent.js';

const gw = new Gateway();
const mk = (command: string) =>
  ({
    id: 'e',
    timestamp: new Date(),
    source: 'user_command',
    type: 'user.command.received',
    severity: 'info',
    data: { command },
  }) as any;
const route = (command: string) => gw.classify(mk(command)) as { path: string; agent?: string };

// Golden set for the system provider wiring: machine-inspection commands
// reach system-agent; everything else keeps its existing route.
describe('system-agent routing (golden)', () => {
  const positive = [
    'check my system',
    'diagnose the system',
    'diagnose my system',
    'check the server',
    'what is running?',
    'is postgres running',
    'is redis running',
    'list listening ports',
    'check open ports',
    'list running services',
    'show top processes',
    'what are the network interfaces',
    'show environment variables',
    'what software is installed',
    'node version',
    'what hardware does this machine have',
    'inspect the environment',
    'check operating system details',
    'list network ports',
  ];
  for (const cmd of positive) {
    it(`routes ${JSON.stringify(cmd)} to system-agent`, () => {
      const d = route(cmd);
      expect(d.path).toBe('agent');
      expect(d.agent).toBe('system-agent');
      expect(SystemAgent.isSystemCommand(cmd)).toBe(true);
    });
  }

  it('keeps bare "system status" on the MARK config capability', () => {
    expect(route('system status').path).toBe('deterministic');
    expect(SystemAgent.isSystemCommand('system status')).toBe(false);
  });

  it('keeps deterministic locals off the agent', () => {
    for (const cmd of ['show disk usage', 'check memory', 'what time is it?', 'show processor info']) {
      const d = route(cmd);
      expect(d.path).toBe('deterministic');
      expect(d.agent).not.toBe('system-agent');
    }
  });

  it('does not steal specialist commands', () => {
    const cases: Array<[string, string]> = [
      ['list git branches', 'git-agent'],
      ['deploy to staging', 'devops-agent'],
      ['restart the container', 'devops-agent'],
      ['is the pipeline green', 'cicd-agent'],
      ['repair the lint errors', 'code-agent'],
      ['look up flights over Nairobi', 'web-agent'],
      ['deep research vector databases', 'research-agent'],
    ];
    for (const [cmd, agent] of cases) {
      const d = route(cmd);
      expect(d.path).toBe('agent');
      expect(d.agent).toBe(agent);
    }
  });

  it('does not fire on substring lookalikes', () => {
    for (const cmd of [
      'this is a legitimate concern',
      'show the latest news',
      'testing my patience here',
      'deployed yesterday morning',
    ]) {
      expect(route(cmd).agent).not.toBe('system-agent');
      expect(SystemAgent.isSystemCommand(cmd)).toBe(false);
    }
  });

  it('handles "what is running?" despite the ?-anchored pattern', () => {
    expect(SystemAgent.isSystemCommand('what is running?')).toBe(true);
    expect(route('what is running?').agent).toBe('system-agent');
  });
});
