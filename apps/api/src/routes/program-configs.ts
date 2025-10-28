import type { FastifyInstance } from 'fastify';
import { programConfigSchema } from '../validators.js';

export async function registerProgramConfigRoutes(app: FastifyInstance) {
  app.put<{ Params: { program_id: string }; Body: unknown }>(
    '/v1/programs/:program_id/config',
    async (request, reply) => {
      const tenantId = request.tenantId;
      if (!tenantId) {
        reply.code(500).send({ error: 'Tenant context missing' });
        return;
      }

      const parsed = programConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(422).send({ error: 'Invalid program config payload', details: parsed.error });
        return;
      }

      const programId = request.params.program_id;
      const { config } = parsed.data;

      await app.db.query(
        `INSERT INTO program_configs (tenant_id, program_id, config)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, program_id)
         DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()` ,
        [tenantId, programId, config],
      );

      reply.code(204).send();
    },
  );

  app.get<{ Params: { program_id: string } }>(
    '/v1/programs/:program_id/config',
    async (request, reply) => {
      const tenantId = request.tenantId;
      if (!tenantId) {
        reply.code(500).send({ error: 'Tenant context missing' });
        return;
      }

      const programId = request.params.program_id;
      const result = await app.db.query<{ config: unknown }>(
        `SELECT config FROM program_configs WHERE tenant_id = $1 AND program_id = $2`,
        [tenantId, programId],
      );

      if (result.rowCount === 0) {
        reply.code(404).send({ error: 'Program config not found' });
        return;
      }

      reply.send({ program_id: programId, config: result.rows[0].config });
    },
  );
}
