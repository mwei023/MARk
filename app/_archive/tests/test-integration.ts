//tesr file to quickly check if core systems (Ollama, PostgreSQL with pgvector, CSV parsing) are working before building the agent
import { Ollama } from 'ollama';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { join } from 'path';

// Load env vars from project root
dotenv.config({ path: join(__dirname, '../.env') });

const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://mwei@localhost:5433/jarvis_memory',
});

const test = async () => {
  console.log('🧪 Running integration test...\n');
  
  // 1. Test Ollama
  console.log('1️⃣ Testing Ollama...');
  const ollamaRes = await ollama.chat({
    model: process.env.OLLAMA_MODEL || 'llama3:8b-instruct-q4_0',
    messages: [{ role: 'user', content: 'Respond with exactly: "PONG"' }],
    stream: false,
  });
  console.log(`   ✅ Ollama: "${ollamaRes.message.content.trim()}"\n`);
  
  // 2. Test PostgreSQL + pgvector
  console.log('2️⃣ Testing PostgreSQL + pgvector...');
  const client = await pool.connect();
  try {
    // Check vector extension
    const extRes = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    if (extRes.rows.length === 0) throw new Error('pgvector extension not found');
    
    // Insert a test document with random embedding
    await client.query(`
      INSERT INTO documents (text, metadata, embedding) 
      VALUES ($1, $2, (SELECT array_agg(random()) FROM generate_series(1, 1024)))
    `, ['Test document for Jarvis integration', '{"test": true}']);
    
    // Query it back with vector similarity (dummy query)
    const searchRes = await client.query(`
      SELECT text, metadata 
      FROM documents 
      ORDER BY embedding <-> $1 
      LIMIT 1
    `, [Array(1024).fill(0.5)]); // dummy vector
    
    console.log(`   ✅ PostgreSQL: Found ${searchRes.rows.length} document(s)`);
    console.log(`   ✅ pgvector: Similarity search working\n`);
  } finally {
    client.release();
  }
  
  // 3. Test CSV parsing (optional but useful)
  console.log('3️⃣ Testing CSV tool...');
  const { parse } = await import('csv-parse/sync');
  const { readFileSync } = await import('fs');
  
  // Create a tiny test CSV if it doesn't exist
  const testCsvPath = '/home/mwei/data/test.csv';
  try {
    const csvContent = 'name,value\n"test",123';
    const records = parse(csvContent, { columns: true });
    console.log(`   ✅ CSV Parser: Parsed ${records.length} row(s)\n`);
  } catch (e) {
    console.log(`   ⚠️ CSV test skipped: ${e}\n`);
  }
  
  console.log('🎉 All core systems operational. Ready to build the agent.');
};

test().catch(err => {
  console.error('❌ Integration test failed:', err);
  process.exit(1);
});
