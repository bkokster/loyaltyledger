import { closePool } from './db.js';
import { processNextNotification } from './processor.js';
import { CONFIG } from './config.js';

let shouldStop = false;

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

export async function run() {
  console.log('Notifier booted');
  while (!shouldStop) {
    try {
      const processed = await processNextNotification();
      if (!processed) {
        await sleep(CONFIG.pollIntervalMs);
      }
    } catch (error) {
      console.error('Notifier encountered an error', error);
      await sleep(CONFIG.pollIntervalMs);
    }
  }

  await closePool();
  console.log('Notifier stopped');
}

function handleShutdown() {
  shouldStop = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('Notifier failed', err);
    process.exit(1);
  });
}
