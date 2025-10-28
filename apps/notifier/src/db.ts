import { Pool, PoolClient, type PoolConfig } from 'pg';
import { CONFIG } from './config.js';

const needsSSL = CONFIG.databaseUrl.includes('render.com') || CONFIG.databaseUrl.startsWith('postgresql://');

let poolInstance: Pool | null = null;

function createPool(config?: PoolConfig): Pool {
  if (config) {
    return new Pool(config);
  }

  return new Pool({
    connectionString: CONFIG.databaseUrl,
    ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
  });
}

export function getPool(): Pool {
  if (!poolInstance) {
    poolInstance = createPool();
  }
  return poolInstance;
}

export function setPoolForTests(pool: Pool): void {
  poolInstance = pool;
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

export type TxFn<T> = (client: PoolClient) => Promise<T>;

export async function withTransaction<T>(fn: TxFn<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
