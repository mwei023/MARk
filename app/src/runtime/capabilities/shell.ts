import { Capability } from './registry';
import { routeLocally } from '../router';
import { createSystemCheckTool } from '../../tools/system_check';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);

/**
 * Linux implementation of MARK's current local-host capability.  It is a
 * deliberately narrow adapter around the existing safe system-check tool;
 * future hosts can provide a different implementation behind this interface.
 */
export class LocalHostCapability implements Capability {
  id = 'host.local';
  name = 'Local host basics';

  canHandle(input: string): boolean {
    return routeLocally(input) !== null || /\bgit\s+(status|branch|log)\b/i.test(input);
  }

  async execute(input: string): Promise<string> {
    if (/\bgit\s+(status|branch|log)\b/i.test(input)) {
      const args = /\bbranch\b/i.test(input)
        ? ['branch', '--show-current']
        : /\blog\b/i.test(input)
        ? ['log', '-1', '--oneline']
        : ['status', '--short'];
      try {
        const { stdout, stderr } = await execFilePromise('git', args, { cwd: process.cwd(), timeout: 15000 });
        return (stdout || stderr || 'Git command completed.').trim();
      } catch (error: any) {
        return `Git command failed: ${error.message || 'unknown error'}`;
      }
    }

    const intent = routeLocally(input);
    if (!intent) return 'No matching local capability.';

    if (intent.type === 'time') {
      return `It's ${new Date().toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi' })}.`;
    }
    if (intent.type === 'date') {
      return `Today is ${new Date().toLocaleDateString('en-KE', {
        timeZone: 'Africa/Nairobi', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      })}.`;
    }

    const command = intent.type === 'files'
      ? 'ls -la ~'
      : intent.metric === 'disk' ? 'df -h /'
      : intent.metric === 'memory' ? 'free -h'
      : 'top -bn1 | grep "Cpu(s)"';
    return createSystemCheckTool().func({ command });
  }
}
