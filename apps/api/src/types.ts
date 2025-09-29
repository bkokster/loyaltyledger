import 'fastify';
import type { Pool } from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }

  interface FastifyRequest {
    tenantId?: string;
  }
}
