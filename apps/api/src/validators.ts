import { z } from 'zod';

const lineItemSchema = z.object({
  line_id: z.string().min(1),
  sku: z.string().optional(),
  category: z.string().optional(),
  qty: z.number().finite().nonnegative(),
  unit_price: z.number().finite().nonnegative(),
  attrs: z.record(z.string(), z.any()).optional(),
});

const receiptSchema = z.object({
  schema_version: z.string().default('1.0'),
  idempotency_key: z.string().min(1),
  issued_at: z
    .string()
    .refine((value: string) => !Number.isNaN(Date.parse(value)), 'issued_at must be an ISO date'),
  currency: z.string().min(1),
  merchant: z.object({
    merchant_id: z.string().min(1),
    store_id: z.string().optional(),
    name: z.string().optional(),
  }),
  buyer: z.object({
    account_ref: z.string().min(1),
    consent_scopes: z.array(z.string()).optional(),
  }),
  payment: z
    .object({
      processor: z.string().optional(),
      processor_txn_id: z.string().optional(),
      method: z.string().optional(),
    })
    .optional(),
  totals: z.object({
    subtotal: z.number().finite().nonnegative().optional(),
    discounts: z.number().finite().nonnegative().optional(),
    tax: z.number().finite().nonnegative().optional(),
    grand_total: z.number().finite().nonnegative(),
  }),
  line_items: z.array(lineItemSchema).default([]),
  signature: z
    .object({
      alg: z.string().optional(),
      kid: z.string().optional(),
      jws: z.string().optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.any()).optional(),
});

export type ReceiptPayload = z.infer<typeof receiptSchema>;

export const redeemSchema = z.object({
  account_id: z.string().min(1),
  program_id: z.string().min(1),
  unit: z.string().min(1),
  qty: z.number().int().positive(),
  memo: z.string().optional(),
});

export const balanceQuerySchema = z.object({
  program_id: z.string().optional(),
});

export function parseReceipt(input: unknown): ReceiptPayload {
  return receiptSchema.parse(input);
}
