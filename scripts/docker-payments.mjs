#!/usr/bin/env node
import { execSync } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { Client } from 'pg';
import { randomUUID } from 'crypto';

const composeCmd = process.env.DOCKER_CMD ?? 'docker compose';
const tenantId = process.env.DOCKER_TENANT_ID ?? 'demo_tenant';
const apiKey = process.env.DOCKER_API_KEY ?? 'demo_api_key';
const apiBase = process.env.DOCKER_SMOKE_API ?? 'http://localhost:3000';
const dbUrl = process.env.DOCKER_SMOKE_DB ?? 'postgres://loyalty:loyalty@localhost:5432/loyaltyledger';

let shouldTearDown = process.env.DOCKER_SMOKE_PRESERVE !== 'true';

async function main() {
  console.log('🐋 Starting docker stack for payments smoke test…');
  run(`${composeCmd} up --build -d`);

  try {
    await waitForHealth();
    console.log('✅ API healthy');

    await runPaymentsFlow();
    console.log('🎉 Payments docker smoke test passed');
  } finally {
    if (shouldTearDown) {
      console.log('🧹 Shutting down docker stack…');
      run(`${composeCmd} down -v`);
    } else {
      console.log('ℹ️ Leaving docker stack running (DOCKER_SMOKE_PRESERVE=true)');
    }
  }
}

async function waitForHealth() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const res = await fetch(`${apiBase}/healthz`);
      if (res.ok) {
        return;
      }
    } catch {
      // ignore
    }
    console.log(`⌛ Waiting for API (${attempt})`);
    await delay(1000);
  }
  throw new Error('API health check never passed');
}

async function runPaymentsFlow() {
  const accountResponse = await fetch(`${apiBase}/v1/payments/accounts`, {
    method: 'POST',
    headers: defaultHeaders({ json: true }),
    body: JSON.stringify({
      merchant_id: 'merchant_demo',
      psp: 'mock',
      psp_account_id: 'acct_demo_psp',
      currency: 'USD',
    }),
  });
  await assertStatus(accountResponse, 201, 'account onboarding should return 201');

  const listAccounts = await fetch(`${apiBase}/v1/payments/accounts`, {
    method: 'GET',
    headers: defaultHeaders(),
  });
  await assertStatus(listAccounts, 200, 'account listing should return 200');

  const { client, periodStart, periodEnd, merchantAccount } = await seedSettlementScenario();

  await assertStatus(
    fetch(`${apiBase}/v1/payments/batches`, {
      method: 'POST',
      headers: defaultHeaders({ json: true }),
      body: JSON.stringify({ period_start: periodStart, period_end: periodEnd }),
    }),
    201,
    'batch creation should return 201',
  );

  await runWorker('scheduler');
  await runWorker('submitter');
  await runWorker('reconciler');

  const payoutItems = await client.query(
    `SELECT status, net_cents FROM payout_items WHERE tenant_id = $1 AND merchant_account = $2`,
    [tenantId, merchantAccount],
  );
  if (payoutItems.rowCount !== 1 || payoutItems.rows[0].status !== 'succeeded') {
    throw new Error(`Expected succeeded payout item, found ${JSON.stringify(payoutItems.rows)}`);
  }

  await runWorker('freezer');

  const freezeStatus = await client.query(
    `SELECT frozen FROM merchant_status WHERE tenant_id = $1 AND merchant_account = $2`,
    [tenantId, merchantAccount],
  );
  if (freezeStatus.rowCount > 0 && freezeStatus.rows[0].frozen) {
    throw new Error('Merchant should not be frozen after successful payout');
  }

  await client.end();

  await assertStatus(
    fetch(`${apiBase}/v1/payments/webhooks/stripe`, {
      method: 'POST',
      headers: {
        ...defaultHeaders({ json: true }),
      },
      body: JSON.stringify({ id: 'evt_test', type: 'mock.event' }),
    }),
    202,
    'webhook endpoint should return 202',
  );
}

async function seedSettlementScenario() {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const periodStart = '2024-01-01T00:00:00Z';
  const periodEnd = '2024-01-31T00:00:00Z';
  const merchantAccount = 'merchant_demo';

  await client.query(
    `
      INSERT INTO program_configs (tenant_id, program_id, config, updated_at)
      VALUES ($1, 'default_points', $2::jsonb, NOW())
      ON CONFLICT (tenant_id, program_id)
      DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
    `,
    [tenantId, JSON.stringify({ cents_per_point: 100, platform_fee_bps: 200, min_payout_cents: 1000 })],
  );

  await client.query(
    `
      INSERT INTO settlement_reports (
        report_id, tenant_id, merchant_account, period_start, period_end, net_points, summary, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (tenant_id, merchant_account, period_start, period_end)
      DO UPDATE SET net_points = EXCLUDED.net_points, summary = EXCLUDED.summary
    `,
    [randomUUID(), tenantId, merchantAccount, periodStart, periodEnd, 500, { source: 'docker-test' }],
  );

  return { client, periodStart, periodEnd, merchantAccount };
}

async function runWorker(worker) {
  console.log(`▶️  Running payments worker: ${worker}`);
  run(`${composeCmd} exec payments sh -lc "PAYMENTS_WORKER=${worker} node dist/index.js"`);
}

async function assertStatus(responsePromise, expectedStatus, message) {
  const response = await responsePromise;
  if (response.status !== expectedStatus) {
    const body = await response.text();
    throw new Error(`${message}. Expected ${expectedStatus} got ${response.status}: ${body}`);
  }
}

function defaultHeaders({ json } = { json: false }) {
  const headers = {
    'x-tenant-id': tenantId,
    'x-api-key': apiKey,
  };
  if (json) {
    return { ...headers, 'content-type': 'application/json' };
  }
  return headers;
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

main().catch((err) => {
  console.error('❌ Payments docker smoke test failed');
  console.error(err);
  process.exit(1);
});
