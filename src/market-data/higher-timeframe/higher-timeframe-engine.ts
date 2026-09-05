import { areCanonicalCandlesIdentical } from '../models';
import { PrismaCandle1mRepository } from '../persistence/candle-repository';
import { CanonicalCandle1m, CanonicalHealthSnapshot, CanonicalStreamEvent } from '../types';
import { aggregateExactBucket } from './aggregate-exact-bucket';
import { PairSerialQueue } from './pair-queue';
import {
  Canonical1mRangeReader,
  CanonicalEngineForHigherTimeframes,
  HigherTimeframeCandle,
  HigherTimeframeClosedEvent,
  HigherTimeframePairOperationalState,
  HigherTimeframePairSnapshot,
} from './types';
import { ENABLED_HIGHER_TIMEFRAMES, MINUTE_MS, bucketEndExclusiveMs, bucketStartMs, durationMs, normalizeTimeframes } from './timeframe';
import { CanonicalDecimal } from '../canonical-decimal';

export type HigherTimeframeEngineLifecycleState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING';
export type HigherTimeframeEventListener = (event: HigherTimeframeClosedEvent) => void;

export interface HigherTimeframeEngineConfig {
  readonly canonicalEngine: CanonicalEngineForHigherTimeframes;
  readonly rangeReader?: Canonical1mRangeReader;
  readonly pairs: readonly string[];
  readonly timeframes?: readonly number[];
}

interface PartialBucket { readonly bucketStartMs: number; readonly candles: readonly CanonicalCandle1m[]; }
interface PairState {
  readonly pair: string;
  readonly identity: object;
  readonly queue: PairSerialQueue;
  operationalState: HigherTimeframePairOperationalState;
  blockReason: string | null;
  lastProcessedCanonicalOpenTimeMs: number | null;
  resyncHighWatermarkMs: number | null;
  readonly partials: Map<number, PartialBucket>;
  readonly publicationWatermarks: Map<number, number | null>;
}

function validPair(pair: string): boolean { return typeof pair === 'string' && pair.trim() !== ''; }

/** Exact Phase 6 health gate; Phase 5 remains the only truth authority. */
export function isPhase5Eligible(health: CanonicalHealthSnapshot | undefined): boolean {
  return health?.state === 'HEALTHY' && health.truthFault === 'NONE' && health.recoveryRequired === false;
}

function isCanonicalCandle(value: unknown, eventPair: string): value is CanonicalCandle1m {
  if (!value || typeof value !== 'object') return false;
  const candle = value as Record<string, unknown>;
  if (candle.pair !== eventPair || !validPair(eventPair) || !Number.isSafeInteger(candle.openTimeMs) || (candle.openTimeMs as number) % MINUTE_MS !== 0 || candle.closeTimeExclusiveMs !== (candle.openTimeMs as number) + MINUTE_MS) return false;
  const decimals = [candle.open, candle.high, candle.low, candle.close, candle.volume];
  if (!decimals.every((decimal) => decimal instanceof CanonicalDecimal)) return false;
  if (candle.quoteVolume !== null && !(candle.quoteVolume instanceof CanonicalDecimal)) return false;
  if (candle.source !== 'WS_FINALIZED' && candle.source !== 'REST_RECOVERY') return false;
  const open = candle.open as CanonicalDecimal;
  const high = candle.high as CanonicalDecimal;
  const low = candle.low as CanonicalDecimal;
  const close = candle.close as CanonicalDecimal;
  return !high.lessThan(low) && !high.lessThan(open) && !high.lessThan(close) && !low.greaterThan(open) && !low.greaterThan(close);
}

export class HigherTimeframeEngine {
  readonly #canonicalEngine: CanonicalEngineForHigherTimeframes;
  readonly #rangeReader: Canonical1mRangeReader;
  readonly #pairs: readonly string[];
  readonly #timeframes: readonly number[];
  readonly #states = new Map<string, PairState>();
  readonly #subscribers = new Set<HigherTimeframeEventListener>();
  #unsubscribe: (() => void) | null = null;
  #lifecycleState: HigherTimeframeEngineLifecycleState = 'STOPPED';
  #currentRunId = 1;
  #startPromise: Promise<void> | null = null;

  constructor(config: HigherTimeframeEngineConfig) {
    if (!config || !config.canonicalEngine) throw new TypeError('canonicalEngine is required');
    if (config.pairs.length === 0) throw new RangeError('At least one configured pair is required');
    const pairs = [...config.pairs];
    for (const pair of pairs) if (!validPair(pair)) throw new RangeError('Configured pair must be nonblank');
    pairs.sort();
    for (let index = 1; index < pairs.length; index++) if (pairs[index] === pairs[index - 1]) throw new RangeError(`Duplicate configured pair: ${pairs[index]}`);
    this.#canonicalEngine = config.canonicalEngine;
    this.#rangeReader = config.rangeReader ?? new PrismaCandle1mRepository();
    this.#pairs = Object.freeze(pairs);
    this.#timeframes = normalizeTimeframes(config.timeframes ?? ENABLED_HIGHER_TIMEFRAMES);
  }

  public get lifecycleState(): HigherTimeframeEngineLifecycleState { return this.#lifecycleState; }
  public get enabledTimeframes(): readonly number[] { return this.#timeframes; }

  public getPairSnapshot(pair: string): HigherTimeframePairSnapshot | undefined {
    const state = this.#states.get(pair);
    if (!state) return undefined;
    return Object.freeze({ pair: state.pair, operationalState: state.operationalState, blockReason: state.blockReason, lastProcessedCanonicalOpenTimeMs: state.lastProcessedCanonicalOpenTimeMs, resyncHighWatermarkMs: state.resyncHighWatermarkMs });
  }

  public subscribe(listener: HigherTimeframeEventListener): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  public start(): Promise<void> {
    if (this.#lifecycleState === 'RUNNING') return Promise.resolve();
    if (this.#lifecycleState === 'STARTING' && this.#startPromise) return this.#startPromise;
    if (this.#canonicalEngine.lifecycleState !== undefined && this.#canonicalEngine.lifecycleState !== 'RUNNING') {
      return Promise.reject(new Error('Phase 5 canonical engine must already be RUNNING'));
    }
    const runId = this.#currentRunId;
    this.#lifecycleState = 'STARTING';
    this.#states.clear();
    for (const pair of this.#pairs) this.#states.set(pair, this.#newPairState(pair));
    this.#unsubscribe = this.#canonicalEngine.subscribe((event) => this.#handleCanonicalEvent(event));
    const promise = Promise.all(this.#pairs.map((pair) => this.#enqueue(pair, runId, async (state) => this.#hydrate(state, runId)))).then(() => {
      if (runId === this.#currentRunId) this.#lifecycleState = 'RUNNING';
    });
    this.#startPromise = promise;
    promise.finally(() => { if (this.#startPromise === promise) this.#startPromise = null; }).catch(() => undefined);
    return promise;
  }

  public stop(): void {
    if (this.#lifecycleState === 'STOPPED' || this.#lifecycleState === 'STOPPING') return;
    this.#lifecycleState = 'STOPPING';
    this.#currentRunId++;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#states.clear();
    this.#startPromise = null;
    this.#lifecycleState = 'STOPPED';
  }

  #newPairState(pair: string): PairState {
    const publicationWatermarks = new Map<number, number | null>();
    for (const timeframe of this.#timeframes) publicationWatermarks.set(timeframe, null);
    return { pair, identity: {}, queue: new PairSerialQueue(), operationalState: 'INITIALIZING', blockReason: null, lastProcessedCanonicalOpenTimeMs: null, resyncHighWatermarkMs: null, partials: new Map(), publicationWatermarks };
  }

  #isCurrent(state: PairState, runId: number): boolean { return runId === this.#currentRunId && this.#states.get(state.pair) === state; }
  #block(state: PairState, reason: string): void { state.operationalState = 'BLOCKED'; state.blockReason = reason; state.resyncHighWatermarkMs = null; }
  #eligible(pair: string): boolean { return isPhase5Eligible(this.#canonicalEngine.getPairHealth(pair)); }

  #enqueue(pair: string, runId: number, operation: (state: PairState) => Promise<void>): Promise<void> {
    const captured = this.#states.get(pair);
    if (!captured) return Promise.resolve();
    return captured.queue.enqueue(async () => {
      if (!this.#isCurrent(captured, runId)) return;
      try { await operation(captured); }
      catch { if (this.#isCurrent(captured, runId)) this.#block(captured, 'TRUTH_UNCERTAIN'); }
    });
  }

  #handleCanonicalEvent(event: CanonicalStreamEvent<unknown>): void {
    const runId = this.#currentRunId;
    if (this.#lifecycleState === 'STOPPED' || !this.#states.has(event.pair)) return;
    void this.#enqueue(event.pair, runId, async (state) => {
      if (!this.#isCurrent(state, runId)) return;
      const eligible = this.#eligible(state.pair);
      if (!eligible) { this.#block(state, 'PHASE5_INELIGIBLE'); return; }
      if (state.operationalState !== 'READY') {
        if (state.lastProcessedCanonicalOpenTimeMs === null) await this.#hydrate(state, runId);
        else await this.#resync(state, runId);
        return;
      }
      if (event.eventType !== 'CANONICAL_1M_CLOSED') return;
      if (!isCanonicalCandle(event.payload, event.pair)) { this.#block(state, 'INVALID_CANONICAL_EVENT'); return; }
      await this.#processLive(state, event.payload, runId);
    });
  }

  #assertContinuous(candles: readonly CanonicalCandle1m[], fromMs: number, toMs: number, pair: string): void {
    const expectedCount = (toMs - fromMs) / MINUTE_MS + 1;
    if (!Number.isSafeInteger(expectedCount) || candles.length !== expectedCount) throw new RangeError('Canonical DB range is incomplete');
    for (let index = 0; index < candles.length; index++) {
      const candle = candles[index];
      if (!candle || candle.pair !== pair || candle.openTimeMs !== fromMs + index * MINUTE_MS || !isCanonicalCandle(candle, pair)) throw new RangeError('Canonical DB range is not exact contiguous truth');
    }
  }

  async #hydrate(state: PairState, runId: number): Promise<void> {
    if (!this.#isCurrent(state, runId)) return;
    state.operationalState = 'INITIALIZING';
    if (!this.#eligible(state.pair)) { this.#block(state, 'PHASE5_INELIGIBLE'); return; }
    const latest = await this.#rangeReader.getLatestCanonicalCandle(state.pair);
    if (!this.#isCurrent(state, runId)) return;
    if (!this.#eligible(state.pair)) { this.#block(state, 'PHASE5_INELIGIBLE'); return; }
    if (latest === null) { this.#block(state, 'AWAITING_CANONICAL_BASELINE'); return; }
    if (!isCanonicalCandle(latest, state.pair)) throw new TypeError('Latest canonical DB candle is invalid');
    const from = Math.min(...this.#timeframes.map((timeframe) => bucketStartMs(latest.openTimeMs, timeframe)));
    const candles = await this.#rangeReader.getRange(state.pair, from, latest.openTimeMs);
    if (!this.#isCurrent(state, runId)) return;
    if (!this.#eligible(state.pair)) { this.#block(state, 'PHASE5_INELIGIBLE'); return; }
    this.#assertContinuous(candles, from, latest.openTimeMs, state.pair);
    this.#rebuildPartials(state, candles, latest.openTimeMs, false, []);
    state.lastProcessedCanonicalOpenTimeMs = latest.openTimeMs;
    state.resyncHighWatermarkMs = null;
    state.operationalState = 'READY';
    state.blockReason = null;
  }

  #rebuildPartials(state: PairState, candles: readonly CanonicalCandle1m[], highWatermark: number, stageCompleted: boolean, staged: HigherTimeframeCandle[]): void {
    state.partials.clear();
    for (const timeframe of this.#timeframes) {
      // The common range anchor can land inside this particular timeframe's bucket.
      // Start staging only at the first complete bucket boundary actually present.
      const firstBoundary = candles.find((candle) => candle.openTimeMs === bucketStartMs(candle.openTimeMs, timeframe));
      const relevant = firstBoundary ? candles.filter((candle) => candle.openTimeMs >= firstBoundary.openTimeMs) : [];
      let current: CanonicalCandle1m[] = [];
      let currentStart: number | null = null;
      for (const candle of relevant) {
        const start = bucketStartMs(candle.openTimeMs, timeframe);
        if (currentStart !== start) { currentStart = start; current = []; }
        current.push(candle);
        if (current.length === timeframe) {
          const aggregate = aggregateExactBucket(current, timeframe);
          if (stageCompleted && this.#canPublish(state, timeframe, aggregate.openTimeMs)) staged.push(aggregate);
        }
      }
      const latestStart = bucketStartMs(highWatermark, timeframe);
      const currentBucket = relevant.filter((candle) => bucketStartMs(candle.openTimeMs, timeframe) === latestStart);
      state.partials.set(timeframe, { bucketStartMs: latestStart, candles: Object.freeze([...currentBucket]) });
      if (!stageCompleted) {
        const latestComplete = highWatermark === bucketEndExclusiveMs(highWatermark, timeframe) - MINUTE_MS
          ? latestStart
          : latestStart - durationMs(timeframe);
        if (!Number.isSafeInteger(latestComplete)) throw new RangeError('Historical publication watermark is unsafe');
        state.publicationWatermarks.set(timeframe, latestComplete);
      }
    }
  }

  #canPublish(state: PairState, timeframe: number, bucketStart: number): boolean {
    const watermark = state.publicationWatermarks.get(timeframe);
    return watermark === null || watermark === undefined || bucketStart > watermark;
  }

  #publish(state: PairState, candle: HigherTimeframeCandle, runId: number): void {
    if (!this.#isCurrent(state, runId) || !this.#eligible(state.pair) || state.operationalState !== 'READY') return;
    if (!this.#canPublish(state, candle.timeframeMinutes, candle.openTimeMs)) return;
    state.publicationWatermarks.set(candle.timeframeMinutes, candle.openTimeMs);
    const event: HigherTimeframeClosedEvent = Object.freeze({ eventType: 'HIGHER_TIMEFRAME_CLOSED', pair: candle.pair, timeframeMinutes: candle.timeframeMinutes, bucketStartMs: candle.openTimeMs, closeTimeExclusiveMs: candle.closeTimeExclusiveMs, eventTimeMs: candle.closeTimeExclusiveMs, candle });
    const recipients = [...this.#subscribers];
    for (const recipient of recipients) {
      if (!this.#isCurrent(state, runId)) return;
      try { recipient(event); } catch { /* downstream exceptions are isolated */ }
    }
  }

  async #processLive(state: PairState, candle: CanonicalCandle1m, runId: number): Promise<void> {
    const last = state.lastProcessedCanonicalOpenTimeMs;
    if (last === null) { await this.#hydrate(state, runId); return; }
    if (candle.openTimeMs <= last) {
      const rows = await this.#rangeReader.getRange(state.pair, candle.openTimeMs, candle.openTimeMs);
      if (!this.#isCurrent(state, runId)) return;
      if (rows.length !== 1 || !areCanonicalCandlesIdentical(rows[0] as CanonicalCandle1m, candle)) this.#block(state, 'CANONICAL_MISMATCH');
      return;
    }
    if (candle.openTimeMs !== last + MINUTE_MS) { this.#block(state, 'CANONICAL_GAP'); await this.#resync(state, runId); return; }
    for (const timeframe of this.#timeframes) {
      const start = bucketStartMs(candle.openTimeMs, timeframe);
      const partial = state.partials.get(timeframe);
      const constituents = partial?.bucketStartMs === start ? [...partial.candles, candle] : [candle];
      if (constituents.length > timeframe) throw new RangeError('Higher timeframe partial bucket overflow');
      state.partials.set(timeframe, { bucketStartMs: start, candles: Object.freeze(constituents) });
      if (constituents.length === timeframe) this.#publish(state, aggregateExactBucket(constituents, timeframe), runId);
    }
    if (!this.#isCurrent(state, runId)) return;
    state.lastProcessedCanonicalOpenTimeMs = candle.openTimeMs;
  }

  async #resync(state: PairState, runId: number): Promise<void> {
    if (!this.#isCurrent(state, runId) || !this.#eligible(state.pair)) { if (this.#isCurrent(state, runId)) this.#block(state, 'PHASE5_INELIGIBLE'); return; }
    const last = state.lastProcessedCanonicalOpenTimeMs;
    if (last === null) { await this.#hydrate(state, runId); return; }
    state.operationalState = 'RESYNCING';
    const unresolved = last + MINUTE_MS;
    const from = Math.min(...this.#timeframes.map((timeframe) => bucketStartMs(unresolved, timeframe)));
    const latest = await this.#rangeReader.getLatestCanonicalCandle(state.pair);
    if (!this.#isCurrent(state, runId)) return;
    if (!this.#eligible(state.pair) || latest === null || !isCanonicalCandle(latest, state.pair)) { this.#block(state, 'PHASE5_INELIGIBLE_OR_NO_BASELINE'); return; }
    state.resyncHighWatermarkMs = latest.openTimeMs;
    // The DB must have advanced through the next unresolved canonical minute; merely
    // rereading the already-processed high watermark cannot prove a resync.
    if (latest.openTimeMs < unresolved) { this.#block(state, 'CANONICAL_RANGE_BEHIND'); return; }
    const candles = await this.#rangeReader.getRange(state.pair, from, latest.openTimeMs);
    if (!this.#isCurrent(state, runId)) return;
    if (!this.#eligible(state.pair)) { this.#block(state, 'PHASE5_INELIGIBLE'); return; }
    this.#assertContinuous(candles, from, latest.openTimeMs, state.pair);
    const staged: HigherTimeframeCandle[] = [];
    this.#rebuildPartials(state, candles, latest.openTimeMs, true, staged);
    if (!this.#eligible(state.pair) || !this.#isCurrent(state, runId)) { if (this.#isCurrent(state, runId)) this.#block(state, 'PHASE5_INELIGIBLE'); return; }
    state.lastProcessedCanonicalOpenTimeMs = latest.openTimeMs;
    state.operationalState = 'READY';
    state.blockReason = null;
    staged.sort((a, b) => a.closeTimeExclusiveMs - b.closeTimeExclusiveMs || a.timeframeMinutes - b.timeframeMinutes);
    for (const candle of staged) this.#publish(state, candle, runId);
    if (this.#isCurrent(state, runId)) state.resyncHighWatermarkMs = null;
  }
}
