import { getPool, closePool } from './db.js';
import { processNextJob } from './processor.js';
import { CONFIG } from './config.js';

let shouldStop = false;

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

export async function run() {
  console.log('Rule runner booted');
  while (!shouldStop) {
    try {
      const processed = await processNextJob();
      if (!processed) {
        await sleep(CONFIG.pollIntervalMs);
      }
    } catch (error) {
      console.error('Rule runner encountered an error', error);
      await sleep(CONFIG.pollIntervalMs);
    }
  }

  await closePool();
  console.log('Rule runner stopped');
}

function handleShutdown() {
  shouldStop = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('Rule runner failed', err);
    process.exit(1);
  });
}
