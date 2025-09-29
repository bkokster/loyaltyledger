import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { DEFAULT_PROGRAM_ID, DEFAULT_UNIT } from '../config.js';
import { customerAccountId, merchantAccountId } from '../accounts.js';
import { withTransaction } from '../db.js';
import { generateId } from '../utils.js';
import { redeemSchema } from '../validators.js';

interface RedeemBody {
  account_id: string;
  program_id: string;
  unit: string;
  qty: number;
  memo?: string;
}

export async function registerRedeemRoutes(app: FastifyInstance) {
  app.post<{ Body: RedeemBody }>(
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

      const { account_id, program_id, unit, qty, memo } = parsed.data;

      if (program_id !== DEFAULT_PROGRAM_ID) {
        reply.code(404).send({ error: 'Unknown program' });
        return;
      }

      if (unit !== DEFAULT_UNIT) {
        reply.code(400).send({ error: 'Unsupported unit' });
        return;
      }

      const pointsToBurn = BigInt(qty);
      const customerAccount = customerAccountId(tenantId, account_id);
      const merchantAccount = merchantAccountId(tenantId);

      try {
        const result = await withTransaction(async (client: PoolClient) => {
          const balanceRes = await client.query(
            `SELECT COALESCE(SUM(l.cr) - SUM(l.dr), 0) AS qty
             FROM ledger_lines l
             JOIN ledger_journal j ON j.entry_id = l.entry_id
             WHERE j.tenant_id = $1 AND j.program_id = $2 AND l.unit = $3 AND l.account_id = $4`,
            [tenantId, DEFAULT_PROGRAM_ID, DEFAULT_UNIT, customerAccount],
          );

          const currentBalance = BigInt(balanceRes.rows[0]?.qty ?? 0);
          if (currentBalance < pointsToBurn) {
            return { success: false as const, reason: 'Insufficient balance' };
          }

          const entryId = generateId();
          await client.query(
            `INSERT INTO ledger_journal (entry_id, tenant_id, program_id, memo)
             VALUES ($1, $2, $3, $4)` ,
            [entryId, tenantId, DEFAULT_PROGRAM_ID, memo ?? 'redeem'],
          );

          await client.query(
            `INSERT INTO ledger_lines (entry_id, line_no, account_id, dr, cr, unit)
             VALUES ($1, $2, $3, $4, $5, $6)` ,
            [entryId, 1, customerAccount, qty, 0, DEFAULT_UNIT],
          );

          await client.query(
            `INSERT INTO ledger_lines (entry_id, line_no, account_id, dr, cr, unit)
             VALUES ($1, $2, $3, $4, $5, $6)` ,
            [entryId, 2, merchantAccount, 0, qty, DEFAULT_UNIT],
          );

          const newBalance = currentBalance - pointsToBurn;
          return { success: true as const, entryId, newBalance };
        });

        if (!result.success) {
          reply.code(422).send({ error: result.reason });
          return;
        }

        reply.send({ entry_id: result.entryId, new_balance: Number(result.newBalance) });
      } catch (error) {
        app.log.error({ err: error }, 'Failed to redeem points');
        reply.code(500).send({ error: 'Failed to redeem' });
      }
    },
  );
}
