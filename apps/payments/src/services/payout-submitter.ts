import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import type { PSPAdapter } from '../adapters/index.js';
import { CONFIG } from '../config.js';
import { generateId } from '@loyaltyledger/core';

export class PayoutSubmitter {
  constructor(private readonly adapter: PSPAdapter) {}

  async processNextPending(): Promise<boolean> {
    let workCompleted = false;
    await withTransaction(async (client) => {
      const item = await this.takeNextItem(client);
      if (!item) {
        return;
      }

      workCompleted = true;
      if (item.direction === 'payout') {
        await this.submitPayout(client, item);
      } else {
        await this.submitCollection(client, item);
      }
    });
    return workCompleted;
  }

  private async takeNextItem(
    client: PoolClient,
  ): Promise<
    | null
    | {
        itemId: string;
        tenantId: string;
        merchantId: string | null;
        merchantAccount: string;
        direction: 'payout' | 'collect';
        netCents: bigint;
        feeCents: bigint;
        currency: string;
        psp: string;
        pspAccountId: string | null;
      }
  > {
    const lockClause = process.env.NODE_ENV === 'test' ? '' : 'FOR UPDATE SKIP LOCKED';
    const result = await client.query<{
      item_id: string;
      tenant_id: string;
      merchant_id: string | null;
      merchant_account: string;
      direction: 'payout' | 'collect';
      net_cents: string | number;
      fee_cents: string | number;
      currency: string;
      psp: string;
      psp_account_id: string | null;
    }>(
      `
        SELECT
          i.item_id,
          i.tenant_id,
          i.merchant_id,
          i.merchant_account,
          i.direction,
          i.net_cents,
          i.fee_cents,
          i.psp,
          b.currency,
          pa.psp_account_id
        FROM payout_items i
        JOIN payout_batches b ON b.batch_id = i.batch_id
        LEFT JOIN payment_accounts pa
          ON pa.tenant_id = i.tenant_id
         AND pa.merchant_id = i.merchant_id
       WHERE i.status = 'pending'
       ORDER BY i.created_at
       ${lockClause}
       LIMIT 1
      `,
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      itemId: row.item_id,
      tenantId: row.tenant_id,
      merchantId: row.merchant_id,
      merchantAccount: row.merchant_account,
      direction: row.direction,
      netCents: BigInt(row.net_cents ?? 0),
      feeCents: BigInt(row.fee_cents ?? 0),
      currency: row.currency ?? 'USD',
      psp: row.psp,
      pspAccountId: row.psp_account_id,
    };
  }

  private async submitPayout(
    client: PoolClient,
    item: {
      itemId: string;
      tenantId: string;
      merchantId: string | null;
      merchantAccount: string;
      netCents: bigint;
      feeCents: bigint;
      currency: string;
      psp: string;
      pspAccountId: string | null;
    },
  ): Promise<void> {
    if (!item.merchantId || !item.pspAccountId) {
      await this.failItem(client, item.itemId, 'Missing merchant PSP account details');
      return;
    }
    if (item.netCents <= 0n) {
      await this.failItem(client, item.itemId, 'Payout item has non-positive net amount');
      return;
    }

    const amount = bigintToNumber(item.netCents);
    const platformFee = Math.max(0, Number(item.feeCents));

    try {
      const result = await this.adapter.createPayout({
        tenantId: item.tenantId,
        merchant: { merchantId: item.merchantId, pspAccountId: item.pspAccountId },
        amountCents: amount,
        currency: item.currency,
        platformFeeCents: platformFee,
        idempotencyKey: `${item.itemId}:payout`,
      });

      await client.query(
        `
          UPDATE payout_items
             SET status = 'submitted',
                 psp_transfer_id = $2,
                 error = NULL,
                 updated_at = NOW()
           WHERE item_id = $1
        `,
        [item.itemId, result.transferId],
      );
    } catch (error) {
      const message = extractError(error);
      await this.failItem(client, item.itemId, message);
    }
  }

  private async submitCollection(
    client: PoolClient,
    item: {
      itemId: string;
      tenantId: string;
      merchantId: string | null;
      merchantAccount: string;
      netCents: bigint;
      currency: string;
      psp: string;
      pspAccountId: string | null;
    },
  ): Promise<void> {
    if (item.netCents >= 0n) {
      await this.failItem(client, item.itemId, 'Collection item has non-negative net amount');
      return;
    }

    const amount = bigintToNumber(-item.netCents);
    const merchantId = item.merchantId ?? item.merchantAccount;

    const collection = await this.upsertCollection(client, {
      tenantId: item.tenantId,
      payoutItemId: item.itemId,
      merchantId,
      merchantAccount: item.merchantAccount,
      amountCents: amount,
      currency: item.currency,
      psp: item.psp,
    });

    if (collection.attempts >= CONFIG.submitterMaxAttempts) {
      await this.failItem(client, item.itemId, 'Collection exceeded max attempts');
      return;
    }

    try {
      const result = await this.adapter.createDebit({
        tenantId: item.tenantId,
        merchant: { merchantId, pspAccountId: item.pspAccountId ?? undefined },
        amountCents: amount,
        currency: item.currency,
        idempotencyKey: `${item.itemId}:collect`,
      });

      await client.query(
        `
          UPDATE collections
             SET status = 'submitted',
                 attempts = attempts + 1,
                 psp_debit_id = $2,
                 error = NULL,
                 updated_at = NOW()
           WHERE collection_id = $1
        `,
        [collection.collectionId, result.debitId],
      );

      await client.query(
        `
          UPDATE payout_items
             SET status = 'submitted',
                 error = NULL,
                 updated_at = NOW()
           WHERE item_id = $1
        `,
        [item.itemId],
      );
    } catch (error) {
      const message = extractError(error);
      await client.query(
        `
          UPDATE collections
             SET status = 'failed',
                 attempts = attempts + 1,
                 error = $2,
                 updated_at = NOW()
           WHERE collection_id = $1
        `,
        [collection.collectionId, message],
      );
      await this.failItem(client, item.itemId, message);
    }
  }

  private async upsertCollection(
    client: PoolClient,
    input: {
      tenantId: string;
      payoutItemId: string;
      merchantId: string;
      merchantAccount: string;
      amountCents: number;
      currency: string;
      psp: string;
    },
  ): Promise<{ collectionId: string; attempts: number }> {
    const existing = await client.query<{
      collection_id: string;
      attempts: number;
    }>(
      `
        SELECT collection_id, attempts
          FROM collections
         WHERE payout_item_id = $1
         FOR UPDATE
      `,
      [input.payoutItemId],
    );

    if ((existing.rowCount ?? 0) > 0) {
      return {
        collectionId: existing.rows[0].collection_id,
        attempts: existing.rows[0].attempts ?? 0,
      };
    }

    const collectionId = generateId();
    await client.query(
      `
        INSERT INTO collections (
          collection_id, tenant_id, payout_item_id, merchant_id, merchant_account,
          amount_cents, currency, psp, status, attempts, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, NOW(), NOW())
      `,
      [
        collectionId,
        input.tenantId,
        input.payoutItemId,
        input.merchantId,
        input.merchantAccount,
        input.amountCents,
        input.currency,
        input.psp,
      ],
    );

    return { collectionId, attempts: 0 };
  }

  private async failItem(client: PoolClient, itemId: string, message: string): Promise<void> {
    await client.query(
      `
        UPDATE payout_items
           SET status = 'failed',
               error = $2,
               updated_at = NOW()
         WHERE item_id = $1
      `,
      [itemId, message.slice(0, 400)],
    );
  }
}

function bigintToNumber(value: bigint): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error('Amount exceeds numeric range');
  }
  return num;
}

function extractError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : 'Unknown PSP error';
}
