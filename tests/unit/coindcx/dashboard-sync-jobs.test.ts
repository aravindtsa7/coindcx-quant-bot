import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { createDashboardServer } from '../../../src/dashboard/server';
import { WorkspaceStore } from '../../../src/dashboard/workspace-store';
import { MINUTE_MS, HistoricalMinuteArchive } from '../../../src/market-data/historical-minute-archive';
import type { HistoricalCandleQuery } from '../../../src/market-data/rest-candle-reader';
import { profile } from './audit-a2-helpers';

const now = Date.parse('2026-11-22T00:00:00Z'), pair = 'B-SOL_USDT';
const fixtures: { root: string; stop: () => Promise<void>; releaseAll: () => void }[] = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-sync-job-test-'));
  const holds: { call: number; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }[] = [];
  const getCandles = vi.fn(async (q: HistoricalCandleQuery) => {
    const hold = holds.find(h => h.call === getCandles.mock.calls.length);
    if (hold) { hold.entered.resolve(); await hold.release.promise; }
    const step = Number(q.resolution) * MINUTE_MS, price = new Decimal(100);
    return Array.from({ length: Math.floor((q.to - q.from + 1) / step) }, (_, i) => ({ pair: q.pair, openTimeMs: q.from + i * step,
      open: price, close: price, high: price.plus(1), low: price.minus(1), volume: new Decimal(1), quoteVolume: null }));
  });
  const options = { client: Object.assign(new CoinDcxClient(), { getCandles }), profiles: ['BTC', 'ETH', 'SOL'].map(profile),
    clock: { nowMs: () => now }, reportDirectory: root, budgetStats: () => ({ connected: true }),
    readSettlementConversion: vi.fn(async () => { throw new Error('UNEXPECTED_ACCOUNT_READ'); }) };
  const dashboard = await createDashboardServer(options);
  const result = { ...dashboard, root, options, getCandles, hold: (call: number) => {
    const h = { call, entered: deferred(), release: deferred() }; holds.push(h); return h;
  }, releaseAll: () => { for (const h of holds) h.release.resolve(); } };
  fixtures.push(result); return result;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.releaseAll(); await f.stop();
    const real = fs.realpathSync(f.root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('coindcx-sync-job-test-')) throw new Error('TEST_CLEANUP_PATH_REFUSED');
    fs.rmSync(real, { recursive: true });
  }
});
const backfill = { action: 'backfill', coin: 'SOL', fromMs: now - 2500 * MINUTE_MS, toMs: now };

describe('Background historical sync API', () => {
  it('returns 202 before a provider response, reports checkpointed chunks and refreshable inventory, then persists completion', async () => {
    const f = await fixture(), hold = f.hold(2);
    const idle = await request(f.app).get('/api/data/sync/status').expect(200);
    expect(idle.headers['cache-control']).toBe('no-store');
    expect(idle.body).toMatchObject({ status: 'IDLE', jobId: null, completedChunks: 0, percentComplete: 0, error: null });
    const started = await request(f.app).post('/api/data/sync').send(backfill).expect(202);
    expect(started.body).toEqual({ jobId: expect.any(String), status: 'RUNNING' });
    await hold.entered.promise;
    const status = await request(f.app).get('/api/data/sync/status').expect(200);
    expect(status.body).toMatchObject({ jobId: started.body.jobId, status: 'RUNNING', coin: 'SOL', pair, operation: 'BACKFILL',
      completedChunks: 1, totalChunks: 3, percentComplete: 33, candlesFetched: 1000, etaSeconds: expect.any(Number), error: null });
    const file = path.join(f.root, 'datasets', `${pair}-1m.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).candles).toHaveLength(1000);
    const persisted = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace-state.json'), 'utf8')).state.syncJobStatus;
    expect(persisted).toEqual(status.body);
    const inventory = await request(f.app).get('/api/data/inventory').expect(200);
    expect(inventory.body.coins.find((c: { pair: string }) => c.pair === pair)).toMatchObject({ candleCount: 1000, sizeBytes: fs.statSync(file).size, gapCount: 0 });
    expect((await request(f.app).get('/api/workspace').expect(200)).body.syncJobStatus).toEqual(status.body);
    await request(f.app).post('/api/data/sync').send(backfill).expect(409);
    await request(f.app).post('/api/data/history').send({ action: 'repair', coin: 'SOL' }).expect(409);
    hold.release.resolve(); await f.engine.waitForSync();
    expect((await request(f.app).get('/api/data/sync/status').expect(200)).body).toMatchObject({ status: 'COMPLETED', completedChunks: 3, totalChunks: 3, percentComplete: 100, candlesFetched: 2500, etaSeconds: 0 });
    expect(f.getCandles.mock.calls.every(([q]) => q.to - q.from < 1000 * MINUTE_MS && q.resolution === '1')).toBe(true);
    const reopened = await WorkspaceStore.open(f.root, () => now);
    expect(reopened.syncStatus().status).toBe('COMPLETED'); expect((await reopened.verifyPersistence()).status).toBe('VERIFIED');
    expect(f.options.readSettlementConversion).not.toHaveBeenCalled();
  });
  it('cancels between chunks, saves the in-flight chunk, and resumes only the missing suffix', async () => {
    const f = await fixture(), hold = f.hold(2);
    const started = await request(f.app).post('/api/data/sync').send(backfill).expect(202);
    await hold.entered.promise;
    await request(f.app).post('/api/data/sync/cancel').send({ jobId: 'a-stale-job' }).expect(409);
    const cancelling = await request(f.app).post('/api/data/sync/cancel').send({ jobId: started.body.jobId }).expect(200);
    expect(cancelling.body.status).toBe('RUNNING'); expect(cancelling.body.message).toContain('Cancelling');
    hold.release.resolve(); await f.engine.waitForSync();
    expect(f.getCandles).toHaveBeenCalledTimes(2);
    const status = (await request(f.app).get('/api/data/sync/status').expect(200)).body;
    expect(status).toMatchObject({ status: 'CANCELLED', completedChunks: 2, totalChunks: 3, candlesFetched: 2000, percentComplete: 66, error: null });
    expect((await new HistoricalMinuteArchive(f.root, () => now).inventory(pair)).candleCount).toBe(2000);
    expect((await WorkspaceStore.open(f.root, () => now)).syncStatus()).toEqual(status);
    expect((await request(f.app).post('/api/data/sync/cancel').send({}).expect(200)).body).toEqual(status);
    await request(f.app).post('/api/data/sync').send(backfill).expect(202); await f.engine.waitForSync();
    expect(f.getCandles).toHaveBeenCalledTimes(3);
    expect(f.getCandles.mock.calls[2]![0].from).toBe(backfill.fromMs + 2000 * MINUTE_MS);
    expect(f.workspace.syncStatus()).toMatchObject({ status: 'COMPLETED', completedChunks: 1, totalChunks: 1, candlesFetched: 500, percentComplete: 100 });
  });
  it('fails safely without losing previous checkpoints or exposing provider secrets, and supports an empty cached plan', async () => {
    const f = await fixture(), original = f.getCandles.getMockImplementation()!;
    f.getCandles.mockImplementationOnce(original).mockRejectedValueOnce(new Error('secret-api-key: provider failure'));
    await request(f.app).post('/api/data/sync').send(backfill).expect(202); await f.engine.waitForSync();
    expect(f.workspace.syncStatus()).toMatchObject({ status: 'FAILED', completedChunks: 1, candlesFetched: 1000, error: 'DATA_SYNC_FAILED' });
    expect(JSON.stringify((await request(f.app).get('/api/data/sync/status').expect(200)).body)).not.toContain('secret-api-key');
    expect((await f.engine.dataLake.archive.inventory(pair)).candleCount).toBe(1000);
    await request(f.app).post('/api/data/sync').send(backfill).expect(202); await f.engine.waitForSync();
    f.getCandles.mockClear();
    await request(f.app).post('/api/data/sync').send(backfill).expect(202); await f.engine.waitForSync();
    expect(f.getCandles).not.toHaveBeenCalled();
    expect(f.workspace.syncStatus()).toMatchObject({ status: 'COMPLETED', totalChunks: 0, completedChunks: 0, percentComplete: 100, candlesFetched: 0 });
  });
  it('tracks sync-all, extend-all, repair and bounded snapshots without enabling live execution', async () => {
    const f = await fixture();
    for (const [input, operation] of [[{ action: 'sync', all: true }, 'SYNC_ALL'], [{ action: 'extend', all: true, days: 1 }, 'EXTEND_ALL'],
      [{ action: 'repair', coin: 'SOL' }, 'REPAIR'], [{ coin: 'SOL', timeframe: '15m', bars: 30 }, 'SYNC']] as const) {
      await request(f.app).post('/api/data/sync').send(input).expect(202); await f.engine.waitForSync();
      expect(f.workspace.syncStatus()).toMatchObject({ status: 'COMPLETED', operation, percentComplete: 100 });
    }
    expect(f.workspace.snapshot().datasets[0]).toMatchObject({ resolution: '15', bars: 30, complete: true });
    const w = (await request(f.app).get('/api/workspace').expect(200)).body;
    expect(w.liveLocked).toBe(true); expect(w.busy).toBeNull();
    await request(f.app).post('/api/data/sync').send({ ...backfill, days: 366 }).expect(400);
    await request(f.app).post('/api/data/sync').send({ action: 'sync', coin: 'UNKNOWN' }).expect(400);
    await request(f.app).post('/api/data/sync/cancel').send({ unexpected: true }).expect(400);
    await request(f.app).post('/api/operations/stop').send({}).expect(200);
    await request(f.app).post('/api/data/sync').send(backfill).expect(409);
  });
  it('marks persisted running work interrupted after restart and retains its counters and archive', async () => {
    const f = await fixture();
    await request(f.app).post('/api/data/sync').send(backfill).expect(202); await f.engine.waitForSync();
    await f.workspace.mutate(state => { state.syncJobStatus!.status = 'RUNNING'; state.jobs.at(-1)!.status = 'RUNNING'; });
    const reopened = await WorkspaceStore.open(f.root, () => now);
    expect(reopened.syncStatus()).toMatchObject({ status: 'FAILED', error: 'PROCESS_RESTARTED', completedChunks: 3, candlesFetched: 2500 });
    expect(reopened.snapshot().jobs.at(-1)!.status).toBe('FAILED');
    expect((await new HistoricalMinuteArchive(f.root, () => now).inventory(pair)).candleCount).toBe(2500);
    expect((await reopened.verifyPersistence()).status).toBe('VERIFIED');
  });
  it('drains and checkpoints a running sync on dashboard shutdown', async () => {
    const f = await fixture(), hold = f.hold(1);
    await request(f.app).post('/api/data/sync').send(backfill).expect(202); await hold.entered.promise;
    const stopping = f.stop(); hold.release.resolve(); await stopping;
    expect(f.workspace.syncStatus()).toMatchObject({ status: 'CANCELLED', completedChunks: 1, candlesFetched: 1000 });
    expect((await f.engine.dataLake.archive.inventory(pair)).candleCount).toBe(1000);
  });
});
