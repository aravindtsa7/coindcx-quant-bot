import { CanonicalDecimal } from '../canonical-decimal';
import { CanonicalCandle1m, CanonicalHealthSnapshot, CanonicalStreamEvent } from '../types';
import { DerivedAggregateDecimal } from './derived-aggregate-decimal';

export interface HigherTimeframeCandle {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly open: CanonicalDecimal;
  readonly high: CanonicalDecimal;
  readonly low: CanonicalDecimal;
  readonly close: CanonicalDecimal;
  readonly volume: DerivedAggregateDecimal;
  readonly quoteVolume: DerivedAggregateDecimal | null;
  readonly source: 'CANONICAL_1M_DERIVED';
}

export interface HigherTimeframeClosedEvent {
  readonly eventType: 'HIGHER_TIMEFRAME_CLOSED';
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bucketStartMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly eventTimeMs: number;
  readonly candle: HigherTimeframeCandle;
}

export interface Canonical1mRangeReader {
  getLatestCanonicalCandle(pair: string): Promise<CanonicalCandle1m | null>;
  getRange(pair: string, fromInclusiveMs: number, toInclusiveMs: number): Promise<readonly CanonicalCandle1m[]>;
}

export type HigherTimeframePairOperationalState = 'INITIALIZING' | 'READY' | 'BLOCKED' | 'RESYNCING';
export interface HigherTimeframePairSnapshot {
  readonly pair: string;
  readonly operationalState: HigherTimeframePairOperationalState;
  readonly blockReason: string | null;
  readonly lastProcessedCanonicalOpenTimeMs: number | null;
  readonly resyncHighWatermarkMs: number | null;
}

export interface CanonicalEngineForHigherTimeframes {
  subscribe(listener: (event: CanonicalStreamEvent<unknown>) => void): () => void;
  getPairHealth(pair: string): CanonicalHealthSnapshot | undefined;
  readonly lifecycleState?: string;
}
