import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestPool } from '../testing/setup.js';
import { closePool } from '../db.js';
import { generateId } from '@loyaltyledger/core';
import { createMockAdapter, resetMockAdapter } from '../adapters/mock.js';
import { PayoutSubmitter } from './payout-submitter.js';
import { PayoutReconciler } from './reconciler.js';

describe('PayoutReconciler', () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = await createTestPool();
    resetMockAdapter();
  });

  afterEach(async () => {
    await closePool();
  });

  it('transitions submitted payout items to succeeded when PSP reports success', async () => {
    const tenantId = 'tenant_reconcile';
    const merchantAccount = 'merchant::acct::reconcile';
    const batchId = generateId();
    const itemId = generateId();

    await pool.query(
      `INSERT INTO payment_accounts (tenant_id, merchant_id, psp, psp_account_id, currency)
       VALUES ($1, $2, 'mock', 'acct_mock_reconcile', 'USD')`,
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
    await submitter.processNextPending();

    await pool.query(
      `UPDATE payout_items SET updated_at = NOW() - INTERVAL '10 hours' WHERE item_id = $1`,
      [itemId],
    );

    const reconciler = new PayoutReconciler(createMockAdapter());
    await reconciler.reconcileSubmitted();

    const item = await pool.query(
      `SELECT status, error FROM payout_items WHERE item_id = $1`,
      [itemId],
    );
    expect(item.rows[0].status).toBe('succeeded');
    expect(item.rows[0].error).toBeNull();
  });

  it('marks collections as succeeded when PSP lookup succeeds', async () => {
    const tenantId = 'tenant_collect_reconcile';
    const merchantAccount = 'merchant::acct::collect_reconcile';
    const batchId = generateId();
    const itemId = generateId();

    await pool.query(
      `INSERT INTO payment_accounts (tenant_id, merchant_id, psp, psp_account_id, currency)
       VALUES ($1, $2, 'mock', 'acct_mock_collect_reconcile', 'USD')`,
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
    await submitter.processNextPending();

    await pool.query(
      `UPDATE collections SET updated_at = NOW() - INTERVAL '10 hours' WHERE payout_item_id = $1`,
      [itemId],
    );
    await pool.query(
      `UPDATE payout_items SET updated_at = NOW() - INTERVAL '10 hours' WHERE item_id = $1`,
      [itemId],
    );

    const reconciler = new PayoutReconciler(createMockAdapter());
    await reconciler.reconcileSubmitted();

    const collection = await pool.query(
      `SELECT status, error FROM collections WHERE payout_item_id = $1`,
      [itemId],
    );
    expect(collection.rows[0].status).toBe('succeeded');
    expect(collection.rows[0].error).toBeNull();

    const item = await pool.query(
      `SELECT status FROM payout_items WHERE item_id = $1`,
      [itemId],
    );
    expect(item.rows[0].status).toBe('succeeded');
  });
});
