import {
  customerAccountId,
  merchantAccountId,
  type PluginHelpers,
  type Receipt,
} from '@loyaltyledger/core';
import { describe, expect, it } from 'vitest';
import { nthFreeStampsPlugin } from './nth-free-stamps.js';

const baseReceipt: Receipt = {
  schema_version: '1.0',
  idempotency_key: 'idem-1',
  issued_at: new Date('2024-01-01T10:00:00Z').toISOString(),
  currency: 'USD',
  merchant: { merchant_id: 'merchant_a' },
  buyer: { account_ref: 'acct_123' },
  totals: { grand_total: 12.5 },
  line_items: [
    { line_id: '1', sku: 'COFFEE_SM', qty: 1, unit_price: 5 },
    { line_id: '2', sku: 'COFFEE_LG', qty: 1, unit_price: 7.5 },
  ],
};

const merchantAccount = merchantAccountId('tenant_test');
const customerAccount = customerAccountId('tenant_test', 'acct_123');

describe('nthFreeStampsPlugin', () => {
  it('returns null when no stamp programs are configured', async () => {
    const helpers: PluginHelpers = {
      now: () => new Date('2024-01-01T00:00:00Z'),
      generateId: () => 'id',
      getProgramConfig: async () => ({} as any),
      getAccountBalance: async () => 0n,
      getRollingSpendCents: async () => 0n,
      upsertCustomerTier: async () => {},
    };

    const result = await nthFreeStampsPlugin.apply(
      { tenantId: 'tenant_test', receipt: baseReceipt, receiptId: 'r1' },
      helpers,
    );

    expect(result).toBeNull();
  });

  it('awards stamps for matching SKUs', async () => {
    const helpers: PluginHelpers = {
      now: () => new Date('2024-01-01T00:00:00Z'),
      generateId: () => 'id',
      getProgramConfig: async () =>
        ({
          stamp_programs: [
            {
              id: 'coffee_card',
              skus: ['COFFEE_SM', 'COFFEE_LG'],
              stamps_per_item: 1,
            },
          ],
        }) as any,
      getAccountBalance: async () => 0n,
      getRollingSpendCents: async () => 0n,
      upsertCustomerTier: async () => {},
    };

    const result = await nthFreeStampsPlugin.apply(
      { tenantId: 'tenant_test', receipt: baseReceipt, receiptId: 'r1' },
      helpers,
    );

    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(1);

    const entry = result?.entries[0];
    expect(entry?.lines).toHaveLength(2);
    expect(entry?.lines[0]).toEqual({
      accountId: merchantAccount,
      debit: 2n,
      credit: 0n,
      unit: 'stamps:coffee_card',
    });
    expect(entry?.lines[1]).toEqual({
      accountId: customerAccount,
      debit: 0n,
      credit: 2n,
      unit: 'stamps:coffee_card',
    });

    expect(result?.summary).toEqual({ stamps_added: { coffee_card: 2 } });
  });

  it('issues coupons when thresholds are crossed', async () => {
    const balanceByUnit: Record<string, bigint> = {
      'stamps:coffee_card': 9n,
    };

    const helpers: PluginHelpers = {
      now: () => new Date('2024-01-01T00:00:00Z'),
      generateId: () => 'id',
      getProgramConfig: async () =>
        ({
          stamp_programs: [
            {
              id: 'coffee_card',
              skus: ['COFFEE_SM', 'COFFEE_LG'],
              stamps_per_item: 1,
              threshold: 10,
            },
          ],
        }) as any,
      getAccountBalance: async (_accountId, _programId, unit) => balanceByUnit[unit] ?? 0n,
      getRollingSpendCents: async () => 0n,
      upsertCustomerTier: async () => {},
    };

    const result = await nthFreeStampsPlugin.apply(
      { tenantId: 'tenant_test', receipt: baseReceipt, receiptId: 'r1' },
      helpers,
    );

    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(2);

    const couponEntry = result?.entries[1];
    expect(couponEntry?.lines).toEqual([
      {
        accountId: merchantAccount,
        debit: 1n,
        credit: 0n,
        unit: 'coupon:coffee_card',
      },
      {
        accountId: customerAccount,
        debit: 0n,
        credit: 1n,
        unit: 'coupon:coffee_card',
      },
    ]);

    expect(result?.summary).toEqual({
      stamps_added: { coffee_card: 2 },
      coupons_issued: { coffee_card: 1 },
    });
  });
});
