import { describe, expect, it } from 'vitest';
import { computeReceiptFingerprint } from './utils.js';
import type { ReceiptPayload } from './validators.js';

const baseReceipt: ReceiptPayload = {
  schema_version: '1.0',
  idempotency_key: 'idem-1',
  issued_at: '2024-01-01T10:00:00Z',
  currency: 'USD',
  merchant: {
    merchant_id: 'merchant_1',
  },
  buyer: {
    account_ref: 'acct_1',
  },
  totals: {
    grand_total: 25.5,
  },
  line_items: [],
};

describe('computeReceiptFingerprint', () => {
  it('produces a deterministic hash for identical receipts', () => {
    const first = computeReceiptFingerprint('tenant-1', baseReceipt);
    const second = computeReceiptFingerprint('tenant-1', { ...baseReceipt });
    expect(first).toBe(second);
  });

  it('changes hash when critical fields differ', () => {
    const first = computeReceiptFingerprint('tenant-1', baseReceipt);
    const modified = {
      ...baseReceipt,
      totals: { grand_total: 30.0 },
    };
    const second = computeReceiptFingerprint('tenant-1', modified);
    expect(first).not.toBe(second);
  });
});
