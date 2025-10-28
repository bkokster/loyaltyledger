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

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://test';
}

process.env.NODE_ENV = 'test';

describe('Receipt ingestion flow', () => {
  let pool: Pool;
  let runnerPool: Pool;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = mem.adapters.createPg();
    const ApiPool = adapter.Pool;
    const RunnerPool = adapter.Pool;
    pool = new ApiPool();
    runnerPool = new RunnerPool();

    setPoolForTests(pool);
    setRunnerPoolForTests(runnerPool);

    await initDb();

    const salt = randomBytes(16);
    const hash = scryptSync(TEST_API_KEY, salt, 32);
    const hashHex = '\\x' + hash.toString('hex');
    const saltHex = '\\x' + salt.toString('hex');
    await pool.query(
      `INSERT INTO tenant_api_keys (tenant_id, api_key_hash, salt, active)
       VALUES ($1, $2, $3, TRUE)`,
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
    await pool.query('DELETE FROM job_notifications');
    await pool.query('DELETE FROM program_configs');
    await pool.query('DELETE FROM ledger_lines');
    await pool.query('DELETE FROM ledger_journal');
    await pool.query('DELETE FROM receipt_jobs');
    await pool.query('DELETE FROM receipts');
  });

  it('enqueues a receipt job and processes it via the rule runner', async () => {
    const payload = {
      schema_version: '1.0',
      idempotency_key: 'idem-1',
      issued_at: '2024-01-01T10:00:00Z',
      currency: 'USD',
      merchant: { merchant_id: 'merchant_1' },
      buyer: { account_ref: 'acct_123' },
      totals: { grand_total: 12.5 },
      line_items: [],
    };

    const response = await server.inject({
      method: 'POST',
      url: '/v1/receipts',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');

    const jobRows = await pool.query(`SELECT * FROM receipt_jobs`);
    expect(jobRows.rowCount).toBe(1);
    expect(jobRows.rows[0].status).toBe('pending');

    const processed = await processNextJob();
    expect(processed).toBe(true);

    const jobRowsAfter = await pool.query(`SELECT status, result_summary FROM receipt_jobs`);
    expect(jobRowsAfter.rows[0].status).toBe('completed');
    expect(jobRowsAfter.rows[0].result_summary).toEqual({ points_earned: 13 });

    const notifications = await pool.query(
      `SELECT job_type, status, summary FROM job_notifications`,
    );
    expect(notifications.rowCount).toBe(1);
    expect(notifications.rows[0].job_type).toBe('receipt');
    expect(notifications.rows[0].status).toBe('completed');
    expect(notifications.rows[0].summary).toEqual({ points_earned: 13 });

    const statusResponse = await server.inject({
      method: 'GET',
      url: `/v1/receipts/${body.receipt_id}/status`,
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(statusResponse.statusCode).toBe(200);
    const statusBody = statusResponse.json();
    expect(statusBody.status).toBe('completed');
    expect(statusBody.summary).toEqual({ points_earned: 13 });

    const ledgerLines = await pool.query(
      `SELECT account_id, dr, cr, unit FROM ledger_lines ORDER BY line_no`,
    );
    expect(ledgerLines.rowCount).toBe(2);
  });

  it('returns conflict with existing job metadata on duplicate receipt', async () => {
    const payload = {
      schema_version: '1.0',
      idempotency_key: 'idem-dup',
      issued_at: '2024-01-01T10:00:00Z',
      currency: 'USD',
      merchant: { merchant_id: 'merchant_1' },
      buyer: { account_ref: 'acct_dup' },
      totals: { grand_total: 5 },
      line_items: [],
    };

    const first = await server.inject({
      method: 'POST',
      url: '/v1/receipts',
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
      url: '/v1/receipts',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload,
    });

    expect(second.statusCode).toBe(409);
    const secondBody = second.json();
    expect(secondBody.receipt_id).toBe(firstBody.receipt_id);
    expect(secondBody.processing_job_id).toBe(firstBody.processing_job_id);
  });

  it('honours program configuration multiplier when present', async () => {
    await server.inject({
      method: 'PUT',
      url: '/v1/programs/default_points/config',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload: { config: { points_multiplier: 1.5 } },
    });

    const payload = {
      schema_version: '1.0',
      idempotency_key: 'idem-multiplier',
      issued_at: '2024-01-01T10:00:00Z',
      currency: 'USD',
      merchant: { merchant_id: 'merchant_abc' },
      buyer: { account_ref: 'acct_mult' },
      totals: { grand_total: 10 },
      line_items: [],
    };

    const response = await server.inject({
      method: 'POST',
      url: '/v1/receipts',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    await processNextJob();

    const job = await pool.query(
      `SELECT result_summary FROM receipt_jobs WHERE tenant_id = $1 AND receipt_id = $2`,
      [TEST_TENANT, response.json().receipt_id],
    );

    expect(job.rows[0].result_summary).toEqual({ points_earned: 15 });
  });

  it('responds with 400 for malformed receipt id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/receipts/non-existent/status',
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('responds with 404 for missing receipt', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/receipts/${randomUUID()}/status`,
      headers: {
        'x-tenant-id': TEST_TENANT,
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(response.statusCode).toBe(404);
  });
});
