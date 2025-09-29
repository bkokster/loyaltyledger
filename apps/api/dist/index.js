import Fastify from 'fastify';
import { CONFIG } from './config.js';
import { pool, initDb } from './db.js';
import authPlugin from './plugins/auth.js';
import { registerReceiptRoutes } from './routes/receipts.js';
import { registerBalanceRoutes } from './routes/balances.js';
import { registerRedeemRoutes } from './routes/redeem.js';
export async function buildServer() {
    const app = Fastify({ logger: true });
    app.decorate('db', pool);
    app.addHook('onClose', async () => {
        await pool.end();
    });
    app.get('/healthz', async () => ({ status: 'ok' }));
    await app.register(authPlugin);
    await registerReceiptRoutes(app);
    await registerBalanceRoutes(app);
    await registerRedeemRoutes(app);
    return app;
}
async function start() {
    await initDb();
    const app = await buildServer();
    const port = CONFIG.port;
    const host = '0.0.0.0';
    try {
        await app.listen({ port, host });
    }
    catch (err) {
        app.log.error(err, 'Failed to start API');
        process.exit(1);
    }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    start();
}
