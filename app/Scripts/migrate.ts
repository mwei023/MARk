/**
 * Database migration runner.
 *
 * Reads numbered SQL files from Scripts/migrations/, tracks which have been
 * applied in a _migrations table, and runs missing ones in order.
 *
 * Usage:
 *   npm run db:migrate
 *   npx ts-node --transpile-only Scripts/migrate.ts
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load .env when run directly
dotenv.config({ path: join(__dirname, '../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM _migrations ORDER BY id ASC',
  );
  return new Set(result.rows.map(r => r.filename));
}

async function getMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter(f => f.endsWith('.sql'))
    .sort(); // lexicographic: 001_ < 002_ < ...
}

async function runMigration(pool: Pool, filename: string): Promise<void> {
  const filepath = join(MIGRATIONS_DIR, filename);
  const sql = await readFile(filepath, 'utf-8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO _migrations (filename) VALUES ($1)',
      [filename],
    );
    await client.query('COMMIT');
    console.log(`  ✓ ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Migration ${filename} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.release();
  }
}

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log('Running database migrations…');
    await ensureMigrationsTable(pool);

    const applied = await getAppliedMigrations(pool);
    const files = await getMigrationFiles();
    const pending = files.filter(f => !applied.has(f));

    if (pending.length === 0) {
      console.log('  Already up to date.');
    } else {
      for (const file of pending) {
        await runMigration(pool, file);
      }
      console.log(`\nApplied ${pending.length} migration(s).`);
    }
  } finally {
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('\nMigration error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
