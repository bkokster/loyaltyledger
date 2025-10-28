import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../db.js';
import { generateId } from '../utils.js';
import { redeemSchema } from '../validators.js';

interface RedeemBody {
  account_id: string;
  program_id: string;
  unit: string;
  qty: number;
  memo?: string;
  idempotency_key?: string;
  burn_merchant_id?: string;
}

interface RedeemReply {
  redemption_id: string;
  processing_job_id: string;
  status: JobStatus;
}

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export async function registerRedeemRoutes(app: FastifyInstance) {
  app.post<{ Body: RedeemBody; Reply: RedeemReply | { redemption_id: string; processing_job_id?: string; status?: JobStatus } | { error: string; details?: unknown } }>(
    '/v1/redeem',
    async (request, reply) => {
      const tenantId = request.tenantId;
      if (!tenantId) {
        reply.code(500).send({ error: 'Tenant context missing' });
        return;
      }

      const parsed = redeemSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(422).send({ error: 'Invalid redeem payload', details: parsed.error });
        return;
      }

      const { account_id, program_id, unit, qty, memo, idempotency_key, burn_merchant_id } = parsed.data;

      try {
        const outcome = await withTransaction<
          | { duplicate: true; requestId: string; jobId?: string; status?: string }
          | { duplicate: false; requestId: string; jobId: string }
        >(async (client) => {
          if (idempotency_key) {
            const existingReq = await client.query(
              `SELECT request_id FROM redeem_requests WHERE tenant_id = $1 AND idempotency_key = $2`,
              [tenantId, idempotency_key],
            );

            if ((existingReq.rowCount ?? 0) > 0) {
              const requestId = existingReq.rows[0].request_id as string;
              const existingJob = await client.query(
                `SELECT job_id, status
                   FROM redeem_jobs
                  WHERE request_id = $1
               ORDER BY created_at DESC
                  LIMIT 1`,
                [requestId],
              );

              return {
                duplicate: true as const,
                requestId,
                jobId: existingJob.rows[0]?.job_id,
                status: existingJob.rows[0]?.status,
              };
            }
          }

          const requestId = generateId();
          const jobId = generateId();

          await client.query(
            `INSERT INTO redeem_requests (
              request_id, tenant_id, account_id, program_id, unit, qty, memo, idempotency_key, burn_merchant_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)` ,
            [
              requestId,
              tenantId,
              account_id,
              program_id,
              unit,
              qty,
              memo ?? null,
              idempotency_key ?? null,
              burn_merchant_id ?? null,
            ],
          );

          await client.query(
            `INSERT INTO redeem_jobs (job_id, tenant_id, request_id)
             VALUES ($1, $2, $3)` ,
            [jobId, tenantId, requestId],
          );

          return { duplicate: false as const, requestId, jobId };
        });

        if (outcome.duplicate) {
          reply
            .code(409)
            .send({
              redemption_id: outcome.requestId,
              processing_job_id: outcome.jobId,
              status: (outcome.status as JobStatus) ?? 'queued',
            });
          return;
        }

        reply.code(202).send({
          redemption_id: outcome.requestId,
          processing_job_id: outcome.jobId,
          status: 'queued',
        });
      } catch (error) {
        app.log.error({ err: error }, 'Failed to queue redemption');
        reply.code(500).send({ error: 'Failed to queue redemption' });
      }
    },
  );
}
