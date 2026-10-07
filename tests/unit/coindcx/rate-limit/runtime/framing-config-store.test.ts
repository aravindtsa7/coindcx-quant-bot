import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateClientConfig, validateCoordinatorConfig } from '../../../../../src/integration/coindcx/rate-limit/runtime/config';
import { encodeFrame, FrameDecoder } from '../../../../../src/integration/coindcx/rate-limit/runtime/framing';
import {
  encodeRecord, initializeDisposableStateDirectory, openStateStore, SLOT_FILES, MARKER_FILE, STATE_FORMAT,
} from '../../../../../src/integration/coindcx/rate-limit/runtime/state-store';

// M2 W2 framing, configuration and durable state. Temporary directories only; fixture values only.
const PIPE = '\\\\.\\pipe\\m2w2-unit';
const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2w2-unit-')); created.push(dir); return path.join(dir, 'state'); }
const installationId = (): string => `i${randomBytes(16).toString('hex')}`;
const slot = (dir: string, s: 'A' | 'B'): string => path.join(dir, SLOT_FILES[s]);
const record = (id: string, seq: number, clients: unknown[] = []) => ({ format: STATE_FORMAT, installationId: id, journalSeq: seq, scheduler: { placeholder: seq }, clients });

describe('M2 W2 framing', () => {
  it('round-trips split and coalesced frames', () => {
    const a = encodeFrame({ t: 'HELLO', v: 1 }, 1024), b = encodeFrame({ x: 'y'.repeat(100) }, 1024);
    const decoder = new FrameDecoder(1024);
    const all = Buffer.concat([a, b]);
    expect(decoder.push(all.subarray(0, 3))).toEqual({ kind: 'FRAMES', frames: [] });
    expect(decoder.push(all.subarray(3, a.length + 10))).toEqual({ kind: 'FRAMES', frames: [{ t: 'HELLO', v: 1 }] });
    expect(decoder.push(all.subarray(a.length + 10))).toEqual({ kind: 'FRAMES', frames: [{ x: 'y'.repeat(100) }] });
  });
  it.each([
    ['oversized', Buffer.from([0, 0, 8, 0]), 'FRAME_TOO_LARGE'],
    ['empty', Buffer.from([0, 0, 0, 0]), 'EMPTY_FRAME'],
    ['non-JSON', Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{x}')]), 'INVALID_JSON'],
  ])('rejects %s frames and stays failed', (_label, bytes, reason) => {
    const decoder = new FrameDecoder(1024);
    expect(decoder.push(bytes)).toEqual({ kind: 'PROTOCOL_ERROR', reason });
    expect(decoder.push(encodeFrame({ ok: true }, 1024)).kind).toBe('PROTOCOL_ERROR');
  });
  it('refuses to encode an oversized frame', () => { expect(() => encodeFrame({ x: 'y'.repeat(2000) }, 1024)).toThrow(RangeError); });
});

describe('M2 W2 configuration (explicit, no defaults)', () => {
  const limiter = {
    windows: [{ windowMs: 1000, maxStarts: 5 }], fairnessWindowMs: 1000,
    classShares: { P0: { minPerWindow: 0, maxPerWindow: 5 }, P1: { minPerWindow: 0, maxPerWindow: 5 }, P2: { minPerWindow: 0, maxPerWindow: 5 }, P3: { minPerWindow: 0, maxPerWindow: 5 } },
    concurrency: 5, p0ReservedSlots: 0, grantTtlMs: 2000, maxRequestDeadlineMs: 60_000, overdueGuardMs: 50, uncertainChargeAlertMs: 2000,
    retryAfter: { noHeaderDefaultMs: 60_000, providerStatedBlockMs: 1000, localBackoffBaseMs: 1000, localBackoffMaxMs: 4000, operationalCapMs: 600_000, clockUncertaintyMs: 2000 },
  };
  const coordinator = (): Record<string, unknown> => ({ limiter, stateDirectory: path.resolve('C:/tmp/x'), pipePath: PIPE, maxFrameBytes: 65_536, maxStateBytes: 1 << 20, tickMs: 20, handshakeTimeoutMs: 2000, maxSessions: 8, maxRegisteredClients: 8, maxPendingRequestsPerSession: 8 });
  it('accepts a complete fixture', () => { expect(validateCoordinatorConfig(coordinator()).kind).toBe('VALID'); });
  it.each<[string, (c: Record<string, unknown>) => void, string]>([
    ['a missing value', (c) => { delete c.tickMs; }, 'CONFIG_SHAPE'],
    ['a relative state directory', (c) => { c.stateDirectory = 'state'; }, 'STATE_DIRECTORY'],
    ['a non-local pipe', (c) => { c.pipePath = '\\\\server\\pipe\\x'; }, 'PIPE_PATH'],
    ['an invalid limiter', (c) => { (c.limiter as Record<string, unknown>).concurrency = 0; }, 'LIMITER_CONCURRENCY'],
    ['a tiny frame limit', (c) => { c.maxFrameBytes = 10; }, 'SIZE_LIMITS'],
  ])('rejects %s', (_label, mutate, reason) => {
    const c = JSON.parse(JSON.stringify(coordinator())) as Record<string, unknown>; mutate(c);
    expect(validateCoordinatorConfig(c)).toEqual({ kind: 'INVALID', reason });
  });
  it('validates client configuration', () => {
    expect(validateClientConfig({ pipePath: PIPE, maxFrameBytes: 65_536, connectTimeoutMs: 1000, probeScopes: ['PUBLIC'], maxOutbox: 10 }).kind).toBe('VALID');
    expect(validateClientConfig({ pipePath: PIPE, maxFrameBytes: 65_536, connectTimeoutMs: 1000, probeScopes: ['PUBLIC', 'PUBLIC'], maxOutbox: 10 })).toEqual({ kind: 'INVALID', reason: 'PROBE_SCOPES' });
  });
});

describe('M2 W2 durable state store', () => {
  it('initializes only a new or empty directory, writing the marker last', () => {
    const dir = tempDir(), id = installationId();
    initializeDisposableStateDirectory(dir, PIPE, id, 'DISPOSABLE_TEST_DIRECTORY');
    expect(fs.readdirSync(dir).sort()).toEqual([MARKER_FILE, SLOT_FILES.A, SLOT_FILES.B].sort());
    expect(() => initializeDisposableStateDirectory(dir, PIPE, installationId(), 'DISPOSABLE_TEST_DIRECTORY')).toThrow(/not new or empty/);
    const opened = openStateStore(dir, PIPE, 1 << 20);
    expect(opened.kind === 'OPEN' && [opened.record.journalSeq, opened.record.scheduler, opened.recoveredFrom]).toEqual([0, null, 'BOTH']);
  });

  it('a missing marker never turns existing (or absent) state into a fresh installation', () => {
    const dir = tempDir(), id = installationId();
    initializeDisposableStateDirectory(dir, PIPE, id, 'DISPOSABLE_TEST_DIRECTORY');
    fs.rmSync(path.join(dir, MARKER_FILE));
    expect(openStateStore(dir, PIPE, 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'INSTALLATION_MARKER_MISSING_OR_UNREADABLE' });
    expect(openStateStore(path.join(dir, 'does-not-exist'), PIPE, 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'INSTALLATION_MARKER_MISSING_OR_UNREADABLE' });
  });

  it('commits write slot A then slot B, each flushed, and acknowledge only after both', () => {
    const dir = tempDir(), id = installationId();
    initializeDisposableStateDirectory(dir, PIPE, id, 'DISPOSABLE_TEST_DIRECTORY');
    const order: string[] = [];
    const opened = openStateStore(dir, PIPE, 1 << 20, { beforeSlotWrite: (s, seq) => order.push(`before ${s}${seq}`), afterSlotWrite: (s, seq) => order.push(`after ${s}${seq}`) });
    if (opened.kind !== 'OPEN') throw new Error('open failed');
    expect(opened.store.commit({ scheduler: { n: 1 }, clients: [] })).toBe(1);
    expect(order).toEqual(['before A1', 'after A1', 'before B1', 'after B1']);
    const reopened = openStateStore(dir, PIPE, 1 << 20);
    expect(reopened.kind === 'OPEN' && [reopened.record.journalSeq, reopened.record.scheduler]).toEqual([1, { n: 1 }]);
  });

  it('a failure between the slots leaves A newer: recovery takes it (unacknowledged but conservative); the store refuses further commits', () => {
    const dir = tempDir(), id = installationId();
    initializeDisposableStateDirectory(dir, PIPE, id, 'DISPOSABLE_TEST_DIRECTORY');
    const opened = openStateStore(dir, PIPE, 1 << 20, { beforeSlotWrite: (s) => { if (s === 'B') throw new Error('simulated crash before B'); } });
    if (opened.kind !== 'OPEN') throw new Error('open failed');
    expect(() => opened.store.commit({ scheduler: { n: 1 }, clients: [] })).toThrow(/simulated crash/);
    expect(opened.store.failed).toBe(true);
    expect(() => opened.store.commit({ scheduler: { n: 2 }, clients: [] })).toThrow(/failed earlier/);
    const reopened = openStateStore(dir, PIPE, 1 << 20);
    expect(reopened.kind === 'OPEN' && [reopened.record.journalSeq, reopened.recoveredFrom]).toEqual([1, 'BOTH']);
  });

  it('a torn or corrupt slot falls back to the other slot; both bad fails closed', () => {
    const dir = tempDir(), id = installationId();
    initializeDisposableStateDirectory(dir, PIPE, id, 'DISPOSABLE_TEST_DIRECTORY');
    const opened = openStateStore(dir, PIPE, 1 << 20);
    if (opened.kind !== 'OPEN') throw new Error('open failed');
    opened.store.commit({ scheduler: { n: 1 }, clients: [] });
    const good = fs.readFileSync(slot(dir, 'A'));
    fs.writeFileSync(slot(dir, 'A'), good.subarray(0, good.length - 7)); // torn tail
    const tornA = openStateStore(dir, PIPE, 1 << 20);
    expect(tornA.kind === 'OPEN' && [tornA.record.journalSeq, tornA.recoveredFrom]).toEqual([1, 'B_ONLY']);
    const flipped = Buffer.from(good); flipped.writeUInt8(flipped.readUInt8(flipped.length - 3) ^ 0xff, flipped.length - 3);
    fs.writeFileSync(slot(dir, 'B'), flipped);
    expect(openStateStore(dir, PIPE, 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'NO_VALID_SLOT_LENGTH_CHECKSUM' });
  });

  it('fails closed on an incompatible version, another installation, another pipe, a sequence gap or an oversized record', () => {
    const dir = tempDir(), id = installationId();
    initializeDisposableStateDirectory(dir, PIPE, id, 'DISPOSABLE_TEST_DIRECTORY');
    const write = (s: 'A' | 'B', seq: number, body: unknown): void => fs.writeFileSync(slot(dir, s), encodeRecord(seq, Buffer.from(JSON.stringify(body))));
    const version = encodeRecord(0, Buffer.from(JSON.stringify(record(id, 0)))); version.writeUInt32BE(2, 8);
    fs.writeFileSync(slot(dir, 'A'), version);
    expect(openStateStore(dir, PIPE, 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'INCOMPATIBLE_RECORD_VERSION_2' });
    write('A', 5, { ...record(id, 5), format: 'coindcx-rest-limiter-state/2' });
    expect(openStateStore(dir, PIPE, 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'INCOMPATIBLE_STATE_FORMAT' });
    write('A', 5, record(installationId(), 5));
    expect(openStateStore(dir, PIPE, 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'INSTALLATION_MISMATCH' });
    write('A', 5, record(id, 5)); write('B', 2, record(id, 2));
    expect(openStateStore(dir, PIPE, 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'SLOT_SEQUENCE_GAP' });
    write('B', 4, record(id, 4));
    expect(openStateStore(dir, PIPE.replace('unit', 'other'), 1 << 20)).toEqual({ kind: 'FAIL_CLOSED', reason: 'PIPE_PATH_MISMATCH' });
    expect(openStateStore(dir, PIPE, 64)).toEqual({ kind: 'FAIL_CLOSED', reason: 'NO_VALID_SLOT_LENGTH_LENGTH' });
    const ok = openStateStore(dir, PIPE, 1 << 20);
    expect(ok.kind === 'OPEN' && ok.record.journalSeq).toBe(5);
  });
});
