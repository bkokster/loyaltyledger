import {
  DEFAULT_PROGRAM_ID,
  DEFAULT_UNIT,
  customerAccountId,
  merchantAccountId,
  type LedgerMutation,
  type ReceiptPlugin,
} from '@loyaltyledger/core';

export const defaultEarnPlugin: ReceiptPlugin = {
  name: 'default_points_earn',
  shouldHandle: () => true,
  async apply(context, helpers) {
    const { receipt, tenantId, receiptId } = context;
    const programConfig = (await helpers.getProgramConfig(DEFAULT_PROGRAM_ID)) ?? {};
    const multiplierRaw = typeof programConfig?.points_multiplier === 'number' ? programConfig.points_multiplier : Number(programConfig?.points_multiplier ?? 1);
    const multiplier = Number.isFinite(multiplierRaw) && multiplierRaw > 0 ? multiplierRaw : 1;
    const pointsEarned = Math.round(receipt.totals.grand_total * multiplier);

    if (pointsEarned <= 0) {
      return {
        entries: [],
        summary: { points_earned: 0 },
      };
    }

    const merchantAccount = merchantAccountId(tenantId);
    const customerAccount = customerAccountId(tenantId, receipt.buyer.account_ref);
    const points = BigInt(pointsEarned);

    const mutation: LedgerMutation = {
      entries: [
        {
          programId: DEFAULT_PROGRAM_ID,
          memo: `earn:${receipt.merchant.merchant_id}`,
          receiptId,
          lines: [
            {
              accountId: merchantAccount,
              debit: points,
              credit: 0n,
              unit: DEFAULT_UNIT,
            },
            {
              accountId: customerAccount,
              debit: 0n,
              credit: points,
              unit: DEFAULT_UNIT,
            },
          ],
        },
      ],
      summary: { points_earned: pointsEarned },
    };

    return mutation;
  },
};
