/**
 * Execution-grade market evidence contract (V2 §4 frozen). Canonical 1m
 * candles remain strategy-analysis truth only — this is the only shape the
 * paper fill engine (a later slice) may ever price a fill against. No field
 * here asserts a concrete CoinDCX provider detail; the concrete producer
 * remains an explicit, unresolved provider-verification gate (PF13-adjacent,
 * P14-B) — this module defines the contract only, never a fallback
 * implementation. There is no historical-candle-OPEN/CLOSE fallback, no
 * entry-price fallback, and no stale-price fallback anywhere in this
 * repository's fill path.
 */
export interface PaperExecutionQuoteSnapshot {
  readonly pair: string;
  readonly instrumentSpecSnapshotId: string;
  readonly bid: string;
  readonly ask: string;
  /** `null` when the provider cannot represent executable depth — never fabricated. */
  readonly availableExecutableQuantity: string | null;
  readonly providerEventId: string;
  readonly providerEventTimeMs: number;
  readonly firstObservedAtMs: number;
  readonly sourceSessionId: string;
  readonly generationId: number;
  /**
   * By construction, only `HEALTHY`/`DEGRADED` snapshots can ever be produced
   * by a genuine provider adapter — `STALE`/`RECOVERING`/`INVALID` truth never
   * reaches this shape at all (V2.2 §24: the adapter refuses to emit a
   * snapshot in that case, rather than emitting one that has to be
   * special-cased downstream).
   */
  readonly healthState: 'HEALTHY' | 'DEGRADED';
  readonly contentSha256: string;
  readonly evidencePolicyVersion: string;
}
