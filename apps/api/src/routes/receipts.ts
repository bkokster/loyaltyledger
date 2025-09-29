import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { DEFAULT_PROGRAM_ID, DEFAULT_UNIT } from '../config.js';
import { customerAccountId, merchantAccountId } from '../accounts.js';
import { withTransaction } from '../db.js';
import { computeReceiptFingerprint, generateId } from '../utils.js';
import { parseReceipt } from '../validators.js';

interface ReceiptReply {
  receipt_id: string;
  summary?: {
    points_earned: number;
  };
}

type ErrorReply = { error: string; details?: unknown };

export async function registerReceiptRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown; Reply: ReceiptReply | { receipt_id: string } | ErrorReply }>(
    '/v1/receipts',
    async (request, reply) => {
      const tenantId = request.tenantId;
      if (!tenantId) {
        reply.code(500).send({ error: 'Tenant context missing' });
        return;
      }

      let receipt;
      try {
        receipt = parseReceipt(request.body);
      } catch (error) {
        reply.code(422).send({ error: 'Invalid receipt payload', details: error });
        return;
      }

      const fingerprint = computeReceiptFingerprint(tenantId, receipt);
      const merchantAccount = merchantAccountId(tenantId);
      const customerAccount = customerAccountId(tenantId, receipt.buyer.account_ref);
      const pointsEarned = Math.round(receipt.totals.grand_total);

      try {
        const outcome = await withTransaction<
          { duplicate: true; receiptId: string } | { duplicate: false; receiptId: string; pointsEarned: number }
        >(async (client: PoolClient) => {
          const existing = await client.query(
            `SELECT receipt_id FROM receipts WHERE tenant_id = $1 AND (idempotency_key = $2 OR fingerprint = $3)` ,
            [tenantId, receipt.idempotency_key, fingerprint],
          );

          if ((existing.rowCount ?? 0) > 0) {
            return { duplicate: true as const, receiptId: existing.rows[0].receipt_id };
          }

          const receiptId = generateId();
          await client.query(
            `INSERT INTO receipts (
              receipt_id, tenant_id, idempotency_key, fingerprint, buyer_account_ref, merchant_reference,
              issued_at, currency, grand_total_cents, payload
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)` ,
            [
              receiptId,
              tenantId,
              receipt.idempotency_key,
              fingerprint,
              receipt.buyer.account_ref,
              receipt.merchant.merchant_id,
              new Date(receipt.issued_at).toISOString(),
              receipt.currency,
              Math.round(receipt.totals.grand_total * 100),
              receipt,
            ],
          );

          if (pointsEarned > 0) {
            const entryId = generateId();
            await client.query(
              `INSERT INTO ledger_journal (entry_id, tenant_id, program_id, receipt_id, memo)
               VALUES ($1, $2, $3, $4, $5)` ,
              [entryId, tenantId, DEFAULT_PROGRAM_ID, receiptId, `earn:${receipt.merchant.merchant_id}`],
            );

            await client.query(
              `INSERT INTO ledger_lines (entry_id, line_no, account_id, dr, cr, unit)
               VALUES ($1, $2, $3, $4, $5, $6)` ,
              [entryId, 1, merchantAccount, pointsEarned, 0, DEFAULT_UNIT],
            );

            await client.query(
              `INSERT INTO ledger_lines (entry_id, line_no, account_id, dr, cr, unit)
               VALUES ($1, $2, $3, $4, $5, $6)` ,
              [entryId, 2, customerAccount, 0, pointsEarned, DEFAULT_UNIT],
            );
          }

          return { duplicate: false as const, receiptId, pointsEarned };
        });

        if (outcome.duplicate) {
          reply.code(409).send({ receipt_id: outcome.receiptId });
          return;
        }

        reply.code(202).send({
          receipt_id: outcome.receiptId,
          summary: { points_earned: outcome.pointsEarned },
        });
      } catch (error) {
        app.log.error({ err: error }, 'Failed to ingest receipt');
        reply.code(500).send({ error: 'Failed to ingest receipt' });
      }
    },
  );
}
