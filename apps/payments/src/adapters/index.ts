import { createStripeAdapter } from './stripe.js';

export interface CreatePayoutInput {
  tenantId: string;
  merchant: { merchantId: string; pspAccountId: string };
  amountCents: number;
  currency: string;
  platformFeeCents: number;
  idempotencyKey: string;
  memo?: string;
}

export interface CreateDebitInput {
  tenantId: string;
  merchant: { merchantId: string; pspAccountId?: string };
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  memo?: string;
}

export interface ParsedWebhook {
  type: string;
  objectId: string;
  tenantId?: string;
  merchantId?: string;
  amountCents?: number;
  raw: unknown;
}

export type LookupResultStatus = 'succeeded' | 'failed' | 'pending';

export interface PSPAdapter {
  createPayout(input: CreatePayoutInput): Promise<{ transferId: string }>;
  createDebit(input: CreateDebitInput): Promise<{ debitId: string }>;
  parseWebhook(req: { headers: Record<string, unknown>; rawBody: Buffer }): Promise<ParsedWebhook>;
  lookup(objectId: string): Promise<{ status: LookupResultStatus; raw: unknown } | null>;
}

type AdapterFactory = () => PSPAdapter;

const factories = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  factories.set(name.toLowerCase(), factory);
}

export function getAdapter(name: string): PSPAdapter {
  const factory = factories.get(name.toLowerCase());
  if (!factory) {
    throw new Error(`PSP adapter "${name}" not registered`);
  }
  return factory();
}

registerAdapter('stripe', createStripeAdapter);
import { createMockAdapter } from './mock.js';

registerAdapter('mock', createMockAdapter);
