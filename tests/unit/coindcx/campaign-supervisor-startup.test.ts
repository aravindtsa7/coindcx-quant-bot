import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const { superviseChild } = createRequire(__filename)('../../../scripts/sync-read-launch/identity-supervisor.cjs') as {
  superviseChild: (spawnChild: () => ChildProcess, supervision: { heartbeatIntervalMs: number; shutdownWaitMs: number }, deadlineMs: number, options?: { stopAfterMs?: number; onChild?: () => void }) => Promise<{ code: number; startupFailure: boolean; taskChildExited: boolean; childCreated: boolean; killed: boolean; spawnErrorCode?: string; outcome?: string }>
};
const supervision = { heartbeatIntervalMs: 10, shutdownWaitMs: 50 };
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined as number | undefined,
    exitCode: null as number | null, signalCode: null as string | null, kill: (): boolean => { child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; } });
  return child;
}
describe('supervised startup and bounded task-child shutdown, offline only', () => {
  it('returns explicit synchronous EPERM without child creation, heartbeat, credentials or retry', async () => {
    let attempts = 0;
    const before = process.listenerCount('SIGTERM');
    const result = await superviseChild(() => { attempts++; throw Object.assign(new Error('synthetic'), { code: 'EPERM' }); }, supervision, 500);
    expect(result).toMatchObject({ code: 1, startupFailure: true, spawnErrorCode: 'EPERM', childCreated: false, taskChildExited: true, outcome: 'SUPERVISOR_CHILD_STARTUP_FAILED' });
    expect(attempts).toBe(1); expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it('handles asynchronous spawn errors before heartbeat and cleans streams/listeners', async () => {
    const child = fakeChild(); let heartbeatBytes = 0; child.stdin.on('data', chunk => { heartbeatBytes += chunk.length; });
    const before = process.listenerCount('SIGINT');
    const result = await superviseChild(() => { queueMicrotask(() => child.emit('error', Object.assign(new Error('synthetic'), { code: 'EPERM' }))); return child as unknown as ChildProcess; }, supervision, 500);
    expect(result).toMatchObject({ code: 1, startupFailure: true, childCreated: false, taskChildExited: true });
    expect(heartbeatBytes).toBe(0); expect(child.stdin.destroyed).toBe(true); expect(process.listenerCount('SIGINT')).toBe(before);
  });
  it('bounds an acknowledged child that ignores STOP and kills only that child', async () => {
    const child = fakeChild(); child.pid = 123; let wire = ''; child.stdin.on('data', chunk => { wire += chunk; });
    const result = await superviseChild(() => { queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcess; }, supervision, 500, { stopAfterMs: 20 });
    expect(result.taskChildExited).toBe(true); expect(result.killed).toBe(true); expect(wire).toContain('HEARTBEAT\n'); expect(wire).toContain('STOP\n');
  });
  it('cleans up an onChild startup failure without sending heartbeat', async () => {
    const child = fakeChild(); child.pid = 123;
    const result = await superviseChild(() => { queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcess; }, supervision, 500, { onChild: () => { throw new Error('synthetic'); } });
    expect(result).toMatchObject({ code: 1, startupFailure: true, taskChildExited: true, killed: true });
  });
  it('reports an unresolved child exit when termination cannot be confirmed, within the shutdown bound', async () => {
    const child = fakeChild(); child.pid = 123; child.kill = () => false;
    const result = await superviseChild(() => { queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcess; }, supervision, 500, { stopAfterMs: 10 });
    expect(result).toMatchObject({ code: 1, taskChildExited: false, killed: false });
  });
  it('runs a real synthetic task child with piped heartbeat and STOP through the same lifecycle', async () => {
    const script = "let s='';process.stdin.on('data',b=>{s+=b;if(s.includes('HEARTBEAT\\n')&&s.includes('STOP\\n'))process.exit(0)});";
    const result = await superviseChild(() => spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      { heartbeatIntervalMs: 10, shutdownWaitMs: 2000 }, 5000, { stopAfterMs: 200 });
    expect(result).toMatchObject({ code: 0, startupFailure: false, taskChildExited: true, childCreated: true, killed: false });
  });
});
