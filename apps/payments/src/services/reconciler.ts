import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import type { PSPAdapter } from '../adapters/index.js';
import { CONFIG } from '../config.js';

export class PayoutReconciler {
  constructor(private readonly adapter: PSPAdapter) {}

  async reconcileSubmitted(): Promise<void> {
    await withTransaction(async (client) => {
      const cutoff = new Date(Date.now() - CONFIG.reconcileLookbackHours * 60 * 60 * 1000);
      const payouts = await this.loadSubmittedPayouts(client, cutoff);
      const collections = await this.loadSubmittedCollections(client, cutoff);

      if (!payouts.length && !collections.length) {
        console.log('[payments] no submitted payments pending reconciliation');
        return;
      }

      for (const payout of payouts) {
        await this.reconcilePayout(client, payout);
      }

      for (const collection of collections) {
        await this.reconcileCollection(client, collection);
      }
    });
  }

  private async loadSubmittedPayouts(
    client: PoolClient,
    cutoff: Date,
  ): Promise<
    Array<{
      itemId: string;
      tenantId: string;
      psp: string;
      pspTransferId: string;
    }>
  > {
    const lockClause = process.env.NODE_ENV === 'test' ? '' : 'FOR UPDATE SKIP LOCKED';
    const result = await client.query<{
      item_id: string;
      tenant_id: string;
      psp: string;
      psp_transfer_id: string;
    }>(
      `
        SELECT item_id, tenant_id, psp, psp_transfer_id
          FROM payout_items
         WHERE status = 'submitted'
           AND psp_transfer_id IS NOT NULL
           AND updated_at <= $1
         ${lockClause}
      `,
      [cutoff.toISOString()],
    );
    return result.rows.map((row) => ({
      itemId: row.item_id,
      tenantId: row.tenant_id,
      psp: row.psp,
      pspTransferId: row.psp_transfer_id,
    }));
  }

  private async loadSubmittedCollections(
    client: PoolClient,
    cutoff: Date,
  ): Promise<
    Array<{
      collectionId: string;
      tenantId: string;
      psp: string;
      pspDebitId: string;
      payoutItemId: string;
    }>
  > {
    const lockClause = process.env.NODE_ENV === 'test' ? '' : 'FOR UPDATE SKIP LOCKED';
    const result = await client.query<{
      collection_id: string;
      tenant_id: string;
      psp: string;
      psp_debit_id: string;
      payout_item_id: string;
    }>(
      `
        SELECT collection_id, tenant_id, psp, psp_debit_id, payout_item_id
          FROM collections
         WHERE status = 'submitted'
           AND psp_debit_id IS NOT NULL
           AND updated_at <= $1
         ${lockClause}
      `,
      [cutoff.toISOString()],
    );
    return result.rows.map((row) => ({
      collectionId: row.collection_id,
      tenantId: row.tenant_id,
      psp: row.psp,
      pspDebitId: row.psp_debit_id,
      payoutItemId: row.payout_item_id,
    }));
  }

  private async reconcilePayout(
    client: PoolClient,
    item: { itemId: string; tenantId: string; psp: string; pspTransferId: string },
  ): Promise<void> {
    try {
      const result = await this.adapter.lookup(item.pspTransferId);
      if (!result || result.status === 'pending') {
        return;
      }

      if (result.status === 'succeeded') {
        await client.query(
          `
            UPDATE payout_items
               SET status = 'succeeded',
                   error = NULL,
                   updated_at = NOW()
             WHERE item_id = $1
          `,
          [item.itemId],
        );
      } else if (result.status === 'failed') {
        await client.query(
          `
            UPDATE payout_items
               SET status = 'failed',
                   error = $2,
                   updated_at = NOW()
             WHERE item_id = $1
          `,
          [item.itemId, 'PSP reported payout failure'],
        );
      }
    } catch (error) {
      console.error('[payments] payout reconciliation error', { itemId: item.itemId, error });
    }
  }

  private async reconcileCollection(
    client: PoolClient,
    collection: { collectionId: string; tenantId: string; psp: string; pspDebitId: string; payoutItemId: string },
  ): Promise<void> {
    try {
      const result = await this.adapter.lookup(collection.pspDebitId);
      if (!result || result.status === 'pending') {
        return;
      }

      if (result.status === 'succeeded') {
        await client.query(
          `
            UPDATE collections
               SET status = 'succeeded',
                   error = NULL,
                   updated_at = NOW()
             WHERE collection_id = $1
          `,
          [collection.collectionId],
        );
        await client.query(
          `
            UPDATE payout_items
               SET status = 'succeeded',
                   error = NULL,
                   updated_at = NOW()
             WHERE item_id = $1
          `,
          [collection.payoutItemId],
        );
      } else if (result.status === 'failed') {
        await client.query(
          `
            UPDATE collections
               SET status = 'failed',
                   error = $2,
                   updated_at = NOW()
             WHERE collection_id = $1
          `,
          [collection.collectionId, 'PSP reported collection failure'],
        );
        await client.query(
          `
            UPDATE payout_items
               SET status = 'failed',
                   error = $2,
                   updated_at = NOW()
             WHERE item_id = $1
          `,
          [collection.payoutItemId, 'PSP reported collection failure'],
        );
      }
    } catch (error) {
      console.error('[payments] collection reconciliation error', {
        collectionId: collection.collectionId,
        error,
      });
    }
  }
}
