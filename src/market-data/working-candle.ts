import { Decimal } from '../core/decimal/decimal';

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
  | { applied: false; reason: 'SUPERSEDED' };

/**
 * Manages working candle snapshots per pair.
 * Invariants:
 * - A PUBLIC_CANDLE_UPDATE is a FULL candle snapshot, NOT a delta.
 * - Same-minute volume is NEVER summed across snapshots.
 * - Newer snapshots replace older working state deterministically.
 * - Primary ordering: providerEventTimeMs.
 * - Deterministic tie-breakers: Phase 4 sequence, then receivedAtMs.
 * - Older same-minute updates are safely dropped.
 * - Identical duplicate updates are idempotent no-ops.
 */
export class WorkingCandleManager {
  // Map of `pair:openTimeMs` -> WorkingCandleSnapshot
  readonly #workingMap = new Map<string, WorkingCandleSnapshot>();
  // Tracks the current working openTimeMs per pair
  readonly #currentOpenTimeByPair = new Map<string, number>();

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

    // Deterministic ordering check: providerEventTimeMs -> sequence -> receivedAtMs
    const isNewer =
      snapshot.providerEventTimeMs > existing.providerEventTimeMs ||
      (snapshot.providerEventTimeMs === existing.providerEventTimeMs &&
        snapshot.sequence > existing.sequence) ||
      (snapshot.providerEventTimeMs === existing.providerEventTimeMs &&
        snapshot.sequence === existing.sequence &&
        snapshot.receivedAtMs > existing.receivedAtMs);

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
    if (this.#currentOpenTimeByPair.get(pair) === openTimeMs) {
      this.#currentOpenTimeByPair.delete(pair);
    }
  }

  public clear(pair: string): void {
    const prefix = `${pair}:`;
    for (const key of this.#workingMap.keys()) {
      if (key.startsWith(prefix)) {
        this.#workingMap.delete(key);
      }
    }
    this.#currentOpenTimeByPair.delete(pair);
  }

  public clearAll(): void {
    this.#workingMap.clear();
    this.#currentOpenTimeByPair.clear();
  }

  #isIdentical(a: WorkingCandleSnapshot, b: WorkingCandleSnapshot): boolean {
    if (a.providerEventTimeMs !== b.providerEventTimeMs) return false;
    if (a.sequence !== b.sequence) return false;
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
