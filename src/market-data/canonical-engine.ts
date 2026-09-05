import { Clock, SystemClock } from '../integration/coindcx/clock';
import { CoinDcxPublicFuturesStream, StreamScheduler, SystemStreamScheduler } from '../integration/coindcx/websocket/public-stream';
import {
  CoinDcxStreamEnvelope,
  PublicCandleUpdatePayload,
  PublicRecoveryRequiredPayload,
} from '../integration/coindcx/websocket/types';
import { createChildLogger } from '../monitoring/logger';
import { CanonicalRecoveryError } from './errors';
import { createCanonicalCandle1m } from './models';
import { PairPersistenceCoordinator } from './pair-persistence-coordinator';
import { CommitOrigin, EpochToken, PairCanonicalStateMachine, PairStateCallbacks } from './pair-state';
import { Candle1mRepository, PrismaCandle1mRepository } from './persistence/candle-repository';
import { CoinDcxFuturesCandleRestReader } from './rest-candle-reader';
import {
  CanonicalCandle1m,
  CanonicalEventListener,
  CanonicalEventType,
  CanonicalHealthSnapshot,
  CanonicalStreamEvent,
} from './types';

const logger = createChildLogger('market-data:canonical-engine');

export type EngineLifecycleState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING';

/**
 * Tracks a single in-flight initializePair() attempt, scoped to the engine run that started it
 * (RESTART-INITIALIZATION-RACE fix). See CanonicalMarketDataEngine#initializePair.
 */
interface PairInitializationAttempt {
  readonly runId: number;
  readonly promise: Promise<PairCanonicalStateMachine>;
}

/**
 * Tracks a single in-flight start() operation, scoped to the run it belongs to (SOL-P5-005). See
 * CanonicalMarketDataEngine#start.
 */
interface StartOperation {
  readonly runId: number;
  readonly promise: Promise<void>;
}

export interface CanonicalMarketDataEngineConfig {
  readonly repository?: Candle1mRepository | undefined;
  readonly restReader?: CoinDcxFuturesCandleRestReader | undefined;
  readonly clock?: Clock | undefined;
  readonly scheduler?: StreamScheduler | undefined;
  readonly finalizationGraceMs?: number | undefined;
  readonly maxFutureSkewMs?: number | undefined;
  readonly maxRecoveryBuffer?: number | undefined;
  readonly publicStream?: CoinDcxPublicFuturesStream | undefined;
}

/**
 * Phase 5 Canonical 1-Minute Market Data Engine.
 * Invariants:
 * - F11: Explicit lifecycle (STOPPED, STARTING, RUNNING, STOPPING). start() is single-flight and
 *   restart-safe: start() -> stop() -> start() is a supported sequence (see start() docstring).
 * - F1: Per-pair commit ordering is owned by PairCanonicalStateMachine's drain queue; this engine's
 *   onFinalizeCandle callback is the atomic persist+publish unit that queue serializes.
 * - F2: Gap recovery ranges include any orphaned pre-gap working candle (owned by PairCanonicalStateMachine).
 * - F3/F4: Monotonic epoch validation and single-flight recovery ownership.
 * - F4: Duplicate DB inserts (ALREADY_IDENTICAL) suppress duplicate CANONICAL_1M_CLOSED publication.
 * - F5/F15/F16: Fail-closed truth fault latch for conflicts, persistence failures, and incomplete/failed
 *   REST recovery (RECOVERY_INCOMPLETE, latched via pairState.latchRecoveryFault).
 * - RESTART-EPOCH-REUSE: every pair state machine is permanently bound to the #currentRunId active when
 *   it was created, AND every onFinalizeCandle callback closes over the exact state-machine instance it
 *   was registered for. A stop()/start() cycle always creates brand-new state machine instances (with
 *   epoch counters reset to their defaults), so a stale callback from a prior run cannot be mistaken for
 *   a legitimate current one just because a same-named pair's fresh instance happens to have matching
 *   epoch values — the callback is rejected unless BOTH the run id still matches AND the pair's active
 *   state machine is the exact instance the callback belongs to.
 * - RESTART-INITIALIZATION-RACE: initializePair() itself is async (it awaits
 *   repository.getLatestCanonicalCandle) and is guarded the same way. Ownership (run id) is captured
 *   BEFORE that await; immediately after it resolves, and again immediately before installing anything
 *   into #pairStates, ownership is revalidated. A stale initialization from a superseded run can never
 *   construct/install a state machine or overwrite a newer run's already-installed instance for the same
 *   pair. #pairInitializations gives per-pair, per-run single-flight: concurrent initializePair() calls
 *   for the same pair within the SAME run share one DB read and one installation; a stale attempt from an
 *   old run can never be joined by a new run's call.
 * - CROSS-RUN SAFETY (SOL-P5-001..005): one coherent lifecycle model, not five local patches. Every
 *   async operation that originates from a run (handleStreamEnvelope dispatch, initializePair,
 *   onFinalizeCandle, executeRecovery, start) captures its run ownership BEFORE its first await and
 *   revalidates it after every subsequent await, before doing anything observable (state-machine
 *   invocation, #pairStates mutation, health/fault mutation, event emission). Concretely:
 *   - #persistenceCoordinator (PairPersistenceCoordinator) is an ENGINE-LEVEL, per-pair physical write
 *     barrier that survives state-machine replacement and run boundaries (SOL-P5-001/2A). ALL physical
 *     repository.insertCandle calls, from any run/origin, are serialized through it — the pair-state
 *     queue alone only serializes within one instance's lifetime, which is not enough across a restart.
 *     A new run's initializePair() awaits the coordinator's settlement for that pair BEFORE reading the
 *     durable baseline (2B), and fails closed (latches PERSISTENCE_FAILURE) rather than treating a
 *     resolved-but-failed predecessor write as an innocent cold start (2C).
 *   - handleStreamEnvelope captures dispatchRunId at entry and re-validates it (not merely !#isStopped,
 *     which a restart resets) after the initializePair() await before ever invoking the returned state
 *     machine (SOL-P5-002).
 *   - executeRecovery captures runId + the exact originating PairCanonicalStateMachine identity +
 *     recoveryEpoch before its REST await, and revalidates all three before every success AND error
 *     action (persist, fault latch, event emission) — a stale run's rejection can no longer emit
 *     CANONICAL_1M_INVALID into a newer run (SOL-P5-003).
 *   - start() tracks its own StartOperation tagged with a runId; a stale operation object surviving past
 *     its own (deferred) cleanup can never be handed back as authoritative once stop() has moved the
 *     engine to a new run (SOL-P5-005).
 * - Section 17: Safe event dispatch isolating engine state from subscriber failures.
 */
export class CanonicalMarketDataEngine {
  readonly #repository: Candle1mRepository;
  readonly #restReader: CoinDcxFuturesCandleRestReader;
  readonly #clock: Clock;
  readonly #scheduler: StreamScheduler;
  readonly #finalizationGraceMs: number;
  readonly #maxFutureSkewMs: number;
  readonly #maxRecoveryBuffer: number;
  readonly #publicStream?: CoinDcxPublicFuturesStream | undefined;

  readonly #pairStates = new Map<string, PairCanonicalStateMachine>();
  // RESTART-INITIALIZATION-RACE: in-flight initializePair() attempts, keyed by pair. Each entry is
  // tagged with the runId that started it, so a stale attempt from a superseded run is never reused by
  // (or allowed to clobber) a newer run's initialization for the same pair.
  readonly #pairInitializations = new Map<string, PairInitializationAttempt>();
  // SOL-P5-001/2A: engine-level, per-pair physical persistence barrier. Constructed once and NEVER
  // reset by stop() — its entire purpose is to survive state-machine replacement and run boundaries.
  readonly #persistenceCoordinator = new PairPersistenceCoordinator();
  readonly #subscribers = new Set<CanonicalEventListener>();
  #streamUnsubscribe: (() => void) | null = null;
  #lifecycleState: EngineLifecycleState = 'STOPPED';
  // SOL-P5-005: the currently-tracked start() operation, if any is in flight or was the last one to
  // complete before its own (deferred) cleanup ran. Reused only if it still belongs to the ACTIVE run.
  #startOperation: StartOperation | null = null;
  #isStopped = false;
  // RESTART-EPOCH-REUSE: bumped every time stop() ends a run, so anything created afterward (whether
  // via a following start() or a direct initializePair() call) is unambiguously tagged as belonging to
  // a new run.
  #currentRunId = 1;

  constructor(config: CanonicalMarketDataEngineConfig = {}) {
    this.#repository = config.repository ?? new PrismaCandle1mRepository();
    this.#restReader =
      config.restReader ??
      new CoinDcxFuturesCandleRestReader(config.clock !== undefined ? { clock: config.clock } : {});
    this.#clock = config.clock ?? new SystemClock();
    this.#scheduler = config.scheduler ?? SystemStreamScheduler;
    this.#finalizationGraceMs = config.finalizationGraceMs ?? 1000;
    this.#maxFutureSkewMs = config.maxFutureSkewMs ?? 5000;
    this.#maxRecoveryBuffer = config.maxRecoveryBuffer ?? 100;
    this.#publicStream = config.publicStream;
  }

  public get lifecycleState(): EngineLifecycleState {
    return this.#lifecycleState;
  }

  /**
   * RESTART-INITIALIZATION-RACE: single-flight, per-pair, per-run pair initialization.
   *
   * initializePair() is asynchronous — it awaits repository.getLatestCanonicalCandle(pair) — so between
   * the moment ownership is captured and the moment that await resolves, the engine may have been
   * stop()/start()-cycled into an entirely new run. Ownership (the engine's #currentRunId at the moment
   * this attempt began) is captured BEFORE that await, in #createPairStateMachine, and is revalidated
   * immediately after the await resolves, before anything is constructed or installed. A stale attempt:
   * - never constructs a PairCanonicalStateMachine or registers its callbacks,
   * - never calls #pairStates.set (never overwrites a newer run's already-installed instance),
   * - resolves to whatever the CURRENT run has already installed for that pair, if anything exists yet.
   *
   * #pairInitializations provides single-flight ownership scoped to (pair, runId): concurrent
   * initializePair(pair) calls within the SAME run share one in-flight promise (one DB read, one
   * installation). An in-flight attempt tagged with an OLD runId is never reused/joined by a call made
   * under a newer run — a fresh attempt is always started instead.
   */
  public async initializePair(pair: string): Promise<PairCanonicalStateMachine> {
    const existing = this.#pairStates.get(pair);
    if (existing) {
      return existing;
    }

    const runId = this.#currentRunId;

    const inFlight = this.#pairInitializations.get(pair);
    if (inFlight && inFlight.runId === runId) {
      return inFlight.promise;
    }

    const promise = this.#createPairStateMachine(pair, runId);
    this.#pairInitializations.set(pair, { runId, promise });

    try {
      return await promise;
    } finally {
      // Only remove the entry if it still belongs to THIS attempt — a newer attempt (different run, or
      // a fresh retry after this one turned out stale) may already have replaced it.
      const tracked = this.#pairInitializations.get(pair);
      if (tracked && tracked.promise === promise) {
        this.#pairInitializations.delete(pair);
      }
    }
  }

  /**
   * Performs the actual DB read + construction + installation for one initializePair() attempt, bound
   * to the runId captured by its caller before any await. See initializePair() for the full contract.
   */
  async #createPairStateMachine(pair: string, runId: number): Promise<PairCanonicalStateMachine> {
    // SOL-P5-001/2B: wait for any prior-run (or same-run) in-flight PHYSICAL canonical write for this
    // pair to settle BEFORE establishing the durable baseline. Reading getLatestCanonicalCandle while a
    // predecessor's insert is still unresolved could observe a null/stale baseline and accept a later
    // minute as if it were the very first, when the true first minute is about to land moments later —
    // out of order.
    const priorPersistence = await this.#persistenceCoordinator.awaitSettled(pair);

    // RESTART-INITIALIZATION-RACE: revalidate ownership after this (now two-part) async gap. A
    // superseded attempt must never construct/install a state machine of its own.
    if (runId !== this.#currentRunId) {
      const currentInstance = this.#pairStates.get(pair);
      if (currentInstance) {
        return currentInstance;
      }
      throw new CanonicalRecoveryError(
        `Pair initialization for ${pair} was superseded by an engine restart before it could complete`
      );
    }

    // Load latest persisted candle from database to establish restart baseline (F2 & F19)
    const latestDbCandle = await this.#repository.getLatestCanonicalCandle(pair);

    // RESTART-INITIALIZATION-RACE: revalidate ownership immediately after this await too.
    if (runId !== this.#currentRunId) {
      const currentInstance = this.#pairStates.get(pair);
      if (currentInstance) {
        // A newer run already installed its own instance for this pair while this attempt was stale;
        // hand that back rather than fabricating or installing anything of our own.
        return currentInstance;
      }
      throw new CanonicalRecoveryError(
        `Pair initialization for ${pair} was superseded by an engine restart before it could complete`
      );
    }

    const callbacks: PairStateCallbacks = {
      onFinalizeCandle: async (candle: CanonicalCandle1m, token?: EpochToken, origin?: CommitOrigin) => {
        // SOL-P5-001: persist before publish (F4 & F16), but the PHYSICAL write is serialized through
        // the engine-level, cross-run persistence coordinator, not called directly. This is the ONLY
        // path that may invoke repository.insertCandle — it is what guarantees a pair's physical writes
        // stay strictly ordered across a stop()/start() boundary, not merely within one state-machine
        // instance's own (intra-run) commit queue.
        const res = await this.#persistenceCoordinator.enqueueWrite(candle.pair, () =>
          this.#repository.insertCandle(candle)
        );

        // RESTART-EPOCH-REUSE: reject unless this callback still belongs to the CURRENT engine run AND
        // the pair's active state machine is the EXACT instance this callback was registered for. A
        // stop()/start() cycle always creates a brand-new instance (even for the same pair, with epoch
        // counters reset to their defaults) — so identity, not reusable epoch values alone, is what
        // proves ownership across a restart boundary.
        if (runId !== this.#currentRunId) return;
        const sm = this.#pairStates.get(candle.pair);
        if (sm !== stateMachine) return;
        if (token) {
          if (token.canonicalEpoch !== sm.canonicalEpoch) return;
          // RECOVERY-COMMIT-INTERLEAVE: mirrors PairCanonicalStateMachine's #isTokenValid — recoveryEpoch
          // only gates REST_RECOVERY candidates (arbitrating between competing recovery operations, F4).
          // A LIVE_FINALIZATION candidate that was already in-flight must not be dropped here just
          // because an unrelated later recovery bumped recoveryEpoch while this insert was pending.
          if (origin === 'REST_RECOVERY' && token.recoveryEpoch !== sm.recoveryEpoch) return;
        }

        // F4: Only emit if newly inserted; idempotent identical row does not duplicate close event
        if (res.outcome === 'INSERTED') {
          this.#emitEvent('CANONICAL_1M_CLOSED', candle.pair, candle);
        }
      },
      onRequestRecovery: async (reqPair: string, fromMs: number, toMs: number, recoveryEpoch?: number) => {
        await this.executeRecovery(reqPair, fromMs, toMs, recoveryEpoch);
      },
      onConflictDetected: (conflictPair: string, msg: string) => {
        logger.error({ pair: conflictPair, msg }, 'Canonical candle conflict detected');
        this.#emitEvent('CANONICAL_1M_INVALID', conflictPair, { reason: msg });
      },
      onStaleDetected: (stalePair: string) => {
        logger.warn({ pair: stalePair }, 'Pair canonical stream became stale');
        this.#emitEvent('CANONICAL_1M_STALE', stalePair, { staleAtMs: this.#clock.nowMs() });
      },
      getPersistedCandle: async (p: string, openTimeMs: number) => {
        return this.#repository.getCandle(p, openTimeMs);
      },
    };

    // Declared with `const` after `callbacks`: the closure inside callbacks.onFinalizeCandle resolves
    // `stateMachine` by scope lookup at CALL time, not at closure-creation time, and it is only ever
    // invoked later (asynchronously, via #commitOne) — well after this declaration has executed.
    const stateMachine = new PairCanonicalStateMachine(
      {
        pair,
        clock: this.#clock,
        scheduler: this.#scheduler,
        finalizationGraceMs: this.#finalizationGraceMs,
        maxFutureSkewMs: this.#maxFutureSkewMs,
        maxRecoveryBuffer: this.#maxRecoveryBuffer,
      },
      callbacks
    );

    if (latestDbCandle) {
      stateMachine.initializeLatestCanonical(latestDbCandle.openTimeMs);
    }

    // SOL-P5-001/2C: a prior-run write for this pair that RESOLVED AS A FAILURE must never be treated
    // as an innocent cold start just because stop()/start() occurred. Latch a durable, fail-closed fault
    // on this brand-new instance immediately — before it ever processes a single packet — so no later
    // minute can leap over the unresolved predecessor until persistence/recovery truth is explicitly
    // reconciled. (A prior write that simply SETTLED — succeeded, or nothing was ever attempted — needs
    // no special handling here: the baseline just read above already reflects it correctly.)
    if (priorPersistence.kind === 'FAILED') {
      stateMachine.latchRecoveryFault('PERSISTENCE_FAILURE', stateMachine.recoveryEpoch);
    }

    // Final revalidation immediately before installation. Nothing async happens between the guard above
    // and here today, but this checkpoint is deliberately explicit and independent so that this
    // invariant — never install a superseded run's state machine — holds even if a future change adds
    // another await in between.
    if (runId !== this.#currentRunId) {
      const currentInstance = this.#pairStates.get(pair);
      if (currentInstance) {
        return currentInstance;
      }
      throw new CanonicalRecoveryError(
        `Pair initialization for ${pair} was superseded by an engine restart before it could complete`
      );
    }

    this.#pairStates.set(pair, stateMachine);
    return stateMachine;
  }

  /**
   * F11 Lifecycle & Restart Contract (explicit restart SUPPORTED):
   * start() -> stop() -> start() is a safe, supported sequence. stop() is a terminal reset for the
   * current run only — it tears down the stream subscription, stops and discards every pair state
   * machine, and clears subscribers, but does not make the engine permanently inert. A following
   * start() resets the internal stop latch, installs a fresh subscription, and pair state machines are
   * lazily re-created via initializePair()/on the next stream envelope, re-establishing their warm
   * restart baseline from the repository. start() is single-flight: any callers made while a start() is
   * already in flight (STARTING) share that same in-flight result and never register more than one
   * underlying stream subscription; once RUNNING, further calls resolve immediately as no-ops. stop()
   * is idempotent.
   *
   * SOL-P5-005: the in-flight/last operation is tracked as a #startOperation tagged with the runId it
   * started under, not just a bare Promise reference. A stop() bumps #currentRunId, so an operation
   * object surviving past its own (deferred) `.finally()` cleanup is never reused as authoritative for a
   * later run — reuse requires BOTH lifecycle STARTING AND a matching runId. The async body itself also
   * re-checks its own runId before flipping lifecycle to RUNNING, so a stop() landing mid-flight can
   * never have a stale start silently report success while the engine is actually stopped with no
   * listener.
   */
  public start(): Promise<void> {
    if (this.#lifecycleState === 'RUNNING') {
      return Promise.resolve();
    }

    if (this.#startOperation && this.#startOperation.runId === this.#currentRunId && this.#lifecycleState === 'STARTING') {
      return this.#startOperation.promise;
    }

    const runId = this.#currentRunId;
    this.#lifecycleState = 'STARTING';
    this.#isStopped = false; // reset the terminal stop latch so a restart is not permanently inert

    const promise = (async () => {
      if (this.#publicStream && this.#streamUnsubscribe === null) {
        this.#streamUnsubscribe = this.#publicStream.subscribe((envelope) => {
          this.handleStreamEnvelope(envelope).catch((err: unknown) => {
            logger.error({ err }, 'Unhandled error processing stream envelope in canonical engine');
          });
        });
      }
      // Only this run's own start operation may flip lifecycle to RUNNING -- a stop() that bumped
      // #currentRunId while this was (hypothetically) still in flight must leave lifecycle exactly as
      // stop() set it.
      if (runId === this.#currentRunId) {
        this.#lifecycleState = 'RUNNING';
      }
    })();

    const operation: StartOperation = { runId, promise };
    this.#startOperation = operation;

    promise
      .finally(() => {
        // Only clear if this operation is still the tracked one -- a newer start() (different runId)
        // may already have replaced it, and an old operation's cleanup must never clear a newer one's.
        if (this.#startOperation === operation) {
          this.#startOperation = null;
        }
      })
      .catch(() => {
        // The tracking chain itself must never surface as an unhandled rejection; callers observe the
        // original `promise` returned below, not this bookkeeping chain.
      });

    return promise;
  }

  public subscribe(listener: CanonicalEventListener): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  public getPairHealth(pair: string): CanonicalHealthSnapshot | undefined {
    return this.#pairStates.get(pair)?.getHealthSnapshot();
  }

  public getAllPairHealth(): readonly CanonicalHealthSnapshot[] {
    return Array.from(this.#pairStates.values()).map((s) => s.getHealthSnapshot());
  }

  /**
   * Dispatches envelopes received from Phase 4 public stream.
   *
   * SOL-P5-002: captures dispatchRunId at entry, BEFORE any await. The PUBLIC_CANDLE_UPDATE path awaits
   * initializePair() — possibly a long wait — so after it resolves, `!#isStopped` alone is NOT enough to
   * detect staleness: a stop()/start() cycle resets #isStopped back to false for the NEW run. Only a
   * dispatchRunId match proves this dispatch still belongs to the run that is currently active; a stale
   * dispatch is dropped inertly rather than being allowed to invoke whatever state machine
   * initializePair() happens to hand back (which, per its own stale-result contract, would be the newer
   * run's instance — authorizing a stale envelope to mutate it is exactly what must never happen).
   */
  public async handleStreamEnvelope(envelope: CoinDcxStreamEnvelope<unknown>): Promise<void> {
    const dispatchRunId = this.#currentRunId;
    if (this.#isStopped) {
      return;
    }

    if (envelope.eventType === 'PUBLIC_STREAM_RECOVERY_REQUIRED') {
      const payload = envelope.payload as PublicRecoveryRequiredPayload;
      // Reconnect barrier: notify all pairs
      for (const [pair, pairState] of this.#pairStates.entries()) {
        pairState.handleReconnectBarrier(payload.newGeneration);
        this.#emitEvent('CANONICAL_1M_RECOVERY_REQUIRED', pair, {
          previousGeneration: payload.previousGeneration,
          newGeneration: payload.newGeneration,
        });

        const latestTime = pairState.latestCanonicalOpenTimeMs;
        if (latestTime !== null) {
          const nowMs = this.#clock.nowMs();
          const latestClosedMinuteMs = Math.floor(nowMs / 60_000) * 60_000 - 60_000;
          if (latestTime + 60_000 <= latestClosedMinuteMs) {
            const recoveryEpoch = pairState.recoveryEpoch;
            this.executeRecovery(pair, latestTime + 60_000, latestClosedMinuteMs, recoveryEpoch).catch(() => {});
          }
        }
      }
      return;
    }

    if (envelope.eventType === 'PUBLIC_CANDLE_UPDATE') {
      const candleEnvelope = envelope as CoinDcxStreamEnvelope<PublicCandleUpdatePayload>;
      const payload = candleEnvelope.payload;
      let stateMachine = this.#pairStates.get(payload.pair);
      if (!stateMachine) {
        try {
          stateMachine = await this.initializePair(payload.pair);
        } catch (err: unknown) {
          // RESTART-INITIALIZATION-RACE: initialization can be superseded by a restart mid-flight with
          // no current-run instance yet installed to fall back to. Treat that as an inert no-op for this
          // envelope rather than propagating — the caller's own context is stale/stopped anyway.
          logger.warn({ err, pair: payload.pair }, 'Pair initialization was superseded; dropping envelope');
          return;
        }
      }

      // SOL-P5-002: re-validate the ORIGINATING dispatch's run is still active — not merely
      // `!#isStopped`, which a stop()->start() cycle resets for the new run. A stop() may have landed
      // (with or without a subsequent restart) while this envelope was waiting on initializePair().
      if (dispatchRunId !== this.#currentRunId) {
        logger.debug({ pair: payload.pair }, 'Dropping envelope: dispatch run was superseded by a restart');
        return;
      }

      // Exact state-machine identity: the instance about to be invoked must still be the one CURRENTLY
      // installed for this pair (defense-in-depth alongside the runId check above).
      if (this.#pairStates.get(payload.pair) !== stateMachine) {
        return;
      }

      await stateMachine.handleStreamEnvelope(candleEnvelope);
    }
  }

  /**
   * Executes REST gap recovery for a specific pair and requested range (F4).
   * Recovery is bound to activeRecoveryEpoch; superseded recoveries become inert.
   *
   * SOL-P5-003: captures runId + the exact originating PairCanonicalStateMachine identity + recoveryEpoch
   * BEFORE the network await. After the REST await (success OR rejection) and before EVERY subsequent
   * action — persisting, latching/clearing a fault, emitting ANY event — `isStillAuthoritative()`
   * re-validates all three. A stale run's REST rejection (e.g. arriving after stop()/start() moved the
   * engine to a new run) can therefore never latch a fault onto, drain the buffer of, or emit
   * CANONICAL_1M_INVALID / CANONICAL_1M_RECOVERY_COMPLETED into a newer run's pair state.
   */
  public async executeRecovery(
    pair: string,
    fromMs: number,
    toMs: number,
    recoveryEpoch?: number
  ): Promise<void> {
    const runId = this.#currentRunId;
    const pairState = this.#pairStates.get(pair);
    if (!pairState || this.#isStopped) {
      return;
    }

    const activeEpoch = recoveryEpoch ?? pairState.enterRecovery();

    // Is this recovery attempt still the authoritative one to act for the CURRENT engine run?
    const isStillAuthoritative = (): boolean =>
      runId === this.#currentRunId &&
      this.#pairStates.get(pair) === pairState &&
      pairState.recoveryEpoch === activeEpoch;

    if (!isStillAuthoritative()) {
      return;
    }

    try {
      this.#emitEvent('CANONICAL_1M_RECOVERY_REQUIRED', pair, { fromMs, toMs, recoveryEpoch: activeEpoch });

      const rawRecords = await this.#restReader.fetchClosedCandles({ pair, fromMs, toMs });

      // Revalidate after the network await (F3 & F4, extended to run + identity ownership).
      if (!isStillAuthoritative()) {
        return;
      }

      // Verify exact continuous minute-by-minute coverage
      const expectedMinutes = Math.floor((toMs - fromMs) / 60_000) + 1;
      const coverageMap = new Map<number, (typeof rawRecords)[0]>();
      for (const r of rawRecords) {
        coverageMap.set(r.openTimeMs, r);
      }

      let isCompleteCoverage = true;
      const canonicalRecovered: CanonicalCandle1m[] = [];

      for (let t = fromMs; t <= toMs; t += 60_000) {
        const record = coverageMap.get(t);
        if (!record) {
          isCompleteCoverage = false;
          break;
        }

        canonicalRecovered.push(
          createCanonicalCandle1m({
            pair: record.pair,
            openTimeMs: record.openTimeMs,
            open: record.open,
            high: record.high,
            low: record.low,
            close: record.close,
            volume: record.volume,
            quoteVolume: record.quoteVolume,
            source: 'REST_RECOVERY',
            finalizedAtMs: this.#clock.nowMs(),
            providerEventTimeMs: null,
            generationId: pairState.getHealthSnapshot().currentGenerationId,
          })
        );
      }

      if (!isCompleteCoverage || canonicalRecovered.length < expectedMinutes) {
        if (!isStillAuthoritative()) {
          return;
        }
        // F5: Incomplete coverage from REST latches a durable RECOVERY_INCOMPLETE fault. Remaining in
        // RECOVERING state alone is not enough — the fault must be explicit and fail-closed so that
        // ordinary live packets arriving later cannot silently mask the unresolved gap.
        logger.warn(
          { pair, fromMs, toMs, expected: expectedMinutes, received: canonicalRecovered.length },
          'REST recovery returned incomplete minute coverage; latching durable RECOVERY_INCOMPLETE fault'
        );
        pairState.latchRecoveryFault('RECOVERY_INCOMPLETE', activeEpoch);
        this.#emitEvent('CANONICAL_1M_INVALID', pair, {
          reason: 'RECOVERY_INCOMPLETE',
          fromMs,
          toMs,
          recoveryEpoch: activeEpoch,
        });
        return;
      }

      // Complete continuous coverage verified: apply and drain. This routes every recovered candle
      // through the pair's unified ordered commit queue, so it will not actually persist/publish
      // anything until any earlier in-flight commit (live or recovery) for this pair has settled.
      await pairState.applyRecoveredCandlesAndDrainBuffer(canonicalRecovered, activeEpoch);

      // Revalidate again after this second await: if an earlier required minute failed to persist (B4),
      // the unified queue blocks this batch behind that fault and applyRecoveredCandlesAndDrainBuffer
      // returns without actually committing anything even though recoveryEpoch itself is unchanged —
      // emitting completion in that case would be a false signal. A run/identity change here also means
      // this recovery must stay silent regardless of what truthFault reads on the (no-longer-ours) pairState.
      if (isStillAuthoritative() && pairState.truthFault === 'NONE') {
        this.#emitEvent('CANONICAL_1M_RECOVERY_COMPLETED', pair, {
          fromMs,
          toMs,
          recoveryEpoch: activeEpoch,
          recoveredCount: canonicalRecovered.length,
        });
      }
    } catch (err: unknown) {
      // SOL-P5-003: a stale run's REST rejection must be inert. Log it (no provider payload leaked —
      // only pair/range/error), but take NO action on canonical state and emit NOTHING once this
      // recovery is no longer authoritative for the current run.
      if (!isStillAuthoritative()) {
        logger.debug({ pair, fromMs, toMs, err }, 'Ignoring REST recovery rejection from a superseded run/recovery');
        return;
      }
      logger.error({ pair, fromMs, toMs, err }, 'Failed to execute REST recovery');
      // F5: REST failure also latches the durable fault (fail-closed), not merely a log line.
      pairState.latchRecoveryFault('RECOVERY_INCOMPLETE', activeEpoch);
      this.#emitEvent('CANONICAL_1M_INVALID', pair, {
        reason: 'RECOVERY_INCOMPLETE',
        fromMs,
        toMs,
        recoveryEpoch: activeEpoch,
      });
    }
  }

  /**
   * Safe event dispatch (Section 17): one subscriber throwing must not corrupt engine state.
   *
   * SOL-P5-006: a subscriber can synchronously mutate engine lifecycle/subscriptions from inside its own
   * invocation (e.g. call stop()/start()/subscribe() while THIS dispatch is still iterating). Two
   * independent mechanisms are both required, neither alone is sufficient:
   *
   *   1. Recipient snapshot: `this.#subscribers` is a live, mutable Set. A `for...of` over it directly
   *      reflects concurrent mutation -- stop() calling `#subscribers.clear()` followed by a same-tick
   *      subscribe() re-populating it would let a brand-new Run-B subscriber be visited by an iterator
   *      that was already in progress before that subscriber ever existed. Snapshotting recipients into
   *      an array BEFORE invoking anyone fixes the recipient list for this dispatch: a subscriber added
   *      after dispatch begins is structurally absent from it, regardless of Set mutation.
   *
   *   2. Dispatch run ownership: the snapshot alone does not stop OLD recipients (present in the snapshot
   *      before stop() ran) from still being invoked with the now-obsolete Run-A event after the engine
   *      has moved on to Run B. `dispatchRunId` is captured once at entry; it is re-checked against the
   *      live `#currentRunId` before every subsequent recipient invocation, and dispatch terminates the
   *      instant they diverge -- no recipient may observe an event from a run that is no longer current,
   *      even ones that were already snapshotted.
   */
  #emitEvent(eventType: CanonicalEventType, pair: string, payload: unknown): void {
    const dispatchRunId = this.#currentRunId;
    const event: CanonicalStreamEvent = {
      eventType,
      pair,
      timestampMs: this.#clock.nowMs(),
      payload,
    };

    const recipients = [...this.#subscribers];

    for (const sub of recipients) {
      if (this.#currentRunId !== dispatchRunId) {
        return;
      }

      try {
        sub(event);
      } catch (err: unknown) {
        logger.error({ err, eventType, pair }, 'Error in canonical market data subscriber');
      }
    }
  }

  /**
   * Stops the canonical engine (F11: idempotent, cleans all resources). Safe to call even if start()
   * was never invoked (e.g. pairs driven directly via handleStreamEnvelope in tests) — cleans up any
   * pair state machines that exist. See start() for the full restart contract.
   */
  public stop(): void {
    if (this.#isStopped) {
      return;
    }

    this.#isStopped = true;
    this.#lifecycleState = 'STOPPED';
    // RESTART-EPOCH-REUSE: this run is over. Anything created from here on (a following start(), or a
    // direct initializePair() call) belongs to a new run and must never be mistaken for this one.
    this.#currentRunId++;
    // SOL-P5-005: explicitly drop the tracked start operation too. Its own runId mismatch already makes
    // it unreusable, but clearing it here is the explicit "stop() invalidates obsolete start ownership"
    // signal and avoids holding a reference to an operation object no future start() can ever reuse.
    this.#startOperation = null;

    if (this.#streamUnsubscribe) {
      this.#streamUnsubscribe();
      this.#streamUnsubscribe = null;
    }

    for (const stateMachine of this.#pairStates.values()) {
      stateMachine.stop();
    }
    this.#pairStates.clear();
    this.#subscribers.clear();
  }
}
