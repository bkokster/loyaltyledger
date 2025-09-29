import { createHash, randomUUID } from 'crypto';
import type { ReceiptPayload } from './validators.js';

export function computeReceiptFingerprint(tenantId: string, receipt: ReceiptPayload): string {
  const hash = createHash('sha256');
  hash.update(tenantId);
  hash.update(receipt.idempotency_key);
  hash.update(receipt.merchant.merchant_id ?? '');
  hash.update(receipt.merchant.store_id ?? '');
  hash.update(receipt.buyer.account_ref);
  hash.update(receipt.totals.grand_total.toFixed(2));
  if (receipt.payment?.processor_txn_id) {
    hash.update(receipt.payment.processor_txn_id);
  }
  hash.update(new Date(receipt.issued_at).toISOString());
  return hash.digest('hex');
}

export function generateId(): string {
  return randomUUID();
}
