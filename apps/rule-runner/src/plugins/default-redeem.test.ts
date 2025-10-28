import {
  DEFAULT_PROGRAM_ID,
  DEFAULT_UNIT,
  customerAccountId,
  merchantAccountId,
  type RedeemContext,
  type RedeemHelpers,
} from '@loyaltyledger/core';
import { describe, expect, it } from 'vitest';
import { defaultRedeemPlugin } from './default-redeem.js';

const tenantId = 'tenant_z';
const context: RedeemContext = {
  tenantId,
  requestId: 'request_1',
  redeem: {
    account_id: 'acct_42',
    program_id: DEFAULT_PROGRAM_ID,
    unit: DEFAULT_UNIT,
    qty: 50,
    memo: 'use points',
  },
};

const helpers: RedeemHelpers = {
  now: () => new Date('2024-01-01T10:00:00Z'),
  generateId: () => 'generated',
  getAccountBalance: async () => 100n,
  getProgramConfig: async () => ({} as any),
  getFrozenMerchants: async () => new Set<string>(),
  getOutstandingAttribution: async (customerAccount, options) => {
    // Default: make all requested partner accounts fully eligible with 100 points
    const accounts = options.partnerAccounts.length > 0 ? options.partnerAccounts : ['tenant_z::merchant_liability'];
    return accounts.map((a) => ({ accountId: a, amount: 100n }));
  },
};

describe('defaultRedeemPlugin', () => {
  it('creates ledger mutation when balance is sufficient', async () => {
    const result = await defaultRedeemPlugin.apply(context, helpers);
    expect(result?.type).toBe('success');

    if (result?.type !== 'success') {
      throw new Error('Expected success');
    }

    const { mutation } = result;
    expect(mutation.summary).toMatchObject({ points_redeemed: 50 });
    expect(mutation.entries).toHaveLength(1);

    const entry = mutation.entries[0];
    expect(entry.programId).toBe(DEFAULT_PROGRAM_ID);

    const customerAccount = customerAccountId(tenantId, 'acct_42');
    const merchantAccount = merchantAccountId(tenantId);

    expect(entry.lines[0]).toMatchObject({ accountId: customerAccount, debit: 50n, credit: 0n });
    expect(entry.lines[1]).toMatchObject({ accountId: merchantAccount, debit: 0n, credit: 50n });
  });

  it('allocates across partner merchants with proportional weights', async () => {
    const result = await defaultRedeemPlugin.apply(context, {
      ...helpers,
      getProgramConfig: async () =>
        ({
          cross_brand_allocation: {
            strategy: 'proportional',
            partners: [
              { merchant_account: 'merchant_partner_a', weight: 1 },
              { merchant_account: 'merchant_partner_b', weight: 3 },
            ],
          },
        }) as any,
      getOutstandingAttribution: async (_acct, _opts) => [
        { accountId: 'merchant_partner_a', amount: 100n },
        { accountId: 'merchant_partner_b', amount: 300n },
      ],
    });

    expect(result?.type).toBe('success');

    if (result?.type !== 'success') {
      throw new Error('Expected success');
    }

    const entry = result.mutation.entries[0];
    expect(entry.lines).toHaveLength(3);
    const a = entry.lines.find((l) => l.accountId === 'merchant_partner_a');
    const b = entry.lines.find((l) => l.accountId === 'merchant_partner_b');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).toMatchObject({ credit: 12n });
    expect(b).toMatchObject({ credit: 38n });
    expect(result.mutation.summary).toMatchObject({
      points_redeemed: 50,
      allocation: [
        { merchant_account: 'merchant_partner_a', amount: 12 },
        { merchant_account: 'merchant_partner_b', amount: 38 },
      ],
    });
  });

  it('honours partner hint for priority allocation', async () => {
    const hintedContext: RedeemContext = {
      ...context,
      redeem: { ...context.redeem, partner_hint: 'merchant_partner_b' },
    };

    const result = await defaultRedeemPlugin.apply(hintedContext, {
      ...helpers,
      getProgramConfig: async () =>
        ({
          cross_brand_allocation: {
            strategy: 'priority',
            partners: [
              { merchant_account: 'merchant_partner_a' },
              { merchant_account: 'merchant_partner_b' },
            ],
          },
        }) as any,
      getOutstandingAttribution: async (_acct, _opts) => [
        { accountId: 'merchant_partner_b', amount: 100n },
        { accountId: 'merchant_partner_a', amount: 0n },
      ],
    });

    expect(result?.type).toBe('success');
    if (result?.type !== 'success') {
      throw new Error('Expected success');
    }

    const entry = result.mutation.entries[0];
    expect(entry.lines[1]).toMatchObject({ accountId: 'merchant_partner_b', credit: 50n });
  });

  it('fails when balance is insufficient', async () => {
    const result = await defaultRedeemPlugin.apply(context, {
      ...helpers,
      getOutstandingAttribution: async () => [{ accountId: 'tenant_z::merchant_liability', amount: 10n }],
    });

    expect(result).toEqual({ type: 'failure', reason: 'Insufficient balance', retryable: false });
  });

  it('propagates burn merchant metadata and settlement adjustments', async () => {
    const result = await defaultRedeemPlugin.apply(
      {
        ...context,
        redeem: { ...context.redeem, burn_merchant_id: 'merchant_burn' },
      },
      {
        ...helpers,
        getProgramConfig: async () =>
          ({
            cross_brand_allocation: {
              strategy: 'source_proportional',
              partners: [{ merchant_account: 'merchant_partner_meta', weight: 1 }],
              partner_map: [{ merchant_id: 'merchant_meta', merchant_account: 'merchant_partner_meta' }],
            },
          }) as any,
        getOutstandingAttribution: async (_account, options) => {
          expect(options.burnMerchantId).toBe('merchant_burn');
          return [
            { accountId: 'merchant_partner_meta', amount: 50n, settlementAdjustmentBps: 200 },
          ];
        },
      },
    );

    expect(result?.type).toBe('success');
    if (result?.type !== 'success') {
      throw new Error('Expected success');
    }

    expect(result.mutation.summary).toMatchObject({
      burn_merchant_id: 'merchant_burn',
      allocation: [
        {
          merchant_account: 'merchant_partner_meta',
          settlement_adjustment_bps: 200,
        },
      ],
    });
  });
});
