import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createTestPool } from '../testing/setup.js';
import { closePool } from '../db.js';
import type { Pool } from 'pg';
import { generateId } from '@loyaltyledger/core';
import { PayoutScheduler } from './payout-scheduler.js';
import { createMockAdapter, resetMockAdapter } from '../adapters/mock.js';

describe('PayoutScheduler', () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = await createTestPool();
    resetMockAdapter();
  });

  afterEach(async () => {
    await closePool();
  });

  it('creates payout items from settlement reports', async () => {
    const tenantId = 'tenant_a';
    const merchantAccount = 'merchant::acct::1';
    const periodStart = new Date('2024-01-01T00:00:00Z');
    const periodEnd = new Date('2024-01-31T00:00:00Z');

    await seedConfig(pool, tenantId, {
      cents_per_point: 100,
      platform_fee_bps: 200,
      min_payout_cents: 1000,
    });

    await pool.query(
      `
        INSERT INTO payment_accounts (tenant_id, merchant_id, psp, psp_account_id, currency)
        VALUES ($1, $2, 'mock', 'acct_mock_1', 'USD')
      `,
      [tenantId, merchantAccount],
    );

    await pool.query(
      `
        INSERT INTO settlement_reports (
          report_id, tenant_id, merchant_account, period_start, period_end, net_points, summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [generateId(), tenantId, merchantAccount, periodStart.toISOString(), periodEnd.toISOString(), 500, {}],
    );

    const scheduler = new PayoutScheduler(createMockAdapter());
    await scheduler.runOnce({ periodStart, periodEnd });

    const batches = await pool.query(`SELECT * FROM payout_batches`);
    expect(batches.rowCount).toBe(1);
    expect(batches.rows[0].summary).toEqual({
      total_items: 1,
      payouts: { count: 1, amount_cents: '49000' },
      collections: { count: 0, amount_cents: '0' },
    });

    const items = await pool.query(`SELECT direction, net_cents, fee_cents FROM payout_items`);
    expect(items.rowCount).toBe(1);
    expect(items.rows[0].direction).toBe('payout');
    expect(Number(items.rows[0].net_cents)).toBe(49000);
    expect(Number(items.rows[0].fee_cents)).toBe(1000);
  });

  it('creates collection items for negative settlements above threshold', async () => {
    const tenantId = 'tenant_b';
    const merchantAccount = 'merchant::acct::2';
    const periodStart = new Date('2024-02-01T00:00:00Z');
    const periodEnd = new Date('2024-02-28T00:00:00Z');

    await seedConfig(pool, tenantId, {
      cents_per_point: 200,
      platform_fee_bps: 100,
      min_payout_cents: 1000,
    });

    await pool.query(
      `
        INSERT INTO payment_accounts (tenant_id, merchant_id, psp, psp_account_id, currency)
        VALUES ($1, $2, 'mock', 'acct_mock_2', 'USD')
      `,
      [tenantId, merchantAccount],
    );

    await pool.query(
      `
        INSERT INTO settlement_reports (
          report_id, tenant_id, merchant_account, period_start, period_end, net_points, summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [generateId(), tenantId, merchantAccount, periodStart.toISOString(), periodEnd.toISOString(), -300, {}],
    );

    const scheduler = new PayoutScheduler(createMockAdapter());
    await scheduler.runOnce({ periodStart, periodEnd });

    const items = await pool.query(`SELECT direction, net_cents FROM payout_items`);
    expect(items.rowCount).toBe(1);
    expect(items.rows[0].direction).toBe('collect');
    expect(Number(items.rows[0].net_cents)).toBe(-59400); // gross -60000, fee -600, net = -59400
  });
});

async function seedConfig(
  pool: Pool,
  tenantId: string,
  config: { cents_per_point?: number; platform_fee_bps?: number; min_payout_cents?: number },
) {
  await pool.query(
    `
      INSERT INTO program_configs (tenant_id, program_id, config)
      VALUES ($1, 'default_points', $2::jsonb)
      ON CONFLICT (tenant_id, program_id)
      DO UPDATE SET config = EXCLUDED.config
    `,
    [tenantId, JSON.stringify(config)],
  );
}
