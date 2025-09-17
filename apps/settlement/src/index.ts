export async function run() {
  // TODO: generate netting reports and payouts on a schedule
  console.log('Settlement job executed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('Settlement job failed', err);
    process.exit(1);
  });
}
