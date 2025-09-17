export async function run() {
  // TODO: consume receipt events and execute reward plugins
  console.log('Rule runner booted');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('Rule runner failed', err);
    process.exit(1);
  });
}
