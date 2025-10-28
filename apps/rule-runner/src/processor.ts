import {
  generateId,
  runPlugins,
  runRedeemPlugins,
  type LedgerMutation,
  type PluginHelpers,
  type Receipt,
  type ReceiptContext,
  type RedeemContext,
  type RedeemHelpers,
  type RedeemRequest,
} from '@loyaltyledger/core';
import type { PoolClient } from 'pg';
import { CONFIG } from './config.js';
import { withTransaction } from './db.js';
import { postLedgerEntries } from './ledger.js';
import { receiptPlugins, redeemPlugins } from './plugins/index.js';

type JobTable = 'receipt_jobs' | 'redeem_jobs';
type JobType = 'receipt' | 'redeem';

const JOB_TYPE_BY_TABLE: Record<JobTable, JobType> = {
  receipt_jobs: 'receipt',
  redeem_jobs: 'redeem',
};

interface JobMeta {
  table: JobTable;
  tenantId: string;
  jobId: string;
  referenceId: string;
}

interface ReceiptJobRow {
  job_id: string;
  tenant_id: string;
  receipt_id: string;
  attempts: number;
}

interface ReceiptRow {
  payload: Receipt;
}

interface RedeemJobRow {
  job_id: string;
  tenant_id: string;
  request_id: string;
  attempts: number;
  account_id: string;
  program_id: string;
  unit: string;
  qty: string | number;
  memo: string | null;
  idempotency_key: string | null;
  burn_merchant_id: string | null;
}

function buildLookbackClause(
  column: string,
  paramIndex: number,
  params: any[],
  days: number,
): { clause: string; nextIndex: number } {
  if (process.env.NODE_ENV === 'test') {
    const cutoff = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
    params.push(cutoff);
    return { clause: `${column} >= $${paramIndex}::timestamptz`, nextIndex: paramIndex + 1 };
  }

  params.push(Number(days));
  return { clause: `${column} >= NOW() - ($${paramIndex}::int * INTERVAL '1 day')`, nextIndex: paramIndex + 1 };
}

export async function processNextJob(): Promise<boolean> {
  if (await processReceiptJob()) {
    return true;
  }

  return processRedeemJob();
}

async function processReceiptJob(): Promise<boolean> {
  return withTransaction(async (client) => {
    const selectSql = createReceiptJobSelectSql();
    const jobRes = await client.query<ReceiptJobRow>(selectSql);

    if (jobRes.rowCount === 0) {
      return false;
    }

    const job = jobRes.rows[0];
    const meta: JobMeta = {
      table: 'receipt_jobs',
      tenantId: job.tenant_id,
      jobId: job.job_id,
      referenceId: job.receipt_id,
    };
    await client.query(
      `UPDATE receipt_jobs
          SET status = 'processing',
              attempts = attempts + 1,
              last_error = NULL
        WHERE job_id = $1`,
      [job.job_id],
    );

    const receiptRes = await client.query<ReceiptRow>(
      `SELECT payload
         FROM receipts
        WHERE receipt_id = $1`,
      [job.receipt_id],
    );

    if (receiptRes.rowCount === 0) {
      await markJobAsFailed(client, meta, job.attempts + 1, 'Receipt payload missing');
      return true;
    }

    const receiptPayload = receiptRes.rows[0].payload;
    const context: ReceiptContext = {
      tenantId: job.tenant_id,
      receipt: receiptPayload,
      receiptId: job.receipt_id,
    };

    const summaries: Record<string, unknown> = {};

    try {
      const helpers = createReceiptHelpers(client, job.tenant_id);
      const mutations = await runPlugins({ plugins: receiptPlugins }, context, helpers);
      await applyMutations(client, context.tenantId, mutations);

      for (const mutation of mutations) {
        if (mutation.summary) {
          Object.assign(summaries, mutation.summary);
        }
      }

      await client.query(
        `UPDATE receipt_jobs
            SET status = 'completed',
                completed_at = NOW(),
                result_summary = $2
          WHERE job_id = $1`,
        [job.job_id, Object.keys(summaries).length > 0 ? summaries : null],
      );

      await queueJobNotification(client, {
        meta,
        status: 'completed',
        summary: Object.keys(summaries).length > 0 ? summaries : null,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await rescheduleOrFail(client, meta, job.attempts + 1, errMsg);
    }

    return true;
  });
}

async function processRedeemJob(): Promise<boolean> {
  return withTransaction(async (client) => {
    const selectSql = createRedeemJobSelectSql();
    const jobRes = await client.query<RedeemJobRow>(selectSql);

    if (jobRes.rowCount === 0) {
      return false;
    }

    const job = jobRes.rows[0];
    const meta: JobMeta = {
      table: 'redeem_jobs',
      tenantId: job.tenant_id,
      jobId: job.job_id,
      referenceId: job.request_id,
    };
    await client.query(
      `UPDATE redeem_jobs
          SET status = 'processing',
              attempts = attempts + 1,
              last_error = NULL
        WHERE job_id = $1`,
      [job.job_id],
    );

    const redeemRequest: RedeemRequest = {
      account_id: job.account_id,
      program_id: job.program_id,
      unit: job.unit,
      qty: typeof job.qty === 'string' ? Number(job.qty) : Number(job.qty ?? 0),
      memo: job.memo ?? undefined,
      idempotency_key: job.idempotency_key ?? undefined,
      burn_merchant_id: job.burn_merchant_id ?? undefined,
    };

    const context: RedeemContext = {
      tenantId: job.tenant_id,
      requestId: job.request_id,
      redeem: redeemRequest,
    };

    const helpers = createRedeemHelpers(client, job.tenant_id);

    try {
      const result = await runRedeemPlugins({ plugins: redeemPlugins }, context, helpers);

      if (!result) {
        throw new Error('No redeem plugin accepted the request');
      }

      if (result.type === 'failure') {
        if (result.retryable) {
          await rescheduleOrFail(client, meta, job.attempts + 1, result.reason);
        } else {
          await completeJobWithFailure(client, meta, result.reason);
        }
        return true;
      }

      await applyMutations(client, context.tenantId, [result.mutation]);

      await client.query(
        `UPDATE redeem_jobs
            SET status = 'completed',
                completed_at = NOW(),
                result_summary = $2
          WHERE job_id = $1`,
        [job.job_id, result.mutation.summary ?? null],
      );

      await queueJobNotification(client, {
        meta,
        status: 'completed',
        summary: result.mutation.summary ?? null,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await rescheduleOrFail(client, meta, job.attempts + 1, errMsg);
    }

    return true;
  });
}

function createReceiptJobSelectSql(): string {
  const base = `SELECT job_id, tenant_id, receipt_id, attempts
         FROM receipt_jobs
        WHERE status = 'pending' AND available_at <= NOW()
        ORDER BY created_at
        LIMIT 1`;

  if (CONFIG.env === 'test') {
    return base;
  }

  return `${base} FOR UPDATE SKIP LOCKED`;
}

function createRedeemJobSelectSql(): string {
const base = `SELECT j.job_id, j.tenant_id, j.request_id, j.attempts,
                       r.account_id, r.program_id, r.unit, r.qty, r.memo, r.idempotency_key, r.burn_merchant_id
                  FROM redeem_jobs j
                  JOIN redeem_requests r ON r.request_id = j.request_id
                 WHERE j.status = 'pending' AND j.available_at <= NOW()
                 ORDER BY j.created_at
                 LIMIT 1`;

  if (CONFIG.env === 'test') {
    return base;
  }

  return `${base} FOR UPDATE SKIP LOCKED`;
}

async function applyMutations(
  client: PoolClient,
  tenantId: string,
  mutations: LedgerMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    if (mutation.entries.length === 0) {
      continue;
    }

    const entryIds = await postLedgerEntries(client, tenantId, mutation.entries);

    // After posting, create lots for any earn entries and consume lots for redemptions
    for (let i = 0; i < mutation.entries.length; i++) {
      const entry = mutation.entries[i];
      const entryId = entryIds[i];

      // Create lots on earns: detect memo starting with 'earn:' and credit to a customer account
      if (entry.memo && entry.memo.startsWith('earn:')) {
        const merchantId = entry.memo.split(':')[1] ?? null;
        // Find customer credit lines
        for (const line of entry.lines) {
          if (line.credit > 0n && line.unit === 'points') {
            await createPointLot(client, tenantId, entry.programId, line.unit, line.accountId, merchantId, entryId, line.credit);
          }
        }
      }
    }

    // If mutation reflects a redemption, consume lots using allocation summary
    if (mutation.summary && (mutation.summary as any).allocation) {
      await consumePointLotsForRedemption(client, tenantId, mutation);
    }
  }
}

async function getProgramConfigForTenant<T = Record<string, unknown> | null>(
  client: PoolClient,
  tenantId: string,
  programId: string,
): Promise<T | null> {
  return getProgramConfig(client, tenantId, programId);
}

async function createPointLot(
  client: PoolClient,
  tenantId: string,
  programId: string,
  unit: string,
  customerAccount: string,
  merchantId: string | null,
  earnEntryId: string,
  qty: bigint,
): Promise<void> {
  // Load config to determine expiry
  const config = (await getProgramConfigForTenant<any>(client, tenantId, programId)) ?? {};
  const cross = config?.cross_brand_allocation ?? {};
  const partnerMap: Record<string, string> = Object.fromEntries((cross?.partner_map ?? []).map((p: any) => [p.merchant_id, p.merchant_account]));
  const partners: Array<{ merchant_account: string; expiry_days?: number | null }> = cross?.partners ?? [];

  function resolveExpiryDays(): number | null | undefined {
    const overrides: Array<{ merchant_id: string; expiry_days: number | null }> = config?.earn_expiry_overrides ?? [];
    const defaultExpiry: number | null | undefined = config?.earn_expiry_days_default;
    if (merchantId) {
      const partnerAccount = partnerMap[merchantId];
      if (partnerAccount) {
        const partner = partners.find((p) => p.merchant_account === partnerAccount);
        if (partner && 'expiry_days' in partner && partner.expiry_days !== undefined) return partner.expiry_days ?? null;
      }
      const override = overrides.find((o) => o.merchant_id === merchantId);
      if (override) return override.expiry_days ?? null;
    }
    return defaultExpiry ?? null;
  }

  const expiryDays = resolveExpiryDays();
  const lotId = generateId();
  const expiryParam = expiryDays === null || expiryDays === undefined ? null : Number(expiryDays);
  const useSqlExpiry = process.env.NODE_ENV !== 'test';
  const expiresAtExpression = useSqlExpiry
    ? `CASE WHEN $9::int IS NULL THEN NULL ELSE NOW() + ($9::int * INTERVAL '1 day') END`
    : '$9::timestamptz';
  const expiryValue = useSqlExpiry
    ? expiryParam
    : expiryParam == null
      ? null
      : new Date(Date.now() + expiryParam * 24 * 60 * 60 * 1000).toISOString();
  await client.query(
    `INSERT INTO point_lots (
       lot_id, tenant_id, program_id, unit, customer_account, merchant_id, earn_entry_id, qty_total, qty_remaining, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, ${expiresAtExpression})` ,
    [
      lotId,
      tenantId,
      programId,
      unit,
      customerAccount,
      merchantId,
      earnEntryId,
      qty.toString(),
      expiryValue,
    ],
  );
}

async function consumePointLotsForRedemption(
  client: PoolClient,
  tenantId: string,
  mutation: LedgerMutation,
): Promise<void> {
  // Find the customer account and program/unit for the redemption
  let customerAccount: string | null = null;
  let programId: string | null = null;
  let unit: string | null = null;
  for (const entry of mutation.entries) {
    for (const line of entry.lines) {
      if (line.debit > 0n && line.unit === 'points' && line.accountId.includes('::acct::')) {
        customerAccount = line.accountId;
        programId = entry.programId;
        unit = line.unit;
        break;
      }
    }
    if (customerAccount) break;
  }

  if (!customerAccount || !programId || !unit) return;

  const config = (await getProgramConfigForTenant<any>(client, tenantId, programId)) ?? {};
  const cross = config?.cross_brand_allocation ?? {};
  const partnerMap: Array<{ merchant_id: string; merchant_account: string }> = cross?.partner_map ?? [];
  const globalExpiryDays = typeof cross?.expiry_days === 'number' && cross.expiry_days >= 0 ? cross.expiry_days : undefined;

  const allocation: Array<{ merchant_account: string; amount: number }>
    = Array.isArray((mutation.summary as any)?.allocation) ? (mutation.summary as any).allocation : [];

  const burnMerchantId = typeof (mutation.summary as any)?.burn_merchant_id === 'string'
    ? ((mutation.summary as any).burn_merchant_id as string)
    : null;
  const ruleSet = await loadRedemptionRules(client, tenantId, burnMerchantId);

  if (allocation.length === 0) {
    // No explicit per-merchant allocation; consume FIFO across all merchants
    const totalToConsume = Number((mutation.summary as any)?.points_redeemed ?? 0);
    if (totalToConsume > 0) {
      await consumeLots(
        client,
        tenantId,
        { customerAccount, programId, unit, amount: BigInt(totalToConsume) },
        null,
        { globalExpiryDays },
      );
    }
    return;
  }

  // Build reverse map account->merchant_ids for targeted consumption (fallback)
  const byAccount = new Map<string, string[]>();
  for (const map of partnerMap) {
    const ids = byAccount.get(map.merchant_account) ?? [];
    ids.push(map.merchant_id);
    byAccount.set(map.merchant_account, ids);
  }

  for (const item of allocation) {
    let merchantIds = byAccount.get(item.merchant_account) ?? null;
    let expiryOverrideDays: number | null | undefined;

    const rule = ruleSet.byAccount.get(item.merchant_account);
    if (rule) {
      merchantIds = [rule.earnMerchantId];
      expiryOverrideDays = rule.expiryOverrideDays;
    }

    await consumeLots(
      client,
      tenantId,
      { customerAccount, programId, unit, amount: BigInt(item.amount) },
      merchantIds,
      { globalExpiryDays, expiryOverrideDays },
    );
  }
}

async function consumeLots(
  client: PoolClient,
  tenantId: string,
  args: { customerAccount: string; programId: string; unit: string; amount: bigint },
  merchantIds: string[] | null,
  options?: { globalExpiryDays?: number; expiryOverrideDays?: number | null },
): Promise<void> {
  let remaining = args.amount;
  if (remaining <= 0n) return;

  const params: any[] = [tenantId, args.customerAccount, args.programId, args.unit];
  let paramIndex = params.length + 1;
  let merchantClause = '';
  if (merchantIds && merchantIds.length > 0) {
    merchantClause = `AND pl.merchant_id = ANY($${paramIndex})`;
    params.push(merchantIds);
    paramIndex += 1;
  }

  const extraClauses: string[] = [];
  if (options?.globalExpiryDays !== undefined && options.globalExpiryDays >= 0) {
    const result = buildLookbackClause('pl.created_at', paramIndex, params, Number(options.globalExpiryDays));
    extraClauses.push(result.clause);
    paramIndex = result.nextIndex;
  }
  if (options?.expiryOverrideDays !== undefined && options.expiryOverrideDays !== null && options.expiryOverrideDays >= 0) {
    const result = buildLookbackClause('pl.created_at', paramIndex, params, Number(options.expiryOverrideDays));
    extraClauses.push(result.clause);
    paramIndex = result.nextIndex;
  }

  const additionalWhere = extraClauses.length > 0 ? `AND ${extraClauses.join(' AND ')}` : '';

  const res = await client.query<{
    lot_id: string;
    qty_remaining: string | number;
  }>(
    `SELECT pl.lot_id, pl.qty_remaining
       FROM point_lots pl
      WHERE pl.tenant_id = $1
        AND pl.customer_account = $2
        AND pl.program_id = $3
        AND pl.unit = $4
        ${merchantClause}
        AND pl.qty_remaining > 0
        AND (pl.expires_at IS NULL OR pl.expires_at > NOW())
        ${additionalWhere}
      ORDER BY pl.expires_at NULLS LAST, pl.created_at ASC` ,
    params,
  );

  for (const row of res.rows) {
    if (remaining <= 0n) break;
    const lotRemaining = BigInt(row.qty_remaining ?? 0);
    if (lotRemaining <= 0n) continue;
    const consume = lotRemaining >= remaining ? remaining : lotRemaining;
    remaining -= consume;
    await client.query(
      `UPDATE point_lots
          SET qty_remaining = qty_remaining - $2
        WHERE lot_id = $1 AND qty_remaining >= $2` ,
      [row.lot_id, consume.toString()],
    );
  }

  if (remaining > 0n) {
    // Not enough eligible lots; leave as-is (ledger was already posted). In a stricter model, we'd throw.
    // For safety, we throw to keep ledger and lots consistent.
    throw new Error('Insufficient eligible points in lots to cover redemption');
  }
}

interface RedemptionRule {
  earnMerchantId: string;
  earnMerchantAccount: string;
  burnMerchantId: string;
  expiryOverrideDays: number | null;
  settlementAdjustmentBps: number | null;
}

interface RedemptionRuleSet {
  rules: RedemptionRule[];
  byAccount: Map<string, RedemptionRule>;
  byMerchant: Map<string, RedemptionRule[]>;
}

async function loadRedemptionRules(
  client: PoolClient,
  tenantId: string,
  burnMerchantId: string | null,
): Promise<RedemptionRuleSet> {
  if (!burnMerchantId) {
    return { rules: [], byAccount: new Map(), byMerchant: new Map() };
  }

  const res = await client.query<{
    earn_merchant_id: string;
    earn_merchant_account: string;
    burn_merchant_id: string;
    expiry_days_override: number | null;
    settlement_adjustment_bps: number | null;
  }>(
    `SELECT earn_merchant_id, earn_merchant_account, burn_merchant_id, expiry_days_override, settlement_adjustment_bps
       FROM merchant_redemption_rules
      WHERE tenant_id = $1
        AND burn_merchant_id = $2
        AND enabled = TRUE` ,
    [tenantId, burnMerchantId],
  );

  const rules: RedemptionRule[] = res.rows.map((row) => ({
    earnMerchantId: row.earn_merchant_id,
    earnMerchantAccount: row.earn_merchant_account,
    burnMerchantId: row.burn_merchant_id,
    expiryOverrideDays: row.expiry_days_override ?? null,
    settlementAdjustmentBps: row.settlement_adjustment_bps ?? null,
  }));

  const byAccount = new Map<string, RedemptionRule>();
  const byMerchant = new Map<string, RedemptionRule[]>();
  for (const rule of rules) {
    byAccount.set(rule.earnMerchantAccount, rule);
    const list = byMerchant.get(rule.earnMerchantId) ?? [];
    list.push(rule);
    byMerchant.set(rule.earnMerchantId, list);
  }

  return { rules, byAccount, byMerchant };
}

interface FallbackAttributionInput {
  tenantId: string;
  customerAccount: string;
  partnerAccounts: string[];
  partnerMap: Record<string, string>;
  expiryDays?: number;
}

async function fallbackOutstandingAttribution(
  client: PoolClient,
  input: FallbackAttributionInput,
): Promise<Array<{ accountId: string; amount: bigint }>> {
  const partnerSet = new Set(input.partnerAccounts);

  const params: any[] = [input.tenantId, input.customerAccount, 'default_points', 'points'];
  let paramIndex = params.length + 1;
  let expiryClause = '';
  if (input.expiryDays !== undefined && input.expiryDays !== null && input.expiryDays > 0) {
    const lookback = buildLookbackClause('created_at', paramIndex, params, Number(input.expiryDays));
    expiryClause = `AND ${lookback.clause}`;
    paramIndex = lookback.nextIndex;
  }

  const lotsRes = await client.query<{ merchant_id: string | null; remaining: string | number }>(
    `SELECT merchant_id, COALESCE(SUM(qty_remaining), 0) AS remaining
       FROM point_lots
      WHERE tenant_id = $1
        AND customer_account = $2
        AND program_id = $3
        AND unit = $4
        AND qty_remaining > 0
        AND (expires_at IS NULL OR expires_at > NOW())
        ${expiryClause}
      GROUP BY merchant_id` ,
    params,
  );

  const results = new Map<string, bigint>();
  const candidateAccounts = input.partnerAccounts;

  for (const row of lotsRes.rows) {
    const merchantId = row.merchant_id ?? '';
    let accountId = input.partnerMap[merchantId];
    if (!accountId) {
      if (candidateAccounts.length === 1) {
        accountId = candidateAccounts[0];
      } else {
        continue;
      }
    }
    if (!partnerSet.has(accountId)) continue;
    const prev = results.get(accountId) ?? 0n;
    results.set(accountId, prev + BigInt(row.remaining ?? 0));
  }

  return Array.from(results.entries()).map(([accountId, amount]) => ({ accountId, amount }));
}

interface SumLotBalanceInput {
  tenantId: string;
  customerAccount: string;
  merchantId: string;
  programId: string;
  unit: string;
  expiryDaysGlobal?: number;
  expiryOverrideDays?: number | null;
}

async function sumEligibleLotBalance(
  client: PoolClient,
  input: SumLotBalanceInput,
): Promise<bigint> {
  const params: any[] = [input.tenantId, input.customerAccount, input.programId, input.unit, input.merchantId];
  let paramIndex = params.length + 1;
  const clauses: string[] = [];

  if (input.expiryDaysGlobal !== undefined && input.expiryDaysGlobal !== null && input.expiryDaysGlobal > 0) {
    const lookback = buildLookbackClause('pl.created_at', paramIndex, params, Number(input.expiryDaysGlobal));
    clauses.push(lookback.clause);
    paramIndex = lookback.nextIndex;
  }

  if (input.expiryOverrideDays !== undefined && input.expiryOverrideDays !== null && input.expiryOverrideDays >= 0) {
    const lookback = buildLookbackClause('pl.created_at', paramIndex, params, Number(input.expiryOverrideDays));
    clauses.push(lookback.clause);
    paramIndex = lookback.nextIndex;
  }

  const extraWhere = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';

  const res = await client.query<{ remaining: string | number | null }>(
    `SELECT COALESCE(SUM(pl.qty_remaining), 0) AS remaining
       FROM point_lots pl
      WHERE pl.tenant_id = $1
        AND pl.customer_account = $2
        AND pl.program_id = $3
        AND pl.unit = $4
        AND pl.merchant_id = $5
        AND pl.qty_remaining > 0
        AND (pl.expires_at IS NULL OR pl.expires_at > NOW())
        ${extraWhere}` ,
    params,
  );

  return BigInt(res.rows[0]?.remaining ?? 0);
}

function createReceiptHelpers(client: PoolClient, tenantId: string): PluginHelpers {
  return {
    now: () => new Date(),
    generateId,
    getProgramConfig: async (programId: string) => getProgramConfig(client, tenantId, programId),
    getAccountBalance: async (accountId: string, programId: string, unit: string) => {
      const balanceRes = await client.query(
        `SELECT COALESCE(SUM(l.cr) - SUM(l.dr), 0) AS qty
           FROM ledger_lines l
           JOIN ledger_journal j ON j.entry_id = l.entry_id
          WHERE j.tenant_id = $1 AND j.program_id = $2 AND l.unit = $3 AND l.account_id = $4`,
        [tenantId, programId, unit, accountId],
      );

      return BigInt(balanceRes.rows[0]?.qty ?? 0);
    },
    getRollingSpendCents: async ({
      merchantId,
      customerAccountRef,
      windowStart,
      windowEnd,
    }) => {
      const spendRes = await client.query<{ sum: string | number | null }>(
        `SELECT COALESCE(SUM(grand_total_cents), 0) AS sum
           FROM receipts
          WHERE tenant_id = $1
            AND merchant_reference = $2
            AND buyer_account_ref = $3
            AND issued_at >= $4
            AND issued_at < $5`,
        [
          tenantId,
          merchantId,
          customerAccountRef,
          windowStart.toISOString(),
          windowEnd.toISOString(),
        ],
      );

      return BigInt(spendRes.rows[0]?.sum ?? 0);
    },
    upsertCustomerTier: async ({
      merchantId,
      customerAccountRef,
      customerAccount,
      tierId,
      tierName,
      windowDays,
      windowStart,
      windowEnd,
      rollingSpendCents,
    }) => {
      await client.query(
        `INSERT INTO customer_tiers (
            tenant_id, merchant_id, customer_account, customer_account_ref, tier_id, tier_name,
            window_days, window_start, window_end, rolling_spend_cents, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (tenant_id, merchant_id, customer_account)
         DO UPDATE SET
           tier_id = EXCLUDED.tier_id,
           tier_name = EXCLUDED.tier_name,
           window_days = EXCLUDED.window_days,
           window_start = EXCLUDED.window_start,
           window_end = EXCLUDED.window_end,
           rolling_spend_cents = EXCLUDED.rolling_spend_cents,
           updated_at = NOW()`,
        [
          tenantId,
          merchantId,
          customerAccount,
          customerAccountRef,
          tierId,
          tierName,
          windowDays,
          windowStart.toISOString(),
          windowEnd.toISOString(),
          rollingSpendCents.toString(),
        ],
      );
    },
    getCustomerTier: async (tenantIdArg, merchantId, customerAccount) => {
      const tierRes = await client.query<{
        tier_id: string;
        tier_name: string | null;
        window_days: number;
        window_start: string;
        window_end: string;
        rolling_spend_cents: string | number | null;
      }>(
        `SELECT tier_id, tier_name, window_days, window_start, window_end, rolling_spend_cents
           FROM customer_tiers
          WHERE tenant_id = $1
            AND merchant_id = $2
            AND customer_account = $3`,
        [tenantIdArg, merchantId, customerAccount],
      );

      if (tierRes.rowCount === 0) {
        return null;
      }

      const row = tierRes.rows[0];
      return {
        tierId: row.tier_id,
        tierName: row.tier_name ?? undefined,
        windowDays: row.window_days,
        windowStart: new Date(row.window_start),
        windowEnd: new Date(row.window_end),
        rollingSpendCents: BigInt(row.rolling_spend_cents ?? 0),
      };
    },
  };
}

function createRedeemHelpers(client: PoolClient, tenantId: string): RedeemHelpers {
  const base = createReceiptHelpers(client, tenantId);
  return {
    ...base,
    getAccountBalance: async (accountId: string, programId: string, unit: string) => {
      const balanceRes = await client.query(
        `SELECT COALESCE(SUM(l.cr) - SUM(l.dr), 0) AS qty
           FROM ledger_lines l
           JOIN ledger_journal j ON j.entry_id = l.entry_id
          WHERE j.tenant_id = $1 AND j.program_id = $2 AND l.unit = $3 AND l.account_id = $4`,
        [tenantId, programId, unit, accountId],
      );

      return BigInt(balanceRes.rows[0]?.qty ?? 0);
    },
    getOutstandingAttribution: async (
      customerAccount: string,
      options: { partnerAccounts: string[]; partnerMap?: Record<string, string>; expiryDays?: number; burnMerchantId?: string | null },
    ) => {
      // Filter out frozen merchants first (by merchant_account)
      let candidateAccounts = options.partnerAccounts;
      if (candidateAccounts.length > 0) {
        const frozenRes = await client.query<{ merchant_account: string }>(
          `SELECT merchant_account
             FROM merchant_status
            WHERE tenant_id = $1 AND frozen = TRUE AND merchant_account = ANY($2)` ,
          [tenantId, candidateAccounts],
        );
        const frozenSet = new Set(frozenRes.rows.map((r) => r.merchant_account));
        candidateAccounts = candidateAccounts.filter((a) => !frozenSet.has(a));
      }

      if (candidateAccounts.length === 0) {
        return [];
      }

      const partnerSet = new Set(candidateAccounts);
      const ruleSet = await loadRedemptionRules(client, tenantId, options.burnMerchantId ?? null);

      if (ruleSet.rules.length === 0) {
        if (options.burnMerchantId) {
          return [];
        }
        return fallbackOutstandingAttribution(client, {
          tenantId,
          customerAccount,
          partnerAccounts: candidateAccounts,
          partnerMap: options.partnerMap ?? {},
          expiryDays: options.expiryDays,
        });
      }

      const results: Array<{ accountId: string; amount: bigint; settlementAdjustmentBps?: number | null }> = [];
      for (const rule of ruleSet.rules) {
        if (!partnerSet.has(rule.earnMerchantAccount)) {
          continue;
        }

        const amount = await sumEligibleLotBalance(client, {
          tenantId,
          customerAccount,
          merchantId: rule.earnMerchantId,
          programId: 'default_points',
          unit: 'points',
          expiryDaysGlobal: options.expiryDays,
          expiryOverrideDays: rule.expiryOverrideDays,
        });

        if (amount > 0n) {
          results.push({
            accountId: rule.earnMerchantAccount,
            amount,
            settlementAdjustmentBps: rule.settlementAdjustmentBps ?? null,
          });
        }
      }

      return results;
    },
    getFrozenMerchants: async (accounts: string[]) => {
      if (accounts.length === 0) return new Set<string>();
      const res = await client.query<{ merchant_account: string }>(
        `SELECT merchant_account
           FROM merchant_status
          WHERE tenant_id = $1 AND frozen = TRUE AND merchant_account = ANY($2)` ,
        [tenantId, accounts],
      );
      return new Set(res.rows.map((r) => r.merchant_account));
    },
  };
}

async function getProgramConfig<T = Record<string, unknown> | null>(
  client: PoolClient,
  tenantId: string,
  programId: string,
): Promise<T | null> {
  const res = await client.query<{ config: T }>(
    `SELECT config FROM program_configs WHERE tenant_id = $1 AND program_id = $2`,
    [tenantId, programId],
  );

  if (res.rowCount === 0) {
    return null;
  }

  return res.rows[0].config ?? null;
}

async function rescheduleOrFail(
  client: PoolClient,
  meta: JobMeta,
  attempts: number,
  error: string,
) {
  const shouldRetry = attempts < CONFIG.maxAttempts;
  const delayMs = Math.min(60000, attempts * 5000);
  const availableAt = new Date(Date.now() + delayMs);

  const status = shouldRetry ? 'pending' : 'failed';
  const availableAtValue = shouldRetry ? availableAt.toISOString() : new Date().toISOString();
  const completedAtValue = shouldRetry ? null : new Date().toISOString();
  const tableName = meta.table;

  await client.query(
    `UPDATE ${tableName}
        SET status = $2,
            available_at = $3,
            completed_at = $5,
            result_summary = NULL,
            last_error = $4
      WHERE job_id = $1`,
    [meta.jobId, status, availableAtValue, truncateError(error), completedAtValue],
  );

  if (!shouldRetry) {
    await queueJobNotification(client, {
      meta,
      status: 'failed',
      summary: null,
      error,
    });
  }
}

async function markJobAsFailed(
  client: PoolClient,
  meta: JobMeta,
  attempts: number,
  error: string,
) {
  await rescheduleOrFail(client, meta, attempts, error);
}

async function completeJobWithFailure(
  client: PoolClient,
  meta: JobMeta,
  reason: string,
) {
  const tableName = meta.table;
  await client.query(
    `UPDATE ${tableName}
        SET status = 'failed',
            completed_at = NOW(),
            result_summary = $2,
            last_error = $3
      WHERE job_id = $1`,
    [meta.jobId, { failure: reason }, truncateError(reason)],
  );

  await queueJobNotification(client, {
    meta,
    status: 'failed',
    summary: { failure: reason },
    error: reason,
  });
}

async function queueJobNotification(
  client: PoolClient,
  options: {
    meta: JobMeta;
    status: string;
    summary: Record<string, unknown> | null;
    error?: string | null;
  },
): Promise<void> {
  const notificationId = generateId();
  const jobType = JOB_TYPE_BY_TABLE[options.meta.table];

  await client.query(
    `INSERT INTO job_notifications (
        notification_id, tenant_id, job_type, job_id, reference_id, status, summary, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
    [
      notificationId,
      options.meta.tenantId,
      jobType,
      options.meta.jobId,
      options.meta.referenceId,
      options.status,
      options.summary,
      options.error ? truncateError(options.error) : null,
    ],
  );
}

function truncateError(message: string): string {
  if (message.length <= 1024) {
    return message;
  }
  return message.slice(0, 1024);
}
