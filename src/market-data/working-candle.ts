import { Decimal } from '../core/decimal/decimal';
import { createHash } from 'node:crypto';

export const MAX_PROVIDER_TIMES_PER_WORKING_MINUTE = 4096;
type EvidenceSnapshot = Pick<WorkingCandleSnapshot, 'pair' | 'openTimeMs' | 'providerEventTimeMs' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'quoteVolume'>;
type EvidenceFault = 'CONFLICT' | 'EVIDENCE_LIMIT';

export interface WorkingCandleSnapshot {
  readonly pair: string;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
  readonly quoteVolume: Decimal | null;
  readonly providerEventTimeMs: number;
  readonly sequence: number;
  readonly receivedAtMs: number;
  readonly generationId: number;
  readonly rawChannel: string;
}

export type WorkingCandleUpdateResult =
  | { applied: true; reason: 'ACCEPTED' | 'IDEMPOTENT_DUPLICATE' }
  | { applied: false; reason: 'SUPERSEDED' | EvidenceFault };

export function haveIdenticalCandleValues(a: Pick<WorkingCandleSnapshot, 'open' | 'high' | 'low' | 'close' | 'volume' | 'quoteVolume'>, b: Pick<WorkingCandleSnapshot, 'open' | 'high' | 'low' | 'close' | 'volume' | 'quoteVolume'>): boolean {
  return a.open.equals(b.open) && a.high.equals(b.high) && a.low.equals(b.low) &&
    a.close.equals(b.close) && a.volume.equals(b.volume) &&
    (a.quoteVolume === null ? b.quoteVolume === null : b.quoteVolume !== null && a.quoteVolume.equals(b.quoteVolume));
}

/**
 * Manages working candle snapshots per pair.
 * Invariants:
 * - A PUBLIC_CANDLE_UPDATE is a FULL candle snapshot, NOT a delta.
 * - Same-minute volume is NEVER summed across snapshots.
 * - Newer snapshots replace older working state deterministically.
 * - Primary ordering: providerEventTimeMs.
 * - Equal provider times with different values are unresolved conflicts.
 * - Older same-minute updates are safely dropped.
 * - Identical duplicate updates are idempotent no-ops.
 */
export class WorkingCandleManager {
  // Map of `pair:openTimeMs` -> WorkingCandleSnapshot
  readonly #workingMap = new Map<string, WorkingCandleSnapshot>();
  // Tracks the current working openTimeMs per pair
  readonly #currentOpenTimeByPair = new Map<string, number>();
  // Fixed-size fingerprints, not historical snapshots. Overflow fails closed, never evicts
  // an ordering assertion that a delayed conflicting counterpart might still reference.
  readonly #evidence = new Map<string, { times: Map<number, string>; fault: EvidenceFault | null }>();

  public get retainedEvidenceCount(): number {
    let count = 0;
    for (const item of this.#evidence.values()) count += item.times.size;
    return count;
  }

  public observeEvidence(snapshot: EvidenceSnapshot): EvidenceFault | null {
    const key = this.#buildKey(snapshot.pair, snapshot.openTimeMs);
    let evidence = this.#evidence.get(key);
    if (!evidence) {
      evidence = { times: new Map(), fault: null };
      this.#evidence.set(key, evidence);
    }
    if (evidence.fault) return evidence.fault;
    const fingerprint = createHash('sha256').update(JSON.stringify([
      snapshot.open.toString(), snapshot.high.toString(), snapshot.low.toString(),
      snapshot.close.toString(), snapshot.volume.toString(), snapshot.quoteVolume?.toString() ?? null,
    ])).digest('hex');
    const previous = evidence.times.get(snapshot.providerEventTimeMs);
    if (previous !== undefined && previous !== fingerprint) evidence.fault = 'CONFLICT';
    else if (previous === undefined) {
      if (evidence.times.size >= MAX_PROVIDER_TIMES_PER_WORKING_MINUTE) evidence.fault = 'EVIDENCE_LIMIT';
      else evidence.times.set(snapshot.providerEventTimeMs, fingerprint);
    }
    if (evidence.fault) evidence.times.clear(); // Keep only the fault until disposal/reset.
    return evidence.fault;
  }

  #buildKey(pair: string, openTimeMs: number): string {
    return `${pair}:${openTimeMs}`;
  }

  public get(pair: string, openTimeMs: number): WorkingCandleSnapshot | undefined {
    return this.#workingMap.get(this.#buildKey(pair, openTimeMs));
  }

  public getCurrent(pair: string): WorkingCandleSnapshot | undefined {
    const openTimeMs = this.#currentOpenTimeByPair.get(pair);
    if (openTimeMs === undefined) return undefined;
    return this.get(pair, openTimeMs);
  }

  public getCurrentOpenTimeMs(pair: string): number | null {
    return this.#currentOpenTimeByPair.get(pair) ?? null;
  }

  public update(snapshot: WorkingCandleSnapshot): WorkingCandleUpdateResult {
    const fault = this.observeEvidence(snapshot);
    if (fault) return { applied: false, reason: fault };
    const key = this.#buildKey(snapshot.pair, snapshot.openTimeMs);
    const existing = this.#workingMap.get(key);

    if (!existing) {
      this.#workingMap.set(key, snapshot);
      const cur = this.#currentOpenTimeByPair.get(snapshot.pair);
      if (cur === undefined || snapshot.openTimeMs >= cur) {
        this.#currentOpenTimeByPair.set(snapshot.pair, snapshot.openTimeMs);
      }
      return { applied: true, reason: 'ACCEPTED' };
    }

    // Check identical duplicate
    if (this.#isIdentical(existing, snapshot)) {
      return { applied: true, reason: 'IDEMPOTENT_DUPLICATE' };
    }

    if (snapshot.providerEventTimeMs === existing.providerEventTimeMs) {
      return { applied: false, reason: 'CONFLICT' };
    }
    const isNewer = snapshot.providerEventTimeMs > existing.providerEventTimeMs;

    if (!isNewer) {
      return { applied: false, reason: 'SUPERSEDED' };
    }

    // Replace working state with the newest valid snapshot
    this.#workingMap.set(key, snapshot);
    const cur = this.#currentOpenTimeByPair.get(snapshot.pair);
    if (cur === undefined || snapshot.openTimeMs >= cur) {
      this.#currentOpenTimeByPair.set(snapshot.pair, snapshot.openTimeMs);
    }

    return { applied: true, reason: 'ACCEPTED' };
  }

  public delete(pair: string, openTimeMs: number): void {
    const key = this.#buildKey(pair, openTimeMs);
    this.#workingMap.delete(key);
    this.#evidence.delete(key);
    if (this.#currentOpenTimeByPair.get(pair) === openTimeMs) {
      this.#currentOpenTimeByPair.delete(pair);
    }
  }

  public clear(pair: string): void {
    const prefix = `${pair}:`;
    for (const key of this.#evidence.keys()) if (key.startsWith(prefix)) this.#evidence.delete(key);
    for (const key of this.#workingMap.keys()) {
      if (key.startsWith(prefix)) {
        this.#workingMap.delete(key);
      }
    }
    this.#currentOpenTimeByPair.delete(pair);
  }

  public clearAll(): void {
    this.#evidence.clear();
    this.#workingMap.clear();
    this.#currentOpenTimeByPair.clear();
  }

  #isIdentical(a: WorkingCandleSnapshot, b: WorkingCandleSnapshot): boolean {
    if (a.providerEventTimeMs !== b.providerEventTimeMs) return false;
    if (!a.open.equals(b.open)) return false;
    if (!a.high.equals(b.high)) return false;
    if (!a.low.equals(b.low)) return false;
    if (!a.close.equals(b.close)) return false;
    if (!a.volume.equals(b.volume)) return false;

    if (a.quoteVolume === null && b.quoteVolume !== null) return false;
    if (a.quoteVolume !== null && b.quoteVolume === null) return false;
    if (a.quoteVolume !== null && b.quoteVolume !== null && !a.quoteVolume.equals(b.quoteVolume)) {
      return false;
    }

    return true;
  }
}
