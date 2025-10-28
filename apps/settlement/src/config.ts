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
  SETTLEMENT_LOOKBACK_DAYS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid settlement configuration: ${parsed.error.message}`);
}

const env = parsed.data;

export const CONFIG = {
  env: env.NODE_ENV ?? 'development',
  databaseUrl: env.DATABASE_URL,
  lookbackDays: env.SETTLEMENT_LOOKBACK_DAYS ? Number(env.SETTLEMENT_LOOKBACK_DAYS) : 1,
};
