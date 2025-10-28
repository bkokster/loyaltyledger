import {
  DEFAULT_PROGRAM_ID,
  DEFAULT_UNIT,
  customerAccountId,
  merchantAccountId,
  type PluginHelpers,
  type Receipt,
} from '@loyaltyledger/core';
import { describe, expect, it } from 'vitest';
import { defaultEarnPlugin } from './default-earn.js';

const baseReceipt: Receipt = {
  schema_version: '1.0',
  idempotency_key: 'key-1',
  issued_at: new Date('2024-01-01T10:00:00Z').toISOString(),
  currency: 'USD',
  merchant: {
    merchant_id: 'merchant_1',
  },
  buyer: {
    account_ref: 'acct_1',
  },
  totals: {
    grand_total: 42.5,
  },
  line_items: [],
};

const helpers: PluginHelpers = {
  now: () => new Date('2024-01-01T10:00:00Z'),
  generateId: () => 'generated-id',
  getProgramConfig: async () => ({ points_multiplier: 1 } as any),
  getAccountBalance: async () => 0n,
  getRollingSpendCents: async () => 0n,
  upsertCustomerTier: async () => {},
};

describe('defaultEarnPlugin', () => {
  it('awards rounded points for receipts', async () => {
    const context = {
      tenantId: 'tenant_a',
      receipt: baseReceipt,
      receiptId: 'receipt_1',
    };

    const result = await defaultEarnPlugin.apply(context, helpers);
    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(1);

    const entry = result?.entries[0];
    expect(entry?.programId).toBe(DEFAULT_PROGRAM_ID);
    expect(entry?.memo).toBe('earn:merchant_1');
    expect(entry?.receiptId).toBe('receipt_1');
    expect(entry?.lines).toHaveLength(2);

    const merchantAccount = merchantAccountId('tenant_a');
    const customerAccount = customerAccountId('tenant_a', 'acct_1');

    const merchantLine = entry?.lines[0];
    expect(merchantLine?.accountId).toBe(merchantAccount);
    expect(merchantLine?.debit).toBe(43n);
    expect(merchantLine?.credit).toBe(0n);
    expect(merchantLine?.unit).toBe(DEFAULT_UNIT);

    const customerLine = entry?.lines[1];
    expect(customerLine?.accountId).toBe(customerAccount);
    expect(customerLine?.debit).toBe(0n);
    expect(customerLine?.credit).toBe(43n);

    expect(result?.summary).toEqual({ points_earned: 43 });
  });

  it('returns zero summary when no points are earned', async () => {
    const receipt: Receipt = {
      ...baseReceipt,
      totals: { grand_total: 0 },
    };

    const context = {
      tenantId: 'tenant_b',
      receipt,
      receiptId: 'receipt_2',
    };

    const result = await defaultEarnPlugin.apply(context, {
      ...helpers,
      getProgramConfig: async () => ({ points_multiplier: 1 } as any),
    });
    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(0);
    expect(result?.summary).toEqual({ points_earned: 0 });
  });

  it('applies multiplier from program config when provided', async () => {
    const context = {
      tenantId: 'tenant_a',
      receipt: baseReceipt,
      receiptId: 'receipt_1',
    };

    const result = await defaultEarnPlugin.apply(context, {
      ...helpers,
      getProgramConfig: async () => ({ points_multiplier: 2.5 } as any),
    });

    expect(result?.summary).toEqual({ points_earned: 106 });
  });
});
