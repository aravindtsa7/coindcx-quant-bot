/**
 * Phase 18B Checkpoint B: the two kinds of timing value the recovery core
 * uses, kept apart by type and by name.
 *
 * A. HARD OPERATIONAL CEILINGS (`PRACTICAL_RECOVERY_HARD_CEILINGS`, here).
 *    PROVISIONAL, UNCALIBRATED, PRE-SHADOW values whose only job is to stop a
 *    read or a pass from hanging. Exceeding one FAILS CLOSED: a read over
 *    `readTimeoutMs` is abandoned as READ_HARD_TIMEOUT (provider unavailable);
 *    a pass over `passDurationMs` does not count (PASS_HARD_CEILING_EXCEEDED).
 *    They are deliberately far above the calibration candidates, so a slow
 *    but healthy provider is measured by the candidates, not refused by these.
 *    They are NOT CoinDCX guarantees, NOT calibrated production thresholds,
 *    NOT final Stage 2 policy, and NOT a Stage 1A certification threshold.
 *    They MUST be replaced (or explicitly frozen) from Stage 2 shadow
 *    measurements before any venue-mutation rollout.
 *
 * B. CALIBRATION CANDIDATES (Stage 1A `PRACTICAL_TIMING_CANDIDATES`: 3 s per
 *    read, 15 s per pass, 2 s between reads). TELEMETRY MARKERS ONLY: each is
 *    measured and reported as `...CandidateExceeded`, and exceeding one never
 *    fails a read, a pass, or a certification. An exceedance is not a
 *    provider guarantee violation (there is no guarantee); it is Stage 2
 *    shadow evidence. The candidates are not frozen here.
 *
 * Neither kind touches the Stage 1A hard SAFETY ceilings from the enablement
 * (pass count, certification span, pass spacing, certificate lifetime), which
 * are enforced exactly as before.
 */
import type { PracticalTimingCandidate } from '../practical/policy';

export interface PracticalRecoveryHardCeilings {
  readonly kind: 'HARD_OPERATIONAL_CEILING';
  /** Provisional: to be replaced or frozen from Stage 2 shadow measurements before any venue mutation. */
  readonly status: 'PROVISIONAL_UNCALIBRATED_PRE_SHADOW';
  /** A read still pending after this long is abandoned (fail closed). */
  readonly readTimeoutMs: number;
  /** A pass (first read start to last read end) longer than this does not count. */
  readonly passDurationMs: number;
  readonly providerGuarantee: false;
}

export const PRACTICAL_RECOVERY_HARD_CEILINGS: PracticalRecoveryHardCeilings = Object.freeze({
  kind: 'HARD_OPERATIONAL_CEILING' as const,
  status: 'PROVISIONAL_UNCALIBRATED_PRE_SHADOW' as const,
  readTimeoutMs: 20_000,
  passDurationMs: 60_000,
  providerGuarantee: false as const,
});

/** Calibration marker only: whether a measured duration is above a candidate. Never a failure. */
export function practicalCandidateExceeded(measuredMs: number, candidate: PracticalTimingCandidate): boolean {
  return measuredMs > candidate.valueMs;
}
