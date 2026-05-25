// src/db/postgres.ts
import { Pool } from 'pg';

let _pool: Pool | null = null;

export const getPool = (): Pool => {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set');
    _pool = new Pool({ connectionString });
    console.log('✅ PostgreSQL pool initialized');
  }
  return _pool;
};

// Export for convenience (lazy-loads on first access)
export const pool = new Proxy({} as Pool, {
  get: (_, prop) => {
    return (getPool() as any)[prop];
  }
});

export const shutdown = async () => {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
};
