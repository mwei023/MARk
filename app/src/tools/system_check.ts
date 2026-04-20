// src/tools/system_check.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import { isCommandSafe, logAction } from '../security';
import { z } from 'zod';
import { createTool } from './index'; // ← Import from index, not self

const execPromise = promisify(exec);

export const systemCheckArgsSchema = z.object({
  action: z.string().transform((val) => {
    // Normalize common LLM outputs to our allowed values
    const normalized = val.toLowerCase().trim();
    const map: Record<string, string> = {
      'ps': 'ps',
      'docker ps': 'ps',
      'list': 'ps',
      'containers': 'ps',
      'stats': 'stats',
      'docker stats': 'stats',
      'resources': 'stats',
      'images': 'images',
      'docker images': 'images',
      'logs': 'logs',
      'docker logs': 'logs',
      'version': 'version',
      'docker version': 'version',
    };
    return map[normalized] || normalized; // fallback to original if unmatched
  }),
});

export const createSystemCheckTool = () => createTool({
  name: "system_check",
  description: "Check Docker container status, resource usage, or logs.",
  argsSchema: systemCheckArgsSchema,
  func: async (args) => {
  // Validate normalized action is actually allowed
  const ALLOWED_ACTIONS = ['ps', 'stats', 'images', 'logs', 'version'] as const;
  if (!ALLOWED_ACTIONS.includes(args.action as any)) {
    throw new Error(`⚠️ Invalid docker action: "${args.action}". Allowed: ${ALLOWED_ACTIONS.join(', ')}`);
  }

  const cmd = `docker ${args.action}`;
    
    if (!isCommandSafe(cmd)) {
      await logAction("jarvis", cmd, "BLOCKED", "Failed safety validation");
      throw new Error("⚠️ Command blocked by safety protocol");
    }

    try {
      const { stdout, stderr } = await execPromise(cmd);
      const output = stderr ? `${stdout}\n[stderr] ${stderr}`.trim() : stdout.trim();
      let formatted: string;
      if (args.action === 'ps') {
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const count = lines.length - 1; // minus header
        const healthy = lines.filter(l => l.includes('(healthy)')).length;
        formatted = `✅ ${count} containers running (${healthy} healthy)\n\n` + `Key services:\n` +
        lines.slice(1, 4).map(l => `  • ${l.split(/\s{2,}/)[5]?.trim() || 'unknown'}`).join('\n');
      } else {
        formatted = stdout.trim() || "✅ Command executed (no output)";
      }
      await logAction("jarvis", cmd, "SUCCESS", `Output length: ${formatted.length}`);
      return formatted;
    } catch (error: any) {
      await logAction("jarvis", cmd, "ERROR", error.message); // ← Use "ERROR", not "ERROR"
      throw new Error(`❌ Command failed: ${error.message}`);
    }
  },
});