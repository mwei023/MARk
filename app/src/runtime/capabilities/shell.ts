import { Capability, register } from './registry';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);
const ALLOWED = ['ls', 'df', 'free', 'uptime', 'whoami', 'pwd', 'ps'];

export class ShellCapability implements Capability {
  id = "shell:local"; name = "Local Shell"; provides = ALLOWED;
  async execute(method: string, args: { command: string }) {
    if (!ALLOWED.includes(method)) return `❌ '${method}' not allowed`;
    const dangerous = ['rm -rf', 'sudo', '>', '|', ';', '`', '$('];
    if (dangerous.some(p => args.command.includes(p))) return `❌ Unsafe pattern`;
    try {
      const { stdout } = await execPromise(args.command, { timeout: 15000 });
      return stdout.trim().slice(0, 500) + (stdout.length > 500 ? '…' : '');
    } catch (e: any) { return `❌ ${e.message}`; }
  }
}
register(new ShellCapability());
