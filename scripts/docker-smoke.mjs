#!/usr/bin/env node
import { execSync } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { randomUUID } from 'crypto';
import { Client } from 'pg';

const composeCmd = process.env.DOCKER_CMD ?? 'docker compose';
const tenantId = 'demo_tenant';
const apiKey = 'demo_api_key';
const apiBase = process.env.DOCKER_SMOKE_API ?? 'http://localhost:3000';
const dbUrl = process.env.DOCKER_SMOKE_DB ?? 'postgres://loyalty:loyalty@localhost:5432/loyaltyledger';

let shouldTearDown = process.env.DOCKER_SMOKE_PRESERVE !== 'true';

async function main() {
  console.log('🐋 Starting docker stack…');
  run(`${composeCmd} up --build -d`);

  try {
    await waitForHealth();
    console.log('✅ API healthy');

    await seedProgramConfig();
    const users = await seedReceipts();
    await exerciseRedemptions(users);
    await verifyUserBalances(users);
    await exerciseStampProgram();
    await exerciseTierProgram(users);
    await runParallelOverdraw(users[0]);
    console.log('🎉 Docker smoke test succeeded');
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

async function seedProgramConfig() {
  const configPayload = {
    config: {
      points_multiplier: 1,
      cross_brand_allocation: {
        strategy: 'priority',
        partners: [
          { merchant_account: 'partner::merchant::a' },
          { merchant_account: 'partner::merchant::b' },
        ],
      },
      stamp_programs: [
        {
          id: 'coffee_card',
          skus: ['COFFEE_SM', 'COFFEE_LG'],
          stamps_per_item: 1,
          threshold: 5,
          unit: 'stamps:coffee_card',
          coupon_unit: 'coupon:coffee_card',
        },
      ],
      loyalty_tiers: {
        window_days: 365,
        tiers: [
          { id: 'base', display_name: 'Base', threshold_cents: 0 },
          { id: 'silver', display_name: 'Silver', threshold_cents: 15000 },
        ],
      },
    },
  };

  const res = await fetch(`${apiBase}/v1/programs/default_points/config`, {
    method: 'PUT',
    headers: defaultHeaders({ json: true }),
    body: JSON.stringify(configPayload),
  });

  if (!res.ok) {
    throw new Error(`Failed to seed program config: ${res.status} ${await res.text()}`);
  }
}

async function seedReceipts() {
  const users = Array.from({ length: 5 }).map((_, idx) => ({
    account: `acct_docker_${idx}`,
    merchant: idx % 2 === 0 ? 'merchant_primary' : 'merchant_partner',
    receiptIds: [],
  }));

  for (const user of users) {
    for (let i = 0; i < 3; i++) {
      const receiptId = await postReceipt({
        account_id: user.account,
        merchant_id: user.merchant,
        grand_total: 50 + i * 10,
      });
      user.receiptIds.push(receiptId);
      await waitForReceipt(receiptId);
    }
    console.log(`📄 Seeded receipts for ${user.account}`);
  }

  return users;
}

async function exerciseRedemptions(users) {
  for (const user of users) {
    const redemptionIds = [];
    for (const qty of [30, 40]) {
      const redemptionId = await postRedeem({ account_id: user.account, qty });
      redemptionIds.push(redemptionId);
      const status = await waitForRedeem(redemptionId);
      validateRedeemSummary(status, qty);
      console.log(`🔥 ${user.account} redeemed ${qty}`);
    }

    // Attempt to overdraw well above remaining balance
    const overdraw = await postRedeem({ account_id: user.account, qty: 500 }).then(waitForRedeem);
    if (overdraw.status !== 'failed' || overdraw.last_error !== 'Insufficient balance') {
      throw new Error(`Expected overdraw failure for ${user.account}`);
    }
    console.log(`🚫 Overdraw correctly blocked for ${user.account}`);
  }
}

async function postReceipt({ account_id, merchant_id, grand_total, line_items = [] }) {
  const payload = {
    schema_version: '1.0',
    idempotency_key: randomUUID(),
    issued_at: new Date().toISOString(),
    currency: 'USD',
    merchant: { merchant_id },
    buyer: { account_ref: account_id },
    totals: { grand_total },
    line_items,
  };

  const res = await fetch(`${apiBase}/v1/receipts`, {
    method: 'POST',
    headers: defaultHeaders({ json: true }),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to POST receipt: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  return body.receipt_id;
}

async function waitForReceipt(receiptId) {
  return waitForStatus(`${apiBase}/v1/receipts/${receiptId}/status`, (status) => {
    if (status.status === 'completed') {
      return status;
    }
    if (status.status === 'failed') {
      throw new Error(`Receipt job failed: ${status.last_error}`);
    }
    return null;
  });
}

async function postRedeem({ account_id, qty }) {
  const payload = {
    account_id,
    program_id: 'default_points',
    unit: 'points',
    qty,
  };

  const res = await fetch(`${apiBase}/v1/redeem`, {
    method: 'POST',
    headers: defaultHeaders({ json: true }),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to POST redeem: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  return body.redemption_id;
}

async function waitForRedeem(redemptionId) {
  return waitForStatus(`${apiBase}/v1/redeem/${redemptionId}/status`, (status) => {
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }
    return null;
  });
}

function validateRedeemSummary(status, expectedQty) {
  if (status.status !== 'completed') {
    return;
  }
  const summary = status.summary ?? {};
  if (summary.points_redeemed !== expectedQty) {
    throw new Error(`Unexpected points_redeemed: ${summary.points_redeemed}`);
  }
  const allocation = summary.allocation ?? [];
  const accounts = allocation.map((item) => item.merchant_account);
  if (!accounts.includes('partner::merchant::a')) {
    throw new Error('Allocation missing partner::merchant::a');
  }
}

async function verifyUserBalances(users) {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const user of users) {
      const { rows } = await client.query(
        `SELECT COALESCE(SUM(cr) - SUM(dr), 0) AS balance
           FROM ledger_lines l
           JOIN ledger_journal j ON j.entry_id = l.entry_id
          WHERE j.tenant_id = $1 AND j.program_id = $2 AND l.unit = $3 AND l.account_id = $4`,
        ['demo_tenant', 'default_points', 'points', customerAccount(user.account)],
      );
      const remaining = Number(rows[0]?.balance ?? 0);
      if (remaining < 0) {
        throw new Error(`Negative balance for ${user.account}: ${remaining}`);
      }
      console.log(`💰 ${user.account} remaining balance ${remaining}`);
    }
  } finally {
    await client.end();
  }
}

async function exerciseStampProgram() {
  const account = 'acct_stamps';
  const merchantId = 'merchant_primary';
  let lastStatus = null;

  for (let i = 0; i < 5; i++) {
    const receiptId = await postReceipt({
      account_id: account,
      merchant_id: merchantId,
      grand_total: 5,
      line_items: [
        { line_id: `stamp-${i}`, sku: 'COFFEE_SM', qty: 1, unit_price: 5 },
      ],
    });
    lastStatus = await waitForReceipt(receiptId);
  }

  console.log('📊 Stamp receipt summary', lastStatus?.summary ?? {});

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const [stampsRow] = (
      await client.query(
        `SELECT COALESCE(SUM(cr) - SUM(dr), 0) AS balance
           FROM ledger_lines l
           JOIN ledger_journal j ON j.entry_id = l.entry_id
          WHERE j.tenant_id = $1 AND j.program_id = $2 AND l.unit = $3 AND l.account_id = $4`,
        ['demo_tenant', 'default_points', 'stamps:coffee_card', customerAccount(account)],
      )
    ).rows;

    const [couponRow] = (
      await client.query(
        `SELECT COALESCE(SUM(cr) - SUM(dr), 0) AS balance
           FROM ledger_lines l
           JOIN ledger_journal j ON j.entry_id = l.entry_id
          WHERE j.tenant_id = $1 AND j.program_id = $2 AND l.unit = $3 AND l.account_id = $4`,
        ['demo_tenant', 'default_points', 'coupon:coffee_card', customerAccount(account)],
      )
    ).rows;

    const stampBalance = Number(stampsRow?.balance ?? 0);
    const couponBalance = Number(couponRow?.balance ?? 0);

    if (stampBalance < 5) {
      throw new Error(`Expected at least 5 stamps, found ${stampBalance}`);
    }
    if (couponBalance < 1) {
      throw new Error(`Expected at least 1 coupon, found ${couponBalance}`);
    }

    console.log(
      `🪙 Stamp program issued ${stampBalance} stamps and ${couponBalance} coupons for ${account}`,
    );
  } finally {
    await client.end();
  }
}

async function exerciseTierProgram(users) {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const candidate = users.find((user) => user.merchant === 'merchant_primary') ?? users[0];
    const { rows } = await client.query(
      `SELECT tier_id, rolling_spend_cents
         FROM customer_tiers
        WHERE tenant_id = $1
          AND merchant_id = $2
          AND customer_account = $3`,
      ['demo_tenant', 'merchant_primary', customerAccount(candidate.account)],
    );

    if (rows.length === 0) {
      throw new Error('Expected customer tier record to exist');
    }

    const tier = rows[0];
    if (tier.tier_id !== 'silver') {
      throw new Error(`Expected tier to be silver, got ${tier.tier_id}`);
    }
    const spend = Number(tier.rolling_spend_cents ?? 0);
    if (spend < 15000) {
      throw new Error(`Expected rolling spend above threshold, got ${spend}`);
    }

    console.log(
      `🥇 Tier program set ${candidate.account} to ${tier.tier_id} with rolling spend ${spend}`,
    );
  } finally {
    await client.end();
  }
}

async function runParallelOverdraw(user) {
  const qty = 60;
  console.log(`🔁 Running parallel redeem attempts for ${user.account}`);
  const attemptIds = await Promise.allSettled(
    Array.from({ length: 3 }).map(() => postRedeem({ account_id: user.account, qty })),
  );

  let successCount = 0;
  for (const result of attemptIds) {
    if (result.status === 'fulfilled') {
      const status = await waitForRedeem(result.value);
      if (status.status === 'completed') {
        successCount += 1;
      }
    }
  }

  if (successCount > 1) {
    throw new Error('Parallel overdraw allowed multiple successes');
  }
  console.log(`✅ Parallel overdraw allowed ${successCount} successes (expected ≤ 1)`);
}

async function waitForStatus(url, handler) {
  for (let attempt = 1; attempt <= 60; attempt++) {
    const res = await fetch(url, { headers: defaultHeaders() });
    if (!res.ok) {
      throw new Error(`Status poll failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const result = handler(body);
    if (result) {
      return result;
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for status at ${url}`);
}

function defaultHeaders({ json = false } = {}) {
  const headers = {
    'x-tenant-id': tenantId,
    'x-api-key': apiKey,
  };
  if (json) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: '0' } });
}

function customerAccount(account) {
  return `demo_tenant::acct::${account}`;
}

process.on('SIGINT', () => {
  shouldTearDown = true;
});

main().catch((err) => {
  console.error('❌ Docker smoke test failed:', err);
  if (shouldTearDown) {
    try {
      run(`${composeCmd} down -v`);
    } catch {
      // ignore
    }
  }
  process.exit(1);
});
