// src/db/sessions.ts - Minimal command audit logger (bridges legacy agent).
// Writes to incident_actions when available; never throws (audit must not break commands).
import { getPool } from './postgres';

export interface CommandLogInput {
  userId: string;
  command: string;
  args: readonly string[] | string[];
  output: string;
  error?: string;
  success: boolean;
}

export const logCommandExecution = async (input: CommandLogInput): Promise<void> => {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO incident_actions (incident_id, timestamp, agent, action, tool, args, result, details)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)`,
      [
        `CMD-${input.userId}`,
        'legacy-agent',
        `command:${input.command}`,
        'terminal',
        JSON.stringify({ args: input.args }),
        input.success ? 'success' : 'failure',
        (input.error || input.output || '').slice(0, 2000),
      ],
    );
  } catch (error) {
    console.warn('[sessions] audit log skipped:', error instanceof Error ? error.message : String(error));
  }
};
