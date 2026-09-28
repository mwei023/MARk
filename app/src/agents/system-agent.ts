/**
 * SystemAgent: MARK's machine-inspection specialist. Answers "what is true
 * about this computer" — hardware, processes, services, ports, network,
 * environment, software — and composes them into a diagnose-system-state
 * summary. Read-only by construction: every probe is a fixed execFile call
 * with a timeout, no shell, no writes. Anything mutating (restart service,
 * kill process, free disk) is proposed to DevOpsAgent/approvals instead.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import type { CapabilityRegistry } from '../runtime/capabilities/registry';

const execFilePromise = promisify(execFile);
const PROBE_TIMEOUT = 15000;

async function probe(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFilePromise(bin, args, { timeout: PROBE_TIMEOUT, maxBuffer: 1024 * 1024 });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function redactEnv(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const m = line.match(/^([A-Za-z_][\w]*)=(.*)$/);
      if (m && /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i.test(m[1])) {
        return `${m[1]}=<redacted>`;
      }
      return line;
    })
    .join('\n');
}

export class SystemAgent extends Agent {
  constructor() {
    super('system-agent');
  }

  canHandle(event: Event): boolean {
    if (event.type !== 'user.command.received') return false;
    const command = String((event.data as Record<string, any>).command || '');
    return SystemAgent.isSystemCommand(command);
  }

  static isSystemCommand(command: string): boolean {
    // "what is running?" is anchored separately: a trailing \b after \s*$
    // can never match (golden eval caught it falling through to reasoning).
    if (/what is running\?*\s*$/i.test(command)) return true;
    if (/\b(check my system|inspect the environment|check the server|diagnose( the| my)? system)\b/i.test(command)) return true;
    if (/\bis\s+[a-z0-9_.-]+\s+running\b/i.test(command)) return true;
    if (/\bnode\b.*\bversion\b|\bversion\b.*\bnode\b/i.test(command)) return true;
    return /\b(ram|memory|cpu|processor|disk|operating system|\bos\b|ports?|interfaces?|services?|processes?|server|environment|machine|hardware|software)\b/i.test(command);
  }

  async handle(_event: Event): Promise<void> {
    // SystemAgent is command-path only (user.command.received → handleCommand).
    // No bus event types route here; AgentRuntime.handleEvent never selects it.
  }

  async handleCommand(event: Event, _capabilities: CapabilityRegistry): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');
    const lower = command.toLowerCase();

    if (/\b(check my system|diagnose( the| my)? system|check the server)\b/i.test(command)) {
      return this.diagnose();
    }
    if (/\b(cpu|processor)\b/i.test(command)) return this.inspectCpuMemory();
    if (/\b(ram|memory)\b/i.test(command)) return this.inspectCpuMemory();
    if (/\bdisk\b/i.test(command)) return this.inspectDisk();
    if (/\b(operating system|\bos\b)\b/i.test(command)) return this.inspectMachine();
    if (/\bprocesses?\b/i.test(command) || /\bwhat is running\?*\s*$/i.test(command)) return this.inspectProcesses();
    if (/\bservices?\b/i.test(command) || /\bis\s+[a-z0-9_.-]+\s+running\b/i.test(command)) return this.inspectServices(command);
    if (/\bports?\b/i.test(command) || /\blistening\b/i.test(command)) return this.inspectPorts(command);
    if (/\binterfaces?|network\b/i.test(command)) return this.inspectNetwork();
    if (/\benvironment\b/i.test(command)) return this.inspectEnvironment();
    if (/\b(software|node|version|installed)\b/i.test(command)) return this.inspectSoftware();
    if (/\b(machine|hardware|server)\b/i.test(command)) return this.diagnose();
    return this.diagnose();
  }

  async inspectMachine(): Promise<string> {
    const [os, kernel, arch, host] = await Promise.all([
      probe('lsb_release', ['-d', '-s']),
      probe('uname', ['-r']),
      probe('uname', ['-m']),
      probe('hostname', []),
    ]);
    const lines = [
      `OS: ${os ?? 'unknown'}${kernel ? ` (kernel ${kernel})` : ''}`,
      `Arch: ${arch ?? 'unknown'}`,
      `Host: ${host ?? 'unknown'}`,
    ];
    return `System Agent — machine:\n${lines.join('\n')}`;
  }

  async inspectCpuMemory(): Promise<string> {
    const [mem, load, cpuModel] = await Promise.all([
      probe('free', ['-h']),
      probe('cat', ['/proc/loadavg']),
      readCpuModel(),
    ]);
    const lines = [
      `CPU: ${cpuModel ?? 'unknown'}`,
      `Load: ${load ? load.split(' ').slice(0, 3).join(' ') : 'unknown'} (1/5/15 min)`,
      mem ? `Memory:\n${mem.split('\n').slice(0, 3).join('\n')}` : 'Memory: unknown',
    ];
    return `System Agent — cpu/memory:\n${lines.join('\n')}`;
  }

  async inspectDisk(): Promise<string> {
    const df = await probe('df', ['-h', '/']);
    if (!df) return 'System Agent: disk info unavailable.';
    return `System Agent — disk:\n${df.split('\n').slice(0, 3).join('\n')}`;
  }

  async inspectProcesses(): Promise<string> {
    const ps = await probe('ps', ['-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu']);
    if (!ps) return 'System Agent: process list unavailable.';
    const rows = ps.split('\n');
    return `System Agent — top processes by CPU:\n${rows.slice(0, 11).join('\n')}`;
  }

  async inspectServices(command: string): Promise<string> {
    const named = command.match(/\bis\s+([a-z0-9_.-]+)\s+running\b/i)?.[1]?.toLowerCase();
    if (named) {
      const active = await probe('systemctl', ['is-active', named]);
      const state = active?.trim() ?? 'unknown';
      return `System Agent — service ${named}: ${state}.`;
    }
    const list = await probe('systemctl', ['list-units', '--type=service', '--state=running', '--no-pager', '--no-legend']);
    if (!list) return 'System Agent: service list unavailable (systemctl restricted?).';
    const rows = list.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 15);
    return `System Agent — running services (${rows.length} shown):\n${rows.join('\n')}`;
  }

  async inspectPorts(command: string): Promise<string> {
    const ss = await probe('ss', ['-tlnp']);
    if (!ss) return 'System Agent: port info unavailable.';
    const portMatch = command.match(/\bport\s+(\d{2,5})\b/i)?.[1];
    const rows = ss.split('\n').filter(l => l.trim().length > 0);
    if (portMatch) {
      const hit = rows.filter(l => l.includes(`:${portMatch}`));
      return hit.length > 0
        ? `System Agent — port ${portMatch} is listening:\n${hit.slice(0, 5).join('\n')}`
        : `System Agent — nothing listening on port ${portMatch}.`;
    }
    return `System Agent — listening ports:\n${rows.slice(0, 15).join('\n')}`;
  }

  async inspectNetwork(): Promise<string> {
    const [addrs, routes] = await Promise.all([
      probe('ip', ['-brief', 'address']),
      probe('ip', ['route', 'show', 'default']),
    ]);
    const lines = [
      addrs ? `Interfaces:\n${addrs.split('\n').slice(0, 10).join('\n')}` : 'Interfaces: unknown',
      `Default route: ${routes?.split('\n')[0] ?? 'unknown'}`,
    ];
    return `System Agent — network:\n${lines.join('\n')}`;
  }

  async inspectEnvironment(): Promise<string> {
    const keys = ['USER', 'HOME', 'SHELL', 'TERM', 'LANG', 'PATH', 'DISPLAY', 'NODE_ENV'];
    const lines = keys.map(k => `${k}=${k === 'PATH' ? (process.env[k] ?? '').split(':').slice(0, 6).join(':') + ':…' : process.env[k] ?? '(unset)'}`);
    return `System Agent — environment (secrets never shown):\n${lines.join('\n')}`;
  }

  async inspectSoftware(): Promise<string> {
    const [node, npm, python, git] = await Promise.all([
      probe('node', ['--version']),
      probe('npm', ['--version']),
      probe('python3', ['--version']),
      probe('git', ['--version']),
    ]);
    const lines = [
      `node: ${node ?? 'missing'}`,
      `npm: ${npm ?? 'missing'}`,
      `python3: ${python ?? 'missing'}`,
      `git: ${git ?? 'missing'}`,
    ];
    return `System Agent — installed software:\n${lines.join('\n')}`;
  }

  async diagnose(): Promise<string> {
    const [machine, resources, disk, procs] = await Promise.all([
      this.inspectMachine().catch(() => 'machine: unknown'),
      this.inspectCpuMemory().catch(() => 'cpu/memory: unknown'),
      this.inspectDisk().catch(() => 'disk: unknown'),
      this.inspectProcesses().catch(() => 'processes: unknown'),
    ]);
    const verdict = /unknown/.test(`${machine}${resources}${disk}`) ? 'partial visibility' : 'all probes answered';
    return `${machine}\n${resources}\n${disk}\n${procs}\nSystem Agent — diagnosis: ${verdict}. Mutating actions (restart, kill, cleanup) need DevOps approval — say the word.`;
  }
}

async function readCpuModel(): Promise<string | null> {
  try {
    const { readFileSync } = await import('fs');
    const info = readFileSync('/proc/cpuinfo', 'utf8');
    const model = info.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim();
    return model ?? null;
  } catch {
    return null;
  }
}
