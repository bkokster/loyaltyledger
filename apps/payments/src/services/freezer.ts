import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import { CONFIG } from '../config.js';

export class MerchantFreezer {
  async evaluate(): Promise<void> {
    await withTransaction(async (client) => {
      const delinquent = await this.findMerchantsInArrears(client);
      const thawable = await this.findMerchantsToUnfreeze(client);

      for (const merchant of delinquent) {
        await this.freezeMerchant(client, merchant);
      }

      for (const merchant of thawable) {
        await this.unfreezeMerchant(client, merchant);
      }
    });
  }

  private async findMerchantsInArrears(
    client: PoolClient,
  ): Promise<Array<{ tenantId: string; merchantAccount: string }>> {
    const policy = CONFIG.freezePolicy;
    const result = await client.query<{
      tenant_id: string;
      merchant_account: string;
      total_cents: string | number | null;
      last_updated: Date | null;
      max_attempts: number | null;
    }>(
      `
        SELECT
          tenant_id,
          merchant_account,
          SUM(amount_cents) AS total_cents,
          MAX(updated_at) AS last_updated,
          MAX(attempts) AS max_attempts
        FROM collections
        WHERE status IN ('failed', 'pending', 'submitted')
        GROUP BY tenant_id, merchant_account
      `,
    );

    const now = Date.now();
    const thresholdMs = policy.arrearsDays * 24 * 60 * 60 * 1000;

    return result.rows
      .filter((row) => {
        const outstanding = Number(row.total_cents ?? 0);
        if (outstanding < policy.minOutstandingCents) {
          return false;
        }
        const attempts = row.max_attempts ?? 0;
        if (attempts >= policy.maxFailedAttempts) {
          return true;
        }
        if (!row.last_updated) {
          return false;
        }
        const age = now - new Date(row.last_updated).getTime();
        return age >= thresholdMs;
      })
      .map((row) => ({
        tenantId: row.tenant_id,
        merchantAccount: row.merchant_account,
      }));
  }

  private async findMerchantsToUnfreeze(
    client: PoolClient,
  ): Promise<Array<{ tenantId: string; merchantAccount: string }>> {
    const frozen = await client.query<{
      tenant_id: string;
      merchant_account: string;
    }>(`SELECT tenant_id, merchant_account FROM merchant_status WHERE frozen = TRUE`);

    if (frozen.rowCount === 0) {
      return [];
    }

    const outstanding = await client.query<{
      tenant_id: string;
      merchant_account: string;
    }>(
      `SELECT tenant_id, merchant_account FROM collections WHERE status IN ('failed', 'pending', 'submitted')`,
    );

    const outstandingSet = new Set(
      outstanding.rows.map((row) => `${row.tenant_id}::${row.merchant_account}`),
    );

    return frozen.rows
      .filter((row) => !outstandingSet.has(`${row.tenant_id}::${row.merchant_account}`))
      .map((row) => ({
        tenantId: row.tenant_id,
        merchantAccount: row.merchant_account,
      }));
  }

  private async freezeMerchant(
    client: PoolClient,
    merchant: { tenantId: string; merchantAccount: string },
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO merchant_status (tenant_id, merchant_account, frozen, updated_at)
        VALUES ($1, $2, TRUE, NOW())
        ON CONFLICT (tenant_id, merchant_account)
        DO UPDATE SET frozen = TRUE, updated_at = EXCLUDED.updated_at
      `,
      [merchant.tenantId, merchant.merchantAccount],
    );
  }

  private async unfreezeMerchant(
    client: PoolClient,
    merchant: { tenantId: string; merchantAccount: string },
  ): Promise<void> {
    await client.query(
      `
        UPDATE merchant_status
           SET frozen = FALSE,
               updated_at = NOW()
         WHERE tenant_id = $1
           AND merchant_account = $2
      `,
      [merchant.tenantId, merchant.merchantAccount],
    );
  }
}
