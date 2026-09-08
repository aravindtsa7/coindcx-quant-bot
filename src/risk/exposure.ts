import { riskDecimal } from './decimal';
import type { RiskRejectionCode } from './reason-codes';
import type { PortfolioExposureSnapshot, RiskPolicy, StrategyRiskCandidate } from './types';

export interface ExposureHeadroom {
  readonly globalInr: string;
  readonly pairInr: string;
  readonly strategyInr: string;
}

export function reservationIdentityReasons(snapshot: PortfolioExposureSnapshot | null, candidate: StrategyRiskCandidate): readonly RiskRejectionCode[] {
  if (snapshot === null || snapshot.pending.status === 'UNKNOWN') return [];
  const reasons: RiskRejectionCode[] = [];
  const seen = new Set<string>();
  for (const reservation of snapshot.pending.instancePendingReservations) {
    if (seen.has(reservation.strategyInstanceId)) reasons.push('EXPOSURE_STATE_UNAVAILABLE');
    seen.add(reservation.strategyInstanceId);
    if (reservation.strategyInstanceId === candidate.strategyDecision.strategyInstanceId &&
        (reservation.strategyId !== candidate.strategyDecision.strategyId || reservation.strategyVersion !== candidate.strategyDecision.strategyVersion || reservation.parameterHash !== candidate.strategyDecision.parameterHash)) reasons.push('DECISION_IDENTITY_MISMATCH');
  }
  return reasons;
}

function mapValue(record: Readonly<Record<string, string>>, key: string): string { return record[key] ?? '0'; }

function nonNegative(value: string): boolean { return riskDecimal(value).gte(0); }
function recordNonNegative(record: Readonly<Record<string, string>>): boolean {
  return Object.values(record).every(nonNegative);
}

export function exposureStateReasons(snapshot: PortfolioExposureSnapshot): readonly RiskRejectionCode[] {
  if (snapshot.concurrentOpenPositions < 0) return ['EXPOSURE_STATE_UNAVAILABLE'];
  if (!nonNegative(snapshot.globalOpenNotionalInr) || !recordNonNegative(snapshot.perPairOpenNotionalInr) ||
      !recordNonNegative(snapshot.perStrategyOpenNotionalInr)) return ['EXPOSURE_STATE_UNAVAILABLE'];
  if (snapshot.pending.status === 'UNKNOWN') return [];
  if (!nonNegative(snapshot.pending.globalPendingNotionalInr) || !recordNonNegative(snapshot.pending.pairPendingNotionalInr) ||
      !recordNonNegative(snapshot.pending.strategyPendingNotionalInr) || snapshot.pending.pendingReservationCount < 0 ||
      !nonNegative(snapshot.pending.pendingDirectionalNotionalInr.longInr) || !nonNegative(snapshot.pending.pendingDirectionalNotionalInr.shortInr) ||
      snapshot.pending.instancePendingReservations.some((reservation) => !nonNegative(reservation.pendingNotionalInr) || reservation.pendingReservationCount < 0)) {
    return ['EXPOSURE_STATE_UNAVAILABLE'];
  }
  return [];
}

export function exposureHeadroom(snapshot: PortfolioExposureSnapshot, candidate: StrategyRiskCandidate, policy: RiskPolicy): ExposureHeadroom | null {
  if (snapshot.pending.status === 'UNKNOWN' || exposureStateReasons(snapshot).length > 0) return null;
  const pair = candidate.pair;
  const strategy = candidate.strategyDecision.strategyId;
  const globalA = riskDecimal(policy.globalConfig.globalMaxOpenNotionalInr); const globalB = riskDecimal(policy.modeConfig.maxConcurrentExposureInr);
  const pairA = riskDecimal(policy.pairConfig.pairMaxExposureInr); const pairB = riskDecimal(policy.modeConfig.maxCoinExposureInr);
  const globalCap = globalA.lt(globalB) ? globalA : globalB;
  const pairCap = pairA.lt(pairB) ? pairA : pairB;
  return {
    globalInr: globalCap.minus(snapshot.globalOpenNotionalInr).minus(snapshot.pending.globalPendingNotionalInr).toFixed(),
    pairInr: pairCap.minus(mapValue(snapshot.perPairOpenNotionalInr, pair)).minus(mapValue(snapshot.pending.pairPendingNotionalInr, pair)).toFixed(),
    strategyInr: riskDecimal(policy.modeConfig.maxStrategyExposureInr).minus(mapValue(snapshot.perStrategyOpenNotionalInr, strategy)).minus(mapValue(snapshot.pending.strategyPendingNotionalInr, strategy)).toFixed(),
  };
}

export function exposureReasons(snapshot: PortfolioExposureSnapshot | null, candidate: StrategyRiskCandidate, policy: RiskPolicy, candidateNotionalInr: string | null): readonly RiskRejectionCode[] {
  if (snapshot === null) return ['EXPOSURE_STATE_UNAVAILABLE'];
  const reasons: RiskRejectionCode[] = [...exposureStateReasons(snapshot)];
  if (snapshot.pending.status === 'UNKNOWN') reasons.push('PENDING_EXPOSURE_UNKNOWN');
  reasons.push(...reservationIdentityReasons(snapshot, candidate));
  const requested = candidateNotionalInr === null ? null : riskDecimal(candidateNotionalInr);
  const pendingGlobal = snapshot.pending.status === 'KNOWN' && nonNegative(snapshot.pending.globalPendingNotionalInr) ? riskDecimal(snapshot.pending.globalPendingNotionalInr) : null;
  const pendingPairValue = snapshot.pending.status === 'KNOWN' ? mapValue(snapshot.pending.pairPendingNotionalInr, candidate.pair) : null;
  const pendingStrategyValue = snapshot.pending.status === 'KNOWN' ? mapValue(snapshot.pending.strategyPendingNotionalInr, candidate.strategyDecision.strategyId) : null;
  const globalCurrentValid = nonNegative(snapshot.globalOpenNotionalInr);
  const pairCurrentValue = mapValue(snapshot.perPairOpenNotionalInr, candidate.pair);
  const strategyCurrentValue = mapValue(snapshot.perStrategyOpenNotionalInr, candidate.strategyDecision.strategyId);
  const globalCap = riskDecimal(policy.globalConfig.globalMaxOpenNotionalInr).lt(policy.modeConfig.maxConcurrentExposureInr)
    ? riskDecimal(policy.globalConfig.globalMaxOpenNotionalInr) : riskDecimal(policy.modeConfig.maxConcurrentExposureInr);
  const pairCap = riskDecimal(policy.pairConfig.pairMaxExposureInr).lt(policy.modeConfig.maxCoinExposureInr)
    ? riskDecimal(policy.pairConfig.pairMaxExposureInr) : riskDecimal(policy.modeConfig.maxCoinExposureInr);
  if (globalCurrentValid) {
    const currentHeadroom = globalCap.minus(snapshot.globalOpenNotionalInr);
    if (currentHeadroom.lte(0)) reasons.push('GLOBAL_EXPOSURE_LIMIT');
    else if (pendingGlobal !== null) {
      const headroom = currentHeadroom.minus(pendingGlobal);
      if ((requested === null && headroom.lte(0)) || (requested !== null && requested.gt(headroom))) reasons.push('GLOBAL_EXPOSURE_LIMIT');
    }
  }
  if (nonNegative(pairCurrentValue)) {
    const currentHeadroom = pairCap.minus(pairCurrentValue);
    if (currentHeadroom.lte(0)) reasons.push('PAIR_EXPOSURE_LIMIT');
    else if (pendingPairValue !== null && nonNegative(pendingPairValue)) {
      const headroom = currentHeadroom.minus(pendingPairValue);
      if ((requested === null && headroom.lte(0)) || (requested !== null && requested.gt(headroom))) reasons.push('PAIR_EXPOSURE_LIMIT');
    }
  }
  if (nonNegative(strategyCurrentValue)) {
    const currentHeadroom = riskDecimal(policy.modeConfig.maxStrategyExposureInr).minus(strategyCurrentValue);
    if (currentHeadroom.lte(0)) reasons.push('STRATEGY_EXPOSURE_LIMIT');
    else if (pendingStrategyValue !== null && nonNegative(pendingStrategyValue)) {
      const headroom = currentHeadroom.minus(pendingStrategyValue);
      if ((requested === null && headroom.lte(0)) || (requested !== null && requested.gt(headroom))) reasons.push('STRATEGY_EXPOSURE_LIMIT');
    }
  }
  const concurrentCap = Math.min(policy.globalConfig.globalMaxConcurrentPositions, policy.modeConfig.maxConcurrentPositions,
    policy.pairConfig.pairMaxConcurrentPositions ?? policy.globalConfig.globalMaxConcurrentPositions);
  if (snapshot.concurrentOpenPositions >= 0 &&
      (snapshot.concurrentOpenPositions + 1 > concurrentCap ||
       (snapshot.pending.status === 'KNOWN' && snapshot.pending.pendingReservationCount >= 0 && snapshot.concurrentOpenPositions + snapshot.pending.pendingReservationCount + 1 > concurrentCap))) {
    reasons.push('MAX_CONCURRENT_POSITIONS');
  }
  return reasons;
}
