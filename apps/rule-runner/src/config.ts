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
  DATABASE_URL: z.string().url(),
  POLL_INTERVAL_MS: z.string().optional(),
  MAX_ATTEMPTS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid rule runner configuration: ${parsed.error.message}`);
}

const env = parsed.data;

export const CONFIG = {
  env: env.NODE_ENV ?? 'development',
  databaseUrl: env.DATABASE_URL,
  pollIntervalMs: env.POLL_INTERVAL_MS ? Number(env.POLL_INTERVAL_MS) : 1000,
  maxAttempts: env.MAX_ATTEMPTS ? Number(env.MAX_ATTEMPTS) : 5,
};
