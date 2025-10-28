import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import { computeReceiptFingerprint, generateId } from '../utils.js';
import { parseReceipt } from '../validators.js';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

interface ReceiptReply {
  receipt_id: string;
  processing_job_id: string;
  status: JobStatus;
  summary?: {
    points_earned: number;
  };
}

type ErrorReply = { error: string; details?: unknown };

export async function registerReceiptRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown; Reply: ReceiptReply | { receipt_id: string; processing_job_id?: string; status?: JobStatus } | ErrorReply }>(
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
      try {
        const outcome = await withTransaction<
          | { duplicate: true; receiptId: string; jobId?: string; status?: string }
          | { duplicate: false; receiptId: string; jobId: string }
        >(async (client: PoolClient) => {
          const existing = await client.query(
            `SELECT receipt_id FROM receipts WHERE tenant_id = $1 AND (idempotency_key = $2 OR fingerprint = $3)` ,
            [tenantId, receipt.idempotency_key, fingerprint],
          );

          if ((existing.rowCount ?? 0) > 0) {
            const receiptId = existing.rows[0].receipt_id as string;
            const jobRes = await client.query(
              `SELECT job_id, status
                 FROM receipt_jobs
                WHERE receipt_id = $1
             ORDER BY created_at DESC
                LIMIT 1`,
              [receiptId],
            );

            return {
              duplicate: true as const,
              receiptId,
              jobId: jobRes.rows[0]?.job_id,
              status: jobRes.rows[0]?.status,
            };
          }

          const receiptId = generateId();
          const jobId = generateId();
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

          await client.query(
            `INSERT INTO receipt_jobs (job_id, tenant_id, receipt_id)
             VALUES ($1, $2, $3)` ,
            [jobId, tenantId, receiptId],
          );

          return { duplicate: false as const, receiptId, jobId };
        });

        if (outcome.duplicate) {
          reply
            .code(409)
            .send({
              receipt_id: outcome.receiptId,
              processing_job_id: outcome.jobId,
              status: (outcome.status as JobStatus) ?? 'queued',
            });
          return;
        }

        reply.code(202).send({
          receipt_id: outcome.receiptId,
          processing_job_id: outcome.jobId,
          status: 'queued',
        });
      } catch (error) {
        app.log.error({ err: error }, 'Failed to ingest receipt');
        reply.code(500).send({ error: 'Failed to ingest receipt' });
      }
    },
  );
}
