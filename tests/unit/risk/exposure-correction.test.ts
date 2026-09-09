import { TEST_INSTANCE_ID, TEST_PARAMETER_HASH } from './helpers';
import { describe, expect, it } from 'vitest';
import { REJECTION_PRECEDENCE_V1, RiskEngine, type PortfolioExposureSnapshot, type RiskEvaluationContext } from '../../../src/risk';
import { makeContext, makeExposure, makePolicy, resealContext } from './helpers';

function invalidReservation(suffix: string) {
  return {
    strategyInstanceId: TEST_INSTANCE_ID, strategyId: `wrong-${suffix}`, strategyVersion: '1.0.0', parameterHash: TEST_PARAMETER_HASH,
    pendingNotionalInr: '10', pendingReservationCount: 1,
  };
}

function exposure(changes: Partial<PortfolioExposureSnapshot> = {}, reverseReservations = false): PortfolioExposureSnapshot {
  const base = makeExposure();
  if (base.pending.status !== 'KNOWN') throw new Error('fixture');
  // Keep this fixture an identity-only failure; duplicate-instance evidence is
  // independently rejected and covered by the rerun regression suite.
  const reservations = [invalidReservation('a'), { ...invalidReservation('b'), strategyInstanceId: 'instance-2' }];
  return {
    ...base,
    ...changes,
    pending: {
      ...base.pending,
      // Global must cover both instance reservations below it (C-F04 aggregate consistency).
      globalPendingNotionalInr: '20',
      instancePendingReservations: reverseReservations ? reservations.reverse() : reservations,
      pendingReservationCount: changes.pending?.status === 'KNOWN' ? changes.pending.pendingReservationCount : base.pending.pendingReservationCount,
      ...(changes.pending?.status === 'KNOWN' ? changes.pending : {}),
    },
  };
}

function codes(exposureSnapshot: PortfolioExposureSnapshot): readonly string[] {
  const context: RiskEvaluationContext = resealContext({ ...makeContext(), exposureSnapshot });
  const result = new RiskEngine(makePolicy()).evaluateRisk(context);
  return result.status === 'REJECTED' ? [result.primaryReasonCode, ...result.secondaryReasonCodes] : [];
}

describe('P13-IMPL-R01 exposure reason accumulation', () => {
  it('reports a pending-reservation identity mismatch alone', () => {
    expect(codes(exposure())).toEqual(['DECISION_IDENTITY_MISMATCH']);
  });

  it('reports a global exposure breach without an identity mismatch', () => {
    const base = makeExposure();
    const result = codes({ ...base, globalOpenNotionalInr: '800000' });
    expect(result).toContain('GLOBAL_EXPOSURE_LIMIT');
    expect(result).not.toContain('DECISION_IDENTITY_MISMATCH');
  });

  it('retains identity mismatch with a simultaneous global breach', () => {
    const result = codes(exposure({ globalOpenNotionalInr: '800000' }));
    expect(result).toContain('DECISION_IDENTITY_MISMATCH');
    expect(result).toContain('GLOBAL_EXPOSURE_LIMIT');
  });

  it('retains identity mismatch with a simultaneous pair breach', () => {
    const result = codes(exposure({ perPairOpenNotionalInr: { 'B-BTC_USDT': '400000' } }));
    expect(result).toContain('DECISION_IDENTITY_MISMATCH');
    expect(result).toContain('PAIR_EXPOSURE_LIMIT');
  });

  it('retains identity mismatch with a simultaneous strategy breach', () => {
    const result = codes(exposure({ perStrategyOpenNotionalInr: { 'EMA_TREND': '300000' } }));
    expect(result).toContain('DECISION_IDENTITY_MISMATCH');
    expect(result).toContain('STRATEGY_EXPOSURE_LIMIT');
  });

  it('retains identity mismatch with a simultaneous concurrency breach', () => {
    const result = codes(exposure({ concurrentOpenPositions: 10 }));
    expect(result).toContain('DECISION_IDENTITY_MISMATCH');
    expect(result).toContain('MAX_CONCURRENT_POSITIONS');
  });

  it('orders every simultaneous exposure reason by canonical precedence', () => {
    const result = codes(exposure({
      globalOpenNotionalInr: '800000', perPairOpenNotionalInr: { 'B-BTC_USDT': '400000' },
      perStrategyOpenNotionalInr: { 'EMA_TREND': '300000' }, concurrentOpenPositions: 10,
    }));
    expect(result).toEqual(REJECTION_PRECEDENCE_V1.filter((code) => result.includes(code)));
    expect(result).toEqual(expect.arrayContaining([
      'DECISION_IDENTITY_MISMATCH', 'GLOBAL_EXPOSURE_LIMIT', 'PAIR_EXPOSURE_LIMIT',
      'STRATEGY_EXPOSURE_LIMIT', 'MAX_CONCURRENT_POSITIONS',
    ]));
  });

  it('keeps reason order invariant when reservation input order changes', () => {
    const changes = {
      globalOpenNotionalInr: '800000', perPairOpenNotionalInr: { 'B-BTC_USDT': '400000' },
      perStrategyOpenNotionalInr: { 'EMA_TREND': '300000' }, concurrentOpenPositions: 10,
    };
    expect(codes(exposure(changes, true))).toEqual(codes(exposure(changes, false)));
  });
});
