import { describe, expect, it, vi } from 'vitest';
import type { PluginHelpers } from '@loyaltyledger/core';
import { rollingTierPlugin } from './rolling-tier.js';

const baseHelpers = (): PluginHelpers => ({
  now: () => new Date('2024-01-31T12:00:00Z'),
  generateId: () => 'id',
  getProgramConfig: async () => ({}) as any,
  getAccountBalance: async () => 0n,
  getRollingSpendCents: async () => 0n,
  upsertCustomerTier: async () => {},
});

describe('rollingTierPlugin', () => {
  it('skips when no loyalty_tiers config', async () => {
    const helpers = baseHelpers();
    const result = await rollingTierPlugin.apply(
      {
        tenantId: 'tenant_test',
        receipt: {
          schema_version: '1.0',
          idempotency_key: 'key',
          issued_at: '2024-01-01T10:00:00Z',
          currency: 'USD',
          merchant: { merchant_id: 'merchant_a' },
          buyer: { account_ref: 'acct_1' },
          totals: { grand_total: 10 },
          line_items: [],
        },
        receiptId: 'receipt_1',
      },
      helpers,
    );

    expect(result).toBeNull();
  });

  it('persists tier based on rolling spend', async () => {
    const upsert = vi.fn(async () => {});
    const helpers: PluginHelpers = {
      ...baseHelpers(),
      getProgramConfig: async () =>
        ({
          loyalty_tiers: {
            window_days: 90,
            tiers: [
              { id: 'base', display_name: 'Base', threshold_cents: 0 },
              { id: 'silver', display_name: 'Silver', threshold_cents: 15000 },
            ],
          },
        }) as any,
      getRollingSpendCents: async () => 18000n,
      upsertCustomerTier: upsert,
    };

    const result = await rollingTierPlugin.apply(
      {
        tenantId: 'tenant_test',
        receipt: {
          schema_version: '1.0',
          idempotency_key: 'key',
          issued_at: '2024-01-30T10:00:00Z',
          currency: 'USD',
          merchant: { merchant_id: 'merchant_a' },
          buyer: { account_ref: 'acct_1' },
          totals: { grand_total: 60 },
          line_items: [],
        },
        receiptId: 'receipt_1',
      },
      helpers,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0][0];
    expect(args.tenantId).toBe('tenant_test');
    expect(args.merchantId).toBe('merchant_a');
    expect(args.tierId).toBe('silver');
    expect(args.tierName).toBe('Silver');
    expect(args.windowDays).toBe(90);
    expect(args.rollingSpendCents).toBe(18000n);
    expect(args.customerAccount).toBe('tenant_test::acct::acct_1');

    expect(result).not.toBeNull();
    expect(result?.summary).toEqual({
      loyalty_tier: {
        merchant_id: 'merchant_a',
        customer_account: 'tenant_test::acct::acct_1',
        tier_id: 'silver',
        tier_name: 'Silver',
        rolling_spend_cents: 18000,
        window_days: 90,
      },
    });
  });

  it('defaults to lowest tier when spend below thresholds', async () => {
    const upsert = vi.fn(async () => {});
    const helpers: PluginHelpers = {
      ...baseHelpers(),
      getProgramConfig: async () =>
        ({
          loyalty_tiers: {
            window_days: 60,
            tiers: [
              { id: 'base', threshold_cents: 0 },
              { id: 'gold', threshold_cents: 50000 },
            ],
          },
        }) as any,
      getRollingSpendCents: async () => 2000n,
      upsertCustomerTier: upsert,
    };

    await rollingTierPlugin.apply(
      {
        tenantId: 'tenant_test',
        receipt: {
          schema_version: '1.0',
          idempotency_key: 'key',
          issued_at: '2024-01-30T10:00:00Z',
          currency: 'USD',
          merchant: { merchant_id: 'merchant_a' },
          buyer: { account_ref: 'acct_1' },
          totals: { grand_total: 10 },
          line_items: [],
        },
        receiptId: 'receipt_1',
      },
      helpers,
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tierId: 'base',
        tierName: 'base',
        rollingSpendCents: 2000n,
      }),
    );
  });
});
