// src/agent/memory.ts
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const saveConversation = async (
  userId: string,
  entries: Array<{ role: string; content: string; timestamp: string }>
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    for (const entry of entries) {
      await client.query(`
        INSERT INTO conversation_history (user_id, role, content, timestamp)
        VALUES ($1, $2, $3, $4)
      `, [userId, entry.role, entry.content, entry.timestamp]);
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const loadRecentHistory = async (userId: string, limit: number = 20) => {
  const res = await pool.query(`
    SELECT role, content, timestamp 
    FROM conversation_history 
    WHERE user_id = $1 
    ORDER BY timestamp DESC 
    LIMIT $2
  `, [userId, limit]);
  
  return res.rows.reverse(); // Oldest first
};