import { randomBytes, scrypt as scryptCb } from 'crypto';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Pool, PoolClient, type PoolConfig } from 'pg';
import { CONFIG } from './config.js';

const scrypt = promisify(scryptCb);

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

export async function initDb(): Promise<void> {
  const migrationsApplied = await runMigrationsIfRequested();
  if (migrationsApplied) {
    return;
  }

  const pool = getPool();
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
      grand_total_cents BIGINT NOT NULL CHECK (grand_total_cents >= 0),
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
      dr BIGINT NOT NULL DEFAULT 0 CHECK (dr >= 0),
      cr BIGINT NOT NULL DEFAULT 0 CHECK (cr >= 0),
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS receipt_jobs (
      job_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      receipt_id UUID NOT NULL REFERENCES receipts(receipt_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      result_summary JSONB,
      completed_at TIMESTAMPTZ,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_receipt_jobs_status_available
      ON receipt_jobs(status, available_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS redeem_requests (
      request_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      program_id TEXT NOT NULL,
      unit TEXT NOT NULL,
      qty BIGINT NOT NULL CHECK (qty > 0),
      memo TEXT,
      idempotency_key TEXT,
      burn_merchant_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE redeem_requests
      ADD COLUMN IF NOT EXISTS burn_merchant_id TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS redeem_jobs (
      job_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      request_id UUID NOT NULL REFERENCES redeem_requests(request_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      result_summary JSONB,
      completed_at TIMESTAMPTZ,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_requests_tenant_idempotency
      ON redeem_requests(tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_jobs_status_available
      ON redeem_jobs(status, available_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS program_configs (
      tenant_id TEXT NOT NULL,
      program_id TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, program_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_notifications (
      notification_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      job_id UUID NOT NULL,
      reference_id UUID NOT NULL,
      status TEXT NOT NULL,
      summary JSONB,
      error TEXT,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      delivery_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settlement_reports (
      report_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      merchant_account TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      net_points BIGINT NOT NULL,
      summary JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_status (
      tenant_id TEXT NOT NULL,
      merchant_account TEXT NOT NULL,
      frozen BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, merchant_account)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS point_lots (
      lot_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      program_id TEXT NOT NULL,
      unit TEXT NOT NULL,
      customer_account TEXT NOT NULL,
      merchant_id TEXT,
      earn_entry_id UUID,
      qty_total BIGINT NOT NULL,
      qty_remaining BIGINT NOT NULL,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_point_lots_lookup
      ON point_lots(tenant_id, customer_account, program_id, unit, expires_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_redemption_rules (
      tenant_id TEXT NOT NULL,
      earn_merchant_id TEXT NOT NULL,
      earn_merchant_account TEXT NOT NULL,
      burn_merchant_id TEXT NOT NULL,
      expiry_days_override INTEGER,
      settlement_adjustment_bps INTEGER,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, earn_merchant_id, burn_merchant_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_redemption_rules_burn
      ON merchant_redemption_rules(tenant_id, burn_merchant_id)
      WHERE enabled = TRUE;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_program_configs_tenant_program
      ON program_configs(tenant_id, program_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_job_notifications_delivery
      ON job_notifications(delivered_at, available_at);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_reports_unique
      ON settlement_reports(tenant_id, merchant_account, period_start, period_end);
  `);
}

async function upsertTenantApiKey(tenantId: string, apiKey: string) {
  const salt = randomBytes(16);
  const hash = (await scrypt(apiKey, salt, 32)) as Buffer;

  await getPool().query(
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

async function runMigrationsIfRequested(): Promise<boolean> {
  if (process.env.DB_RUN_MIGRATIONS !== 'true') {
    return false;
  }

  try {
    const module = await import('node-pg-migrate');
    const run = (module as unknown as { default?: (options: unknown) => Promise<unknown>; run?: (options: unknown) => Promise<unknown> }).run ??
      (module as unknown as { default?: (options: unknown) => Promise<unknown> }).default;

    if (typeof run !== 'function') {
      throw new Error('node-pg-migrate run function not available');
    }

    const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

    await run({
      databaseUrl: CONFIG.databaseUrl,
      dir: migrationsDir,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      count: Infinity,
      noLock: true,
      logger: {
        info: () => undefined,
        warn: (msg: unknown) => console.warn('[migrate]', msg),
        error: (msg: unknown) => console.error('[migrate]', msg),
      },
    });

    return true;
  } catch (error) {
    console.warn('Failed to run migrations automatically, falling back to inline schema setup', error);
    return false;
  }
}
