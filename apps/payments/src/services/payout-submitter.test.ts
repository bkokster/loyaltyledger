import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestPool } from '../testing/setup.js';
import { closePool } from '../db.js';
import { generateId } from '@loyaltyledger/core';
import { PayoutSubmitter } from './payout-submitter.js';
import { createMockAdapter, resetMockAdapter } from '../adapters/mock.js';

describe('PayoutSubmitter', () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = await createTestPool();
    resetMockAdapter();
  });

  afterEach(async () => {
    await closePool();
  });

  it('submits payout items to the PSP adapter', async () => {
    const tenantId = 'tenant_submit';
    const merchantAccount = 'merchant::acct::submit';
    const batchId = generateId();
    const itemId = generateId();

    await pool.query(
      `INSERT INTO payment_accounts (tenant_id, merchant_id, psp, psp_account_id, currency)
       VALUES ($1, $2, 'mock', 'acct_mock_submit', 'USD')`,
      [tenantId, merchantAccount],
    );

    await pool.query(
      `INSERT INTO payout_batches (batch_id, tenant_id, period_start, period_end, currency, status, summary)
       VALUES ($1, $2, NOW(), NOW(), 'USD', 'open', '{"total_items":1}')`,
      [batchId, tenantId],
    );

    await pool.query(
      `INSERT INTO payout_items (
         item_id, batch_id, tenant_id, merchant_account, merchant_id, points_settled,
         rate_cents_per_point, gross_cents, platform_fee_bps, fee_cents,
         settlement_adj_bps, adj_cents, net_cents, direction, psp, status
       ) VALUES (
         $1, $2, $3, $4, $5, 500,
         100, 50000, 200, 1000,
         NULL, 0, 49000, 'payout', 'mock', 'pending'
       )`,
      [itemId, batchId, tenantId, merchantAccount, merchantAccount],
    );

    const submitter = new PayoutSubmitter(createMockAdapter());
    const processed = await submitter.processNextPending();
    expect(processed).toBe(true);

    const item = await pool.query(
      `SELECT status, psp_transfer_id, error FROM payout_items WHERE item_id = $1`,
      [itemId],
    );
    expect(item.rows[0].status).toBe('submitted');
    expect(item.rows[0].psp_transfer_id).toMatch(/^mock_payout_/);
    expect(item.rows[0].error).toBeNull();
  });

  it('creates collection records for negative net settlements', async () => {
    const tenantId = 'tenant_collect';
    const merchantAccount = 'merchant::acct::collect';
    const batchId = generateId();
    const itemId = generateId();

    await pool.query(
      `INSERT INTO payment_accounts (tenant_id, merchant_id, psp, psp_account_id, currency)
       VALUES ($1, $2, 'mock', 'acct_mock_collect', 'USD')`,
      [tenantId, merchantAccount],
    );

    await pool.query(
      `INSERT INTO payout_batches (batch_id, tenant_id, period_start, period_end, currency, status, summary)
       VALUES ($1, $2, NOW(), NOW(), 'USD', 'open', '{"total_items":1}')`,
      [batchId, tenantId],
    );

    await pool.query(
      `INSERT INTO payout_items (
         item_id, batch_id, tenant_id, merchant_account, merchant_id, points_settled,
         rate_cents_per_point, gross_cents, platform_fee_bps, fee_cents,
         settlement_adj_bps, adj_cents, net_cents, direction, psp, status
       ) VALUES (
         $1, $2, $3, $4, $5, -200,
         100, -20000, 0, 0,
         NULL, 0, -20000, 'collect', 'mock', 'pending'
       )`,
      [itemId, batchId, tenantId, merchantAccount, merchantAccount],
    );

    const submitter = new PayoutSubmitter(createMockAdapter());
    const processed = await submitter.processNextPending();
    expect(processed).toBe(true);

    const collection = await pool.query(
      `SELECT status, attempts, psp_debit_id FROM collections WHERE payout_item_id = $1`,
      [itemId],
    );
    expect(collection.rowCount).toBe(1);
    expect(collection.rows[0].status).toBe('submitted');
    expect(collection.rows[0].attempts).toBe(1);
    expect(collection.rows[0].psp_debit_id).toMatch(/^mock_debit_/);

    const item = await pool.query(
      `SELECT status, error FROM payout_items WHERE item_id = $1`,
      [itemId],
    );
    expect(item.rows[0].status).toBe('submitted');
    expect(item.rows[0].error).toBeNull();
  });
});
