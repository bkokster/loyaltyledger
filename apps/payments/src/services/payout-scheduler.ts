import type { PoolClient } from 'pg';
import { generateId } from '@loyaltyledger/core';
import { CONFIG } from '../config.js';
import { withTransaction } from '../db.js';
import type { PSPAdapter } from '../adapters/index.js';

export interface ScheduleWindow {
  periodStart: Date;
  periodEnd: Date;
}

interface RawProgramConfig {
  cents_per_point?: number;
  platform_fee_bps?: number;
  min_payout_cents?: number;
  reserve_bps?: number;
}

interface SettlementReportRow {
  tenant_id: string;
  merchant_account: string;
  net_points: string | number | null;
  merchant_id: string;
  psp: string;
  psp_account_id: string;
  currency: string;
  program_config: RawProgramConfig | null;
  settlement_adjustment_bps: number | null;
}

interface EnrichedReport {
  tenantId: string;
  merchantAccount: string;
  merchantId: string;
  netPoints: bigint;
  centsPerPoint: number;
  platformFeeBps: number;
  minPayoutCents: bigint;
  settlementAdjustmentBps: number | null;
  psp: string;
  pspAccountId: string;
  currency: string;
}

export class PayoutScheduler {
  constructor(private readonly adapter: PSPAdapter) {
    void this.adapter; // adapter reserved for future PSP pre-checks
  }

  async runOnce(window?: ScheduleWindow): Promise<void> {
    const targetWindow = window ?? this.defaultWindow();
    console.log('[payments] scheduling payouts', {
      periodStart: targetWindow.periodStart.toISOString(),
      periodEnd: targetWindow.periodEnd.toISOString(),
    });

    await withTransaction(async (client) => {
      const settlementReports = await this.fetchSettlementReports(client, targetWindow);
      if (!settlementReports.length) {
        console.log('[payments] no settlement reports found for window');
        return;
      }

      const grouped = groupByTenant(settlementReports);

      for (const [tenantId, reports] of grouped.entries()) {
        const batchCandidate = generateId();
        const batch = await this.insertBatch(client, {
          batchId: batchCandidate,
          tenantId,
          currency: reports[0]?.currency ?? 'USD',
          window: targetWindow,
        });
        if (!batch) {
          console.log('[payments] unable to determine payout batch for tenant/window', { tenantId });
          continue;
        }

        const insertedCount = await this.buildPayoutItems(client, batch.batchId, reports);
        if (insertedCount === 0 && batch.isNew) {
          console.log('[payments] no items qualified for new payout batch; rolling back', {
            tenantId,
            batchId: batch.batchId,
          });
          await client.query('DELETE FROM payout_batches WHERE batch_id = $1', [batch.batchId]);
        }
      }
    });
  }

  private defaultWindow(): ScheduleWindow {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - CONFIG.schedulerLookbackDays * 24 * 60 * 60 * 1000);
    return { periodStart, periodEnd };
  }

  private async fetchSettlementReports(client: PoolClient, window: ScheduleWindow): Promise<EnrichedReport[]> {
    const result = await client.query<SettlementReportRow>(
      `
        SELECT
          sr.tenant_id,
          sr.merchant_account,
          sr.net_points,
          pa.merchant_id,
          pa.psp,
          pa.psp_account_id,
          pa.currency,
          pc.config AS program_config,
          NULL::integer AS settlement_adjustment_bps
        FROM settlement_reports sr
        JOIN payment_accounts pa
          ON pa.tenant_id = sr.tenant_id
         AND pa.merchant_id = sr.merchant_account
        LEFT JOIN program_configs pc
          ON pc.tenant_id = sr.tenant_id
         AND pc.program_id = 'default_points'
       WHERE sr.period_start >= $1
         AND sr.period_end   <= $2
         AND sr.net_points IS NOT NULL
      `,
      [window.periodStart.toISOString(), window.periodEnd.toISOString()],
    );

    return result.rows
      .map((row) => {
        const netPoints = BigInt(row.net_points ?? 0);
        if (netPoints === 0n) {
          return null;
        }
        const config = normaliseProgramConfig(row.program_config);
        return {
          tenantId: row.tenant_id,
          merchantAccount: row.merchant_account,
          merchantId: row.merchant_id,
          netPoints,
          centsPerPoint: config.centsPerPoint,
          platformFeeBps: config.platformFeeBps,
          minPayoutCents: BigInt(config.minPayoutCents),
          settlementAdjustmentBps: row.settlement_adjustment_bps,
          psp: row.psp,
          pspAccountId: row.psp_account_id,
          currency: row.currency ?? 'USD',
        } satisfies EnrichedReport;
      })
      .filter((row): row is EnrichedReport => row !== null);
  }

  private async insertBatch(
    client: PoolClient,
    input: { batchId: string; tenantId: string; currency: string; window: ScheduleWindow },
  ): Promise<{ batchId: string; isNew: boolean } | null> {
    const { batchId, tenantId, currency, window } = input;
    const summary = { total_items: 0 };
    const result = await client.query(
      `
        INSERT INTO payout_batches (
          batch_id, tenant_id, period_start, period_end, currency, status, summary
        ) VALUES ($1, $2, $3, $4, $5, 'open', $6)
        ON CONFLICT (tenant_id, period_start, period_end) DO NOTHING
        RETURNING batch_id
      `,
      [batchId, tenantId, window.periodStart.toISOString(), window.periodEnd.toISOString(), currency, summary],
    );
    if ((result.rowCount ?? 0) > 0) {
      return { batchId: result.rows[0].batch_id, isNew: true };
    }

    const existing = await client.query<{ batch_id: string }>(
      `
        SELECT batch_id
          FROM payout_batches
         WHERE tenant_id = $1
           AND period_start = $2
           AND period_end = $3
         LIMIT 1
      `,
      [tenantId, window.periodStart.toISOString(), window.periodEnd.toISOString()],
    );

    if ((existing.rowCount ?? 0) === 0) {
      return null;
    }

    return { batchId: existing.rows[0].batch_id, isNew: false };
  }

  private async buildPayoutItems(client: PoolClient, batchId: string, reports: EnrichedReport[]): Promise<number> {
    let inserted = 0;
    let payoutCount = 0;
    let payoutAmount = 0n;
    let collectionCount = 0;
    let collectionAmount = 0n;

    for (const report of reports) {
      const amounts = calculateAmounts(report.netPoints, report.centsPerPoint, report.platformFeeBps, report.settlementAdjustmentBps);

      const absNet = amounts.netCents < 0n ? -amounts.netCents : amounts.netCents;
      if (absNet < report.minPayoutCents) {
        continue;
      }

      const direction: 'payout' | 'collect' = amounts.netCents >= 0n ? 'payout' : 'collect';
      const itemId = generateId();

      await client.query(
        `
          INSERT INTO payout_items (
            item_id, batch_id, tenant_id, merchant_account, merchant_id,
            points_settled, rate_cents_per_point, gross_cents, platform_fee_bps, fee_cents,
            settlement_adj_bps, adj_cents, net_cents, direction, psp, status, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, 'pending', NOW(), NOW()
          )
          ON CONFLICT (batch_id, merchant_account) DO NOTHING
        `,
        [
          itemId,
          batchId,
          report.tenantId,
          report.merchantAccount,
          report.merchantId,
          report.netPoints.toString(),
          report.centsPerPoint,
          amounts.grossCents.toString(),
          report.platformFeeBps,
          amounts.feeCents.toString(),
          report.settlementAdjustmentBps,
          amounts.adjustmentCents.toString(),
          amounts.netCents.toString(),
          direction,
          report.psp,
        ],
      );

      inserted += 1;
      if (direction === 'payout') {
        payoutCount += 1;
        payoutAmount += amounts.netCents;
      } else {
        collectionCount += 1;
        collectionAmount += -amounts.netCents;
      }
    }

    if (inserted > 0) {
      const summary = {
        total_items: inserted,
        payouts: { count: payoutCount, amount_cents: payoutAmount.toString() },
        collections: { count: collectionCount, amount_cents: collectionAmount.toString() },
      };
      await client.query(
        `
          UPDATE payout_batches
             SET summary = $2,
                 updated_at = NOW()
           WHERE batch_id = $1
        `,
        [batchId, summary],
      );
    }

    return inserted;
  }
}

function groupByTenant(reports: EnrichedReport[]): Map<string, EnrichedReport[]> {
  const grouped = new Map<string, EnrichedReport[]>();
  for (const report of reports) {
    const list = grouped.get(report.tenantId) ?? [];
    list.push(report);
    grouped.set(report.tenantId, list);
  }
  return grouped;
}

function normaliseProgramConfig(config: RawProgramConfig | null): {
  centsPerPoint: number;
  platformFeeBps: number;
  minPayoutCents: number;
  reserveBps: number;
} {
  return {
    centsPerPoint: Number.isFinite(config?.cents_per_point) ? Number(config?.cents_per_point) : 100,
    platformFeeBps: Number.isFinite(config?.platform_fee_bps) ? Number(config?.platform_fee_bps) : 0,
    minPayoutCents: Number.isFinite(config?.min_payout_cents) ? Number(config?.min_payout_cents) : 0,
    reserveBps: Number.isFinite(config?.reserve_bps) ? Number(config?.reserve_bps) : 0,
  };
}

function calculateAmounts(
  netPoints: bigint,
  centsPerPoint: number,
  platformFeeBps: number,
  settlementAdjustmentBps: number | null,
): {
  grossCents: bigint;
  feeCents: bigint;
  adjustmentCents: bigint;
  netCents: bigint;
} {
  const grossCents = netPoints * BigInt(centsPerPoint);
  const feeCents = applyBps(grossCents, platformFeeBps);
  const adjustmentCents = settlementAdjustmentBps != null ? applyBps(grossCents, settlementAdjustmentBps) : 0n;
  const netCents = grossCents - feeCents + adjustmentCents;
  return { grossCents, feeCents, adjustmentCents, netCents };
}

function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isFinite(bps) || bps === 0 || amount === 0n) {
    return 0n;
  }
  const abs = amount < 0n ? -amount : amount;
  const bigBps = BigInt(Math.trunc(bps));
  const rounded = (abs * bigBps + 5000n) / 10000n;
  return amount < 0n ? -rounded : rounded;
}
