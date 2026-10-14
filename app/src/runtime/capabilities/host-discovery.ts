import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Capability } from './registry';

const execFilePromise = promisify(execFile);

export class HostDiscoveryCapability implements Capability {
  id = 'host.discovery';
  name = 'Host discovery and capability probe';

  canHandle(input: string): boolean {
    const cmd = String(input || '').toLowerCase();
    return /\bhost\.discover\b|\bdiscover host\b|\bwhat (host|machine)\b|\bwhere (am i|am i)\b/.test(cmd);
  }

  async execute(_input: string): Promise<string> {
    const info: Record<string, any> = {};
    try {
      info.hostname = os.hostname();
      info.platform = os.platform();
      info.release = os.release();
      info.arch = os.arch();
      info.cpus = os.cpus().length;
      info.cpuModel = os.cpus()[0]?.model ?? null;
      info.totalMem = os.totalmem();
      info.freeMem = os.freemem();
      info.uptimeSec = Math.floor(os.uptime());
      info.networkInterfaces = os.networkInterfaces();
      info.env = {
        display: process.env.DISPLAY ?? null,
        adbServer: process.env.ADB_SERVER_SOCKET ?? null,
      };

      // Probe for common host-installed command-line apps.
      const commands = ['git', 'node', 'python3', 'python', 'docker', 'adb', 'snap', 'systemctl', 'bash'];
      const installed: Record<string, boolean | string> = {};
      await Promise.all(commands.map(async (cmd) => {
        try {
          const { stdout } = await execFilePromise('which', [cmd], { timeout: 5000 });
          installed[cmd] = String(stdout || '').trim() || true;
        } catch {
          installed[cmd] = false;
        }
      }));
      info.installedCommands = installed;

      // Docker availability check
      try {
        const { stdout } = await execFilePromise('docker', ['version', '--format', '{{.Client.Version}}'], { timeout: 5000 });
        info.docker = { available: true, version: String(stdout).trim() };
      } catch {
        info.docker = { available: false };
      }

      // ADB availability check (Android device interaction)
      try {
        const { stdout } = await execFilePromise('adb', ['version'], { timeout: 5000 });
        info.adb = { available: true, version: String(stdout).trim() };
        // quick list of connected devices if any (non-blocking)
        try {
          const { stdout: devout } = await execFilePromise('adb', ['devices', '-l'], { timeout: 5000 });
          info.adb.connected = String(devout).trim();
        } catch {
          info.adb.connected = null;
        }
      } catch {
        info.adb = { available: false };
      }

      // Suggest capabilities that could be registered based on discovery
      const suggestions: string[] = [];
      if (info.adb && info.adb.available) suggestions.push('android.adb');
      if (info.docker && info.docker.available) suggestions.push('docker.control');
      if (installed['git']) suggestions.push('repo.access');
      if (installed['node']) suggestions.push('node.runtime');
      info.suggestedCapabilities = suggestions;

      return JSON.stringify({ status: 'ok', info }, null, 2);
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: String(err?.message || err) });
    }
  }
}

export default HostDiscoveryCapability;
