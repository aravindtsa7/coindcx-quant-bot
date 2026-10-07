// Test-only child process: runs a limiter coordinator from a base64 JSON configuration.
// argv: <config-base64> <fault: none|crash-before-a|crash-after-a|crash-after-commit>
// A fault exits the process abruptly (code 77) at the named point of the first commit that contains a planned
// (not yet delivered) grant. Prints RUNNING / BIND_FAILED <code> / FAIL_CLOSED <reason>.
import { validateCoordinatorConfig } from '../../../../../src/integration/coindcx/rate-limit/runtime/config';
import { RateLimitCoordinator } from '../../../../../src/integration/coindcx/rate-limit/runtime/coordinator';

const [encoded, fault = 'none'] = process.argv.slice(2);
const config = validateCoordinatorConfig(JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8')));
if (config.kind !== 'VALID') { process.stdout.write(`INVALID_CONFIG ${config.reason}\n`); process.exit(2); }
let coordinator: RateLimitCoordinator | null = null;
const planned = (): boolean => coordinator !== null && coordinator.state.charges.some((charge) => charge.delivery === 'PENDING_PERSIST');
const crash = (): never => process.exit(77);
void (async () => {
  const result = await RateLimitCoordinator.start(config.config, {
    store: {
      beforeSlotWrite: (slot) => { if (fault === 'crash-before-a' && slot === 'A' && planned()) crash(); },
      afterSlotWrite: (slot) => { if (fault === 'crash-after-a' && slot === 'A' && planned()) crash(); },
    },
    afterCommitBeforeDelivery: () => { if (fault === 'crash-after-commit' && planned()) crash(); },
  });
  if (result.kind === 'BIND_FAILED') { process.stdout.write(`BIND_FAILED ${result.code}\n`); process.exit(3); }
  if (result.kind === 'FAIL_CLOSED') { process.stdout.write(`FAIL_CLOSED ${result.reason}\n`); process.exit(4); }
  coordinator = result.coordinator;
  process.stdout.write(`RUNNING ${process.pid}\n`);
  process.stdin.on('end', () => { void coordinator?.close().then(() => process.exit(0)); });
  process.stdin.resume();
})();
