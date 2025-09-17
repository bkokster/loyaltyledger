export async function run() {
  // TODO: subscribe to ledger events and deliver notifications/webhooks
  console.log('Notifier booted');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('Notifier failed', err);
    process.exit(1);
  });
}
