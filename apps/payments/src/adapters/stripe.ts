import type { PSPAdapter, CreateDebitInput, CreatePayoutInput, ParsedWebhook, LookupResultStatus } from './index.js';

class StripeAdapter implements PSPAdapter {
  async createPayout(input: CreatePayoutInput): Promise<{ transferId: string }> {
    throw new Error(`Stripe createPayout not implemented. Input: ${JSON.stringify({ tenantId: input.tenantId, merchant: input.merchant })}`);
  }

  async createDebit(input: CreateDebitInput): Promise<{ debitId: string }> {
    throw new Error(`Stripe createDebit not implemented. Input: ${JSON.stringify({ tenantId: input.tenantId, merchant: input.merchant })}`);
  }

  async parseWebhook(req: { headers: Record<string, unknown>; rawBody: Buffer }): Promise<ParsedWebhook> {
    throw new Error(`Stripe parseWebhook not implemented. Headers: ${JSON.stringify(req.headers)}`);
  }

  async lookup(_objectId: string): Promise<{ status: LookupResultStatus; raw: unknown } | null> {
    return null;
  }
}

export function createStripeAdapter(): PSPAdapter {
  return new StripeAdapter();
}
