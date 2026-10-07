// Shared support for M2 W2 offline IPC tests: temporary disposable state directories, unique local pipes,
// fixture configuration (NOT approved values), polling helpers and child-process launch through the installed tsx.
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateClientConfig, validateCoordinatorConfig, type ClientConfig, type CoordinatorConfig } from '../../../../src/integration/coindcx/rate-limit/runtime/config';
import { initializeDisposableStateDirectory } from '../../../../src/integration/coindcx/rate-limit/runtime/state-store';

export const REPO = path.resolve(__dirname, '../../../..');
export const created: string[] = [];
export function cleanup(): void { for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); }

export function limiterFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    windows: [{ windowMs: 1000, maxStarts: 5 }, { windowMs: 10_000, maxStarts: 50 }], fairnessWindowMs: 10_000,
    classShares: { P0: { minPerWindow: 0, maxPerWindow: 50 }, P1: { minPerWindow: 0, maxPerWindow: 50 }, P2: { minPerWindow: 0, maxPerWindow: 50 }, P3: { minPerWindow: 0, maxPerWindow: 50 } },
    concurrency: 20, p0ReservedSlots: 0, grantTtlMs: 2000, maxRequestDeadlineMs: 60_000, overdueGuardMs: 50, uncertainChargeAlertMs: 60_000,
    retryAfter: { noHeaderDefaultMs: 60_000, providerStatedBlockMs: 1000, localBackoffBaseMs: 1000, localBackoffMaxMs: 4000, operationalCapMs: 600_000, clockUncertaintyMs: 2000 },
    ...overrides,
  };
}
export interface Fixture { readonly dir: string; readonly pipe: string; readonly coordinatorInput: Record<string, unknown>; readonly coordinator: CoordinatorConfig; readonly client: ClientConfig }
/** A NEW disposable state directory, explicitly initialized (permitted only for disposable test directories in W2). */
export function fixture(limiter: Record<string, unknown> = limiterFixture(), initialize = true): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2w2-it-')); created.push(root);
  const dir = path.join(root, 'state');
  const pipe = `\\\\.\\pipe\\m2w2-${randomBytes(8).toString('hex')}`;
  if (initialize) initializeDisposableStateDirectory(dir, pipe, `i${randomBytes(16).toString('hex')}`, 'DISPOSABLE_TEST_DIRECTORY');
  const coordinatorInput = { limiter, stateDirectory: dir, pipePath: pipe, maxFrameBytes: 65_536, maxStateBytes: 1 << 20, tickMs: 20, handshakeTimeoutMs: 2000, maxSessions: 32, maxRegisteredClients: 64, maxPendingRequestsPerSession: 64 };
  const c = validateCoordinatorConfig(coordinatorInput);
  if (c.kind !== 'VALID') throw new Error(`fixture coordinator config: ${c.reason}`);
  return { dir, pipe, coordinatorInput, coordinator: c.config, client: clientConfig(pipe) };
}
export function clientConfig(pipe: string, probeScopes: readonly ('API_AUTH' | 'PUBLIC')[] = []): ClientConfig {
  const c = validateClientConfig({ pipePath: pipe, maxFrameBytes: 65_536, connectTimeoutMs: 5000, probeScopes: [...probeScopes], maxOutbox: 1000 });
  if (c.kind !== 'VALID') throw new Error(`fixture client config: ${c.reason}`);
  return c.config;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}
export function maxInWindow(times: readonly number[], windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let hi = 0, lo = 0; hi < sorted.length; hi++) { while (sorted[hi]! - sorted[lo]! >= windowMs) lo++; best = Math.max(best, hi - lo + 1); }
  return best;
}

/** Launches a TypeScript fixture in a child Node process through the installed tsx (no install, no network). */
export function launch(script: string, args: readonly string[]): { child: ChildProcess; lines: string[]; exited: Promise<number | null> } {
  // `--import tsx` runs the fixture in this single child process (the tsx CLI would add a wrapper process, and the
  // PID used for OS suspension must be the process that runs the client).
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(REPO, 'node_modules/tsx/dist/loader.mjs')).href, path.join(__dirname, 'fixtures', script), ...args], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = []; let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); let i; while ((i = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, i).trim()); buffer = buffer.slice(i + 1); } });
  let stderr = ''; child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => { if (stderr.trim() !== '' && code !== 0 && code !== 77) lines.push(`STDERR ${stderr.trim().slice(0, 500)}`); resolve(code); }));
  return { child, lines, exited };
}
