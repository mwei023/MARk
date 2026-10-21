import { Capability } from './registry';
import { routeLocally } from '../router';
import { stripQuoted } from '../../core/gateway';
import { createSystemCheckTool } from '../../tools/system_check';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'node:os';

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
    // Intent, not payload: quoted file content must never claim a
    // capability (observed live: a dashboard write answered the date
    // because its HTML mentioned "time"). Agents receive the full text.
    const intent = stripQuoted(input);
    return routeLocally(intent) !== null || /\bgit\s+(status|branch|log)\b/i.test(intent);
  }

  async execute(input: string): Promise<string> {
    const stripped = stripQuoted(input);
    if (/\bgit\s+(status|branch|log)\b/i.test(stripped)) {
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

    const intent = routeLocally(stripped);
    if (!intent) return 'No matching local capability.';

    if (intent.type === 'time') {
      return `It's ${new Date().toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi' })}.`;
    }
    if (intent.type === 'date') {
      return `Today is ${new Date().toLocaleDateString('en-KE', {
        timeZone: 'Africa/Nairobi', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      })}.`;
    }

    if (intent.type === 'files') {
      // Search-first phrasing ("list all mp4 files"): if the input names a
      // file extension, answer with a filename find instead of a raw listing.
      const extMatch = /\b(?:mp4|mkv|avi|mov|mp3|wav|flac|pdf|docx?|xlsx?|pptx?|csv|zip|tar|jpe?g|png|gif|svg|txt|md|json|ts|js|py|ipynb)\b/i
        .exec(stripped);
      const ext = extMatch ? extMatch[0].toLowerCase() : null;
      if (ext) {
        const target = intent.path?.trim() || homedir();
        try {
          const { stdout } = await promisify(execFile)('find', [
            target, '-maxdepth', '5', '-not', '-path', '*/node_modules/*',
            '-type', 'f', '-iname', `*.${ext}`,
          ], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
            .catch((err: { stdout?: string; stderr?: string; message?: string }) => {
              // find exits 1 when it hits unreadable directories — that is
              // a partial result, not a failure. Only fail with no matches.
              if (typeof err?.stdout === 'string' && err.stdout.trim()) return { stdout: err.stdout };
              throw new Error('nothing found (critical error)');
            });
          const found = stdout.trim() ? stdout.trim().split('\n') : [];
          if (found.length === 0) return `No ${ext} files found under ${target}.`;
          const shown = found.slice(0, 25);
          const more = found.length > shown.length ? `\n… and ${found.length - shown.length} more` : '';
          return `Found ${found.length} ${ext} file(s) under ${target}:\n${shown.join('\n')}${more}`;
        } catch (error: any) {
          return `Could not search ${target}: ${error.message || 'unknown error'}`;
        }
      }
      // Plain directory listing: honor the bound folder ("downloads folder"),
      // default to the home directory. Cap output so answers stay readable.
      const target = intent.path?.trim() || homedir();
      try {
        const { stdout } = await execFilePromise('ls', ['-la', '--', target], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
        const lines = stdout.trimEnd().split('\n');
        const shown = lines.slice(0, 40);
        const more = lines.length > shown.length ? `\n… (${lines.length - shown.length} more entries not shown)` : '';
        return `Contents of ${target}:\n${shown.join('\n')}${more}`;
      } catch (error: any) {
        return `Could not list ${target}: ${error.message || 'unknown error'}`;
      }
    }

    const command = intent.metric === 'disk' ? 'df -h /'
      : intent.metric === 'memory' ? 'free -h'
      : 'top -bn1 | grep "Cpu(s)"';
    return createSystemCheckTool().func({ command });
  }
}
