import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

if (!process.env.DATABASE_URL) {
  const searchPaths = ['.env', '../.env', '../../.env'];
  for (const candidate of searchPaths) {
    const absolute = resolve(process.cwd(), candidate);
    if (!existsSync(absolute)) {
      continue;
    }
    const result = loadEnv({ path: absolute });
    if (result?.parsed?.DATABASE_URL || process.env.DATABASE_URL) {
      break;
    }
  }
}

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  DATABASE_URL: z.string().url(),
  BOOTSTRAP_TENANT_ID: z.string().optional(),
  BOOTSTRAP_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

const env = parsed.data;

export const CONFIG = {
  env: env.NODE_ENV ?? 'development',
  port: env.PORT ? Number(env.PORT) : 3000,
  databaseUrl: env.DATABASE_URL,
  bootstrapTenantId: env.BOOTSTRAP_TENANT_ID,
  bootstrapApiKey: env.BOOTSTRAP_API_KEY,
};

export const DEFAULT_PROGRAM_ID = 'default_points';
export const DEFAULT_UNIT = 'points';
