// Preloaded (via `node --import`) into every test process by scripts/run-tests.mjs.
// A test that prints its summary and then lets a detached promise reject — or throws
// asynchronously after main() resolves — could otherwise exit 0 and be misreported as PASS.
// Turning both signals into a non-zero exit makes such failures impossible to miss.
function fail(kind, error) {
  console.error(`\n[harness] ${kind}:`, error)
  process.exit(1)
}
process.on('unhandledRejection', (reason) => fail('unhandledRejection', reason))
process.on('uncaughtException', (error) => fail('uncaughtException', error))
