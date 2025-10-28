import Fastify from 'fastify';
import { CONFIG } from './config.js';
import { getPool, initDb, closePool } from './db.js';
import authPlugin from './plugins/auth.js';
import { registerReceiptRoutes } from './routes/receipts.js';
import { registerBalanceRoutes } from './routes/balances.js';
import { registerRedeemRoutes } from './routes/redeem.js';
import { registerReceiptStatusRoutes } from './routes/receipt-status.js';
import { registerRedeemStatusRoutes } from './routes/redeem-status.js';
import { registerProgramConfigRoutes } from './routes/program-configs.js';
import { registerPaymentRoutes } from './routes/payments.js';

export async function buildServer() {
  const app = Fastify({ logger: true });
  const pool = getPool();
  app.decorate('db', pool);

  app.addHook('onClose', async () => {
    await closePool();
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(authPlugin);

  await registerReceiptRoutes(app);
  await registerReceiptStatusRoutes(app);
  await registerProgramConfigRoutes(app);
  await registerBalanceRoutes(app);
  await registerRedeemRoutes(app);
  await registerRedeemStatusRoutes(app);
  await registerPaymentRoutes(app);

  return app;
}

async function start() {
  await initDb();
  const app = await buildServer();
  const port = CONFIG.port;
  const host = '0.0.0.0';

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err, 'Failed to start API');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
