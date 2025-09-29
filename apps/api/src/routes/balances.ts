import type { FastifyInstance } from 'fastify';
import { normaliseAccountId } from '../accounts.js';
import { balanceQuerySchema } from '../validators.js';

interface BalanceResponse {
  program_id: string;
  unit: string;
  qty: number;
}

export async function registerBalanceRoutes(app: FastifyInstance) {
  app.get<{ Params: { account_id: string }; Querystring: { program_id?: string } }>(
    '/v1/accounts/:account_id/balances',
    async (request, reply) => {
      const tenantId = request.tenantId;
      if (!tenantId) {
        reply.code(500).send({ error: 'Tenant context missing' });
        return;
      }

      const params = request.params;
      const queryValidation = balanceQuerySchema.safeParse(request.query);
      if (!queryValidation.success) {
        reply.code(400).send({ error: 'Invalid query parameters' });
        return;
      }

      const accountKey = normaliseAccountId(tenantId, params.account_id);
      const { program_id } = queryValidation.data;

      try {
        const bindings = [tenantId, accountKey] as (string | number)[];
        let filter = '';
        if (program_id) {
          bindings.push(program_id);
          filter = ' AND j.program_id = $3';
        }

        const result = await app.db.query(
          `SELECT j.program_id, l.unit, COALESCE(SUM(l.cr) - SUM(l.dr), 0) AS qty
           FROM ledger_lines l
           JOIN ledger_journal j ON j.entry_id = l.entry_id
           WHERE j.tenant_id = $1 AND l.account_id = $2${filter}
           GROUP BY j.program_id, l.unit`,
          bindings,
        );

        const balances: BalanceResponse[] = result.rows.map((row: { program_id: string; unit: string; qty: string | number | null; }) => ({
          program_id: row.program_id,
          unit: row.unit,
          qty: Number(row.qty ?? 0),
        }));

        reply.send(balances);
      } catch (error) {
        app.log.error({ err: error }, 'Failed to fetch balances');
        reply.code(500).send({ error: 'Failed to fetch balances' });
      }
    },
  );
}
