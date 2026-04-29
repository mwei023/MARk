// src/agent/commands/terminal.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logCommandExecution } from '../../db/sessions'; // your PG logger

const execFilePromise = promisify(execFile);

// 🛡️ ALLOWLIST: Only these command prefixes are permitted
export const ALLOWED_COMMANDS = {
  'list files': { cmd: 'ls', args: ['-la', process.env.HOME || '/home/mwei'] },
  'check disk': { cmd: 'df', args: ['-h'] },
  'check memory': { cmd: 'free', args: ['-h'] },
  'check network': { cmd: 'ip', args: ['a'] },
  'restart cloudflared': { 
    cmd: 'systemctl', 
    args: ['restart', 'cloudflared'],
    requiresConfirmation: true, // 🔒 destructive actions need explicit OK
    allowedServices: ['cloudflared', 'nginx'] // extra guardrail
  },
  // Add more as needed — always explicit, never wildcard
} as const;

export type CommandKey = keyof typeof ALLOWED_COMMANDS;

export const executeCommand = async (
  commandKey: CommandKey, 
  userId: string
): Promise<{ success: boolean; output: string; error?: string }> => {
  
  const config = ALLOWED_COMMANDS[commandKey];
  if (!config) {
    throw new Error(`Command not allowed: ${commandKey}`);
  }

  // 🔒 Extra validation for service commands
  if (config.cmd === 'systemctl' && config.allowedServices) {
    const service = config.args[1];
    if (!config.allowedServices.includes(service)) {
      throw new Error(`Service '${service}' not in allowlist`);
    }
  }

  try {
    console.log(`🔧 Executing: ${config.cmd} ${config.args.join(' ')}`);
    
    const { stdout, stderr } = await execFilePromise(config.cmd, config.args, {
      timeout: 30000,
      env: { ...process.env, PATH: process.env.PATH },
    });

    const output = stdout || stderr || 'Command completed.';
    
    // 📝 Audit log to PostgreSQL
    await logCommandExecution({
      userId,
      command: commandKey,
      args: config.args,
      output,
      success: true,
    });

    return { success: true, output };

  } catch (error: any) {
    const errorMsg = error.message || 'Unknown execution error';
    
    // 📝 Log failures too (for security audit)
    await logCommandExecution({
      userId,
      command: commandKey,
      args: config.args,
      output: '',
      error: errorMsg,
      success: false,
    });

    console.error(`⚠️ Command failed: ${errorMsg}`);
    return { success: false, output: '', error: errorMsg };
  }
};