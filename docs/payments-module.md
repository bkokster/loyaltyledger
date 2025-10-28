# Payments & Settlement Module — Design Spec

This document describes a PSP‑agnostic payments/settlement module with a first adapter for Stripe Connect. It sits on top of the existing ledger, program configs, cross‑brand rules, point lots, and monthly netting.

## Goals
- Convert monthly net points into money and settle between platform and merchants.
- Support payouts (positive net) and collections (negative net), with platform transaction fees and per‑pair settlement adjustments.
- Keep payments durable, auditable, idempotent, and pluggable by PSP.
- Drive freeze/unfreeze decisions for merchants that fail to settle.

## Non‑Goals (initial)
- Multi‑currency FX, chargebacks/disputes, tax issuance (1099/K2), and invoice generation UX. These are noted under “Future”.

## Architecture
- Sources:
  - `settlement_reports` (existing): net_points per merchant + period.
  - `merchant_redemption_rules`: per earn→burn pairs, includes `settlement_adjustment_bps`.
  - Program config: `cents_per_point`, `platform_fee_bps`, optional `min_payout_cents`, `reserve_bps`.
- Workers (new):
  - PayoutScheduler: builds `payout_batches` + `payout_items` from `settlement_reports` and rules.
  - PayoutSubmitter: sends payouts (Stripe Transfers) and collections (PaymentIntent/Invoice/ACH) via adapter.
  - Reconciler: backfills payment states by PSP lookup; processes webhooks.
  - Freezer: updates `merchant_status.frozen` based on arrears policy.
- API (new): onboarding + admin endpoints + webhook receiver.
- Storage: payment tables below (Postgres), plus existing ledger for money postings (unit `cents`).

## Data Model (DDL outline)
```sql
create table payment_accounts (
  tenant_id text not null,
  merchant_id text not null,
  psp text not null,                          -- 'stripe'
  psp_account_id text not null,               -- Stripe Connect account id
  currency text not null default 'USD',
  payout_schedule text default 'monthly',     -- policy hint
  status text not null default 'active',      -- active|disabled|kyc_pending
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, merchant_id)
);

create table payout_batches (
  batch_id uuid primary key,
  tenant_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  currency text not null,
  status text not null default 'open',        -- open|submitting|submitted|reconciled|failed
  summary jsonb,
  created_at timestamptz not null default now()
);

create table payout_items (
  item_id uuid primary key,
  batch_id uuid not null references payout_batches(batch_id) on delete cascade,
  tenant_id text not null,
  merchant_account text not null,              -- points side
  merchant_id text not null,                   -- human id if available
  points_settled bigint not null,              -- from settlement_reports
  rate_cents_per_point integer not null,
  gross_cents bigint not null,
  platform_fee_bps integer not null,
  fee_cents bigint not null,
  settlement_adj_bps integer,
  adj_cents bigint not null default 0,
  net_cents bigint not null,
  direction text not null,                     -- payout|collect
  psp text not null,
  psp_transfer_id text,
  status text not null default 'pending',      -- pending|submitted|succeeded|failed|reversed
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table collections (
  collection_id uuid primary key,
  tenant_id text not null,
  merchant_id text not null,
  amount_cents bigint not null,
  currency text not null,
  psp text not null,
  psp_debit_id text,
  attempts integer not null default 0,
  status text not null default 'pending',      -- pending|submitted|succeeded|failed
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table payment_events (
  event_id uuid primary key,
  tenant_id text not null,
  psp text not null,
  psp_event_type text not null,
  psp_object_id text not null,                 -- transfer id, charge id, etc.
  payload jsonb not null,
  received_at timestamptz not null default now()
);
```
Indexes: by `(tenant_id, status)` for queue scans; `(tenant_id, merchant_id)` in accounts; `(tenant_id, psp_object_id)` in events.

## PSP Adapter Interface
```ts
export interface PSPAdapter {
  createPayout(input: {
    tenantId: string;
    merchant: { merchantId: string; pspAccountId: string };
    amountCents: number;
    currency: string;
    platformFeeCents: number;    // application fee, our revenue
    idempotencyKey: string;
    memo?: string;
  }): Promise<{ transferId: string }>;

  createDebit(input: {
    tenantId: string;
    merchant: { merchantId: string; pspAccountId?: string };
    amountCents: number;
    currency: string;
    idempotencyKey: string;
    memo?: string;
  }): Promise<{ debitId: string }>;

  parseWebhook(req: { headers: any; rawBody: Buffer }): Promise<{
    type: string;                     // normalized: payout.succeeded, collection.failed, etc.
    objectId: string;
    tenantId?: string;                // if carried in metadata
    merchantId?: string;
    amountCents?: number;
    raw: any;
  }>;

  lookup(objectId: string): Promise<any>;      // Reconciliation
}
```
Stripe mapping:
- `createPayout` → Transfers to connected account (`destination`), `application_fee_amount` for platform fee.
- `createDebit` → PaymentIntent/Invoice/ACH debit on platform account; merchant funds collected to platform.

## Amount Calculation
For each merchant in `settlement_reports` for the period:
- `gross_cents = net_points * cents_per_point` (program default).
- Apply per‑pair `settlement_adjustment_bps` if the net is driven by cross‑brand burns. Accumulate adjustments from allocation summaries; store on `payout_items`.
- `fee_cents = round(gross_cents * platform_fee_bps / 10000)`.
- `net_cents = gross_cents - fee_cents + adj_cents`.
- Direction: `payout` if `net_cents > 0`, else `collect` if negative.
- Skip if `abs(net_cents) < min_payout_cents` (carry forward).

## Batch + Job Flow
1) PayoutScheduler (daily/monthly)
- Reads all `settlement_reports` for lookback, groups by merchant.
- Computes `gross/fee/adj/net` and inserts one `payout_items` per merchant into a new `payout_batches` row. Idempotent by `(tenant, period_start, period_end)`.

2) PayoutSubmitter (queue)
- Scans `payout_items where status='pending'`.
- For `payout`: calls `adapter.createPayout`, updates `psp_transfer_id`, `status='submitted'`.
- For `collect`: creates `collections` row and calls `createDebit`.
- Retries with backoff; on hard failure, `status='failed'` + error.

3) WebhookReceiver
- Verifies signature, upserts `payment_events`.
- Updates `payout_items` / `collections` to `succeeded|failed|reversed`.
- On failure or reversal → increment arrears; if arrears aging breaches policy, set `merchant_status.frozen=true`.

4) Reconciler
- For submitted items without webhook after N hours, calls `adapter.lookup` and reconciles.

5) Ledger postings (money)
- Payout success: `Dr platform_clearing_cents / Cr merchant_cash_cents` and `Dr merchant_cash_cents / Cr platform_revenue_cents` for the fee.
- Collection success: `Dr merchant_cash_cents / Cr platform_clearing_cents` (or receivable), record fee if applicable.
- Keep money units (`cents`) separate from points.

## API Surface (admin)
- `POST /v1/payments/accounts` – upsert PSP account for merchant.
- `GET /v1/payments/accounts?merchant_id=...`
- `POST /v1/payments/batches` – create batch (manual run) with period and options.
- `GET /v1/payments/batches/:id`
- `GET /v1/payments/payouts?status=pending&merchant_id=...`
- `POST /v1/payments/payouts/:id/retry`
- `POST /v1/payments/collections/:id/retry`
- `POST /v1/merchants/:id/freeze` / `.../unfreeze`
- Webhook endpoint `/v1/payments/webhooks/stripe` (raw body + signature verification).

Auth: tenant‑scoped API key; webhooks use PSP signatures.

## Configuration
Program level (extend `program_configs.config`):
```json
{
  "cents_per_point": 100,
  "platform_fee_bps": 200,
  "min_payout_cents": 500,
  "reserve_bps": 0
}
```
Merchant level (new `payment_accounts` rows): `psp`, `psp_account_id`, currency.
Per‑pair adjustments: `merchant_redemption_rules.settlement_adjustment_bps` (already present).

## Freeze / Arrears Policy
- Define thresholds: `max_failed_attempts`, `arrears_days`, `min_outstanding_cents`.
- When violated: set `merchant_status.frozen=true` (already respected by attribution/burns).
- Unfreeze on successful payment or admin override.

## Errors, Retries, Idempotency
- Idempotency keys: batch id + item id; PSP idempotency on Transfers/PaymentIntents.
- Retries: exponential backoff; mark `failed` after limit but keep items addressable for manual retry.
- Webhook reconciliation defends against duplicate events and out‑of‑order notifications.

## Observability
- Structured logs with item/batch ids.
- Metrics: items created/submitted/succeeded/failed; PSP latency/error rates; arrears counts; frozen merchants.
- Alerts on stuck submitted items and rising failures.

## Testing Strategy
- Unit tests: amount calculation, adapter mapping, state machine transitions.
- Adapter integration: use stripe-mock or local fixtures; verify idempotency and event parsing.
- E2E: reuse docker stack, add a payments worker that fakes PSP responses to validate end‑to‑end payouts and freeze policy.

## Migration Plan
- Add tables via `node-pg-migrate` migration `002_payments_schema.js`.
- Seed `payment_accounts` for existing merchants (no payouts until configured).
- Backfill `merchant_redemption_rules` with self/self where missing.

## Future & Risks
- FX & multi‑currency (map program currency to merchant currency; mid‑market rate table).
- Disputes/chargebacks and refunds; reversal postings in money ledger.
- Tax and compliance (KYC, 1099/K2), payout limits, reserves.
- Advanced fee schedules (tiered fees, per‑merchant overrides).
- Real‑time payouts vs batch; wallet prefunding with rolling reserves.

## Milestones
1) Migrations + adapter scaffolding + minimal admin API
2) Scheduler + submitter + webhook receiver (Stripe)
3) Money ledger postings + reports
4) Freeze/arrears automation + alerts
5) PSP #2 adapter (to validate interface)

---
This spec is tailored to the current codebase: Postgres queue semantics, monthly netting, point lots, cross‑brand rules, and merchant freeze support.
