import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { cleanup, clientConfig, fixture, launch, limiterFixture, maxInWindow, sleep, waitFor } from './support';

// M2 W2 process-level tests: real child processes, real Windows named pipes, abrupt process exits at commit
// points, a second coordinator binding the same pipe, and genuine OS suspension (ntdll NtSuspendProcess) of a client
// inside its synchronous start region. Offline: temporary directories and local IPC only.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');
const read = { cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 30_000, lifetimeMs: 1000 } as const;

function childCoordinator(input: Record<string, unknown>, fault = 'none') {
  const proc = launch('coordinator-process.ts', [b64(input), fault]);
  stops.push(async () => { if (proc.child.exitCode === null) { proc.child.kill(); await proc.exited; } });
  return proc;
}
async function client(pipe: string): Promise<RateLimitClient> {
  const c = new RateLimitClient(clientConfig(pipe));
  stops.push(() => c.close());
  expect(await c.connect()).toBe(true);
  return c;
}

describe('M2 W2 Windows named-pipe singleton', () => {
  it('a second coordinator for the same pipe fails to bind while the first runs, and binds after the first exits', async () => {
    const f = fixture();
    const first = childCoordinator(f.coordinatorInput);
    await waitFor(() => first.lines.find((l) => l.startsWith('RUNNING')), 20_000, 'first coordinator');
    const second = childCoordinator(f.coordinatorInput);
    expect(await second.exited).toBe(3);
    expect(second.lines).toContain('BIND_FAILED EADDRINUSE');
    first.child.kill();
    await first.exited;
    const third = childCoordinator(f.coordinatorInput);
    await waitFor(() => third.lines.find((l) => l.startsWith('RUNNING')), 20_000, 'third coordinator after the first exited');
  }, 60_000);
});

describe('M2 W2 crashes around the durable commit', () => {
  it.each([
    ['crash-before-a', 0],
    ['crash-after-a', 1],
    ['crash-after-commit', 1],
  ] as const)('%s: the grant is never delivered; after restart the charge is %s (1 = retained as uncertain)', async (fault, expectedCharges) => {
    const f = fixture();
    const coordinator = childCoordinator(f.coordinatorInput, fault);
    await waitFor(() => coordinator.lines.find((l) => l.startsWith('RUNNING')), 20_000, 'child coordinator');
    const c = await client(f.pipe);
    expect(await c.acquire(read)).toEqual({ kind: 'UNAVAILABLE', reason: 'DISCONNECTED' });
    expect(await coordinator.exited).toBe(77);
    const restarted = await RateLimitCoordinator.start(f.coordinator);
    if (restarted.kind !== 'RUNNING') throw new Error(JSON.stringify(restarted));
    stops.push(() => restarted.coordinator.close());
    const charges = restarted.coordinator.state.charges;
    expect(charges).toHaveLength(expectedCharges);
    for (const charge of charges) expect([charge.latestStartMs, charge.slotHeld, charge.started]).toEqual([null, true, false]);
    // The client never received the grant, so its (empty) inventory proves nothing: the charge stays uncertain.
    expect(await c.connect()).toBe(true);
    await sleep(300);
    expect(restarted.coordinator.state.charges).toHaveLength(expectedCharges);
  }, 60_000);
});

describe('M2 W2 genuine OS suspension inside the synchronous start region', () => {
  let helper: ReturnType<typeof spawn> | null = null;
  const replies: string[] = [];
  afterAll(() => { helper?.stdin?.end(); helper?.kill(); });
  async function nt(verb: 'suspend' | 'resume', pid: number): Promise<string> {
    if (helper === null) {
      helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures', 'nt-suspend.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
      let buffer = '';
      helper.stdout!.on('data', (chunk: Buffer) => { buffer += chunk.toString(); let i; while ((i = buffer.indexOf('\n')) >= 0) { replies.push(buffer.slice(0, i).trim()); buffer = buffer.slice(i + 1); } });
      await waitFor(() => replies.includes('HELPER_READY'), 60_000, 'suspension helper');
    }
    const before = replies.length;
    helper.stdin!.write(`${verb} ${pid}\n`);
    return waitFor(() => (replies.length > before ? replies[replies.length - 1] : null), 10_000, `${verb} reply`);
  }

  it('a client suspended after its start check starts late; its charge stays uncertain; measured starts never exceed the cap', async () => {
    await nt('resume', process.pid).catch(() => undefined); // warm up the helper (resume of a running process is a no-op)
    const f = fixture(limiterFixture({ windows: [{ windowMs: 1000, maxStarts: 3 }], fairnessWindowMs: 1000,
      classShares: { P0: { minPerWindow: 0, maxPerWindow: 3 }, P1: { minPerWindow: 0, maxPerWindow: 3 }, P2: { minPerWindow: 0, maxPerWindow: 3 }, P3: { minPerWindow: 0, maxPerWindow: 3 } } }));
    const started = await RateLimitCoordinator.start(f.coordinator);
    if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
    const coordinator = started.coordinator;
    stops.push(() => coordinator.close());
    const marker = path.join(path.dirname(f.dir), 'checked.marker');
    const unixNow = (): number => performance.timeOrigin + performance.now();
    const starts: number[] = [];
    let loading = true;
    const loader = await client(f.pipe);
    const load = (async () => {
      while (loading) {
        const r = await loader.acquire({ ...read, deadlineInMs: 5000 });
        if (r.kind !== 'GRANTED') continue;
        const s = r.permit.start(unixNow);
        if (s.kind === 'STARTED') starts.push(s.value);
        await r.permit.complete();
      }
    })();
    const child = launch('suspendable-client.ts', [f.pipe, marker]);
    stops.push(async () => { if (child.child.exitCode === null) { child.child.kill(); await child.exited; } });
    await waitFor(() => fs.existsSync(marker), 30_000, 'child inside its start region');
    expect(await nt('suspend', child.child.pid!)).toBe('suspend 0');
    await sleep(1500);
    const held = coordinator.state.charges.filter((c) => c.clientInstanceId !== loader.clientInstanceId);
    expect(held.map((c) => [c.latestStartMs, c.slotHeld])).toEqual([[null, true]]); // suspended: unresolved, still counted
    await sleep(1500);
    expect(await nt('resume', child.child.pid!)).toBe('resume 0');
    const line = await waitFor(() => child.lines.find((l) => l.startsWith('{')), 20_000, 'child start record');
    const record = JSON.parse(line) as { startedAtUnixMs: number; regionMs: number; grantId: string };
    await sleep(1500);
    loading = false; await load;
    expect(await child.exited).toBe(0);
    expect(record.regionMs).toBeGreaterThanOrEqual(3000); // OS-verified: the synchronous region was suspended
    const all = [...starts, record.startedAtUnixMs];
    expect(starts.length).toBeGreaterThan(6);
    expect(maxInWindow(all, 1000)).toBeLessThanOrEqual(3);
  }, 120_000);
});
