import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { setPoolForTests } from '../db.js';

export async function createTestPool(): Promise<Pool> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool();
  setPoolForTests(pool);
  await initialiseSchema(pool);
  return pool;
}

async function initialiseSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE program_configs (
      tenant_id TEXT NOT NULL,
      program_id TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, program_id)
    );
  `);

  await pool.query(`
    CREATE TABLE payment_accounts (
      tenant_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      psp TEXT NOT NULL,
      psp_account_id TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      payout_schedule TEXT NOT NULL DEFAULT 'monthly',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, merchant_id)
    );
  `);

  await pool.query(`
    CREATE TABLE settlement_reports (
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
    CREATE TABLE payout_batches (
      batch_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      summary JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, period_start, period_end)
    );
  `);

  await pool.query(`
    CREATE TABLE payout_items (
      item_id UUID PRIMARY KEY,
      batch_id UUID NOT NULL REFERENCES payout_batches(batch_id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      merchant_account TEXT NOT NULL,
      merchant_id TEXT,
      points_settled BIGINT NOT NULL,
      rate_cents_per_point INTEGER NOT NULL,
      gross_cents BIGINT NOT NULL,
      platform_fee_bps INTEGER NOT NULL,
      fee_cents BIGINT NOT NULL,
      settlement_adj_bps INTEGER,
      adj_cents BIGINT NOT NULL DEFAULT 0,
      net_cents BIGINT NOT NULL,
      direction TEXT NOT NULL,
      psp TEXT NOT NULL,
      psp_transfer_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (batch_id, merchant_account)
    );
  `);

  await pool.query(`
    CREATE TABLE collections (
      collection_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      payout_item_id UUID NOT NULL REFERENCES payout_items(item_id) ON DELETE CASCADE,
      merchant_id TEXT NOT NULL,
      merchant_account TEXT NOT NULL,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL,
      psp TEXT NOT NULL,
      psp_debit_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (payout_item_id)
    );
  `);

  await pool.query(`
    CREATE TABLE merchant_status (
      tenant_id TEXT NOT NULL,
      merchant_account TEXT NOT NULL,
      frozen BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, merchant_account)
    );
  `);

  await pool.query(`
    CREATE TABLE payment_events (
      event_id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      psp TEXT NOT NULL,
      psp_event_type TEXT NOT NULL,
      psp_object_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
