import type { LedgerMutation } from './ledger.js';
import type { ReceiptContext, RedeemContext } from './types.js';

export interface RollingSpendArgs {
  tenantId: string;
  merchantId: string;
  customerAccountRef: string;
  windowStart: Date;
  windowEnd: Date;
}

export interface UpsertTierArgs {
  tenantId: string;
  merchantId: string;
  customerAccountRef: string;
  customerAccount: string;
  tierId: string;
  tierName: string;
  windowDays: number;
  windowStart: Date;
  windowEnd: Date;
  rollingSpendCents: bigint;
}

export interface PluginHelpers {
  now(): Date;
  generateId(): string;
  getProgramConfig<T = Record<string, unknown> | null>(programId: string): Promise<T | null>;
  getAccountBalance(accountId: string, programId: string, unit: string): Promise<bigint>;
  getRollingSpendCents(args: RollingSpendArgs): Promise<bigint>;
  upsertCustomerTier(args: UpsertTierArgs): Promise<void>;
}

export interface ReceiptPlugin {
  name: string;
  shouldHandle(context: ReceiptContext): boolean;
  apply(context: ReceiptContext, helpers: PluginHelpers): Promise<LedgerMutation | null>;
}

export interface PluginRegistry {
  plugins: ReceiptPlugin[];
}

export function runPlugins(
  registry: PluginRegistry,
  context: ReceiptContext,
  helpers: PluginHelpers,
): Promise<LedgerMutation[]> {
  const tasks = registry.plugins
    .filter((plugin) => plugin.shouldHandle(context))
    .map(async (plugin) => {
      const result = await plugin.apply(context, helpers);
      return result;
    });

  return Promise.all(tasks).then((results) => results.filter((r): r is LedgerMutation => r !== null));
}

export interface RedeemHelpers extends PluginHelpers {
  getAccountBalance(accountId: string, programId: string, unit: string): Promise<bigint>;
  getOutstandingAttribution(
    customerAccount: string,
    options: {
      partnerAccounts: string[];
      partnerMap?: Record<string, string>;
      expiryDays?: number;
      burnMerchantId?: string | null;
    },
  ): Promise<Array<{ accountId: string; amount: bigint; settlementAdjustmentBps?: number | null }>>;
  getFrozenMerchants(accounts: string[]): Promise<Set<string>>;
}

export interface RedeemSuccessResult {
  type: 'success';
  mutation: LedgerMutation;
}

export interface RedeemFailureResult {
  type: 'failure';
  reason: string;
  retryable?: boolean;
}

export type RedeemResult = RedeemSuccessResult | RedeemFailureResult;

export interface RedeemPlugin {
  name: string;
  shouldHandle(context: RedeemContext): boolean;
  apply(context: RedeemContext, helpers: RedeemHelpers): Promise<RedeemResult | null>;
}

export interface RedeemPluginRegistry {
  plugins: RedeemPlugin[];
}

export async function runRedeemPlugins(
  registry: RedeemPluginRegistry,
  context: RedeemContext,
  helpers: RedeemHelpers,
): Promise<RedeemResult | null> {
  for (const plugin of registry.plugins) {
    if (!plugin.shouldHandle(context)) {
      continue;
    }

    const result = await plugin.apply(context, helpers);
    if (result) {
      return result;
    }
  }

  return null;
}
