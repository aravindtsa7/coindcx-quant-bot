import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { WorkingCandleManager, MAX_PROVIDER_TIMES_PER_WORKING_MINUTE } from '../../../src/market-data/working-candle';
import { createTestWorkingSnapshot } from './test-helpers';
import { setup, update, P, T, M, final, flushQueues } from './audit-a1-helpers';

const orders = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'];
const evidence = {
  A: { providerEventTimeMs: T + 30_000, close: new Decimal('100') },
  B: { providerEventTimeMs: T + 30_000, close: new Decimal('110') },
  C: { providerEventTimeMs: T + 40_000, close: new Decimal('115') },
};

describe('A-F18 equal-time evidence-set determinism', () => {
  for (const buffered of [false, true]) {
    it.each(orders)('all evidence conflicts in order %s; buffered=' + buffered, async order => {
      const c = setup(T + M + 1000);
      try {
        const state = await c.engine.initializePair(P);
        if (buffered) state.enterRecovery();
        for (const [sequence, key] of [...order].entries()) {
          await c.engine.handleStreamEnvelope(update(T, 1, evidence[key as keyof typeof evidence], sequence + 1));
        }
        await c.engine.handleStreamEnvelope(update(T + M));
        c.scheduler.advanceTime(1000); await flushQueues();
        expect(c.engine.getPairHealth(P)).toMatchObject({ state: 'INVALID', truthFault: 'CANONICAL_CONFLICT', workingOpenTimeMs: null, bufferedLiveUpdateCount: 0 });
        expect(c.repository.insertCalls).toHaveLength(0);
        // A later REST batch cannot silently clear this durable ambiguity fault.
        await state.applyRecoveredCandlesAndDrainBuffer([final(T)], state.recoveryEpoch);
        expect(state.truthFault).toBe('CANONICAL_CONFLICT');
        expect(c.repository.insertCalls).toHaveLength(0);
      } finally { c.engine.stop(); }
    });
  }

  it('identical equal-time evidence/retransmissions preserve the later canonical close in every permutation', async () => {
    for (const order of orders) {
      const c = setup(T + M + 1000);
      try {
        for (const key of order) await c.engine.handleStreamEnvelope(update(T, 1, key === 'C' ? evidence.C : evidence.A));
        await c.engine.handleStreamEnvelope(update(T, 1, evidence.C));
        await c.engine.handleStreamEnvelope(update(T + M)); c.scheduler.advanceTime(1000); await flushQueues();
        expect(c.engine.getPairHealth(P)?.truthFault).toBe('NONE');
        expect(c.repository.insertCalls.map(candle => candle.close.value)).toEqual(['115']);
      } finally { c.engine.stop(); }
    }
  });

  it('two independent conflict groups cannot be hidden by newer provider times', () => {
    for (const times of [[30_000, 40_000, 50_000, 30_000, 40_000], [50_000, 40_000, 30_000, 40_000, 30_000]]) {
      const manager = new WorkingCandleManager();
      const results = times.map((offset, index) => manager.update(createTestWorkingSnapshot({ openTimeMs: T, providerEventTimeMs: T + offset, close: new Decimal(100 + index) })));
      expect(results.at(-1)).toEqual({ applied: false, reason: 'CONFLICT' });
      expect(manager.retainedEvidenceCount).toBe(0);
    }
  });

  it('working and recovery-buffer evidence share the same ordering assertions', async () => {
    const c = setup(T + M + 1000);
    try {
      await c.engine.handleStreamEnvelope(update(T, 1, evidence.A));
      const state = await c.engine.initializePair(P); state.enterRecovery();
      await c.engine.handleStreamEnvelope(update(T, 1, evidence.C));
      await c.engine.handleStreamEnvelope(update(T, 1, evidence.B));
      expect(state.truthFault).toBe('CANONICAL_CONFLICT');
    } finally { c.engine.stop(); }
  });

  it('fingerprint capacity fails closed without eviction; minute disposal releases ownership', () => {
    const manager = new WorkingCandleManager();
    for (let i = 0; i < MAX_PROVIDER_TIMES_PER_WORKING_MINUTE; i++) {
      expect(manager.update(createTestWorkingSnapshot({ openTimeMs: T, providerEventTimeMs: T + i })).applied).toBe(true);
    }
    expect(manager.retainedEvidenceCount).toBe(MAX_PROVIDER_TIMES_PER_WORKING_MINUTE);
    expect(manager.update(createTestWorkingSnapshot({ openTimeMs: T, providerEventTimeMs: T + MAX_PROVIDER_TIMES_PER_WORKING_MINUTE }))).toEqual({ applied: false, reason: 'EVIDENCE_LIMIT' });
    expect(manager.retainedEvidenceCount).toBe(0);
    manager.delete(P, T);
    expect(manager.update(createTestWorkingSnapshot({ openTimeMs: T, providerEventTimeMs: T })).applied).toBe(true);
    manager.clear(P); expect(manager.retainedEvidenceCount).toBe(0);
    manager.update(createTestWorkingSnapshot({ openTimeMs: T }));
    manager.clearAll(); expect(manager.retainedEvidenceCount).toBe(0);
  });
});
