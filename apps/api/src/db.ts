import { randomBytes, scrypt as scryptCb } from 'crypto';
import { promisify } from 'util';
import { Pool, PoolClient } from 'pg';
import { CONFIG } from './config.js';

const scrypt = promisify(scryptCb);

const needsSSL = CONFIG.databaseUrl.includes('render.com') || CONFIG.databaseUrl.startsWith('postgresql://');

export const pool = new Pool({
  connectionString: CONFIG.databaseUrl,
  ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
});

export type TxFn<T> = (client: PoolClient) => Promise<T>;

export async function withTransaction<T>(fn: TxFn<T>): Promise<T> {
  const client = await pool.connect();
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

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS receipts (
      receipt_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      buyer_account_ref TEXT NOT NULL,
      merchant_reference TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      currency TEXT NOT NULL,
      grand_total_cents BIGINT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, idempotency_key),
      UNIQUE (tenant_id, fingerprint)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_journal (
      entry_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      program_id TEXT NOT NULL,
      receipt_id UUID,
      memo TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_lines (
      entry_id UUID NOT NULL REFERENCES ledger_journal(entry_id) ON DELETE CASCADE,
      line_no SMALLINT NOT NULL,
      account_id TEXT NOT NULL,
      dr BIGINT NOT NULL DEFAULT 0,
      cr BIGINT NOT NULL DEFAULT 0,
      unit TEXT NOT NULL,
      PRIMARY KEY (entry_id, line_no)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_api_keys (
      tenant_id TEXT PRIMARY KEY,
      api_key_hash BYTEA NOT NULL,
      salt BYTEA NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  if (CONFIG.bootstrapTenantId && CONFIG.bootstrapApiKey) {
    await upsertTenantApiKey(CONFIG.bootstrapTenantId, CONFIG.bootstrapApiKey);
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_receipts_tenant_idempotency
      ON receipts(tenant_id, idempotency_key);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_receipts_tenant_fingerprint
      ON receipts(tenant_id, fingerprint);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ledger_lines_account
      ON ledger_lines(account_id, unit);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ledger_journal_tenant
      ON ledger_journal(tenant_id, program_id);
  `);
}

async function upsertTenantApiKey(tenantId: string, apiKey: string) {
  const salt = randomBytes(16);
  const hash = (await scrypt(apiKey, salt, 32)) as Buffer;

  await pool.query(
    `INSERT INTO tenant_api_keys (tenant_id, api_key_hash, salt, active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (tenant_id)
       DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash,
                     salt = EXCLUDED.salt,
                     active = TRUE,
                     created_at = NOW()`,
    [tenantId, hash, salt],
  );
}
