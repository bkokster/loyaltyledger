import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { randomBytes, randomUUID, scryptSync } from 'crypto';
import type { Pool } from 'pg';
import { buildServer } from './index.js';
import { initDb, setPoolForTests, closePool } from './db.js';
import {
  setPoolForTests as setRunnerPoolForTests,
  closePool as closeRunnerPool,
} from '../../rule-runner/src/db.js';
import { processNextJob } from '../../rule-runner/src/processor.js';

const TEST_TENANT = 'tenant_test';
const TEST_API_KEY = 'super-secret';
const ACCOUNT_ID = 'acct_123';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://test';
}

process.env.NODE_ENV = 'test';

describe('Redemption flow', () => {
  let apiPool: Pool;
  let runnerPool: Pool;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = mem.adapters.createPg();
    const ApiPool = adapter.Pool;
    const RunnerPool = adapter.Pool;
    apiPool = new ApiPool();
    runnerPool = new RunnerPool();

    setPoolForTests(apiPool);
    setRunnerPoolForTests(runnerPool);
    await initDb();

    const salt = randomBytes(16);
    const hash = scryptSync(TEST_API_KEY, salt, 32);
    const hashHex = '\\x' + hash.toString('hex');
    const saltHex = '\\x' + salt.toString('hex');

    await apiPool.query(
      `INSERT INTO tenant_api_keys (tenant_id, api_key_hash, salt, active)
       VALUES ($1, $2, $3, TRUE)` ,
      [TEST_TENANT, hashHex, saltHex],
    );

    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await closePool();
    await closeRunnerPool();
  });

  beforeEach(async () => {
    await apiPool.query('DELETE FROM job_notifications');
    await apiPool.query('DELETE FROM program_configs');
    await apiPool.query('DELETE FROM merchant_redemption_rules');
    await apiPool.query('DELETE FROM redeem_jobs');
    await apiPool.query('DELETE FROM redeem_requests');
    await apiPool.query('DELETE FROM receipt_jobs');
    await apiPool.query('DELETE FROM receipts');
    await apiPool.query('DELETE FROM point_lots');
    await apiPool.query('DELETE FROM ledger_lines');
    await apiPool.query('DELETE FROM ledger_journal');
  });

  it('enqueues redemption and processes via rule runner', async () => {
    await seedEarnedPoints(server);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: {
        account_id: ACCOUNT_ID,
        program_id: 'default_points',
        unit: 'points',
        qty: 20,
        memo: 'coffee',
        idempotency_key: 'redeem-1',
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');

    const jobRows = await apiPool.query('SELECT status FROM redeem_jobs');
    expect(jobRows.rows[0].status).toBe('pending');

    const processed = await processNextJob();
    expect(processed).toBe(true);

    const jobRowsAfter = await apiPool.query(
      'SELECT status, result_summary FROM redeem_jobs',
    );
    expect(jobRowsAfter.rows[0].status).toBe('completed');
    expect(jobRowsAfter.rows[0].result_summary).toMatchObject({ points_redeemed: 20 });

    const notifications = await apiPool.query(
      `SELECT status, summary FROM job_notifications WHERE job_type = 'redeem'`,
    );
    expect(notifications.rowCount).toBeGreaterThan(0);
    expect(notifications.rows[0].status).toBe('completed');

    const journal = await apiPool.query(
      `SELECT entry_id FROM ledger_journal WHERE memo = $1 ORDER BY ts DESC LIMIT 1`,
      ['coffee'],
    );
    expect(journal.rowCount).toBe(1);
    const entryId = journal.rows[0].entry_id;

    const lines = await apiPool.query(
      `SELECT account_id, dr, cr FROM ledger_lines WHERE entry_id = $1 ORDER BY line_no`,
      [entryId],
    );
    expect(lines.rowCount).toBe(2);

    const statusResponse = await server.inject({
      method: 'GET',
      url: `/v1/redeem/${body.redemption_id}/status`,
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(statusResponse.statusCode).toBe(200);
    const statusBody = statusResponse.json();
    expect(statusBody.status).toBe('completed');
    expect(statusBody.summary).toMatchObject({ points_redeemed: 20 });
  });

  it('returns existing job for idempotent redemption', async () => {
    await seedEarnedPoints(server);

    const payload = {
      account_id: ACCOUNT_ID,
      program_id: 'default_points',
      unit: 'points',
      qty: 5,
      idempotency_key: 'redeem-dup',
    };

    const first = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload,
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();

    const second = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload,
    });

    expect(second.statusCode).toBe(409);
    const secondBody = second.json();
    expect(secondBody.redemption_id).toBe(firstBody.redemption_id);
    expect(secondBody.processing_job_id).toBe(firstBody.processing_job_id);
  });

  it('marks redemption as failed when balance is insufficient', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: {
        account_id: ACCOUNT_ID,
        program_id: 'default_points',
        unit: 'points',
        qty: 50,
      },
    });

    expect(response.statusCode).toBe(202);

    const processed = await processNextJob();
    expect(processed).toBe(true);

    const job = await apiPool.query(
      'SELECT status, last_error, result_summary FROM redeem_jobs',
    );
    expect(job.rows[0].status).toBe('failed');
    expect(job.rows[0].last_error).toBe('Insufficient balance');
    expect(job.rows[0].result_summary).toEqual({ failure: 'Insufficient balance' });

    const notifications = await apiPool.query(
      `SELECT status, error FROM job_notifications WHERE job_type = 'redeem' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(notifications.rows[0].status).toBe('failed');
    expect(notifications.rows[0].error).toBe('Insufficient balance');

    const statusResponse = await server.inject({
      method: 'GET',
      url: `/v1/redeem/${response.json().redemption_id}/status`,
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(statusResponse.statusCode).toBe(200);
    const statusBody = statusResponse.json();
    expect(statusBody.status).toBe('failed');
    expect(statusBody.last_error).toBe('Insufficient balance');
  });

  it('honours cross-brand configuration when redeeming', async () => {
    await seedEarnedPoints(server);

    await apiPool.query(
      `INSERT INTO program_configs (tenant_id, program_id, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, program_id)
       DO UPDATE SET config = EXCLUDED.config`,
      [
        TEST_TENANT,
        'default_points',
        {
          cross_brand_allocation: {
            strategy: 'priority',
            partners: [
              { merchant_account: 'partner::merchant::a' },
              { merchant_account: 'partner::merchant::b' },
            ],
          },
        },
      ],
    );

    const response = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: {
        account_id: ACCOUNT_ID,
        program_id: 'default_points',
        unit: 'points',
        qty: 30,
      },
    });

    expect(response.statusCode).toBe(202);
    await processNextJob();

    const journal = await apiPool.query(
      `SELECT entry_id FROM ledger_journal WHERE memo = $1 ORDER BY ts DESC LIMIT 1`,
      ['redeem'],
    );
    const entryId = journal.rows[0].entry_id;

    const partnerLines = await apiPool.query(
      `SELECT account_id, cr FROM ledger_lines WHERE entry_id = $1 AND dr = 0 ORDER BY cr DESC`,
      [entryId],
    );

    const accounts = partnerLines.rows.map((row) => row.account_id);
    expect(accounts).toContain('partner::merchant::a');
    expect(accounts).not.toContain('partner::merchant::b');
  });

  it('distributes proportionally when configured', async () => {
    await seedEarnedPoints(server);

    await apiPool.query(
      `INSERT INTO program_configs (tenant_id, program_id, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, program_id)
       DO UPDATE SET config = EXCLUDED.config`,
      [
        TEST_TENANT,
        'default_points',
        {
          cross_brand_allocation: {
            strategy: 'proportional',
            partners: [
              { merchant_account: 'partner::merchant::a', weight: 1 },
              { merchant_account: 'partner::merchant::b', weight: 1 },
            ],
          },
        },
      ],
    );

    const response = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: {
        account_id: ACCOUNT_ID,
        program_id: 'default_points',
        unit: 'points',
        qty: 20,
      },
    });

    expect(response.statusCode).toBe(202);
    await processNextJob();

    const journal = await apiPool.query(
      `SELECT entry_id FROM ledger_journal WHERE memo = $1 ORDER BY ts DESC LIMIT 1`,
      ['redeem'],
    );
    const entryId = journal.rows[0].entry_id;

    const partnerLines = await apiPool.query(
      `SELECT account_id, cr FROM ledger_lines WHERE entry_id = $1 AND dr = 0 ORDER BY account_id`,
      [entryId],
    );

    const matched = partnerLines.rows.filter((row) => row.account_id.startsWith('partner::'));
    expect(matched).toHaveLength(2);
    const amounts = matched.map((row) => Number(row.cr));
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(20);
  });

  it('respects configured earn to burn rules', async () => {
    await seedEarnedPoints(server);

    await apiPool.query(
      `INSERT INTO program_configs (tenant_id, program_id, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, program_id)
       DO UPDATE SET config = EXCLUDED.config` ,
      [
        TEST_TENANT,
        'default_points',
        {
          cross_brand_allocation: {
            strategy: 'source_proportional',
            partners: [{ merchant_account: 'partner::merchant::a', weight: 1 }],
            partner_map: [{ merchant_id: 'merchant_1', merchant_account: 'partner::merchant::a' }],
            expiry_days: 90,
          },
        },
      ],
    );

    await apiPool.query(
      `INSERT INTO merchant_redemption_rules (
         tenant_id, earn_merchant_id, earn_merchant_account, burn_merchant_id, expiry_days_override, settlement_adjustment_bps
       ) VALUES ($1, $2, $3, $4, $5, $6)` ,
      [TEST_TENANT, 'merchant_1', 'partner::merchant::a', 'merchant::burn::a', 45, 150],
    );

    const response = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: {
        account_id: ACCOUNT_ID,
        program_id: 'default_points',
        unit: 'points',
        qty: 30,
        burn_merchant_id: 'merchant::burn::a',
      },
    });

    expect(response.statusCode).toBe(202);
    await processNextJob();

    const jobRows = await apiPool.query(
      `SELECT status, result_summary FROM redeem_jobs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(jobRows.rows[0].status).toBe('completed');
    expect(jobRows.rows[0].result_summary).toMatchObject({
      burn_merchant_id: 'merchant::burn::a',
    });
    const summaryAllocation = (jobRows.rows[0].result_summary.allocation ?? []) as Array<{
      merchant_account: string;
      settlement_adjustment_bps?: number | null;
    }>;
    expect(summaryAllocation).toHaveLength(1);
    expect(summaryAllocation[0]).toMatchObject({
      merchant_account: 'partner::merchant::a',
      settlement_adjustment_bps: 150,
    });

    const entry = await apiPool.query(
      `SELECT entry_id FROM ledger_journal WHERE memo = $1 ORDER BY ts DESC LIMIT 1`,
      ['redeem'],
    );
    const entryId = entry.rows[0].entry_id;
    const merchantCredits = await apiPool.query(
      `SELECT account_id, cr FROM ledger_lines WHERE entry_id = $1 AND dr = 0`,
      [entryId],
    );
    expect(merchantCredits.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: 'partner::merchant::a', cr: expect.anything() }),
      ]),
    );
  });

  it('fails redemption when burn merchant is not authorised', async () => {
    await seedEarnedPoints(server);

    await apiPool.query(
      `INSERT INTO program_configs (tenant_id, program_id, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, program_id)
       DO UPDATE SET config = EXCLUDED.config` ,
      [
        TEST_TENANT,
        'default_points',
        {
          cross_brand_allocation: {
            strategy: 'source_proportional',
            partners: [{ merchant_account: 'partner::merchant::a', weight: 1 }],
            partner_map: [{ merchant_id: 'merchant_1', merchant_account: 'partner::merchant::a' }],
          },
        },
      ],
    );

    await apiPool.query(
      `INSERT INTO merchant_redemption_rules (
         tenant_id, earn_merchant_id, earn_merchant_account, burn_merchant_id
       ) VALUES ($1, $2, $3, $4)` ,
      [TEST_TENANT, 'merchant_1', 'partner::merchant::a', 'merchant::burn::allowed'],
    );

    const response = await server.inject({
      method: 'POST',
      url: '/v1/redeem',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: {
        account_id: ACCOUNT_ID,
        program_id: 'default_points',
        unit: 'points',
        qty: 20,
        burn_merchant_id: 'merchant::burn::blocked',
      },
    });

    expect(response.statusCode).toBe(202);
    await processNextJob();

    const jobRows = await apiPool.query(
      `SELECT status, last_error FROM redeem_jobs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(jobRows.rows[0].status).toBe('failed');
    expect(jobRows.rows[0].last_error).toContain('Insufficient balance');
  });

  it('responds with 400 for malformed redemption id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/redeem/not-a-uuid/status',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('responds with 404 for missing redemption', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/redeem/${randomUUID()}/status`,
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  async function seedEarnedPoints(testServer: Awaited<ReturnType<typeof buildServer>>) {
    const receiptResponse = await testServer.inject({
      method: 'POST',
      url: '/v1/receipts',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: {
        schema_version: '1.0',
        idempotency_key: randomUUID(),
        issued_at: '2024-01-01T10:00:00Z',
        currency: 'USD',
        merchant: { merchant_id: 'merchant_1' },
        buyer: { account_ref: ACCOUNT_ID },
        totals: { grand_total: 100 },
        line_items: [],
      },
    });

    expect(receiptResponse.statusCode).toBe(202);
    const processedReceipt = await processNextJob();
    expect(processedReceipt).toBe(true);
  }
});
