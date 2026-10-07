// Test-only child process: a limiter client whose synchronous start region can be suspended by the OS.
// argv: <pipe> <marker-file>. Acquires one grant, then inside `permit.start`: writes the marker file
// (synchronously), blocks in Atomics.wait for 1500 ms (the test suspends the whole process meanwhile), then records
// the simulated request start. Prints one JSON line: { startedAtUnixMs, regionMs, grantId }.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { validateClientConfig } from '../../../../../src/integration/coindcx/rate-limit/runtime/config';
import { RateLimitClient } from '../../../../../src/integration/coindcx/rate-limit/runtime/client';

const [pipe, marker] = process.argv.slice(2);
const config = validateClientConfig({ pipePath: pipe, maxFrameBytes: 65_536, connectTimeoutMs: 5000, probeScopes: [], maxOutbox: 100 });
if (config.kind !== 'VALID') process.exit(2);
const unixNow = (): number => performance.timeOrigin + performance.now();
void (async () => {
  const client = new RateLimitClient(config.config);
  if (!(await client.connect())) process.exit(3);
  const result = await client.acquire({ cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 30_000, lifetimeMs: 1000 });
  if (result.kind !== 'GRANTED') { process.stdout.write(`${JSON.stringify({ error: result })}\n`); process.exit(4); }
  const started = result.permit.start(() => {
    fs.writeFileSync(marker!, 'CHECKED');
    const t0 = performance.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    return { startedAtUnixMs: unixNow(), regionMs: performance.now() - t0 };
  });
  if (started.kind !== 'STARTED') process.exit(5);
  process.stdout.write(`${JSON.stringify({ ...started.value, grantId: result.permit.grant.grantId })}\n`);
  await result.permit.complete();
  client.close();
  process.exit(0);
})();
