// src/test-db.ts
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try multiple .env locations
dotenv.config({ path: join(__dirname, '../.env') }) || 
dotenv.config({ path: join(__dirname, '../../.env') });

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  // Optional: explicit auth params as fallback
  user: process.env.DB_USER || 'mwei',
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  database: process.env.DB_NAME || 'jarvis_memory',
});

const main = async () => {
  try {
    const res = await pool.query('SELECT NOW() as connected_at');
    console.log('✅ Database connected:', res.rows[0]);
    
    // Test pgvector extension
    const ext = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");

    try {
        await pool.query(`SELECT '[1,2,3]'::vector <-> '[4,5,6]'::vector as distance`);
        console.log('✅ pgvector extension: active and functional');
    } catch (vecError: any) {
        console.warn('⚠️ pgvector query failed:', vecError.message);
        console.log('💡 Try: CREATE EXTENSION vector; (as superuser if needed)');
    }
    console.log(ext.rows.length > 0 ? '✅ pgvector extension: active' : '⚠️ pgvector: not found');
    
  } catch (error: any) {
    console.log('🔍 Env debug:');
    console.log('  DATABASE_URL:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')); // Hide password
    console.log('  DB_PASSWORD:', process.env.DB_PASSWORD ? '***set***' : '❌ missing');
    console.error('❌ Connection failed:', error.message);
    console.log('\n💡 Tips:');
    console.log('  1. Check DATABASE_URL includes password: postgres://user:pass@host:port/db');
    console.log('  2. Ensure PostgreSQL is running: docker compose ps');
    console.log('  3. Verify .env is loaded:', process.env.DATABASE_URL ? '✅' : '❌');
  } finally {
    await pool.end();
  }
};

main();