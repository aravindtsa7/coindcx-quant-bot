/**
 * The single mark contract (V2 §5 frozen) used uniformly by unrealized PnL,
 * equity, open-exposure valuation, margin valuation, funding reference
 * valuation, and reconciliation — never five ad-hoc valuations. No field here
 * asserts a concrete CoinDCX provider detail; the concrete producer remains an
 * explicit, unresolved provider-verification gate (PF13, P14-B). This module
 * defines the contract only. There is no fallback to candle close, last
 * trade, or entry price anywhere in this repository's accounting path — every
 * consumer takes a `PaperMarkSnapshot` as a required, freshly-acquired
 * parameter.
 */
export interface PaperMarkSnapshot {
  readonly pair: string;
  readonly markPrice: string;
  readonly sourceId: string;
  readonly providerEventId: string;
  readonly providerEventTimeMs: number;
  readonly observedAtMs: number;
  /** Binary — a stale mark is unusable, not degraded-but-usable. */
  readonly freshnessState: 'FRESH' | 'STALE';
  readonly sourceSessionId: string;
  readonly generationId: number;
  readonly contentSha256: string;
  readonly markPolicyVersion: string;
}
