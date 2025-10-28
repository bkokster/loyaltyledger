import {
  DEFAULT_PROGRAM_ID,
  customerAccountId,
  type LedgerMutation,
  type ReceiptPlugin,
} from '@loyaltyledger/core';

interface RawTierConfig {
  window_days?: unknown;
  tiers?: Array<{
    id?: unknown;
    display_name?: unknown;
    threshold_cents?: unknown;
  }>;
}

interface TierDefinition {
  id: string;
  displayName: string;
  thresholdCents: bigint;
}

interface ParsedTierConfig {
  windowDays: number;
  tiers: TierDefinition[];
}

function parseTierConfig(raw: unknown): ParsedTierConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const config = raw as RawTierConfig;
  const windowDaysRaw = config.window_days;
  const windowDays =
    typeof windowDaysRaw === 'number' && Number.isFinite(windowDaysRaw) && windowDaysRaw > 0
      ? Math.floor(windowDaysRaw)
      : null;

  const tiersRaw = Array.isArray(config.tiers) ? config.tiers : [];
  const tiers: TierDefinition[] = [];
  for (const tier of tiersRaw) {
    if (!tier || typeof tier !== 'object') {
      continue;
    }
    const id =
      typeof tier.id === 'string' && tier.id.trim().length > 0 ? tier.id.trim() : undefined;
    if (!id) {
      continue;
    }
    const threshold =
      typeof tier.threshold_cents === 'number' && Number.isFinite(tier.threshold_cents)
        ? BigInt(Math.max(0, Math.floor(tier.threshold_cents)))
        : null;
    if (threshold === null) {
      continue;
    }
    const displayName =
      typeof tier.display_name === 'string' && tier.display_name.trim().length > 0
        ? tier.display_name.trim()
        : id;
    tiers.push({
      id,
      displayName,
      thresholdCents: threshold,
    });
  }

  if (!windowDays || tiers.length === 0) {
    return null;
  }

  tiers.sort((a, b) => (a.thresholdCents < b.thresholdCents ? -1 : a.thresholdCents > b.thresholdCents ? 1 : 0));

  return { windowDays, tiers };
}

export const rollingTierPlugin: ReceiptPlugin = {
  name: 'rolling_spend_tiers',
  shouldHandle: () => true,
  async apply(context, helpers) {
    const programConfig = (await helpers.getProgramConfig(DEFAULT_PROGRAM_ID)) ?? {};
    const tierConfig = parseTierConfig(
      (programConfig as Record<string, unknown>)?.loyalty_tiers,
    );

    if (!tierConfig) {
      return null;
    }

    const { tenantId, receipt } = context;
    const merchantId = receipt.merchant.merchant_id;
    if (!merchantId) {
      return null;
    }

    const now = helpers.now();
    const windowEnd = now;
    const windowStart = new Date(windowEnd.getTime() - tierConfig.windowDays * 24 * 60 * 60 * 1000);

    const rollingSpend = await helpers.getRollingSpendCents({
      tenantId,
      merchantId,
      customerAccountRef: receipt.buyer.account_ref,
      windowStart,
      windowEnd,
    });

    let selectedTier = tierConfig.tiers[0];
    for (const tier of tierConfig.tiers) {
      if (rollingSpend >= tier.thresholdCents) {
        selectedTier = tier;
      } else {
        break;
      }
    }

    const customerAccount = customerAccountId(tenantId, receipt.buyer.account_ref);

    await helpers.upsertCustomerTier({
      tenantId,
      merchantId,
      customerAccountRef: receipt.buyer.account_ref,
      customerAccount,
      tierId: selectedTier.id,
      tierName: selectedTier.displayName,
      windowDays: tierConfig.windowDays,
      windowStart,
      windowEnd,
      rollingSpendCents: rollingSpend,
    });

    const mutation: LedgerMutation = {
      entries: [],
      summary: {
        loyalty_tier: {
          merchant_id: merchantId,
          customer_account: customerAccount,
          tier_id: selectedTier.id,
          tier_name: selectedTier.displayName,
          rolling_spend_cents: Number(rollingSpend),
          window_days: tierConfig.windowDays,
        },
      },
    };

    return mutation;
  },
};
