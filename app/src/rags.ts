// src/rags.ts - MINIMAL WORKING VERSION
import { Pool } from 'pg';
import { embeddings } from './llm/embeddings';

let _pool: Pool | null = null;

const getPool = (): Pool => {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set');
    _pool = new Pool({ connectionString });
    console.log('✅ PostgreSQL pool initialized');
  }
  return _pool;
};

export const ingestDocument = async (text: string, metadata: Record<string, any> = {}) => {
  const pool = getPool();
  const rawVector = await embeddings.embedQuery(text);
  
  const cleanVector: number[] = Array.isArray(rawVector)
    ? rawVector.map(v => typeof v === 'number' ? v : parseFloat(v))
    : [];
  
  if (cleanVector.length !== 768) {
    throw new Error(`Expected 768-dim vector, got ${cleanVector.length}`);
  }
  
  const pgVectorLiteral = `[${cleanVector.join(',')}]`;
  
  await pool.query(
    `INSERT INTO documents (text, metadata, embedding) VALUES ($1, $2, $3::vector)`,
    [text, metadata, pgVectorLiteral]
  );
  
  console.log(`✅ Ingested: "${text.slice(0, 50)}..." (768 dims)`);
};

export const retrieveContext = async (query: string, limit: number = 3): Promise<string> => {
  const pool = getPool();
  
  // 1. Generate and clean the query vector
  const rawQueryVector = await embeddings.embedQuery(query);
  const cleanQueryVector: number[] = Array.isArray(rawQueryVector)
    ? rawQueryVector.map(v => typeof v === 'number' ? v : parseFloat(v))
    : [];
  
  // 🔑 CRITICAL: Define queryVectorLiteral HERE, before any other logic
  const queryVectorLiteral: string = `[${cleanQueryVector.join(',')}]`;
  
  // 2. Simple SQL query - no topic filtering for now
  const result = await pool.query(
    `SELECT text, metadata 
     FROM documents 
     WHERE 1 - (embedding <-> $1::vector) > 0.18 
     ORDER BY 1 - (embedding <-> $1::vector) DESC 
     LIMIT $2`,
    [queryVectorLiteral, limit]  // ← queryVectorLiteral is used here
  );
  
  if (result.rows.length === 0) return "";
  
  // 3. Format and return results
  return result.rows.map((row: any, i: number) => 
    `[${i + 1}] ${row.text}`
  ).join('\n\n');
};

export const clearDocuments = async () => {
  const pool = getPool();
  await pool.query('DELETE FROM documents');
  console.log("🗑️ Cleared knowledge base");
};

export const shutdown = async () => {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
};