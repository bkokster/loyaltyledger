# Dockerized Local Stack

This repository ships with a `docker-compose.yaml` that spins up:

- **postgres** — Postgres 16, credentials `loyalty/loyalty`, data persisted in the `pgdata` volume.
- **api** — Fastify ingest service; runs migrations on boot and seeds a demo tenant (`demo_tenant` / `demo_api_key`).
- **rule-runner** — Processes receipt/redeem jobs and posts ledger entries.
- **notifier** — Delivers job notifications to the webhook configured via environment variables.
- **settlement** — Generates net settlement summaries (runs continuously in this dev setup).

## Prerequisites

- Docker Desktop / Docker Engine >= 20
- Corepack-enabled PNPM (locally installing dependencies is recommended so Docker layer caching reuses them).

## Commands

```bash
pnpm docker:up   # build images and start the stack
pnpm docker:down # stop and remove containers/volumes
pnpm docker:test # run automated smoke test (brings the stack up and down)
```

The API listens on `http://localhost:3000` and Postgres on `localhost:5432`.

## Demo Workflow

1. Start the stack: `pnpm docker:up`.
2. Post a receipt:

   ```bash
   curl -X POST http://localhost:3000/v1/receipts \
     -H 'x-tenant-id: demo_tenant' \
     -H 'x-api-key: demo_api_key' \
     -H 'content-type: application/json' \
     -d '{
       "schema_version":"1.0",
       "idempotency_key":"idem-101",
       "issued_at":"2024-01-01T10:00:00Z",
       "currency":"USD",
       "merchant":{"merchant_id":"merchant_1"},
       "buyer":{"account_ref":"acct_1"},
       "totals":{"grand_total":42.5},
       "line_items":[]
     }'
   ```

3. (Optional) Redeem:

   ```bash
   curl -X POST http://localhost:3000/v1/redeem \
     -H 'x-tenant-id: demo_tenant' \
     -H 'x-api-key: demo_api_key' \
     -H 'content-type: application/json' \
     -d '{
       "account_id":"acct_1",
       "program_id":"default_points",
       "unit":"points",
       "qty":20
     }'
   ```

4. Tail logs (`docker compose logs -f rule-runner notifier`) or connect to Postgres with `psql postgres://loyalty:loyalty@localhost:5432/loyaltyledger` to inspect ledger entries.

The notifier ships with a default webhook target of `http://host.docker.internal:4000/mock-webhook`; adjust the environment if you need a different sink.
