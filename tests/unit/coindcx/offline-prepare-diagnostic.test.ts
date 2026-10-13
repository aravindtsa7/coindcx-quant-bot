import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const requireLocal = createRequire(__filename);
const { capturePrepare } = requireLocal('../../../scripts/sync-read-launch/offline-prepare-diagnostic.cjs');
const { superviseChild } = requireLocal('../../../scripts/sync-read-launch/identity-supervisor.cjs');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(mode: 'success' | 'failure' | 'unresolved' | 'spawn-error' | 'preflight-error') {
  const output = mkdtempSync(path.join(tmpdir(), 'OFFLINE-prepare-result-')); directories.push(output);
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null, kill: () => false });
  const transport = {
    spawnSync: () => ({ status: mode === 'preflight-error' ? 1 : 0, signal: null, stdout: 'synthetic custody', stderr: '' }),
    spawn: (..._args: unknown[]) => {
      if (mode === 'spawn-error') throw Object.assign(Error('SYNTHETIC_SPAWN_FAILURE'), { code: 'EPERM' });
      queueMicrotask(() => {
        child.emit('spawn');
        if (mode === 'unresolved') return;
        child.stdout.write(mode === 'success' ? JSON.stringify({ outcome: 'CAMPAIGN_CONFIGURATION_VALID', maximumRequests: 39, readyToContactProvider: false }) + '\n' : 'synthetic failed output\n');
        child.stderr.write(mode === 'success' ? '' : 'SYNTHETIC_INPUT_REJECTED\n');
        child.exitCode = mode === 'success' ? 0 : 1;
        child.emit('exit', child.exitCode, null); child.emit('close', child.exitCode, null);
      });
      return child;
    },
  };
  const originalSpawn = transport.spawn;
  const supervise = async () => {
    if (transport.spawnSync().status !== 0) throw Error('SUPERVISOR_CUSTODY_PREFLIGHT_FAILED');
    return superviseChild(() => transport.spawn('node', ['protected-module-guard.cjs', 'prepare'], { stdio: ['pipe', 'pipe', 'pipe'] }),
      { heartbeatIntervalMs: 5, shutdownWaitMs: 15 }, 100, mode === 'unresolved' ? { stopAfterMs: 5 } : {});
  };
  return { output, originalSpawn, transport, supervise };
}
async function run(mode: Parameters<typeof fixture>[0]) {
  const f = fixture(mode);
  const value = await capturePrepare({ ...f, inputFile: 'OFFLINE-input.json', nodePath: 'node', guard: 'OFFLINE-guard.cjs' });
  expect(JSON.parse(readFileSync(path.join(f.output, 'diagnostic-result.json'), 'utf8'))).toEqual(value);
  expect(f.transport.spawn).toBe(f.originalSpawn);
  return { ...f, value };
}
describe('offline prepare diagnostic retains evidence before evaluating outcome', () => {
  it('saves successful preparation, acknowledgement, PID, stdout and close', async () => {
    const { value } = await run('success');
    expect(value.passed).toBe(true); expect(value.child).toMatchObject({ pid: 123, spawnAcknowledged: true, exitObserved: true, closeObserved: true, exitCode: 0 });
    expect(value.stdout.text).toContain('CAMPAIGN_CONFIGURATION_VALID'); expect(value.cleanupStatus).toBe('CHILD_CLOSE_CONFIRMED');
  });
  it('saves failed preparation stdout/stderr and supervisor result instead of discarding them', async () => {
    const { value } = await run('failure');
    expect(value.passed).toBe(false); expect(value.result.code).toBe(1); expect(value.failureStage).toBe('CHILD_EXECUTION');
    expect(value.stdout.text).toContain('synthetic failed output'); expect(value.stderr.text).toContain('SYNTHETIC_INPUT_REJECTED');
    expect(value.child.closeObserved).toBe(true);
  });
  it('retains synthetic preflight rejection without claiming any task child existed', async () => {
    const { value } = await run('preflight-error');
    expect(value.preflight.status).toBe(1); expect(value.error.message).toBe('SUPERVISOR_CUSTODY_PREFLIGHT_FAILED');
    expect(value.spawnCalls).toBe(0); expect(value.child.pid).toBeNull();
  });
  it('retains a synthetic native spawn failure without retry', async () => {
    const { value } = await run('spawn-error');
    expect(value.child.error.code).toBe('EPERM'); expect(value.spawnCalls).toBe(1); expect(value.result.childCreated).toBe(false);
    expect(value.child.spawnAcknowledged).toBe(false); expect(value.child.spawnThrew).toBe(true);
    expect(value.cleanupStatus).toBe('SPAWN_THROW_NO_CHILD_RETURNED');
  });
  it('keeps unconfirmed child exit unresolved and records STOP and attempted kill', async () => {
    const { value } = await run('unresolved');
    expect(value.cleanupStatus).toBe('CHILD_EXIT_UNRESOLVED'); expect(value.result.taskChildExited).toBe(false);
    expect(value.child.stopWrites).toBe(1); expect(value.child.killCalls).toEqual([{ signal: 'SIGTERM', accepted: false }]);
  });
  it('does not overwrite prior diagnostic evidence or silently repeat an invocation', async () => {
    const f = await run('failure');
    await expect(capturePrepare({ ...f, inputFile: 'OFFLINE-input.json', nodePath: 'node', guard: 'OFFLINE-guard.cjs' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(f.transport.spawn).toBe(f.originalSpawn);
  });
});
