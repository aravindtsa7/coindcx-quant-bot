import { CanonicalDecimal } from './canonical-decimal';

export type CanonicalCandleSource = 'WS_FINALIZED' | 'REST_RECOVERY';

/**
 * Immutable canonical closed 1-minute candlestick domain model.
 * Invariants:
 * - openTimeMs is aligned to exact UTC minute (openTimeMs % 60_000 === 0)
 * - closeTimeExclusiveMs === openTimeMs + 60_000
 * - OHLCV use strict CanonicalDecimal representation (scale <= 18, precision <= 36)
 * - quoteVolume is nullable when genuine upstream data is absent (never fabricated as 0)
 * - pair + openTimeMs uniquely identifies the canonical candle
 */
export interface CanonicalCandle1m {
  readonly pair: string;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly open: CanonicalDecimal;
  readonly high: CanonicalDecimal;
  readonly low: CanonicalDecimal;
  readonly close: CanonicalDecimal;
  readonly volume: CanonicalDecimal;
  readonly quoteVolume: CanonicalDecimal | null;
  readonly source: CanonicalCandleSource;
  readonly finalizedAtMs: number;
  readonly providerEventTimeMs: number | null;
  readonly generationId: number | null;
}

/**
 * Standard data-health state vocabulary.
 */
export type CanonicalHealthState =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'STALE'
  | 'RECOVERING'
  | 'INVALID';

/**
 * Persistent blocking truth fault latch.
 * Fail-closed: ordinary live packets cannot clear a non-NONE truth fault.
 */
export type TruthFault =
  | 'NONE'
  | 'CANONICAL_CONFLICT'
  | 'PERSISTENCE_FAILURE'
  | 'RECOVERY_INCOMPLETE'
  | 'BUFFER_OVERFLOW'
  | 'TIME_INVALID';

/**
 * Read-only health snapshot isolated per instrument pair.
 */
export interface CanonicalHealthSnapshot {
  readonly pair: string;
  readonly state: CanonicalHealthState;
  readonly truthFault: TruthFault;
  readonly currentGenerationId: number | null;
  readonly canonicalEpoch: number;
  readonly recoveryEpoch: number;
  readonly workingOpenTimeMs: number | null;
  readonly latestCanonicalOpenTimeMs: number | null;
  readonly continuityWatermarkMs: number | null;
  readonly pendingFinalizationsCount: number;
  readonly lastValidProviderEventTimeMs: number | null;
  readonly lastValidReceivedAtMs: number | null;
  readonly gapCount: number;
  readonly lateDropCount: number;
  readonly duplicateCount: number;
  readonly recoveryRequired: boolean;
  readonly bufferedLiveUpdateCount: number;
}

export type CanonicalEventType =
  | 'CANONICAL_1M_CLOSED'
  | 'CANONICAL_1M_RECOVERY_REQUIRED'
  | 'CANONICAL_1M_RECOVERY_COMPLETED'
  | 'CANONICAL_1M_STALE'
  | 'CANONICAL_1M_INVALID';

export interface CanonicalStreamEvent<T = unknown> {
  readonly eventType: CanonicalEventType;
  readonly pair: string;
  readonly timestampMs: number;
  readonly payload: T;
}

export type CanonicalEventListener = (event: CanonicalStreamEvent<unknown>) => void;
