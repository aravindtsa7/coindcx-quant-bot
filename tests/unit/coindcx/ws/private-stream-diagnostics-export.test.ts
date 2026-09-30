import { mkdtemp, readFile, writeFile, readdir, rm, lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateStreamDiagnosticExporter, type DiagnosticExporterOptions } from '../../../../scripts/private-stream-diagnostics/exporter';
import { createShadowDiagnosticsFactory } from '../../../../scripts/private-stream-diagnostics/config';
import { PrivateStreamDiagnosticRecorder } from '../../../../src/integration/coindcx/websocket/private-stream-diagnostics';
import { DIAGNOSTICS_LIMITS, parsePrivateStreamDiagnostics, type ExportFailure } from '../../../../src/integration/coindcx/websocket/private-stream-diagnostics-schema';

// The worker is plain ESM and deliberately runs without tsx or inherited environment.
// @ts-expect-error This JS worker intentionally has no TypeScript runtime dependency.
import { publishSnapshot } from '../../../../scripts/private-stream-diagnostics/writer.mjs';

const roots: string[] = []; const exporters: PrivateStreamDiagnosticExporter[] = [];
afterEach(async () => {
  for (const exporter of exporters.splice(0)) await exporter.finish();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('p18b-diagnostics-test-')) throw new Error('TEST_DIRECTORY_OWNERSHIP');
    await rm(root, { recursive: true, force: true });
  }
});
async function setup(overrides: Partial<DiagnosticExporterOptions> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p18b-diagnostics-test-')); roots.push(directory);
  const destination = path.join(directory, 'snapshot.json'); const warnings: ExportFailure[] = [];
  const recorder = new PrivateStreamDiagnosticRecorder({ sessionId: '12345678-1234-4123-8123-123456789abc', sourceCommit: '7c6f6fa1d8bc89fe6c7b291681c593fa158c91e5', clock: { read: () => ({ wallMs: 1, elapsedMs: 1 }) } });
  const snapshot: DiagnosticExporterOptions['snapshot'] = (reason, history) => recorder.snapshot(reason, { generation: 0, activeAttempt: null, state: 'STOPPED', authJoinSent: false, reconciliationRequired: false }, history);
  const exporter = new PrivateStreamDiagnosticExporter({ destination, snapshot, warn: category => warnings.push(category), ...overrides }); exporters.push(exporter);
  return { directory, destination, warnings, recorder, snapshot, exporter, read: async () => parsePrivateStreamDiagnostics(await readFile(destination, 'utf8')) };
}

describe('real atomic sidecar files and worker acknowledgement', () => {
  it('publishes complete validated snapshots, replaces owned files, and acknowledges FINAL', async () => {
    const c = await setup(); expect(await c.exporter.request('START')).toBe(true);
    const first = await c.read(); expect(first.snapshot.reason).toBe('START'); expect(c.exporter.history.lastAcknowledgedSnapshotSequence).toBe(first.snapshot.sequence);
    expect(await c.exporter.request('PERIODIC')).toBe(true); const next = await c.read(); expect(next.snapshot.sequence).toBeGreaterThan(first.snapshot.sequence);
    expect(next.exportHistory.lastAcknowledgedSnapshotSequence).toBe(first.snapshot.sequence);
    expect(await c.exporter.finish()).toBe(true); expect((await c.read()).snapshot.reason).toBe('FINAL'); expect(c.exporter.history.finalUnconfirmed).toBe(false);
    expect(await readdir(c.directory)).toEqual(['snapshot.json']);
  });
  it('atomically refuses an existing destination and never adopts or deletes it', async () => {
    const c = await setup(); await writeFile(c.destination, 'EXISTING_ARTIFACT', { flag: 'wx' });
    expect(await c.exporter.request('START')).toBe(false); expect(await readFile(c.destination, 'utf8')).toBe('EXISTING_ARTIFACT');
    expect(c.warnings).toContain('DESTINATION_EXISTS'); expect(await c.exporter.finish()).toBe(false);
    expect(c.exporter.history.lastAcknowledgedSnapshotSequence).toBeNull(); expect(c.exporter.history.finalUnconfirmed).toBe(true);
    expect(await readdir(c.directory)).toEqual(['snapshot.json']);
  });
  it.each(['AFTER_OPEN', 'AFTER_WRITE', 'BEFORE_LINK'] as const)('failed first publication leaves no partial destination and removes only its owned temporary: %s', async testFault => {
    const c = await setup({ testFault }); expect(await c.exporter.request('START')).toBe(false);
    expect(await readdir(c.directory)).toEqual([]); expect(c.exporter.history.lastAcknowledgedSnapshotSequence).toBeNull();
  });
  it('replacement failure preserves the previous valid snapshot, marks incomplete coverage and cannot claim FINAL', async () => {
    const c = await setup({ testFault: 'BEFORE_REPLACE' }); expect(await c.exporter.request('START')).toBe(true);
    const previous = await readFile(c.destination, 'utf8'); expect(await c.exporter.request('PERIODIC')).toBe(false); expect(await readFile(c.destination, 'utf8')).toBe(previous);
    expect(await c.exporter.finish()).toBe(false); expect(await readFile(c.destination, 'utf8')).toBe(previous);
    expect(c.warnings).toContain('REPLACE_FAILED'); expect(c.exporter.history.finalUnconfirmed).toBe(true);
    const observed = c.snapshot('PERIODIC', c.exporter.history)!; expect(observed.coverage.issues).toContain('EXPORT_WRITE_FAILED'); expect(observed.coverage.issues).toContain('FINAL_UNCONFIRMED');
  });
  it('refuses ownership loss on replacement and preserves the replacement artifact', async () => {
    const c = await setup(); expect(await c.exporter.request('START')).toBe(true);
    // Replacing the inode, rather than editing the owned file in place, is intentional.
    await rename(c.destination, path.join(c.directory, 'previous-owned.json')); await writeFile(c.destination, 'OTHER_ARTIFACT', { flag: 'wx' });
    expect(await c.exporter.request('PERIODIC')).toBe(false); expect(c.warnings).toContain('OWNERSHIP_LOST'); expect(await readFile(c.destination, 'utf8')).toBe('OTHER_ARTIFACT');
  });
  it('simultaneous first writers cannot overwrite one another', async () => {
    const c = await setup(); const text = JSON.stringify(c.snapshot('START', c.exporter.history));
    const results = await Promise.all([publishSnapshot(c.destination, 1, text, null), publishSnapshot(c.destination, 1, text, null)]);
    expect(results.filter((result: { ok: boolean }) => result.ok)).toHaveLength(1); expect(parsePrivateStreamDiagnostics(await readFile(c.destination, 'utf8')).snapshot.sequence).toBe(1);
    expect(await readdir(c.directory)).toEqual(['snapshot.json']);
  });
  it('exclusive temporary collision preserves the unowned temporary', async () => {
    const c = await setup(); await writeFile(`${c.destination}.tmp-1`, 'UNOWNED_TEMP', { flag: 'wx' });
    expect(await c.exporter.request('START')).toBe(false); expect(await readFile(`${c.destination}.tmp-1`, 'utf8')).toBe('UNOWNED_TEMP');
    expect(c.warnings).toContain('OPEN_FAILED');
  });
  it('validates/serializes before creating files; invalid snapshots and failing warning callbacks cannot throw', async () => {
    const c = await setup({ snapshot: () => { throw new Error('PRIVATE_ERROR_MARKER'); }, warn: () => { throw new Error('PRIVATE_WARNING_MARKER'); } });
    expect(await c.exporter.request('START')).toBe(false); expect(await readdir(c.directory)).toEqual([]); expect(c.exporter.history.lastFailure).toBe('SNAPSHOT_INVALID');
    expect(await c.exporter.finish()).toBe(false);
  });
  it('a real hung worker times out, clears busy, stops future work and preserves the last valid artifact', async () => {
    const c = await setup({ testFault: 'HANG_AFTER_CLOSE', ackTimeoutMs: 700 });
    const previous = JSON.stringify(c.snapshot('START', c.exporter.history)); await writeFile(c.destination, previous);
    const pending = c.exporter.request('PERIODIC'); expect(c.exporter.busy).toBe(true);
    expect(await c.exporter.request('PERIODIC')).toBe(false); expect(await pending).toBe(false);
    expect(c.exporter.busy).toBe(false); expect(c.exporter.history.ackTimeouts).toBe(1); expect(c.warnings).toContain('ACK_TIMEOUT');
    expect(await readFile(c.destination, 'utf8')).toBe(previous); expect(await c.exporter.request('PERIODIC')).toBe(false);
    expect(c.snapshot('PERIODIC', c.exporter.history)!.coverage.issues).toEqual(['EXPORT_SKIPPED', 'EXPORT_WRITE_FAILED', 'EXPORT_ACK_TIMEOUT']);
    await vi.waitFor(async () => expect(await readdir(c.directory)).toEqual(['snapshot.json']));
    expect(await c.exporter.finish()).toBe(false); expect(c.exporter.history.finalUnconfirmed).toBe(true);
  });
  it('FINAL busy terminates immediately and FINAL deadline reports an unacknowledged result', async () => {
    const busy = await setup({ testFault: 'HANG_AFTER_CLOSE' }); const pending = busy.exporter.request('START'); const started = performance.now();
    expect(await busy.exporter.finish()).toBe(false); expect(performance.now() - started).toBeLessThan(1000); expect(await pending).toBe(false); expect(busy.warnings).toContain('FINAL_BUSY');
    const final = await setup({ testFault: 'HANG_AFTER_CLOSE', finalWaitMs: 100 }); const before = performance.now();
    expect(await final.exporter.finish()).toBe(false); expect(performance.now() - before).toBeLessThan(1000); expect(final.warnings).toContain('FINAL_FLUSH_TIMEOUT');
    expect(final.exporter.history.lastAcknowledgedSnapshotSequence).toBeNull(); expect(final.exporter.history.finalUnconfirmed).toBe(true);
    expect(DIAGNOSTICS_LIMITS).toMatchObject({ exportAckTimeoutMs: 5000, finalFlushTimeoutMs: 1000 });
  });
  it('worker startup/exit failures are sanitized and finite', async () => {
    const c = await setup({ workerPath: path.resolve('missing-diagnostic-worker.mjs') }); expect(await c.exporter.request('START')).toBe(false);
    expect(c.warnings).toContain('WORKER_EXITED'); expect(c.exporter.busy).toBe(false); expect(c.exporter.history.workerFailures).toBe(1);
    expect(JSON.stringify(c.snapshot('PERIODIC', c.exporter.history))).not.toContain(c.destination);
  });
  it('an idle unreferenced real worker does not prevent normal process exit', async () => {
    const c = await setup();
    const program = `const { PrivateStreamDiagnosticExporter } = require('./scripts/private-stream-diagnostics/exporter.ts');
      const { PrivateStreamDiagnosticRecorder } = require('./src/integration/coindcx/websocket/private-stream-diagnostics.ts');
      const recorder = new PrivateStreamDiagnosticRecorder({sessionId:'12345678-1234-4123-8123-123456789abc',sourceCommit:'${'a'.repeat(40)}'});
      const exporter = new PrivateStreamDiagnosticExporter({destination:process.argv[1],warn:()=>{},snapshot:(reason,history)=>recorder.snapshot(reason,{generation:0,activeAttempt:null,state:'STOPPED',authJoinSent:false,reconciliationRequired:false},history)});
      exporter.request('START').then(ok=>{if(!ok)process.exitCode=1;console.log(ok?'ACKNOWLEDGED':'UNCONFIRMED');});`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', program, c.destination], { timeout: 3000, windowsHide: true });
    expect(stdout.trim()).toBe('ACKNOWLEDGED'); expect((await c.read()).snapshot.reason).toBe('START');
  });
  it('direct publication fault leaves previous identity/content untouched', async () => {
    const c = await setup(); const text = JSON.stringify(c.snapshot('START', c.exporter.history));
    const first = await publishSnapshot(c.destination, 1, text, null); expect(first.ok).toBe(true);
    const before = await lstat(c.destination, { bigint: true });
    const next = JSON.stringify(c.snapshot('PERIODIC', c.exporter.history)); const failed = await publishSnapshot(c.destination, 2, next, first.ownership, undefined, 'BEFORE_REPLACE');
    expect(failed).toEqual({ ok: false, category: 'REPLACE_FAILED' }); expect((await lstat(c.destination, { bigint: true })).ino).toBe(before.ino); expect(await readFile(c.destination, 'utf8')).toBe(text);
  });
});

describe('shadow-only sidecar configuration', () => {
  it('is disabled by default and by values other than exact true; invalid paths are never echoed', () => {
    const warnings: string[] = [];
    for (const value of [undefined, 'false', '1', 'yes']) {
      const factory = createShadowDiagnosticsFactory({ env: { LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_ENABLED: value }, repoRoot: process.cwd(), warn: category => warnings.push(category) });
      expect(factory('a'.repeat(40))).toBeNull();
    }
    const factory = createShadowDiagnosticsFactory({ env: { LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_ENABLED: 'true', LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_DIR: 'PRIVATE_PATH_MARKER' }, repoRoot: process.cwd(), warn: category => warnings.push(category) });
    expect(factory('a'.repeat(40))).toBeNull(); expect(warnings).toEqual(['CONFIG_INVALID']);
  });
  it('creates fresh non-authoritative sessions with clean commit provenance without file/network/DB activity', async () => {
    const c = await setup(); const factory = createShadowDiagnosticsFactory({ env: { LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_ENABLED: 'true', LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_DIR: c.directory }, repoRoot: process.cwd(), warn: () => {} });
    const a = factory('a'.repeat(40))!; const b = factory('a'.repeat(40))!;
    expect(a.config.sessionId).not.toBe(b.config.sessionId); expect(a.config.sourceCommit).toBe('a'.repeat(40)); expect(await readdir(c.directory)).toEqual([]);
    await a.finish(); expect(await readdir(c.directory)).toEqual([]);
  });
});
