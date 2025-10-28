import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

if (!process.env.DATABASE_URL) {
  const candidates = ['.env', '../.env', '../../.env'];
  for (const candidate of candidates) {
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
  PAYMENTS_PSP: z.string().optional(),
  PAYMENTS_SCHEDULER_LOOKBACK_DAYS: z.string().optional(),
  PAYMENTS_SUBMITTER_MAX_ATTEMPTS: z.string().optional(),
  PAYMENTS_RECONCILE_LOOKBACK_HOURS: z.string().optional(),
  PAYMENTS_FREEZE_MAX_FAILED_ATTEMPTS: z.string().optional(),
  PAYMENTS_FREEZE_ARREARS_DAYS: z.string().optional(),
  PAYMENTS_FREEZE_MIN_OUTSTANDING_CENTS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid payments configuration: ${parsed.error.message}`);
}

const env = parsed.data;

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

export const CONFIG = {
  env: env.NODE_ENV ?? 'development',
  databaseUrl: env.DATABASE_URL,
  defaultPsp: env.PAYMENTS_PSP ?? 'stripe',
  schedulerLookbackDays: parseNumber(env.PAYMENTS_SCHEDULER_LOOKBACK_DAYS, 30),
  submitterMaxAttempts: parseNumber(env.PAYMENTS_SUBMITTER_MAX_ATTEMPTS, 5),
  reconcileLookbackHours: parseNumber(env.PAYMENTS_RECONCILE_LOOKBACK_HOURS, 6),
  freezePolicy: {
    maxFailedAttempts: parseNumber(env.PAYMENTS_FREEZE_MAX_FAILED_ATTEMPTS, 3),
    arrearsDays: parseNumber(env.PAYMENTS_FREEZE_ARREARS_DAYS, 7),
    minOutstandingCents: parseNumber(env.PAYMENTS_FREEZE_MIN_OUTSTANDING_CENTS, 5_000),
  },
};
