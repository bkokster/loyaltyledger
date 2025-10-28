import { CONFIG } from './config.js';
import { closePool } from './db.js';
import { getAdapter } from './adapters/index.js';
import { MerchantFreezer, PayoutReconciler, PayoutScheduler, PayoutSubmitter } from './services/index.js';

export type PaymentsWorker = 'scheduler' | 'submitter' | 'reconciler' | 'freezer';

export async function run(worker: PaymentsWorker): Promise<void> {
  const normalized = worker ?? 'scheduler';
  try {
    switch (normalized) {
      case 'scheduler': {
        const adapter = getAdapter(CONFIG.defaultPsp);
        const scheduler = new PayoutScheduler(adapter);
        await scheduler.runOnce();
        break;
      }
      case 'submitter': {
        const adapter = getAdapter(CONFIG.defaultPsp);
        const submitter = new PayoutSubmitter(adapter);
        await submitter.processNextPending();
        break;
      }
      case 'reconciler': {
        const adapter = getAdapter(CONFIG.defaultPsp);
        const reconciler = new PayoutReconciler(adapter);
        await reconciler.reconcileSubmitted();
        break;
      }
      case 'freezer': {
        const freezer = new MerchantFreezer();
        await freezer.evaluate();
        break;
      }
      default:
        throw new Error(`Unknown payments worker "${normalized}"`);
    }
  } finally {
    await closePool();
  }
}

async function main(): Promise<void> {
  const worker = (process.env.PAYMENTS_WORKER as PaymentsWorker | undefined) ?? 'scheduler';
  console.log(`[payments] starting worker "${worker}" in ${CONFIG.env} mode`);
  await run(worker);
  console.log(`[payments] worker "${worker}" completed`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[payments] worker failed', err);
    process.exit(1);
  });
}
