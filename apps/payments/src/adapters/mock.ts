import { randomUUID } from 'crypto';
import type { CreateDebitInput, CreatePayoutInput, PSPAdapter, ParsedWebhook, LookupResultStatus } from './index.js';

type StoredTransfer = {
  status: LookupResultStatus;
  kind: 'payout' | 'debit';
};

const store = new Map<string, StoredTransfer>();

function record(id: string, entry: StoredTransfer) {
  store.set(id, entry);
}

function read(id: string): StoredTransfer | undefined {
  return store.get(id);
}

export class MockAdapter implements PSPAdapter {
  async createPayout(input: CreatePayoutInput): Promise<{ transferId: string }> {
    const transferId = `mock_payout_${randomUUID()}`;
    const status = input.amountCents < 0 ? 'failed' : 'succeeded';
    record(transferId, { status, kind: 'payout' });
    return { transferId };
  }

  async createDebit(input: CreateDebitInput): Promise<{ debitId: string }> {
    const debitId = `mock_debit_${randomUUID()}`;
    const status = input.amountCents <= 0 ? 'failed' : 'succeeded';
    record(debitId, { status, kind: 'debit' });
    return { debitId };
  }

  async parseWebhook(req: { headers: Record<string, unknown>; rawBody: Buffer }): Promise<ParsedWebhook> {
    return {
      type: String(req.headers['x-mock-event'] ?? 'mock.event'),
      objectId: req.headers['x-mock-object-id'] ? String(req.headers['x-mock-object-id']) : randomUUID(),
      raw: req.rawBody.toString('utf8'),
    };
  }

  async lookup(objectId: string): Promise<{ status: LookupResultStatus; raw: unknown } | null> {
    const recorded = read(objectId);
    if (!recorded) {
      return null;
    }
    return { status: recorded.status, raw: { kind: recorded.kind } };
  }
}

export function createMockAdapter(): PSPAdapter {
  return new MockAdapter();
}

export function resetMockAdapter(): void {
  store.clear();
}
