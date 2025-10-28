import {
  DEFAULT_PROGRAM_ID,
  DEFAULT_UNIT,
  customerAccountId,
  merchantAccountId,
  type LedgerMutation,
  type RedeemPlugin,
} from '@loyaltyledger/core';

export const defaultRedeemPlugin: RedeemPlugin = {
  name: 'default_points_redeem',
  shouldHandle: (context) =>
    context.redeem.program_id === DEFAULT_PROGRAM_ID && context.redeem.unit === DEFAULT_UNIT,
  async apply(context, helpers) {
    const { tenantId, redeem } = context;
    const pointsToBurn = BigInt(redeem.qty);
    if (pointsToBurn <= 0n) {
      return {
        type: 'failure',
        reason: 'Redemption quantity must be positive',
        retryable: false,
      };
    }

    const customerAccount = customerAccountId(tenantId, redeem.account_id);
    const programConfig = (await helpers.getProgramConfig(DEFAULT_PROGRAM_ID)) ?? {};
    const crossBrandConfig = (programConfig as Record<string, unknown>)?.cross_brand_allocation as
      | {
          strategy: 'priority' | 'proportional' | 'source_proportional';
          partners: { merchant_account: string; weight?: number }[];
          partner_map?: { merchant_id: string; merchant_account: string }[];
          expiry_days?: number;
        }
      | undefined;

    const partnerAccounts =
      crossBrandConfig?.partners?.map((partner) => ({
        accountId: partner.merchant_account,
        weight: partner.weight ?? 1,
      })) ?? [];

    const allocationStrategy = (crossBrandConfig?.strategy as any) ?? 'priority';

    let allocation: { accountId: string; amount: bigint }[];

    const burnMerchantId = redeem.burn_merchant_id ?? null;

    // Filter out frozen merchants for any allocation path
    const partnerAccountsList = partnerAccounts.map((p) => p.accountId);
    const frozenSet = await helpers.getFrozenMerchants(partnerAccountsList);
    const unfrozenPartners = partnerAccounts.filter((p) => !frozenSet.has(p.accountId));

    // Compute source-based attribution, respecting expiry and frozen merchants when configured
    const partnerMap: Record<string, string> = Object.fromEntries(
      (crossBrandConfig?.partner_map ?? []).map((p) => [p.merchant_id, p.merchant_account]),
    );
    const attribution = await helpers.getOutstandingAttribution(customerAccount, {
      partnerAccounts:
        unfrozenPartners.length > 0
          ? unfrozenPartners.map((p) => p.accountId)
          : [merchantAccountId(tenantId)],
      partnerMap: Object.keys(partnerMap).length > 0 ? partnerMap : undefined,
      expiryDays: crossBrandConfig?.expiry_days,
      burnMerchantId,
    });

    // If attribution didn't map to partners (e.g., missing partner_map), use global eligible across all lots
    const globalAttribution =
      attribution.length > 0
        ? attribution
        : await helpers.getOutstandingAttribution(customerAccount, {
            partnerAccounts: [merchantAccountId(tenantId)],
            burnMerchantId,
          });

    const eligibleBalance = globalAttribution.reduce((sum, a) => sum + a.amount, 0n);

    const settlementAdjustments = new Map<string, number | null>();
    for (const entry of attribution) {
      if (entry.settlementAdjustmentBps !== undefined) {
        settlementAdjustments.set(entry.accountId, entry.settlementAdjustmentBps ?? null);
      }
    }

    if (eligibleBalance < pointsToBurn) {
      return {
        type: 'failure',
        reason: 'Insufficient balance',
        retryable: false,
      };
    }

    // Allocation strategy:
    // - If strategy is source_proportional, or proportional with available attribution, distribute by contribution
    // - Else follow configured strategy across partner weights/priority (after implicit freeze filtering via attribution)
    if (allocationStrategy === 'source_proportional') {
      if (attribution.length === 0) {
        return {
          type: 'failure',
          reason: 'No eligible merchants for redemption',
          retryable: false,
        };
      }
      allocation = proportionalByWeights(pointsToBurn, attribution.map((a) => ({ accountId: a.accountId, weight: a.amount })));
    } else if (allocationStrategy === 'proportional') {
      if (attribution.length > 0) {
        const partnersFromAttribution = attribution.map((a) => ({ accountId: a.accountId, weight: Number(a.amount) }));
        allocation = await determineAllocation({
          tenantId,
          pointsToBurn,
          partners: partnersFromAttribution,
          strategy: 'proportional',
          redeem,
        });
      } else {
        allocation = await determineAllocation({
          tenantId,
          pointsToBurn,
          partners: unfrozenPartners,
          strategy: 'proportional',
          redeem,
        });
      }
    } else {
      allocation = await determineAllocation({
        tenantId,
        pointsToBurn,
        partners: unfrozenPartners,
        strategy: allocationStrategy,
        redeem,
      });
    }

    if (!allocation || allocation.length === 0) {
      return {
        type: 'failure',
        reason: 'No eligible merchants for redemption',
        retryable: false,
      };
    }

    const mutation: LedgerMutation = {
      entries: [
        {
          programId: DEFAULT_PROGRAM_ID,
          memo: redeem.memo ?? 'redeem',
          receiptId: undefined,
          lines: [
            {
              accountId: customerAccount,
              debit: pointsToBurn,
              credit: 0n,
              unit: DEFAULT_UNIT,
            },
            ...allocation.map((item) => ({
              accountId: item.accountId,
              debit: 0n,
              credit: item.amount,
              unit: DEFAULT_UNIT,
            })),
          ],
        },
      ],
      summary: {
        points_redeemed: Number(pointsToBurn),
        allocation: allocation.map((item) => ({
          merchant_account: item.accountId,
          amount: Number(item.amount),
          settlement_adjustment_bps: settlementAdjustments.has(item.accountId)
            ? settlementAdjustments.get(item.accountId)
            : null,
        })),
        burn_merchant_id: burnMerchantId,
      },
    };

    return {
      type: 'success',
      mutation,
    };
  },
};

interface AllocationInput {
  tenantId: string;
  pointsToBurn: bigint;
  partners: { accountId: string; weight: number }[];
  strategy: 'priority' | 'proportional';
  redeem: {
    partner_hint?: string;
  };
}

function proportionalByWeights(
  qty: bigint,
  partners: { accountId: string; weight: bigint | number }[],
): { accountId: string; amount: bigint }[] {
  const weights = partners.map((p) => ({ accountId: p.accountId, weight: BigInt(p.weight as any) }));
  const total = weights.reduce((acc, p) => acc + (p.weight > 0n ? p.weight : 0n), 0n);
  if (total <= 0n) {
    return [{ accountId: partners[0].accountId, amount: qty }];
  }
  const floors = weights.map((p) => ({
    accountId: p.accountId,
    floor: (qty * p.weight) / total,
    rem: (qty * p.weight) % total,
  }));
  let allocated = floors.reduce((acc, f) => acc + f.floor, 0n);
  const remainder = qty - allocated;
  floors.sort((a, b) => (a.rem === b.rem ? 0 : a.rem > b.rem ? -1 : 1));
  for (let i = 0n; i < remainder; i++) {
    floors[Number(i % BigInt(floors.length))].floor += 1n;
  }
  return floors.map((f) => ({ accountId: f.accountId, amount: f.floor }));
}

async function determineAllocation(input: AllocationInput): Promise<
  { accountId: string; amount: bigint }[]
> {
  const { pointsToBurn, partners, strategy, redeem } = input;

  if (partners.length === 0) {
    return [
      {
        accountId: merchantAccountId(input.tenantId),
        amount: pointsToBurn,
      },
    ];
  }

  if (strategy === 'priority' || redeem.partner_hint) {
    const orderedPartners = [...partners];
    if (redeem.partner_hint) {
      const hintedIndex = orderedPartners.findIndex(
        (partner) => partner.accountId === redeem.partner_hint,
      );
      if (hintedIndex > 0) {
        const [hinted] = orderedPartners.splice(hintedIndex, 1);
        orderedPartners.unshift(hinted);
      }
    }

    const allocation: { accountId: string; amount: bigint }[] = [];
    let remaining = pointsToBurn;

    for (const partner of orderedPartners) {
      if (remaining <= 0n) {
        break;
      }
      allocation.push({ accountId: partner.accountId, amount: remaining });
      remaining = 0n;
    }

    if (remaining > 0n) {
      allocation[allocation.length - 1].amount += remaining;
    }

    return allocation;
  }

  if (strategy === 'proportional') {
    const totalWeight = partners.reduce((sum, partner) => sum + partner.weight, 0);
    if (totalWeight <= 0) {
      return [
        {
          accountId: partners[0].accountId,
          amount: pointsToBurn,
        },
      ];
    }

    let allocated = 0n;
    const lines = partners.map((partner, index) => {
      let amount =
        index === partners.length - 1
          ? pointsToBurn - allocated
          : BigInt(Math.floor((Number(pointsToBurn) * partner.weight) / totalWeight));
      if (amount < 0n) {
        amount = 0n;
      }
      allocated += amount;
      return { accountId: partner.accountId, amount };
    });

    if (allocated !== pointsToBurn) {
      const diff = pointsToBurn - allocated;
      lines[lines.length - 1].amount += diff;
    }

    return lines;
  }

  return [
    {
      accountId: partners[0].accountId,
      amount: pointsToBurn,
    },
  ];
}
