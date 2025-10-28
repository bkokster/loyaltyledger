import { generateId } from '@loyaltyledger/core';
import { CONFIG } from './config.js';
import { closePool, withTransaction } from './db.js';
import type { PoolClient } from 'pg';

export async function run() {
  console.log('Settlement job started');
  try {
    const reports = await generateSettlementReports();
    reports.forEach((report) => {
      const { tenantId, merchantAccount, netPoints, periodStart, periodEnd } = report;
      console.log(
        '[settlement] report generated',
        JSON.stringify({ tenantId, merchantAccount, netPoints: netPoints.toString(), periodStart, periodEnd }),
      );
    });
  } finally {
    await closePool();
    console.log('Settlement job completed');
  }
}

interface SettlementReport {
  tenantId: string;
  merchantAccount: string;
  netPoints: bigint;
  periodStart: string;
  periodEnd: string;
}

async function generateSettlementReports(): Promise<SettlementReport[]> {
  const lookbackMs = Math.max(CONFIG.lookbackDays, 1) * 24 * 60 * 60 * 1000;
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - lookbackMs);

  const reports: SettlementReport[] = [];

  await withTransaction(async (client) => {
    const result = await client.query<{
      tenant_id: string;
      merchant_account: string;
      net_points: string | number;
    }>(
      `SELECT j.tenant_id, l.account_id AS merchant_account, SUM(l.cr) - SUM(l.dr) AS net_points
         FROM ledger_lines l
         JOIN ledger_journal j ON j.entry_id = l.entry_id
        WHERE j.ts >= $1 AND j.ts < $2
          AND l.account_id LIKE $3
        GROUP BY j.tenant_id, l.account_id`,
      [periodStart.toISOString(), periodEnd.toISOString(), '%::merchant_liability'],
    );

    for (const row of result.rows) {
      const netPoints = BigInt(row.net_points ?? 0);
      await upsertSettlementReport(client, {
        tenantId: row.tenant_id,
        merchantAccount: row.merchant_account,
        netPoints,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });

      reports.push({
        tenantId: row.tenant_id,
        merchantAccount: row.merchant_account,
        netPoints,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });
    }
  });

  return reports;
}

async function upsertSettlementReport(
  client: PoolClient,
  report: SettlementReport,
): Promise<void> {
  await client.query(
    `INSERT INTO settlement_reports (
        report_id, tenant_id, merchant_account, period_start, period_end, net_points, summary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, merchant_account, period_start, period_end)
      DO UPDATE SET net_points = EXCLUDED.net_points,
                    summary = EXCLUDED.summary,
                    created_at = NOW()` ,
    [
      generateId(),
      report.tenantId,
      report.merchantAccount,
      report.periodStart,
      report.periodEnd,
      report.netPoints.toString(),
      { net_points: Number(report.netPoints) },
    ],
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('Settlement job failed', err);
    process.exit(1);
  });
}
