// src/tools/system_check.ts
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

// 🛡️ Allowlist: Only these command prefixes are permitted
const ALLOWED_COMMANDS = [
  'ls', 'df', 'free', 'uptime', 'whoami', 'pwd', 'date', 'uname',
  'ps', 'top', 'htop', 'du', 'cat', 'head', 'tail', 'grep', 'find'
];

export const createSystemCheckTool = () => ({
  description: "Run safe system commands: ls, df, free, ps, etc.",
  argsSchema: z.object({
    command: z.string().describe("Shell command to run, e.g., 'ls -la ~' or 'df -h'"),
  }),
  func: async (args: { command: string }) => {
    const rawCmd = args.command?.trim();
    if (!rawCmd) return "❌ No command provided.";
    
    // Extract base command (first word)
    const baseCmd = rawCmd.split(' ')[0].toLowerCase();
    
    // 🛡️ Allowlist check
    if (!ALLOWED_COMMANDS.includes(baseCmd)) {
      return `❌ Command '${baseCmd}' not allowed.\nAllowed: ${ALLOWED_COMMANDS.join(', ')}`;
    }
    
    // 🛡️ Block dangerous patterns
    const dangerous = ['rm -rf', 'sudo', 'chmod 777', '>', '>>', '|', ';', '`', '$(', '&&', '||'];
    if (dangerous.some(pattern => rawCmd.includes(pattern))) {
      return `❌ Command contains unsafe patterns. Please rephrase.`;
    }
    
    try {
      const { stdout, stderr } = await execPromise(rawCmd, {
        timeout: 15000,
        env: { ...process.env, PATH: process.env.PATH || '/usr/bin:/bin' },
        cwd: process.env.HOME || '/home/mwei',
        shell: '/bin/bash',
      });
      
      const output = (stdout || stderr || 'Command completed.').trim();
      // Truncate long output for TTS friendliness
      return output.length > 500 
        ? `${output.slice(0, 500)}\n... (output truncated)` 
        : output;
        
    } catch (error: any) {
      return `❌ Error: ${error.message || 'Command failed'}`;
    }
  },
});