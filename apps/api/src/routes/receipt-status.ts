import type { FastifyInstance } from 'fastify';

interface ReceiptStatusResponse {
  receipt_id: string;
  processing_job_id: string;
  status: string;
  attempts: number;
  last_error?: string;
  summary?: Record<string, unknown> | null;
  completed_at?: string | null;
  available_at: string;
  created_at: string;
}

export async function registerReceiptStatusRoutes(app: FastifyInstance) {
  app.get<{ Params: { receipt_id: string } }>(
    '/v1/receipts/:receipt_id/status',
    async (request, reply) => {
      const tenantId = request.tenantId;
      if (!tenantId) {
        reply.code(500).send({ error: 'Tenant context missing' });
        return;
      }

      const receiptId = request.params.receipt_id;
      if (!isUuid(receiptId)) {
        reply.code(400).send({ error: 'Invalid receipt id' });
        return;
      }

      const result = await app.db.query(
        `SELECT job_id, status, attempts, last_error, result_summary, completed_at, available_at, created_at
           FROM receipt_jobs
          WHERE tenant_id = $1 AND receipt_id = $2
       ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, receiptId],
      );

      if (result.rowCount === 0) {
        reply.code(404).send({ error: 'Receipt job not found' });
        return;
      }

      const row = result.rows[0];
      const response: ReceiptStatusResponse = {
        receipt_id: receiptId,
        processing_job_id: row.job_id,
        status: row.status,
        attempts: Number(row.attempts ?? 0),
        last_error: row.last_error ?? undefined,
        summary: row.result_summary ?? null,
        completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        available_at: new Date(row.available_at).toISOString(),
        created_at: new Date(row.created_at).toISOString(),
      };

      reply.send(response);
    },
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
