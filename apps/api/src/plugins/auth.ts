import fp from 'fastify-plugin';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { promisify } from 'util';
import { scrypt as scryptCb, timingSafeEqual } from 'crypto';

const scrypt = promisify(scryptCb);

const PUBLIC_ROUTES = new Set(['/healthz']);

async function verifyApiKey(db: Pool, tenantId: string, apiKey: string) {
  const result = await db.query<{
    api_key_hash: Buffer;
    salt: Buffer;
  }>(
    `SELECT api_key_hash, salt
       FROM tenant_api_keys
      WHERE tenant_id = $1 AND active = true`,
    [tenantId],
  );

  if (result.rowCount === 0) {
    return false;
  }

  const { api_key_hash: hash, salt } = result.rows[0];
  const derived = (await scrypt(apiKey, salt, hash.length)) as Buffer;

  try {
    return timingSafeEqual(derived, hash);
  } catch {
    return false;
  }
}

async function authenticateRequest(request: FastifyRequest, reply: FastifyReply) {
  const routeUrl = request.routeOptions?.url;
  if (routeUrl && PUBLIC_ROUTES.has(routeUrl)) {
    return;
  }

  const tenantIdHeader = request.headers['x-tenant-id'];
  const apiKeyHeader = request.headers['x-api-key'];

  if (!tenantIdHeader || !apiKeyHeader) {
    reply.code(401).send({ error: 'Missing tenant credentials' });
    return reply;
  }

  const tenantId = String(tenantIdHeader);
  const apiKey = String(apiKeyHeader);

  const db = request.server.db as Pool;
  const valid = await verifyApiKey(db, tenantId, apiKey);

  if (!valid) {
    reply.code(401).send({ error: 'Invalid credentials' });
    return reply;
  }

  request.tenantId = tenantId;
  return;
}

export default fp(async (app) => {
  app.addHook('preHandler', authenticateRequest);
});
