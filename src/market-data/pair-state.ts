import { Clock, SystemClock } from '../integration/coindcx/clock';
import { StreamScheduler, SystemStreamScheduler } from '../integration/coindcx/websocket/public-stream';
import {
  CoinDcxStreamEnvelope,
  PublicCandleUpdatePayload,
} from '../integration/coindcx/websocket/types';
import { CanonicalDecimal } from './canonical-decimal';
import { MIN_CANONICAL_OPEN_TIME_MS, createCanonicalCandle1m } from './models';
import {
  CanonicalCandle1m,
  CanonicalHealthSnapshot,
  CanonicalHealthState,
  TruthFault,
} from './types';
import { WorkingCandleManager, WorkingCandleSnapshot, WorkingCandleUpdateResult } from './working-candle';

export interface PairStateConfig {
  readonly pair: string;
  readonly clock?: Clock | undefined;
  readonly scheduler?: StreamScheduler | undefined;
  readonly finalizationGraceMs?: number | undefined; // default: 1000ms
  readonly maxFutureSkewMs?: number | undefined; // default: 5000ms
  readonly maxRecoveryBuffer?: number | undefined; // default: 100
  readonly staleThresholdMs?: number | undefined; // default: 120_000ms
}

export interface EpochToken {
  readonly canonicalEpoch: number;
  readonly recoveryEpoch: number;
  readonly generationId: number | null;
}

export interface PairStateCallbacks {
  readonly onFinalizeCandle: (candle: CanonicalCandle1m, token?: EpochToken, origin?: CommitOrigin) => Promise<void>;
  readonly onRequestRecovery: (pair: string, fromMs: number, toMs: number, recoveryEpoch?: number) => Promise<void>;
  readonly onConflictDetected: (pair: string, conflictMessage: string) => void;
  readonly onStaleDetected?: ((pair: string) => void) | undefined;
  readonly getPersistedCandle: (pair: string, openTimeMs: number) => Promise<CanonicalCandle1m | null>;
}

export interface PendingFinalization {
  readonly pair: string;
  readonly openTimeMs: number;
  readonly generationId: number | null;
  readonly canonicalEpoch: number;
  readonly recoveryEpoch: number;
  readonly timerId: number | NodeJS.Timeout;
  readonly sequence: number;
  readonly receivedAtMs: number;
  readonly providerEventTimeMs: number;
}

export interface BufferedEnvelope {
  readonly envelope: CoinDcxStreamEnvelope<PublicCandleUpdatePayload>;
  readonly pair: string;
  readonly openTimeMs: number;
  readonly providerEventTimeMs: number;
  readonly sequence: number;
  readonly receivedAtMs: number;
  readonly generationId: number;
}

export type CommitOrigin = 'LIVE_FINALIZATION' | 'REST_RECOVERY';

/**
 * A single candidate for the unified per-pair ordered commit queue (RECOVERY-COMMIT-INTERLEAVE fix).
 * Both live-finalized minutes and REST-recovered minutes enter this SAME structure and are committed
 * through the SAME #drainCommitQueue/#commitOne authority — there is no separate persistence path.
 * For LIVE_FINALIZATION, the canonical candle is built lazily from the working snapshot at actual
 * commit time (it may still have been updated by a late-but-pending packet after scheduling). For
 * REST_RECOVERY, the candle is already fully built and verified by REST before being queued.
 */
export interface CommitCandidate {
  readonly openTimeMs: number;
  readonly origin: CommitOrigin;
  readonly token: EpochToken;
  readonly prebuiltCandle?: CanonicalCandle1m | undefined;
}

/**
 * Isolated per-pair canonical 1m state machine.
 * Invariants:
 * - F1: ONE unified, ordered per-pair commit queue (readyToCommit + commitInFlight) is the sole path
 *   that may invoke onFinalizeCandle for this pair -- for BOTH live-finalized candles (grace-timer
 *   expiry only marks a minute ready) AND REST-recovered candles (applyRecoveredCandlesAndDrainBuffer
 *   enqueues them into the SAME queue instead of persisting directly). #drainCommitQueue is the sole
 *   committer and only ever starts the strictly-ascending contiguous successor of
 *   latestCanonicalOpenTimeMs, with at most one commit in flight. This means recovery can never persist
 *   a later minute while an earlier live commit is still unresolved, and a live commit can never race a
 *   competing recovery insert for a minute recovery already owns (RECOVERY-COMMIT-INTERLEAVE fix).
 * - F2: Continuity barrier & warm restart validation. First live candle on restart checked against
 *   latestCanonicalOpenTimeMs + 60_000. A predecessor working candle that is orphaned by a live gap (never
 *   finalized) becomes part of the REST verification interval, and is cleared from working state once
 *   recovered, so buffered replay does not re-detect the same gap.
 * - F3/F4: Monotonic epoch tokens (canonicalEpoch, recoveryEpoch, generationId). In-flight stale callbacks abort inertly.
 * - F4: Single-flight recovery ownership. Superseded recoveries become inert.
 * - F5: Fail-closed truth fault latch (truthFault). Normal packets cannot auto-heal truth faults. A
 *   RECOVERY_INCOMPLETE fault can only be cleared by a subsequent successful exact recovery for the
 *   active recovery epoch.
 * - F7: Strict quoteVolume participation in truth equality (null !== Decimal(0)).
 * - F9: Candle-time safety: safe integer, minute aligned, sane bounds, forward-skew and far-future rejection.
 * - F10: Recovery buffer stores full envelopes with exact metadata and duplicate coalescing.
 * - Freshness telemetry (lastValidProviderEventTimeMs/lastValidReceivedAtMs) mutates ONLY after a packet
 *   is classified as current-generation, time-valid, and accepted (never for historical or rejected packets).
 * - Deterministic staleness timer rearming.
 */
export class PairCanonicalStateMachine {
  readonly #pair: string;
  readonly #clock: Clock;
  readonly #scheduler: StreamScheduler;
  readonly #finalizationGraceMs: number;
  readonly #maxFutureSkewMs: number;
  readonly #maxRecoveryBuffer: number;
  readonly #staleThresholdMs: number;
  readonly #callbacks: PairStateCallbacks;

  readonly #workingManager = new WorkingCandleManager();
  readonly #pendingFinalizations = new Map<number, PendingFinalization>();
  readonly #recoveryBuffer: BufferedEnvelope[] = [];
  // Unified per-pair ordered commit queue: candidates (LIVE_FINALIZATION or REST_RECOVERY) ready to
  // commit, keyed by openTimeMs, plus a single-flight guard. #drainCommitQueue is the ONLY path that
  // may invoke onFinalizeCandle for this pair, regardless of origin.
  readonly #readyToCommit = new Map<number, CommitCandidate>();
  #commitInFlight = false;
  // Waiters that resolve once a given openTimeMs's commit candidate has settled (committed, dropped as
  // already-superseded, or permanently blocked by a fault) -- lets applyRecoveredCandlesAndDrainBuffer
  // await the unified queue's decision without ever bypassing it.
  readonly #commitSettledWaiters = new Map<number, Array<() => void>>();

  #state: CanonicalHealthState = 'HEALTHY';
  #truthFault: TruthFault = 'NONE';
  #canonicalEpoch = 1;
  #recoveryEpoch = 1;
  #currentGenerationId: number | null = null;
  #latestCanonicalOpenTimeMs: number | null = null;
  #continuityWatermarkMs: number | null = null;
  #lastValidProviderEventTimeMs: number | null = null;
  #lastValidReceivedAtMs: number | null = null;

  #gapCount = 0;
  #lateDropCount = 0;
  #duplicateCount = 0;

  #staleCheckTimer: number | NodeJS.Timeout | null = null;
  #isStopped = false;

  constructor(config: PairStateConfig, callbacks: PairStateCallbacks) {
    this.#pair = config.pair;
    this.#clock = config.clock ?? new SystemClock();
    this.#scheduler = config.scheduler ?? SystemStreamScheduler;
    this.#finalizationGraceMs = config.finalizationGraceMs ?? 1000;
    this.#maxFutureSkewMs = config.maxFutureSkewMs ?? 5000;
    this.#maxRecoveryBuffer = config.maxRecoveryBuffer ?? 100;
    this.#staleThresholdMs = config.staleThresholdMs ?? 120_000;
    this.#callbacks = callbacks;
  }

  public get pair(): string {
    return this.#pair;
  }

  public get state(): CanonicalHealthState {
    return this.#state;
  }

  public get truthFault(): TruthFault {
    return this.#truthFault;
  }

  public get latestCanonicalOpenTimeMs(): number | null {
    return this.#latestCanonicalOpenTimeMs;
  }

  public get continuityWatermarkMs(): number | null {
    return this.#continuityWatermarkMs;
  }

  public get canonicalEpoch(): number {
    return this.#canonicalEpoch;
  }

  public get recoveryEpoch(): number {
    return this.#recoveryEpoch;
  }

  public initializeLatestCanonical(openTimeMs: number | null): void {
    this.#latestCanonicalOpenTimeMs = openTimeMs;
    this.#continuityWatermarkMs = openTimeMs;
  }

  public getHealthSnapshot(): CanonicalHealthSnapshot {
    return Object.freeze<CanonicalHealthSnapshot>({
      pair: this.#pair,
      state: this.#state,
      truthFault: this.#truthFault,
      currentGenerationId: this.#currentGenerationId,
      canonicalEpoch: this.#canonicalEpoch,
      recoveryEpoch: this.#recoveryEpoch,
      workingOpenTimeMs: this.#workingManager.getCurrentOpenTimeMs(this.#pair),
      latestCanonicalOpenTimeMs: this.#latestCanonicalOpenTimeMs,
      continuityWatermarkMs: this.#continuityWatermarkMs,
      pendingFinalizationsCount: this.#pendingFinalizations.size,
      lastValidProviderEventTimeMs: this.#lastValidProviderEventTimeMs,
      lastValidReceivedAtMs: this.#lastValidReceivedAtMs,
      gapCount: this.#gapCount,
      lateDropCount: this.#lateDropCount,
      duplicateCount: this.#duplicateCount,
      recoveryRequired: this.#state === 'RECOVERING' || this.#truthFault !== 'NONE',
      bufferedLiveUpdateCount: this.#recoveryBuffer.length,
    });
  }

  public setGeneration(generationId: number): void {
    this.#currentGenerationId = generationId;
  }

  /**
   * Puts the pair into RECOVERING state and increments recoveryEpoch.
   */
  public enterRecovery(): number {
    if (this.#isStopped) return this.#recoveryEpoch;
    this.#recoveryEpoch++;
    this.#state = 'RECOVERING';
    this.#clearAllPendingFinalizations();
    return this.#recoveryEpoch;
  }

  /**
   * F5: Latches a durable, fail-closed recovery fault for the ACTIVE recovery epoch when REST recovery
   * returns partial/empty coverage, throws, or otherwise fails to establish exact continuous coverage.
   * A no-op for a superseded epoch. Never overrides an existing (possibly more severe) fault. Ordinary
   * live packets cannot clear this — only a subsequent successful exact recovery for the (then-)active
   * epoch can, via applyRecoveredCandlesAndDrainBuffer.
   */
  public latchRecoveryFault(fault: TruthFault, recoveryEpoch: number): void {
    if (this.#isStopped) return;
    if (recoveryEpoch !== this.#recoveryEpoch) return;
    if (this.#truthFault !== 'NONE') return;
    this.#truthFault = fault;
    this.#state = 'RECOVERING';
  }

  /**
   * Consumes Phase 4 public reconnect barrier event.
   */
  public handleReconnectBarrier(newGeneration: number): void {
    if (this.#isStopped) return;

    this.#currentGenerationId = newGeneration;
    this.#canonicalEpoch++;
    this.#recoveryEpoch++;
    this.#clearAllPendingFinalizations();

    // Invalidate trust in pre-disconnect working candle
    this.#workingManager.clear(this.#pair);

    // Enter RECOVERING state
    this.#state = 'RECOVERING';
  }

  /**
   * Helper method to process a PublicCandleUpdatePayload by wrapping in a stream envelope.
   */
  public async handleCandleUpdate(
    payload: PublicCandleUpdatePayload,
    envelopeMetadata?: { sequence?: number; receivedAtMs?: number; generationId?: number }
  ): Promise<void> {
    const envelope: CoinDcxStreamEnvelope<PublicCandleUpdatePayload> = {
      source: 'COINDCX',
      stream: 'PUBLIC_FUTURES',
      generationId: envelopeMetadata?.generationId ?? this.#currentGenerationId ?? 1,
      sequence: envelopeMetadata?.sequence ?? 1,
      receivedAtMs: envelopeMetadata?.receivedAtMs ?? this.#clock.nowMs(),
      eventType: 'PUBLIC_CANDLE_UPDATE',
      providerTimestampMs: payload.providerEventTimeMs,
      pair: payload.pair,
      payload,
    };
    return this.handleStreamEnvelope(envelope);
  }

  /**
   * Main entry point for processing Phase 4 PUBLIC_CANDLE_UPDATE stream envelopes.
   */
  public async handleStreamEnvelope(envelope: CoinDcxStreamEnvelope<PublicCandleUpdatePayload>): Promise<void> {
    if (this.#isStopped) return;

    const { payload, sequence, receivedAtMs, generationId } = envelope;
    const { openTimeMs, providerEventTimeMs, pair } = payload;

    if (pair !== this.#pair) {
      return;
    }

    // Generation isolation: drop stale generation updates
    if (this.#currentGenerationId !== null && generationId < this.#currentGenerationId) {
      this.#lateDropCount++;
      return;
    }
    this.#currentGenerationId = generationId;

    // F9: Candle-time safety checks
    if (
      !Number.isSafeInteger(openTimeMs) ||
      !Number.isFinite(openTimeMs) ||
      openTimeMs < MIN_CANONICAL_OPEN_TIME_MS ||
      openTimeMs % 60_000 !== 0
    ) {
      this.#state = 'INVALID';
      this.#truthFault = 'TIME_INVALID';
      return;
    }

    if (!Number.isSafeInteger(providerEventTimeMs) || providerEventTimeMs <= 0) {
      this.#state = 'INVALID';
      this.#truthFault = 'TIME_INVALID';
      return;
    }

    const nowMs = this.#clock.nowMs();

    // Reject implausibly far-future candle openings (e.g. year 5000)
    if (openTimeMs > nowMs + this.#maxFutureSkewMs + 60_000) {
      this.#state = 'INVALID';
      this.#truthFault = 'TIME_INVALID';
      return;
    }

    // Forward-skew clock check on provider event time
    if (providerEventTimeMs > nowMs + this.#maxFutureSkewMs) {
      this.#state = 'DEGRADED';
      return;
    }

    // F10: Buffer live envelopes when RECOVERING with full metadata and same-minute coalescing
    if (this.#state === 'RECOVERING') {
      this.#bufferEnvelope({
        envelope,
        pair,
        openTimeMs,
        providerEventTimeMs,
        sequence,
        receivedAtMs,
        generationId,
      });
      return;
    }

    // Fail-closed truth fault latch: normal packets CANNOT clear an existing truth fault
    if (this.#truthFault !== 'NONE') {
      if (this.#state !== 'INVALID') {
        this.#state = 'DEGRADED';
      }
      return;
    }

    // Warm restart check (F2): compare first live candle against latestCanonicalOpenTimeMs + 60_000
    const currentWorkingOpenTimeMs = this.#workingManager.getCurrentOpenTimeMs(this.#pair);
    if (currentWorkingOpenTimeMs === null && this.#latestCanonicalOpenTimeMs !== null) {
      const expectedNextOpenTimeMs = this.#latestCanonicalOpenTimeMs + 60_000;
      if (openTimeMs > expectedNextOpenTimeMs) {
        // Gap on warm restart: e.g. latest was 12:00, first live is 12:03
        this.#gapCount++;
        const recEpoch = this.enterRecovery();
        this.#bufferEnvelope({
          envelope,
          pair,
          openTimeMs,
          providerEventTimeMs,
          sequence,
          receivedAtMs,
          generationId,
        });
        await this.#callbacks.onRequestRecovery(
          this.#pair,
          expectedNextOpenTimeMs,
          openTimeMs - 60_000,
          recEpoch
        );
        return;
      }

      if (openTimeMs <= this.#latestCanonicalOpenTimeMs) {
        // Historical/late packet on restart: check for duplicate/conflict, do not advance working state
        await this.#handleLatePostFinalizationUpdate(payload);
        return;
      }
    }

    // Historical/already-finalized packet classification MUST happen BEFORE freshness telemetry
    // mutates: a late/historical packet is never proof that the live feed is currently fresh, and
    // may even turn out to be a conflicting packet (handled below). Do not let it mask real staleness.
    if (this.#latestCanonicalOpenTimeMs !== null && openTimeMs <= this.#latestCanonicalOpenTimeMs) {
      await this.#handleLatePostFinalizationUpdate(payload);
      return;
    }

    // ARRIVAL != ACCEPTANCE (FRESHNESS-SUPERSEDED-REFRESH fix): freshness telemetry and staleness
    // rearming must NOT mutate here. They mutate only via #refreshFreshness, called below ONLY once the
    // working-candle classification has actually decided this packet represents genuine accepted
    // forward live progress. An older/materially-different same-minute snapshot that
    // WorkingCandleManager reports SUPERSEDED (or a duplicate, or a late-drop) must never refresh
    // freshness or postpone the staleness deadline, even though it was validly received.

    // Working candle management
    if (currentWorkingOpenTimeMs === null) {
      // First accepted working candle: unconditionally a genuine acceptance (brand-new key).
      this.#applyWorkingUpdate(payload, { sequence, receivedAtMs, generationId });
      this.#refreshFreshness(providerEventTimeMs, nowMs);
      return;
    }

    if (openTimeMs === currentWorkingOpenTimeMs) {
      // Same-minute update: only a genuinely ACCEPTED (newer) snapshot proves live progress.
      // SUPERSEDED (older/materially-different) and IDEMPOTENT_DUPLICATE do not refresh freshness --
      // a duplicate is not treated as proof of *current* connectivity under this health policy.
      const result = this.#applyWorkingUpdate(payload, { sequence, receivedAtMs, generationId });
      if (result.applied && result.reason === 'ACCEPTED') {
        this.#refreshFreshness(providerEventTimeMs, nowMs);
      }
      return;
    }

    if (openTimeMs < currentWorkingOpenTimeMs) {
      // Late update for an earlier minute: check if still in finalization grace
      const pending = this.#pendingFinalizations.get(openTimeMs);
      if (pending) {
        const result = this.#applyWorkingUpdate(payload, { sequence, receivedAtMs, generationId });
        if (result.applied && result.reason === 'ACCEPTED') {
          this.#refreshFreshness(providerEventTimeMs, nowMs);
        }
      } else {
        this.#lateDropCount++;
      }
      return;
    }

    // Successor minute arrived: openTimeMs > currentWorkingOpenTimeMs
    const diff = openTimeMs - currentWorkingOpenTimeMs;
    if (diff === 60_000) {
      // Immediate successor: schedule finalization for currentWorkingOpenTimeMs without cancelling earlier pending
      this.#scheduleFinalization(currentWorkingOpenTimeMs, { sequence, receivedAtMs, providerEventTimeMs });
      this.#applyWorkingUpdate(payload, { sequence, receivedAtMs, generationId });
      this.#refreshFreshness(providerEventTimeMs, nowMs);
    } else {
      // Live gap detected (e.g. 12:00 working -> 12:03 live). The triggering packet is itself valid,
      // current-generation, time-safe live data accepted for buffering/recovery, so it proves freshness
      // even though it does not directly become the working candle yet.
      this.#gapCount++;
      const recEpoch = this.enterRecovery();
      this.#bufferEnvelope({
        envelope,
        pair,
        openTimeMs,
        providerEventTimeMs,
        sequence,
        receivedAtMs,
        generationId,
      });
      this.#refreshFreshness(providerEventTimeMs, nowMs);

      // F2: currentWorkingOpenTimeMs (e.g. 12:00) was never finalized/persisted — it must become part
      // of the REST verification interval rather than being silently abandoned. Once recovery succeeds,
      // applyRecoveredCandlesAndDrainBuffer clears this stale working entry before draining the buffer,
      // so replay progresses instead of recursively re-detecting the same gap.
      const fromMs = currentWorkingOpenTimeMs;
      const toMs = openTimeMs - 60_000;
      await this.#callbacks.onRequestRecovery(this.#pair, fromMs, toMs, recEpoch);
    }
  }

  /**
   * ARRIVAL != ACCEPTANCE: call ONLY once a packet has been classified as genuine accepted forward live
   * progress. Never called for SUPERSEDED, duplicate, late-dropped, historical, or rejected packets.
   */
  #refreshFreshness(providerEventTimeMs: number, nowMs: number): void {
    this.#lastValidProviderEventTimeMs = providerEventTimeMs;
    this.#lastValidReceivedAtMs = nowMs;
    if (this.#state === 'STALE' || this.#state === 'DEGRADED') {
      this.#state = 'HEALTHY';
    }
    this.#scheduleStaleCheck();
  }

  #bufferEnvelope(item: BufferedEnvelope): void {
    // Check if an envelope for the exact same pair & openTimeMs is already buffered
    const existingIndex = this.#recoveryBuffer.findIndex((b) => b.openTimeMs === item.openTimeMs);
    if (existingIndex >= 0) {
      const existing = this.#recoveryBuffer[existingIndex];
      if (existing) {
        // Deterministic comparison: providerEventTimeMs -> sequence -> receivedAtMs
        const isNewer =
          item.providerEventTimeMs > existing.providerEventTimeMs ||
          (item.providerEventTimeMs === existing.providerEventTimeMs && item.sequence > existing.sequence) ||
          (item.providerEventTimeMs === existing.providerEventTimeMs &&
            item.sequence === existing.sequence &&
            item.receivedAtMs > existing.receivedAtMs);

        if (isNewer) {
          // Replace in-place (does not increase buffer count)
          this.#recoveryBuffer[existingIndex] = item;
        }
      }
      return;
    }

    // Capacity limit check
    if (this.#recoveryBuffer.length >= this.#maxRecoveryBuffer) {
      this.#truthFault = 'BUFFER_OVERFLOW';
      this.#state = 'INVALID';
      return;
    }

    this.#recoveryBuffer.push(item);
  }

  #applyWorkingUpdate(
    payload: PublicCandleUpdatePayload,
    meta: { sequence: number; receivedAtMs: number; generationId: number }
  ): WorkingCandleUpdateResult {
    const snapshot: WorkingCandleSnapshot = {
      pair: payload.pair,
      openTimeMs: payload.openTimeMs,
      closeTimeMs: payload.closeTimeMs,
      open: payload.open,
      high: payload.high,
      low: payload.low,
      close: payload.close,
      volume: payload.volume,
      quoteVolume: payload.quoteVolume,
      providerEventTimeMs: payload.providerEventTimeMs,
      sequence: meta.sequence,
      receivedAtMs: meta.receivedAtMs,
      generationId: meta.generationId,
      rawChannel: payload.rawChannel,
    };

    const res = this.#workingManager.update(snapshot);
    if (!res.applied) {
      this.#lateDropCount++;
    } else if (res.reason === 'IDEMPOTENT_DUPLICATE') {
      this.#duplicateCount++;
    }
    return res;
  }

  /**
   * Schedules finalization for eligibleOpenTimeMs (F1: per-minute ownership).
   * Does NOT cancel pending finalization for another open time.
   */
  #scheduleFinalization(
    eligibleOpenTimeMs: number,
    meta: { sequence: number; receivedAtMs: number; providerEventTimeMs: number }
  ): void {
    // Clear existing timer for THIS specific openTimeMs if already scheduled
    const existing = this.#pendingFinalizations.get(eligibleOpenTimeMs);
    if (existing) {
      this.#scheduler.clearTimeout(existing.timerId);
      this.#pendingFinalizations.delete(eligibleOpenTimeMs);
      this.#readyToCommit.delete(eligibleOpenTimeMs);
    }

    const currentEpochToken: EpochToken = {
      canonicalEpoch: this.#canonicalEpoch,
      recoveryEpoch: this.#recoveryEpoch,
      generationId: this.#currentGenerationId,
    };

    const timerId = this.#scheduler.setTimeout(() => {
      if (this.#isStopped) return;
      this.#onFinalizationGraceElapsed(eligibleOpenTimeMs, currentEpochToken);
    }, this.#finalizationGraceMs);

    const pending: PendingFinalization = {
      pair: this.#pair,
      openTimeMs: eligibleOpenTimeMs,
      generationId: this.#currentGenerationId,
      canonicalEpoch: this.#canonicalEpoch,
      recoveryEpoch: this.#recoveryEpoch,
      timerId,
      sequence: meta.sequence,
      receivedAtMs: meta.receivedAtMs,
      providerEventTimeMs: meta.providerEventTimeMs,
    };

    this.#pendingFinalizations.set(eligibleOpenTimeMs, pending);
  }

  /**
   * F1: The grace timer for openTimeMs elapsed. This does NOT commit directly — it only enqueues a
   * LIVE_FINALIZATION candidate into the unified commit queue. Commit order/ownership is fully decided
   * by #drainCommitQueue, the same authority REST recovery candidates go through.
   */
  #onFinalizationGraceElapsed(openTimeMs: number, token: EpochToken): void {
    const pending = this.#pendingFinalizations.get(openTimeMs);
    if (!pending) return;

    // F3/F4: Revalidate epoch ownership before this minute is even eligible to commit
    if (!this.#isTokenValid(token, 'LIVE_FINALIZATION')) {
      this.#pendingFinalizations.delete(openTimeMs);
      return;
    }

    this.#enqueueCommitCandidate({ openTimeMs, origin: 'LIVE_FINALIZATION', token });
  }

  /**
   * Adds a commit candidate to the unified per-pair queue and asks the drain authority to make
   * progress. This is the ONLY way a candidate (live or recovered) enters the commit pipeline.
   */
  #enqueueCommitCandidate(candidate: CommitCandidate): void {
    const existing = this.#readyToCommit.get(candidate.openTimeMs);
    if (existing && existing.origin === 'REST_RECOVERY' && candidate.origin === 'LIVE_FINALIZATION') {
      // Verified REST truth already queued for this minute takes precedence over a live candidate.
      return;
    }
    this.#readyToCommit.set(candidate.openTimeMs, candidate);
    this.#drainCommitQueue();
  }

  #resolveCommitSettled(openTimeMs: number): void {
    const waiters = this.#commitSettledWaiters.get(openTimeMs);
    if (!waiters) return;
    this.#commitSettledWaiters.delete(openTimeMs);
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolves once openTimeMs's commit candidate has settled: committed, dropped as already-superseded,
   * or permanently blocked by an active fault. Lets a caller (recovery) safely await the unified
   * queue's decision without ever bypassing it.
   */
  #awaitCommitSettled(openTimeMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const list = this.#commitSettledWaiters.get(openTimeMs);
      if (list) {
        list.push(resolve);
      } else {
        this.#commitSettledWaiters.set(openTimeMs, [resolve]);
      }
    });
  }

  /**
   * F1: Sole owner of per-pair commit ordering, for BOTH live and recovered candidates. At most one
   * commit is ever in flight; the next commit only starts once it is the strictly-ascending contiguous
   * successor of latestCanonicalOpenTimeMs. This guarantees 12:00's persistence/publication always
   * completes before 12:01's, regardless of origin, DB latency, or which candidate became ready first.
   */
  #drainCommitQueue(): void {
    if (this.#isStopped || this.#commitInFlight) return;

    let candidateOpenTimeMs: number | null = null;
    for (const t of this.#readyToCommit.keys()) {
      if (candidateOpenTimeMs === null || t < candidateOpenTimeMs) candidateOpenTimeMs = t;
    }
    if (candidateOpenTimeMs === null) return;

    const candidate = this.#readyToCommit.get(candidateOpenTimeMs);
    if (!candidate) {
      this.#resolveCommitSettled(candidateOpenTimeMs);
      this.#drainCommitQueue();
      return;
    }

    // F5: A blocking truth fault halts commits — EXCEPT that a REST_RECOVERY candidate is exactly what
    // may resolve an active RECOVERY_INCOMPLETE fault (that is the one fault kind recovery is defined
    // to be able to clear). Any other fault kind, or a RECOVERY_INCOMPLETE fault with a LIVE_FINALIZATION
    // candidate, still blocks everything. Without this exemption the very recovery retry meant to clear
    // RECOVERY_INCOMPLETE would deadlock behind its own fault.
    const canResolveOwnFault = this.#truthFault === 'RECOVERY_INCOMPLETE' && candidate.origin === 'REST_RECOVERY';
    if (this.#truthFault !== 'NONE' && !canResolveOwnFault) {
      // Permanently blocked while this fault remains: resolve every queued waiter so callers awaiting
      // settlement (e.g. recovery) don't hang forever; they recheck truthFault afterward and abort.
      for (const openTimeMs of this.#readyToCommit.keys()) {
        this.#resolveCommitSettled(openTimeMs);
      }
      return;
    }

    if (this.#latestCanonicalOpenTimeMs !== null && candidateOpenTimeMs <= this.#latestCanonicalOpenTimeMs) {
      // Already superseded/canonical (e.g. the live path or a prior recovery already committed this
      // minute); drop without re-persisting or re-publishing, and retry the next candidate.
      this.#readyToCommit.delete(candidateOpenTimeMs);
      this.#pendingFinalizations.delete(candidateOpenTimeMs);
      this.#resolveCommitSettled(candidateOpenTimeMs);
      this.#drainCommitQueue();
      return;
    }

    const expectedNext =
      this.#latestCanonicalOpenTimeMs === null ? candidateOpenTimeMs : this.#latestCanonicalOpenTimeMs + 60_000;
    if (candidateOpenTimeMs !== expectedNext) {
      // An earlier contiguous minute has not committed (or aborted) yet — regardless of ITS origin.
      // Later minutes must never leap across an unresolved continuity barrier.
      return;
    }

    this.#readyToCommit.delete(candidateOpenTimeMs);
    this.#commitInFlight = true;

    void this.#commitOne(candidate).finally(() => {
      this.#commitInFlight = false;
      this.#pendingFinalizations.delete(candidateOpenTimeMs);
      this.#resolveCommitSettled(candidateOpenTimeMs);
      this.#drainCommitQueue();
    });
  }

  /**
   * F1: Persists and publishes exactly one candle, live or recovered. Never called concurrently for
   * the same pair — #drainCommitQueue enforces single-flight ownership across both origins.
   */
  async #commitOne(candidate: CommitCandidate): Promise<void> {
    const { openTimeMs, token, origin } = candidate;
    if (!this.#isTokenValid(token, origin)) return;

    // F5: Mirrors #drainCommitQueue's fault exemption — a REST_RECOVERY candidate may proceed despite
    // an active RECOVERY_INCOMPLETE fault (the one fault kind recovery is defined to be able to clear).
    const canResolveOwnFault = this.#truthFault === 'RECOVERY_INCOMPLETE' && candidate.origin === 'REST_RECOVERY';
    if (this.#truthFault !== 'NONE' && !canResolveOwnFault) return;

    try {
      let canonical: CanonicalCandle1m;
      if (candidate.origin === 'REST_RECOVERY') {
        if (!candidate.prebuiltCandle) return;
        canonical = candidate.prebuiltCandle;
      } else {
        // LIVE_FINALIZATION: fetched lazily — a late-but-still-pending packet may have updated the
        // working snapshot after scheduling, so the value at actual commit time is authoritative.
        const working = this.#workingManager.get(this.#pair, openTimeMs);
        if (!working) return;

        // Construction (createCanonicalCandle1m) is deliberately INSIDE this try: a malformed working
        // snapshot (e.g. a structural OHLC violation) must fail closed exactly like a persistence
        // failure, not throw as an unhandled rejection out of #drainCommitQueue's void-fired call.
        canonical = createCanonicalCandle1m({
          pair: working.pair,
          openTimeMs: working.openTimeMs,
          open: working.open,
          high: working.high,
          low: working.low,
          close: working.close,
          volume: working.volume,
          quoteVolume: working.quoteVolume,
          source: 'WS_FINALIZED',
          finalizedAtMs: this.#clock.nowMs(),
          providerEventTimeMs: working.providerEventTimeMs,
          generationId: working.generationId,
        });
      }

      await this.#callbacks.onFinalizeCandle(canonical, token, origin);

      // Recheck token validity after await
      if (!this.#isTokenValid(token, origin)) {
        return;
      }

      // Monotonic watermark: never assign a lower/equal openTimeMs after a higher one.
      if (this.#latestCanonicalOpenTimeMs === null || canonical.openTimeMs > this.#latestCanonicalOpenTimeMs) {
        this.#latestCanonicalOpenTimeMs = canonical.openTimeMs;
        this.#continuityWatermarkMs = canonical.openTimeMs;
      }
      // F5: A successful commit for a REST_RECOVERY candidate is exactly what may clear a
      // RECOVERY_INCOMPLETE fault. Ordinary live packets never reach here while a fault is active
      // (#drainCommitQueue blocks LIVE_FINALIZATION candidates), so this can only ever be recovery
      // resolving its own previously-latched fault for the active epoch.
      if (this.#truthFault === 'RECOVERY_INCOMPLETE' && candidate.origin === 'REST_RECOVERY') {
        this.#truthFault = 'NONE';
      }
      // Clear any working-manager entry for this minute now that canonical truth is durable (covers
      // both a live working snapshot and a stale pre-gap working candle recovery just resolved).
      this.#workingManager.delete(this.#pair, openTimeMs);
    } catch {
      // Persistence failure fails closed (F5 & F16)
      this.#truthFault = 'PERSISTENCE_FAILURE';
      this.#state = 'DEGRADED';
    }
  }

  /**
   * F3/F4/RECOVERY-COMMIT-INTERLEAVE: canonicalEpoch (bumped by handleReconnectBarrier/stop — a full
   * trust reset) and generationId always gate validity for both origins. recoveryEpoch additionally
   * gates ONLY REST_RECOVERY candidates: it arbitrates between competing recovery operations (F4 — a
   * superseding recovery invalidates an older one) and is not meant to invalidate an already
   * in-flight/confirmed LIVE_FINALIZATION commit just because an unrelated later recovery (for a
   * different range) happened to begin while it was awaiting persistence. Without this distinction, a
   * live commit for an earlier minute could be silently dropped from the in-memory watermark (though
   * its row was validly written) the moment any later gap triggered recovery — even though recovery's
   * own range never covered that minute at all.
   */
  #isTokenValid(token: EpochToken, origin: CommitOrigin = 'REST_RECOVERY'): boolean {
    if (this.#isStopped) return false;
    if (token.canonicalEpoch !== this.#canonicalEpoch) return false;
    if (origin === 'REST_RECOVERY' && token.recoveryEpoch !== this.#recoveryEpoch) return false;
    if (token.generationId !== null && this.#currentGenerationId !== null && token.generationId !== this.#currentGenerationId) {
      return false;
    }
    return true;
  }

  /**
   * SOL-P5-004: historical verification must fail closed. A failed DB read (or a corrupt/unconvertible
   * persisted row) must never escape leaving HEALTHY/truthFault=NONE behind — that would let a future,
   * unrelated live packet publish while this pair's canonical truth for an earlier minute was never
   * actually verified. Both the read and the conversion/comparison are wrapped so any failure latches a
   * durable, fail-closed fault instead of throwing past this method.
   */
  async #handleLatePostFinalizationUpdate(payload: PublicCandleUpdatePayload): Promise<void> {
    let existing: CanonicalCandle1m | null;
    try {
      existing = await this.#callbacks.getPersistedCandle(payload.pair, payload.openTimeMs);
    } catch (err: unknown) {
      // A stop() may have landed on THIS instance while the read was in flight; a genuinely superseded
      // instance need not (and must not) still be mutating its own state after being torn down.
      if (this.#isStopped) return;
      this.#truthFault = 'PERSISTENCE_FAILURE';
      this.#state = 'DEGRADED';
      this.#callbacks.onConflictDetected(
        this.#pair,
        `Failed to verify historical canonical truth for ${payload.pair} at ${payload.openTimeMs}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }

    if (this.#isStopped) return;

    if (!existing) {
      this.#truthFault = 'CANONICAL_CONFLICT';
      this.#state = 'DEGRADED';
      this.#callbacks.onConflictDetected(
        this.#pair,
        `Post-finalization update for ${payload.pair} at ${payload.openTimeMs} not found in database`
      );
      return;
    }

    try {
      const payloadOpen = CanonicalDecimal.from(payload.open);
      const payloadHigh = CanonicalDecimal.from(payload.high);
      const payloadLow = CanonicalDecimal.from(payload.low);
      const payloadClose = CanonicalDecimal.from(payload.close);
      const payloadVolume = CanonicalDecimal.from(payload.volume);
      const payloadQuoteVolume = CanonicalDecimal.fromNullable(payload.quoteVolume);

      // F7: Full equality check including quoteVolume with null !== Decimal(0)
      const quoteEqual =
        (existing.quoteVolume === null && payloadQuoteVolume === null) ||
        (existing.quoteVolume !== null && payloadQuoteVolume !== null && existing.quoteVolume.equals(payloadQuoteVolume));

      const isMatch =
        existing.open.equals(payloadOpen) &&
        existing.high.equals(payloadHigh) &&
        existing.low.equals(payloadLow) &&
        existing.close.equals(payloadClose) &&
        existing.volume.equals(payloadVolume) &&
        quoteEqual;

      if (isMatch) {
        this.#duplicateCount++;
        return;
      }

      // Material disagreement with persisted canonical truth: CANONICAL_CONFLICT (F5 & F15)
      this.#truthFault = 'CANONICAL_CONFLICT';
      this.#state = 'DEGRADED';
      this.#callbacks.onConflictDetected(
        this.#pair,
        `Material conflict detected for ${this.#pair} at ${payload.openTimeMs}: incoming live update disagrees with persisted canonical truth`
      );
    } catch (err: unknown) {
      // Conversion/corruption failure while comparing against durable truth: fail closed too, rather
      // than letting a malformed payload or persisted row throw past this method unnoticed.
      if (this.#isStopped) return;
      this.#truthFault = 'CANONICAL_CONFLICT';
      this.#state = 'DEGRADED';
      this.#callbacks.onConflictDetected(
        this.#pair,
        `Failed to convert/compare historical canonical candidate for ${payload.pair} at ${payload.openTimeMs}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Applies recovered REST candles and drains buffered envelopes (F3, F4, F10).
   * Only the ACTIVE recoveryEpoch may execute.
   *
   * RECOVERY-COMMIT-INTERLEAVE fix: every recovered candle is routed through the SAME unified per-pair
   * commit queue used for live finalization (#enqueueCommitCandidate / #drainCommitQueue) instead of
   * being persisted directly. This is what guarantees recovery can never persist/publish a later minute
   * while an earlier commit (live OR recovery) for this pair is still in flight or unresolved, and never
   * races a competing insert for a minute another origin already owns. We wait for every candidate to
   * fully settle (commit, get dropped as already-superseded, or become permanently fault-blocked) before
   * deciding recovery's own outcome.
   */
  public async applyRecoveredCandlesAndDrainBuffer(
    recoveredCandles: readonly CanonicalCandle1m[],
    activeRecoveryEpoch?: number
  ): Promise<void> {
    if (this.#isStopped) return;

    const epoch = activeRecoveryEpoch ?? this.#recoveryEpoch;
    // F4: Single-owner recovery: superseded recovery epoch becomes inert
    if (epoch !== this.#recoveryEpoch) {
      return;
    }

    const token: EpochToken = {
      canonicalEpoch: this.#canonicalEpoch,
      recoveryEpoch: this.#recoveryEpoch,
      generationId: this.#currentGenerationId,
    };

    // 1. Enqueue every recovered candle into the unified ordered commit queue and wait for the whole
    //    batch to settle. Actual persistence order (and thus publication order) is enforced by
    //    #drainCommitQueue's strictly-ascending-contiguous rule, not by this loop.
    const settleWaiters: Promise<void>[] = [];
    for (const candle of recoveredCandles) {
      settleWaiters.push(this.#awaitCommitSettled(candle.openTimeMs));
      this.#enqueueCommitCandidate({
        openTimeMs: candle.openTimeMs,
        origin: 'REST_RECOVERY',
        token,
        prebuiltCandle: candle,
      });
    }
    await Promise.all(settleWaiters);

    // Recheck epoch/fault after the batch settles: a superseding recovery, reconnect barrier, or new
    // fault (e.g. an earlier in-flight commit that ultimately failed persistence) may have arrived while
    // candidates were waiting behind an unresolved predecessor.
    if (!this.#isTokenValid(token)) {
      return;
    }
    if (this.#truthFault !== 'NONE') {
      return;
    }

    // 2. Drain buffered live updates in deterministic chronological order
    const buffered = [...this.#recoveryBuffer].sort((a, b) => {
      if (a.openTimeMs !== b.openTimeMs) return a.openTimeMs - b.openTimeMs;
      if (a.providerEventTimeMs !== b.providerEventTimeMs) return a.providerEventTimeMs - b.providerEventTimeMs;
      if (a.sequence !== b.sequence) return a.sequence - b.sequence;
      return a.receivedAtMs - b.receivedAtMs;
    });

    this.#recoveryBuffer.length = 0;

    // truthFault is guaranteed 'NONE' here (checked above; #commitOne already cleared a
    // RECOVERY_INCOMPLETE fault per-candidate as this batch settled), so it is now safe to leave
    // RECOVERING and resume normal live processing.
    this.#state = 'HEALTHY';

    for (const item of buffered) {
      if (this.#isStopped) return;
      // Stale generation entries dropped before drain (F10)
      if (this.#currentGenerationId !== null && item.generationId < this.#currentGenerationId) {
        this.#lateDropCount++;
        continue;
      }
      await this.handleStreamEnvelope(item.envelope);
    }
  }

  #scheduleStaleCheck(): void {
    this.#scheduleStaleCheckWithDelay(this.#staleThresholdMs);
  }

  #scheduleStaleCheckWithDelay(delayMs: number): void {
    if (this.#staleCheckTimer !== null) {
      this.#scheduler.clearTimeout(this.#staleCheckTimer);
      this.#staleCheckTimer = null;
    }

    if (this.#isStopped) return;

    this.#staleCheckTimer = this.#scheduler.setTimeout(() => {
      if (this.#isStopped) return;

      const checkNow = this.#clock.nowMs();
      const elapsed = this.#lastValidReceivedAtMs !== null ? checkNow - this.#lastValidReceivedAtMs : this.#staleThresholdMs;

      if (elapsed >= this.#staleThresholdMs) {
        if (this.#truthFault === 'NONE' && this.#state === 'HEALTHY') {
          this.#state = 'STALE';
          this.#callbacks.onStaleDetected?.(this.#pair);
        }
        // Re-arm for subsequent checks
        this.#scheduleStaleCheckWithDelay(this.#staleThresholdMs);
      } else {
        // Still fresh (activity occurred shortly before check): re-arm for remaining duration
        const remaining = this.#staleThresholdMs - elapsed;
        this.#scheduleStaleCheckWithDelay(Math.max(1, remaining));
      }
    }, delayMs);
  }

  #clearAllPendingFinalizations(): void {
    for (const pending of this.#pendingFinalizations.values()) {
      this.#scheduler.clearTimeout(pending.timerId);
    }
    this.#pendingFinalizations.clear();
    // A new recovery/reconnect epoch is superseding whatever was queued: resolve waiters for anything
    // still sitting in the queue so a caller awaiting settlement (e.g. a prior recovery batch) never
    // hangs forever waiting on candidates that are now being wiped out from under it.
    for (const openTimeMs of this.#readyToCommit.keys()) {
      this.#resolveCommitSettled(openTimeMs);
    }
    this.#readyToCommit.clear();
  }

  #clearStaleTimer(): void {
    if (this.#staleCheckTimer !== null) {
      this.#scheduler.clearTimeout(this.#staleCheckTimer);
      this.#staleCheckTimer = null;
    }
  }

  public stop(): void {
    this.#isStopped = true;
    this.#canonicalEpoch++;
    this.#recoveryEpoch++;
    this.#clearAllPendingFinalizations();
    this.#clearStaleTimer();
    this.#workingManager.clear(this.#pair);
    this.#recoveryBuffer.length = 0;
  }
}
