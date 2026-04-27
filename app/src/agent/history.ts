// src/agent/history.ts
import { Pool } from 'pg';

// 🔑 Lazy pool (same pattern as rags.ts)
let _pool: Pool | null = null;
const getPool = (): Pool => {
  if (!_pool) {
    const conn = process.env.DATABASE_URL;
    if (!conn) throw new Error('DATABASE_URL not set');
    _pool = new Pool({ connectionString: conn });
  }
  return _pool;
};

export const saveTurn = async (userId: string, userMsg: string, assistantMsg: string) => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO conversation_history (user_id, role, content) VALUES
     ($1, 'user', $2), ($1, 'assistant', $3)`,
    [userId, userMsg, assistantMsg]
  );
};

export const getRecentHistory = async (userId: string, limit: number = 5): Promise<string> => {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT role, content FROM conversation_history
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit * 2] // Each turn = 2 rows
  );
  
  if (rows.length === 0) return "No recent conversation history.";
  
  // Reverse to chronological order & format for prompt
  return rows
    .reverse()
    .map(r => `${r.role === 'user' ? '🗣️ You' : '🤖 Jarvis'}: ${r.content}`)
    .join('\n');
};
