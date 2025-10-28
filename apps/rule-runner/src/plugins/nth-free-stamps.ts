import {
  DEFAULT_PROGRAM_ID,
  customerAccountId,
  merchantAccountId,
  type LedgerEntry,
  type LedgerMutation,
  type ReceiptPlugin,
} from '@loyaltyledger/core';

interface RawStampProgram {
  id?: unknown;
  skus?: unknown;
  threshold?: unknown;
  stamps_per_item?: unknown;
  unit?: unknown;
  coupon_unit?: unknown;
}

interface StampProgram {
  id: string;
  skus: string[];
  threshold?: number;
  stampsPerItem: number;
  unit?: string;
  couponUnit?: string;
  tierOverrides: Map<string, { stampsPerItem?: number; threshold?: number }>;
}

function parseStampPrograms(raw: unknown): StampProgram[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const programs: StampProgram[] = [];

  for (const entry of raw as RawStampProgram[]) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const id =
      typeof entry.id === 'string' && entry.id.trim().length > 0 ? entry.id.trim() : undefined;
    if (!id) {
      continue;
    }

    const skusRaw = Array.isArray(entry.skus) ? entry.skus : [];
    const skus = skusRaw.filter((sku): sku is string => typeof sku === 'string' && sku.length > 0);
    if (skus.length === 0) {
      continue;
    }

    const threshold =
      typeof entry.threshold === 'number' && Number.isFinite(entry.threshold) && entry.threshold > 0
        ? entry.threshold
        : undefined;
    const stampsPerItem =
      typeof entry.stamps_per_item === 'number' && Number.isFinite(entry.stamps_per_item) && entry.stamps_per_item > 0
        ? entry.stamps_per_item
        : 1;
    const unit = typeof entry.unit === 'string' && entry.unit.length > 0 ? entry.unit : undefined;
    const couponUnit =
      typeof entry.coupon_unit === 'string' && entry.coupon_unit.length > 0
        ? entry.coupon_unit
        : undefined;

    const tierOverrides = new Map<string, { stampsPerItem?: number; threshold?: number }>();
    if (Array.isArray((entry as any).tier_overrides)) {
      for (const override of (entry as any).tier_overrides ?? []) {
        if (!override || typeof override !== 'object') {
          continue;
        }
        const tierId =
          typeof override.tier_id === 'string' && override.tier_id.trim().length > 0
            ? override.tier_id.trim()
            : undefined;
        if (!tierId) {
          continue;
        }
        const overrideObject: { stampsPerItem?: number; threshold?: number } = {};
        if (
          typeof override.stamps_per_item === 'number' &&
          Number.isFinite(override.stamps_per_item) &&
          override.stamps_per_item > 0
        ) {
          overrideObject.stampsPerItem = override.stamps_per_item;
        }
        if (
          typeof override.threshold === 'number' &&
          Number.isFinite(override.threshold) &&
          override.threshold > 0
        ) {
          overrideObject.threshold = override.threshold;
        }
        if (Object.keys(overrideObject).length > 0) {
          tierOverrides.set(tierId, overrideObject);
        }
      }
    }

    programs.push({
      id,
      skus,
      threshold,
      stampsPerItem,
      unit,
      couponUnit,
      tierOverrides,
    });
  }

  return programs;
}

export const nthFreeStampsPlugin: ReceiptPlugin = {
  name: 'nth_free_stamps',
  shouldHandle: () => true,
  async apply(context, helpers) {
    const programConfig = (await helpers.getProgramConfig(DEFAULT_PROGRAM_ID)) ?? {};
    const rawPrograms = (programConfig as Record<string, unknown>)?.stamp_programs;
    const programs = parseStampPrograms(rawPrograms);

    if (programs.length === 0) {
      return null;
    }

    const { tenantId, receipt, receiptId } = context;
    const merchantAccount = merchantAccountId(tenantId);
    const customerAccount = customerAccountId(tenantId, receipt.buyer.account_ref);
    const currentTier = await helpers.getCustomerTier(
      tenantId,
      receipt.merchant.merchant_id,
      customerAccount,
    );

    const entries: LedgerEntry[] = [];
    const stampsSummary: Record<string, number> = {};
    const couponsSummary: Record<string, number> = {};

    for (const program of programs) {
      const skuSet = new Set(program.skus.map((sku) => sku.toLowerCase()));

       let effectiveStampsPerItem = program.stampsPerItem;
       let effectiveThreshold = program.threshold;
       if (currentTier) {
         const override = program.tierOverrides.get(currentTier.tierId);
         if (override?.stampsPerItem && override.stampsPerItem > 0) {
           effectiveStampsPerItem = override.stampsPerItem;
         }
         if (override?.threshold && override.threshold > 0) {
           effectiveThreshold = override.threshold;
         }
       }

      let stampsToAdd = 0n;
      for (const line of receipt.line_items) {
        if (!line.sku || !skuSet.has(line.sku.toLowerCase())) {
          continue;
        }
        const qty = Number.isFinite(line.qty) ? line.qty : 0;
        if (qty <= 0) {
          continue;
        }
        const rawStamps = qty * effectiveStampsPerItem;
        const stampsForLine = BigInt(Math.floor(rawStamps));
        if (stampsForLine > 0n) {
          stampsToAdd += stampsForLine;
        }
      }

      if (stampsToAdd <= 0n) {
        continue;
      }

      const unit = program.unit ?? `stamps:${program.id}`;
      const previousBalance = await helpers.getAccountBalance(
        customerAccount,
        DEFAULT_PROGRAM_ID,
        unit,
      );
      const newBalance = previousBalance + stampsToAdd;

      entries.push({
        programId: DEFAULT_PROGRAM_ID,
        memo: `stamps:${program.id}`,
        receiptId,
        lines: [
          {
            accountId: merchantAccount,
            debit: stampsToAdd,
            credit: 0n,
            unit,
          },
          {
            accountId: customerAccount,
            debit: 0n,
            credit: stampsToAdd,
            unit,
          },
        ],
      });

      stampsSummary[program.id] = (stampsSummary[program.id] ?? 0) + Number(stampsToAdd);

      if (effectiveThreshold && effectiveThreshold > 0) {
        const threshold = BigInt(Math.floor(effectiveThreshold));
        if (threshold > 0n) {
          const previousRewards = previousBalance / threshold;
          const newRewards = newBalance / threshold;
          const earned = newRewards - previousRewards;
          if (earned > 0n) {
            const couponUnit = program.couponUnit ?? `coupon:${program.id}`;
            entries.push({
              programId: DEFAULT_PROGRAM_ID,
              memo: `coupon:${program.id}`,
              receiptId,
              lines: [
                {
                  accountId: merchantAccount,
                  debit: earned,
                  credit: 0n,
                  unit: couponUnit,
                },
                {
                  accountId: customerAccount,
                  debit: 0n,
                  credit: earned,
                  unit: couponUnit,
                },
              ],
            });

            couponsSummary[program.id] =
              (couponsSummary[program.id] ?? 0) + Number(earned);
          }
        }
      }
    }

    if (entries.length === 0) {
      return null;
    }

    const summary: Record<string, unknown> = {};
    if (Object.keys(stampsSummary).length > 0) {
      summary.stamps_added = stampsSummary;
    }
    if (Object.keys(couponsSummary).length > 0) {
      summary.coupons_issued = couponsSummary;
    }

    const mutation: LedgerMutation = {
      entries,
      summary: Object.keys(summary).length > 0 ? summary : undefined,
    };

    return mutation;
  },
};
