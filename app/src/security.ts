import { createWriteStream } from 'fs';
import { join } from 'path';
import { z } from 'zod';

// Allowlist: ONLY these command prefixes are permitted
export const ALLOWED_COMMAND_PREFIXES = [
  'git status',
  'git diff',
  'docker ps',
  'docker stats --no-stream',
  'ping -c',
  'curl -s',
  'npm run build',
  'systemctl status',
  'cat ', // careful with this one
] as const;

// Schema for tool arguments (example: CSV tool)
export const csvToolSchema = z.object({
  filePath: z.string().refine(path => 
    path.startsWith(process.env.ALLOWED_DATA_DIR || '/home/mwei/data'),
    { message: `Path must be within ${process.env.ALLOWED_DATA_DIR}` }
  ),
  format: z.string().optional(),
});


// Audit logger
export type AuditStatus = 'SUCCESS' | 'BLOCKED' | 'ERROR'; // ← Add ERROR, remove FAILED

export const logAction = async (
  userId: string, 
  action: string, 
  status: AuditStatus, // ← Use the union type
  details?: string
) => {
  const entry = `[${new Date().toISOString()}] USER:${userId} | ACTION:${action} | STATUS:${status}${details ? ` | DETAILS:${details}` : ''}\n`;
  
  const stream = createWriteStream(join(__dirname, '../audit.log'), { flags: 'a' });
  stream.write(entry);
  stream.end();
  
  // TODO: Also insert into PostgreSQL audit_logs table
  console.log(`[AUDIT] ${entry.trim()}`);
};

// Command validator
export const isCommandSafe = (command: string): boolean => {
  // Block dangerous patterns
  if (/[;&|`$(){}\\]/.test(command)) return false;
  if (command.includes('rm -rf') || command.includes('sudo')) return false;
  
  // Check allowlist
  return ALLOWED_COMMAND_PREFIXES.some(prefix => command.startsWith(prefix));
};