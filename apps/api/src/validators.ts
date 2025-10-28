import type { Receipt } from '@loyaltyledger/core';
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
type _ReceiptCompatibility = Receipt extends ReceiptPayload ? (ReceiptPayload extends Receipt ? true : never) : never;
declare const _receiptCompatibilityCheck: _ReceiptCompatibility;

export const redeemSchema = z.object({
  account_id: z.string().min(1),
  program_id: z.string().min(1),
  unit: z.string().min(1),
  qty: z.number().int().positive(),
  memo: z.string().optional(),
  idempotency_key: z.string().min(1).optional(),
  burn_merchant_id: z.string().min(1).optional(),
});

export const balanceQuerySchema = z.object({
  program_id: z.string().optional(),
});

const partnerAllocationSchema = z.object({
  merchant_account: z.string().min(1),
  weight: z.number().positive().optional(),
  expiry_days: z.number().int().nonnegative().nullable().optional(),
});

const stampProgramSchema = z.object({
  id: z.string().min(1),
  skus: z.array(z.string().min(1)).nonempty(),
  stamps_per_item: z.number().positive().optional(),
  threshold: z.number().positive().optional(),
  unit: z.string().min(1).optional(),
  coupon_unit: z.string().min(1).optional(),
});

const loyaltyTierSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  threshold_cents: z.number().int().nonnegative(),
});

const loyaltyTierConfigSchema = z.object({
  window_days: z.number().int().positive(),
  tiers: z.array(loyaltyTierSchema).nonempty(),
});

export const programConfigSchema = z.object({
  config: z.object({
    points_multiplier: z.number().positive().optional(),
    // Default expiry for earns (applies when no per-merchant override); null or missing means never expire
    earn_expiry_days_default: z.number().int().nonnegative().nullable().optional(),
    // Optional overrides by earning merchant_id
    earn_expiry_overrides: z
      .array(z.object({ merchant_id: z.string().min(1), expiry_days: z.number().int().nonnegative().nullable() }))
      .optional(),
    cross_brand_allocation: z
      .object({
        strategy: z.enum(['priority', 'proportional', 'source_proportional']).default('priority'),
        partners: z.array(partnerAllocationSchema).nonempty(),
        partner_map: z
          .array(
            z.object({ merchant_id: z.string().min(1), merchant_account: z.string().min(1) }),
          )
          .optional(),
        // Legacy/global expiry for attribution; prefer per-partner expiry_days above
        expiry_days: z.number().int().nonnegative().optional(),
      })
      .optional(),
    stamp_programs: z.array(stampProgramSchema).optional(),
    loyalty_tiers: loyaltyTierConfigSchema.optional(),
  }),
});

export function parseReceipt(input: unknown): ReceiptPayload {
  return receiptSchema.parse(input);
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export const paymentAccountSchema = z.object({
  merchant_id: z.string().min(1),
  psp: z.string().min(1).default('stripe'),
  psp_account_id: z.string().min(1),
  currency: z.string().min(1).default('USD'),
  payout_schedule: z.string().optional(),
  status: z.enum(['active', 'disabled', 'kyc_pending']).optional(),
});

export const paymentAccountQuerySchema = z.object({
  merchant_id: z.string().optional(),
});

export const paymentBatchSchema = z.object({
  period_start: z.string().refine(isIsoDate, 'period_start must be an ISO date'),
  period_end: z.string().refine(isIsoDate, 'period_end must be an ISO date'),
  currency: z.string().optional(),
});

export const paymentPayoutQuerySchema = z.object({
  status: z.enum(['pending', 'submitted', 'succeeded', 'failed', 'reversed']).optional(),
  merchant_account: z.string().optional(),
});
