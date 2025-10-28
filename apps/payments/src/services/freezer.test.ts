import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestPool } from '../testing/setup.js';
import { closePool } from '../db.js';
import { generateId } from '@loyaltyledger/core';
import { MerchantFreezer } from './freezer.js';

describe('MerchantFreezer', () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = await createTestPool();
  });

  afterEach(async () => {
    await closePool();
  });

  it('freezes merchants that exceed arrears thresholds', async () => {
    const tenantId = 'tenant_freeze';
    const merchantAccount = 'merchant::acct::freeze';
    const collectionId = generateId();
    const itemId = generateId();

    await pool.query(
      `INSERT INTO payout_batches (batch_id, tenant_id, period_start, period_end, currency, status)
       VALUES ($1, $2, NOW(), NOW(), 'USD', 'open')`,
      [generateId(), tenantId],
    );
    await pool.query(
      `INSERT INTO payout_items (
         item_id, batch_id, tenant_id, merchant_account, merchant_id, points_settled,
         rate_cents_per_point, gross_cents, platform_fee_bps, fee_cents,
         settlement_adj_bps, adj_cents, net_cents, direction, psp, status
       ) VALUES (
         $1, (SELECT batch_id FROM payout_batches LIMIT 1), $2, $3, $3, -50,
         100, -5000, 0, 0,
         NULL, 0, -5000, 'collect', 'mock', 'failed'
       )`,
      [itemId, tenantId, merchantAccount],
    );

    await pool.query(
      `INSERT INTO collections (
         collection_id, tenant_id, payout_item_id, merchant_id, merchant_account,
         amount_cents, currency, psp, status, attempts, error, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         6000, 'USD', 'mock', 'failed', 5, 'Exceeded attempts', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'
       )`,
      [collectionId, tenantId, itemId, merchantAccount, merchantAccount],
    );

    const freezer = new MerchantFreezer();
    await freezer.evaluate();

    const status = await pool.query(
      `SELECT frozen FROM merchant_status WHERE tenant_id = $1 AND merchant_account = $2`,
      [tenantId, merchantAccount],
    );
    expect(status.rowCount).toBe(1);
    expect(status.rows[0].frozen).toBe(true);
  });

  it('unfreezes merchants once arrears are cleared', async () => {
    const tenantId = 'tenant_thaw';
    const merchantAccount = 'merchant::acct::thaw';
    const batchId = generateId();
    const itemId = generateId();

    await pool.query(
      `INSERT INTO merchant_status (tenant_id, merchant_account, frozen, updated_at)
       VALUES ($1, $2, TRUE, NOW())`,
      [tenantId, merchantAccount],
    );

    await pool.query(
      `INSERT INTO payout_batches (batch_id, tenant_id, period_start, period_end, currency, status)
       VALUES ($1, $2, NOW(), NOW(), 'USD', 'open')`,
      [batchId, tenantId],
    );
    await pool.query(
      `INSERT INTO payout_items (
         item_id, batch_id, tenant_id, merchant_account, merchant_id, points_settled,
         rate_cents_per_point, gross_cents, platform_fee_bps, fee_cents,
         settlement_adj_bps, adj_cents, net_cents, direction, psp, status
       ) VALUES (
         $1, $2, $3, $4, $4, 100,
         100, 10000, 0, 0,
         NULL, 0, 10000, 'payout', 'mock', 'succeeded'
       )`,
      [itemId, batchId, tenantId, merchantAccount],
    );

    await pool.query(
      `INSERT INTO collections (
         collection_id, tenant_id, payout_item_id, merchant_id, merchant_account,
         amount_cents, currency, psp, status, attempts, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         1000, 'USD', 'mock', 'succeeded', 1, NOW(), NOW()
       )`,
      [generateId(), tenantId, itemId, merchantAccount, merchantAccount],
    );

    const freezer = new MerchantFreezer();
    await freezer.evaluate();

    const status = await pool.query(
      `SELECT frozen FROM merchant_status WHERE tenant_id = $1 AND merchant_account = $2`,
      [tenantId, merchantAccount],
    );
    expect(status.rows[0].frozen).toBe(false);
  });
});
