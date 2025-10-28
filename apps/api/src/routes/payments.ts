import type { FastifyInstance } from 'fastify';
import { generateId } from '@loyaltyledger/core';
import {
  paymentAccountQuerySchema,
  paymentAccountSchema,
  paymentBatchSchema,
  paymentPayoutQuerySchema,
} from '../validators.js';

interface PaymentAccountRow {
  tenant_id: string;
  merchant_id: string;
  psp: string;
  psp_account_id: string;
  currency: string;
  payout_schedule: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface PayoutBatchRow {
  batch_id: string;
  tenant_id: string;
  period_start: Date;
  period_end: Date;
  currency: string;
  status: string;
  summary: unknown;
  created_at: Date;
  updated_at: Date;
}

interface PayoutItemRow {
  item_id: string;
  batch_id: string;
  tenant_id: string;
  merchant_account: string;
  merchant_id: string | null;
  points_settled: string | number | null;
  rate_cents_per_point: number;
  gross_cents: string | number | null;
  platform_fee_bps: number;
  fee_cents: string | number | null;
  settlement_adj_bps: number | null;
  adj_cents: string | number | null;
  net_cents: string | number | null;
  direction: string;
  psp: string;
  psp_transfer_id: string | null;
  status: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function registerPaymentRoutes(app: FastifyInstance) {
  app.post('/v1/payments/accounts', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }

    const parsed = paymentAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid account payload', details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const result = await app.db.query<PaymentAccountRow>(
      `
        INSERT INTO payment_accounts (
          tenant_id, merchant_id, psp, psp_account_id, currency, payout_schedule, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'monthly'), COALESCE($7, 'active'), NOW(), NOW())
        ON CONFLICT (tenant_id, merchant_id)
        DO UPDATE SET
          psp = EXCLUDED.psp,
          psp_account_id = EXCLUDED.psp_account_id,
          currency = EXCLUDED.currency,
          payout_schedule = COALESCE(EXCLUDED.payout_schedule, payment_accounts.payout_schedule),
          status = COALESCE(EXCLUDED.status, payment_accounts.status),
          updated_at = NOW()
        RETURNING *
      `,
      [
        tenantId,
        payload.merchant_id,
        payload.psp,
        payload.psp_account_id,
        payload.currency,
        payload.payout_schedule ?? null,
        payload.status ?? null,
      ],
    );

    reply.code(201).send({ account: mapAccount(result.rows[0]) });
  });

  app.get('/v1/payments/accounts', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }

    const parsed = paymentAccountQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.flatten() });
      return;
    }

    const conditions: string[] = ['tenant_id = $1'];
    const values: Array<string> = [tenantId];
    if (parsed.data.merchant_id) {
      conditions.push('merchant_id = $2');
      values.push(parsed.data.merchant_id);
    }

    const result = await app.db.query<PaymentAccountRow>(
      `
        SELECT *
          FROM payment_accounts
         WHERE ${conditions.join(' AND ')}
         ORDER BY merchant_id
      `,
      values,
    );

    reply.send({ accounts: result.rows.map(mapAccount) });
  });

  app.post('/v1/payments/batches', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }

    const parsed = paymentBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid batch payload', details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const periodStart = new Date(payload.period_start).toISOString();
    const periodEnd = new Date(payload.period_end).toISOString();
    const batchId = generateId();

    const result = await app.db.query<PayoutBatchRow>(
      `
        INSERT INTO payout_batches (
          batch_id, tenant_id, period_start, period_end, currency, status, summary, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'open', jsonb_build_object('total_items', 0), NOW(), NOW())
        ON CONFLICT (tenant_id, period_start, period_end)
        DO NOTHING
        RETURNING *
      `,
      [batchId, tenantId, periodStart, periodEnd, payload.currency ?? 'USD'],
    );

    if (result.rowCount === 0) {
      reply.code(409).send({ error: 'Batch already exists for period' });
      return;
    }

    reply.code(201).send({ batch: mapBatch(result.rows[0]) });
  });

  app.get<{ Params: { batch_id: string } }>('/v1/payments/batches/:batch_id', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }

    const { batch_id: batchId } = request.params;
    const batchResult = await app.db.query<PayoutBatchRow>(
      `
        SELECT *
          FROM payout_batches
         WHERE batch_id = $1
           AND tenant_id = $2
      `,
      [batchId, tenantId],
    );

    if (batchResult.rowCount === 0) {
      reply.code(404).send({ error: 'Batch not found' });
      return;
    }

    const itemsResult = await app.db.query<PayoutItemRow>(
      `
        SELECT *
          FROM payout_items
         WHERE batch_id = $1
         ORDER BY created_at
      `,
      [batchId],
    );

    reply.send({
      batch: mapBatch(batchResult.rows[0]),
      items: itemsResult.rows.map(mapItem),
    });
  });

  app.get('/v1/payments/payouts', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }

    const parsed = paymentPayoutQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.flatten() });
      return;
    }

    const { status, merchant_account } = parsed.data;
    const conditions: string[] = ['tenant_id = $1'];
    const values: Array<string> = [tenantId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx++}`);
      values.push(status);
    }
    if (merchant_account) {
      conditions.push(`merchant_account = $${idx++}`);
      values.push(merchant_account);
    }

    const result = await app.db.query<PayoutItemRow>(
      `
        SELECT *
          FROM payout_items
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT 200
      `,
      values,
    );

    reply.send({ items: result.rows.map(mapItem) });
  });

  app.post<{ Params: { item_id: string } }>('/v1/payments/payouts/:item_id/retry', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }

    const { item_id: itemId } = request.params;
    const existing = await app.db.query<{ direction: string }>(
      `
        SELECT direction
          FROM payout_items
         WHERE item_id = $1
           AND tenant_id = $2
      `,
      [itemId, tenantId],
    );
    if (existing.rowCount === 0) {
      reply.code(404).send({ error: 'Payout item not found' });
      return;
    }

    await app.db.query(
      `
        UPDATE payout_items
           SET status = 'pending',
               error = NULL,
               psp_transfer_id = NULL,
               updated_at = NOW()
         WHERE item_id = $1
           AND tenant_id = $2
      `,
      [itemId, tenantId],
    );

    if (existing.rows[0].direction === 'collect') {
      await app.db.query(
        `
          UPDATE collections
             SET status = 'pending',
                 error = NULL,
                 psp_debit_id = NULL,
                 updated_at = NOW()
           WHERE payout_item_id = $1
        `,
        [itemId],
      );
    }

    reply.send({ status: 'pending' });
  });

  app.post<{ Params: { collection_id: string } }>('/v1/payments/collections/:collection_id/retry', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }

    const { collection_id: collectionId } = request.params;
    const existing = await app.db.query<{ payout_item_id: string }>(
      `
        SELECT payout_item_id
          FROM collections
         WHERE collection_id = $1
           AND tenant_id = $2
      `,
      [collectionId, tenantId],
    );
    if (existing.rowCount === 0) {
      reply.code(404).send({ error: 'Collection not found' });
      return;
    }

    await app.db.query(
      `
        UPDATE collections
           SET status = 'pending',
               error = NULL,
               psp_debit_id = NULL,
               updated_at = NOW()
         WHERE collection_id = $1
           AND tenant_id = $2
      `,
      [collectionId, tenantId],
    );

    await app.db.query(
      `
        UPDATE payout_items
           SET status = 'pending',
               error = NULL,
               updated_at = NOW()
         WHERE item_id = $1
      `,
      [existing.rows[0].payout_item_id],
    );

    reply.send({ status: 'pending' });
  });

  app.post<{ Params: { merchant_id: string } }>('/v1/merchants/:merchant_id/freeze', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }
    const { merchant_id: merchantAccount } = request.params;

    await app.db.query(
      `
        INSERT INTO merchant_status (tenant_id, merchant_account, frozen, updated_at)
        VALUES ($1, $2, TRUE, NOW())
        ON CONFLICT (tenant_id, merchant_account)
        DO UPDATE SET frozen = TRUE, updated_at = EXCLUDED.updated_at
      `,
      [tenantId, merchantAccount],
    );

    reply.send({ status: 'frozen' });
  });

  app.post<{ Params: { merchant_id: string } }>('/v1/merchants/:merchant_id/unfreeze', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(500).send({ error: 'Tenant context missing' });
      return;
    }
    const { merchant_id: merchantAccount } = request.params;

    await app.db.query(
      `
        UPDATE merchant_status
           SET frozen = FALSE,
               updated_at = NOW()
         WHERE tenant_id = $1
           AND merchant_account = $2
      `,
      [tenantId, merchantAccount],
    );

    reply.send({ status: 'unfrozen' });
  });

  app.post('/v1/payments/webhooks/stripe', async (request, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) {
      reply.code(400).send({ error: 'Tenant context missing' });
      return;
    }

    const payload = request.body as Record<string, unknown> | undefined;
    const eventType = typeof payload?.type === 'string' ? payload.type : 'stripe.event';
    let objectId: string | null = null;
    if (payload && typeof payload === 'object') {
      if (typeof payload['id'] === 'string') {
        objectId = payload['id'];
      } else if (typeof payload['data'] === 'object' && payload['data'] !== null) {
        const data = payload['data'] as Record<string, unknown>;
        if (typeof data['object'] === 'object' && data['object'] !== null) {
          const inner = data['object'] as Record<string, unknown>;
          if (typeof inner['id'] === 'string') {
            objectId = inner['id'];
          }
        }
      }
    }

    const eventId = generateId();
    await app.db.query(
      `
        INSERT INTO payment_events (
          event_id, tenant_id, psp, psp_event_type, psp_object_id, payload, received_at
        ) VALUES ($1, $2, 'stripe', $3, $4, $5, NOW())
      `,
      [eventId, tenantId, eventType, objectId ?? eventId, payload ?? {}],
    );

    reply.code(202).send({ status: 'accepted', event_id: eventId });
  });
}

function mapAccount(row: PaymentAccountRow) {
  return {
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    psp: row.psp,
    psp_account_id: row.psp_account_id,
    currency: row.currency,
    payout_schedule: row.payout_schedule,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapBatch(row: PayoutBatchRow) {
  return {
    batch_id: row.batch_id,
    tenant_id: row.tenant_id,
    period_start: row.period_start,
    period_end: row.period_end,
    currency: row.currency,
    status: row.status,
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapItem(row: PayoutItemRow) {
  return {
    item_id: row.item_id,
    batch_id: row.batch_id,
    tenant_id: row.tenant_id,
    merchant_account: row.merchant_account,
    merchant_id: row.merchant_id,
    points_settled: row.points_settled,
    rate_cents_per_point: row.rate_cents_per_point,
    gross_cents: row.gross_cents,
    platform_fee_bps: row.platform_fee_bps,
    fee_cents: row.fee_cents,
    settlement_adj_bps: row.settlement_adj_bps,
    adj_cents: row.adj_cents,
    net_cents: row.net_cents,
    direction: row.direction,
    psp: row.psp,
    psp_transfer_id: row.psp_transfer_id,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
