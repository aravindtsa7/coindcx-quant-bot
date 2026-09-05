# Canonical 1-Minute Market Data Architecture & Specification

## 1. Overview & System Boundary

Phase 5 implements the **Canonical 1-Minute Market Data Layer** for the CoinDCX Quant Futures Bot. It consumes raw, non-finalized transport candle snapshots (`PUBLIC_CANDLE_UPDATE`) from Phase 4 and produces immutable, verified closed 1-minute candles (`CanonicalCandle1m`) stored persistently in MySQL 8 (`candles_1m`) before emitting downstream events.

### Phase 4 -> Phase 5 Boundary Invariants
1. **Transport is Never Authoritatively Final**: Phase 4 contracts enforce `PublicCandleUpdatePayload.isClosed === false`. Upstream exchange WebSocket messages do not provide a dependable closed flag. Phase 5 never treats transport arrival as finality.
2. **Snapshot Replacement, Never Summing**: Each incoming `PUBLIC_CANDLE_UPDATE` is a complete snapshot of the forming minute, not a trade delta. Volume and quote volume are overwritten by newer valid snapshots, never accumulated or summed across snapshots.
3. **Nullability Integrity**: If the upstream transport does not supply `quote_volume`, Phase 5 preserves `quoteVolume: null`. It strictly forbids fabricating `quoteVolume = 0`.
4. **Source of Truth**: The frozen live source is the CoinDCX Futures 1m candlestick WebSocket stream. Downstream components (indicators, higher-timeframe aggregators) derive truth exclusively from Phase 5 canonical records.

---

## 2. Working Candle vs. Canonical Candle

| Attribute | Working Candle Snapshot (`WorkingCandleSnapshot`) | Canonical 1m Candle (`CanonicalCandle1m`) |
| :--- | :--- | :--- |
| **State** | Mutable forming minute | Immutable frozen record |
| **Finality** | Unfinalized (`isClosed: false`) | Finalized (`isClosed: true`, `closeTimeExclusiveMs = openTimeMs + 60_000`) |
| **Storage** | Ephemeral memory map | Persisted in MySQL `candles_1m` |
| **Ordering** | Primary: `providerEventTimeMs`, Secondary: `sequence` / `receivedAtMs` | Unique deterministic primary key: `(pair, open_time_ms)` |
| **Volume Semantics** | Replaced by newest snapshot | Frozen total volume for the minute |
| **Financial Precision** | Decimal.js (`Decimal`) | `CanonicalDecimal` (scale $\le 18$, precision $\le 36$), MySQL `DECIMAL(36, 18)` |
| **Immutability** | Working calculations | Structurally immutable (backed by validated primitive string, frozen instance) |

---

## 3. Successor-Confirmed Finality & Per-Minute Ownership (F1)

### The Successor Protocol
A candidate minute $T$ is eligible for finalization **only upon observation of a valid, strictly later minute** $T + 60\_000$ (or later) for the same instrument pair.
- Wall clock advance alone **never** finalizes a minute without successor packet confirmation.
- If WebSocket streaming halts or no successor arrives, the candle remains open, and the pair health eventually transitions to `STALE`.

```mermaid
sequenceDiagram
    participant WS as WebSocket Stream
    participant PM as Pair State Machine
    participant Map as pendingFinalizations Map
    participant DB as MySQL (candles_1m)
    participant Pub as Canonical Event Stream

    WS->>PM: 12:00 forming snapshot (providerEventTime = 12:00:30)
    Note over PM: Working candle updated (openTimeMs: 12:00)
    WS->>PM: 12:01 first valid snapshot (providerEventTime = 12:01:01)
    Note over PM: 12:00 eligible; schedules 12:00 finalization in Map
    PM->>Map: set(12:00, pendingFinalization_12_00)
    WS->>PM: 12:02 valid snapshot (providerEventTime = 12:02:01)
    Note over PM: 12:01 eligible; schedules 12:01 finalization in Map
    PM->>Map: set(12:01, pendingFinalization_12_01)
    Note over Map: 12:00 timer NOT cancelled by 12:02!
    Map-->>PM: 12:00 timer fires
    PM->>DB: INSERT INTO candles_1m (12:00)
    DB-->>PM: Insert OK
    PM->>Pub: Emit CANONICAL_1M_CLOSED (12:00)
    Map-->>PM: 12:01 timer fires
    PM->>DB: INSERT INTO candles_1m (12:01)
    DB-->>PM: Insert OK
    PM->>Pub: Emit CANONICAL_1M_CLOSED (12:01)
```

### Per-Minute Finalization Ownership (`pendingFinalizations`)
- Replacing a single mutable finalization timer with `pendingFinalizations: Map<number, PendingFinalization>`.
- Each entry captures: `pair`, `openTimeMs`, `generationId`, `canonicalEpoch`, `recoveryEpoch`, `timerId`, `sequence`, `receivedAtMs`, `providerEventTimeMs`.
- A successor for minute $N$ **never** cancels a pending finalization for minute $N-1$.
- Timers are cancelled only upon:
  1. Exact minute finalization completion
  2. Generation transition / reconnect barrier
  3. Recovery barrier invalidation
  4. Explicit state machine `stop()`
  5. Unresolved canonical conflict

### Unified Ordered Commit Queue (Serialized Persist + Publish, LIVE + RECOVERY)
A grace timer elapsing only marks a minute *ready to commit* (`readyToCommit`) — it does not persist/publish
directly. This is also the **only** entry point recovered candles use: `applyRecoveredCandlesAndDrainBuffer`
enqueues every REST-recovered candle into the exact same queue instead of persisting it directly, tagged
with `origin: 'REST_RECOVERY'` (vs `'LIVE_FINALIZATION'`). A single per-pair `#drainCommitQueue` owns commit
order for BOTH origins and enforces two invariants regardless of DB latency or which candidate became ready
first:
- At most one commit (`#commitOne`, the persist-then-publish unit) is ever in flight per pair, live or
  recovered.
- The next commit only starts once it is the strictly-ascending **contiguous** successor of
  `latestCanonicalOpenTimeMs`. A slow in-flight 12:00 live commit therefore always blocks a recovery batch's
  12:01/12:02 from even starting their inserts, so `latestCanonicalOpenTimeMs` can never regress and DB/publish
  order can never invert or skip a slot (RECOVERY-COMMIT-INTERLEAVE fix). `applyRecoveredCandlesAndDrainBuffer`
  awaits every enqueued candidate's *settlement* (committed, dropped as already-superseded, or permanently
  fault-blocked) before deciding recovery's own outcome — it never bypasses the queue to find out early.

#### Epoch validity is origin-aware
`canonicalEpoch` (bumped by `handleReconnectBarrier`/`stop()` — a full trust reset) and `generationId` gate
validity for **both** origins. `recoveryEpoch` additionally gates **only** `REST_RECOVERY` candidates: it
arbitrates between competing recovery operations (a superseding recovery invalidates an older one). It does
**not** invalidate an already in-flight/confirmed `LIVE_FINALIZATION` commit just because an unrelated later
recovery (for a different range) happened to begin while that commit was awaiting persistence — otherwise a
live minute's data could land correctly in the DB while being silently skipped by the in-memory watermark
the moment any later gap triggered recovery, even though that recovery's own range never covered it.

#### RECOVERY_INCOMPLETE is the one fault recovery can resolve
The queue's fault guard normally blocks all commits while `truthFault !== 'NONE'`, with one exception: a
`REST_RECOVERY` candidate may still proceed despite an active `RECOVERY_INCOMPLETE` fault — that is exactly
what a successful recovery retry clears (see §7). Any other fault, or a `RECOVERY_INCOMPLETE` fault paired
with a `LIVE_FINALIZATION` candidate, still blocks everything.

---

## 4. Continuity Watermark & Warm Restart Validation (F2)

### Warm Restart Continuity
Upon system initialization or warm restart:
1. `initializePair(pair)` queries `getLatestCanonicalCandle(pair)` from the database.
2. Sets `latestCanonicalOpenTimeMs` and `continuityWatermarkMs`.
3. When the first live candle arrives:
   - **Case $\text{live.openTimeMs} == \text{latestCanonicalOpenTimeMs} + 60\_000$**: Normal continuation.
   - **Case $\text{live.openTimeMs} > \text{latestCanonicalOpenTimeMs} + 60\_000$** (no in-memory working candle exists yet — a cold/warm restart): Gap detected. Enters `RECOVERING`, buffers the live packet, and requests REST recovery for the exact missing interval, e.g. latest in DB is 12:00, first live is 12:03 $\Rightarrow$ recovers $[12:01, 12:02]$.
   - **Case $\text{live.openTimeMs} \le \text{latestCanonicalOpenTimeMs}$**: Historical/late candle. Checked for idempotent duplicate or conflict; does **not** advance working state or freshness telemetry.

### Pre-Gap Working Candle Ownership
If a gap is instead detected while a **live, never-finalized working candle already exists in memory**
(e.g. working candle is 12:00, no successor ever arrived, and live jumps straight to 12:03), that
predecessor minute is *not* durably persisted anywhere yet — REST is the only remaining source of truth
for it. The recovery range therefore includes the predecessor's own minute, not just the gap:
`fromMs = currentWorkingOpenTimeMs` (12:00), `toMs = live.openTimeMs - 60_000` (12:02). Once recovery
verifies and persists that full range, the stale in-memory working entry for 12:00 is cleared before the
buffered 12:03 packet is replayed — otherwise replay would re-detect the identical gap against the dead
working state and recurse indefinitely instead of progressing.

### Earliest Unresolved Minute Barrier
- **Safe Rule**: No canonical publication is permitted beyond the earliest unresolved canonical minute.
- In-flight gaps establish a continuity watermark barrier preventing higher minutes from publishing until predecessors are persisted.

---

## 5. Monotonic Epoch Tokens & Single-Flight Recovery (F3 & F4)

### Epoch Tokens
State transitions maintain monotonic per-pair tokens:
- `canonicalEpoch`: incremented on truth conflicts, reconnect barriers, and reset.
- `recoveryEpoch`: incremented whenever a new recovery cycle begins.
- `generationId`: monotonic integer from transport stream envelopes.

### Async Epoch Validation
Every asynchronous operation captures `{ canonicalEpoch, recoveryEpoch, generationId }` before invoking `await`. Immediately before persistence, state mutation, buffer drainage, and publication:
- The token is re-validated.
- If the token is stale (e.g. disconnect occurred while awaiting MySQL insert), the callback aborts inertly without emitting stale events or mutating state.

### Single-Flight Recovery Ownership
- Only the **active** `recoveryEpoch` may persist recovered candles, drain buffered envelopes, clear `RECOVERING`, transition to `HEALTHY`, and emit `CANONICAL_1M_RECOVERY_COMPLETED`.
- If Recovery A is superseded by Recovery B, Recovery A becomes completely inert.

---

## 6. Repository Outcomes & Idempotent Publication (F4)

- `Candle1mRepository.insertCandle` returns a strongly-typed result:
  `{ outcome: 'INSERTED' | 'ALREADY_IDENTICAL' }`
- **INSERTED**: Eligible for `CANONICAL_1M_CLOSED` publication if epoch tokens remain valid.
- **ALREADY_IDENTICAL**: Encountered unique constraint collision on identical data. Suppresses duplicate publication for the live process.
- **Material Conflict**: Throws `CanonicalCandleConflictError` (fail closed, never overwrites).

---

## 7. Fail-Closed Truth Fault Latch (F5)

- Persistent latch: `truthFault: 'NONE' | 'CANONICAL_CONFLICT' | 'PERSISTENCE_FAILURE' | 'RECOVERY_INCOMPLETE' | 'BUFFER_OVERFLOW' | 'TIME_INVALID'`.
- Normal live packets **never** auto-heal an active truth fault to `HEALTHY`.
- While a truth fault is latched, future canonical publications for that pair are completely blocked.
- Only explicit, successful recovery or reconciliation clears the fault.

### `RECOVERY_INCOMPLETE` (REST Recovery Failure)
If REST recovery returns partial coverage, empty coverage, throws, or otherwise fails to establish exact
continuous coverage for the requested range, `latchRecoveryFault('RECOVERY_INCOMPLETE', activeEpoch)`
atomically latches the fault for the pair (a no-op for a superseded epoch, and never overrides an existing,
possibly more severe, fault). This is durable: it is not merely logged, and ordinary live packets arriving
afterward cannot clear it — they are buffered (state stays `RECOVERING`) and never re-examine the fault.
The **only** way to clear a `RECOVERY_INCOMPLETE` fault is a subsequent successful exact recovery for the
still-active recovery epoch, via `applyRecoveredCandlesAndDrainBuffer`.

---

## 8. Deep Canonical Immutability & Decimal Exactness (F6, F7, F8)

### Structural Immutability (`CanonicalDecimal`)
- Published canonical financial values use `CanonicalDecimal`, backed by a validated `readonly value: string` with `Object.freeze(this)`.
- Eliminates exposed mutable `Decimal` internal arrays/properties (e.g. `c`, `d`, `e`), ensuring published canonical entities cannot be modified by downstream subscribers casting to `any`.

### MySQL `DECIMAL(36, 18)` Constraint Validation
Before persistence and before publication, every financial value is strictly validated:
- Scale $\le 18$: 18 decimal places accepted, 19 decimal places rejected before DB.
- Precision $\le 36$: 36 total digits accepted, $>36$ digits rejected.
- Integer digits $\le 18$.
- Exponential notation (e.g. `1e-5`) is forbidden.

### Truth Equality Comparator (`areCanonicalCandlesIdentical`)
- Single unified comparator for DB P2002 deduplication, late updates, and recovery.
- Compares `pair`, `openTimeMs`, `open`, `high`, `low`, `close`, `volume`, and `quoteVolume`.
- Strictly enforces $\text{null} \ne \text{Decimal}(0)$.
- Ephemeral metadata (`generationId`, `providerEventTimeMs`, `finalizedAtMs`) does not create false conflicts.

---

## 9. Candle-Time & Forward-Skew Safety (F9)

- `openTimeMs` must be a safe integer, finite, $\ge 1577836800000$ (2020-01-01 UTC), and aligned to UTC minute boundaries (`openTimeMs % 60_000 === 0`).
- `closeTimeExclusiveMs = openTimeMs + 60_000` is guaranteed to be a safe integer.
- Plausible future bounds: candle openings exceeding `nowMs + maxFutureSkewMs + 60_000` fail immediately with `TIME_INVALID`.
- Forward skew: provider timestamps exceeding `nowMs + maxFutureSkewMs` (default 5,000ms) fail closed to `DEGRADED` without advancing finality.

---

## 10. Recovery Envelope Buffer (F10)

- Stores full `CoinDcxStreamEnvelope<PublicCandleUpdatePayload>` preserving `generationId`, `sequence`, `receivedAtMs`, `providerTimestampMs`.
- Same-minute updates are coalesced in-place: newer snapshots overwrite older ones, identical duplicates are dropped, avoiding false buffer capacity consumption.
- Drains deterministically by `(openTimeMs, providerTimestampMs, sequence, receivedAtMs)`.
- Buffer overflow fails closed with `BUFFER_OVERFLOW` truth fault.

---

## 11. Engine Lifecycle & Single Listener (F11)

- Explicit lifecycle: `STOPPED`, `STARTING`, `RUNNING`, `STOPPING`.
- `start()` is single-flight and idempotent. Registers exactly one stream listener even under concurrent
  callers made before the first `start()` resolves.
- `stop()` clears all timers, stops and discards every pair state machine, unbinds listeners, and is
  idempotent (safe to call even if `start()` was never invoked).
- Safe event dispatch: subscriber exceptions are caught and logged; they never bubble up to corrupt engine state or trigger duplicate database operations.

### Restart Contract (Explicit Support)
`start() -> stop() -> start()` is a **supported** sequence, not merely tolerated. `stop()` is a terminal
reset for the current run only — it does not leave the engine permanently inert. A following `start()`
resets the internal stop latch and installs a fresh subscription; pair state machines are lazily re-created
via `initializePair()`/on the next stream envelope, re-establishing their warm-restart baseline from the
repository. This is a deliberate choice over the alternative (permanently disallowing restart) because it
requires no extra state beyond resetting one latch in `start()`.

### Engine Run Ownership (RESTART-EPOCH-REUSE)
A fresh `PairCanonicalStateMachine` created after a restart resets its epoch counters to their defaults
(`canonicalEpoch: 1, recoveryEpoch: 1`) — the same starting values the *previous* run's instance for the
same pair also had. An async callback captured before `stop()` (e.g. mid-flight awaiting
`repository.insertCandle`) could therefore carry a token whose epoch numbers coincidentally match the new
instance, even though it belongs to an entirely different run. Epoch-number equality alone is not proof of
ownership across a restart boundary. The engine defends against this with two layers, both required:
- **`#currentRunId`**: a monotonic counter incremented every time `stop()` ends a run. Every pair's
  callbacks close over the `runId` that was active when `initializePair()` began, and reject unless
  `runId === this.#currentRunId` still holds.
- **State-machine identity**: callbacks also close over the exact `PairCanonicalStateMachine` instance they
  were registered for, and reject unless `this.#pairStates.get(pair) === thatExactInstance` — a restart
  always constructs a brand-new instance for the same pair name, so identity alone catches what epoch-number
  comparison would miss.

### Restart-Safe Initialization (RESTART-INITIALIZATION-RACE)
`initializePair()` is itself asynchronous — it awaits `repository.getLatestCanonicalCandle(pair)` before it
can construct anything — so ownership must be captured and revalidated around that await too, not only
around `onFinalizeCandle`. `#currentRunId` is captured *before* the await; immediately after it resolves,
and again immediately before `#pairStates.set(pair, stateMachine)`, ownership is revalidated. If a
`stop()`/`start()` cycle happened in between:
- A stale attempt never constructs a `PairCanonicalStateMachine`, never registers its callbacks, and never
  calls `#pairStates.set` — it can never overwrite a newer run's already-installed instance.
- If the newer run already installed its own instance for that pair, the stale attempt resolves to that
  instance instead of fabricating its own.
- If no newer-run instance exists yet, the stale attempt's promise rejects (`CanonicalRecoveryError`)
  rather than installing anything; `handleStreamEnvelope` catches that specific case and treats it as an
  inert dropped envelope, and separately re-checks liveness after any `initializePair()` await before
  acting on its result.

`#pairInitializations: Map<pair, {runId, promise}>` provides single-flight ownership scoped to
`(pair, runId)`: concurrent `initializePair(pair)` calls within the SAME run share one in-flight promise —
one DB read, one construction, one installation. An in-flight attempt tagged with an OLD `runId` is never
reused by a call made under a newer run; a fresh attempt is always started instead, and stays isolated even
across multiple restart cycles (old A/B attempts resolving during run C remain inert).

An old run's stale callback is therefore inert after restart regardless of epoch-number coincidence: no
`CANONICAL_1M_CLOSED` publication, and no mutation of the new run's freshness, watermark, or recovery state.

---

## 12. Staleness Timer Rearming & Freshness (FRESHNESS-SUPERSEDED-REFRESH)

- Scheduled dynamically for `staleThresholdMs - elapsed`.
- When activity occurs shortly before a scheduled deadline, health remains `HEALTHY` and the next deadline is re-armed.
- Later inactivity deterministically transitions the pair to `STALE`.

### ARRIVAL != ACCEPTANCE
`lastValidProviderEventTimeMs`/`lastValidReceivedAtMs` (and the staleness rearm they drive) mutate via
`#refreshFreshness` **only** once the working-candle classification has actually decided a packet is
genuine accepted forward live progress — never merely because a well-formed packet *arrived*. Concretely:
- First-ever working candle, a genuinely newer same-minute update, or a legitimate successor: refreshes.
- `WorkingCandleManager` reporting **SUPERSEDED** for a same-minute update (older or materially different
  than what's already accepted) does **not** refresh — an exact duplicate does not refresh either, since a
  duplicate is not proof of *current* connectivity under this health policy, only genuinely new information
  is.
- Stale-generation drops, forward-skew/time-invalid rejections, and historical/already-finalized packets
  were already excluded before this fix; SUPERSEDED same-minute updates were the gap it closes.

Without this, an older or conflicting same-minute retransmit could make a genuinely stalled feed appear
healthy and push out the staleness deadline, even though nothing new was actually learned.

---

## 13. Final Async Lifecycle & Cross-Run Safety Correction (SOL-P5-001..005)

Sections 11–12 cover restart safety *within* a single pair state machine's own async operations
(initialization races, stale callbacks). A later audit found that engine-level async operations —
physical persistence, stream dispatch, REST recovery, and `start()`/`stop()` bookkeeping itself — were
not held to the same standard: each was fixed locally without a *shared* notion of run ownership, leaving
gaps at the boundaries between them. Phase 5 is **COMPLETE**; this section documents the unified
lifecycle model that closes those gaps as one coherent design rather than five unrelated patches.

### The core principle
Every asynchronous engine operation must capture its run ownership (`#currentRunId`, and where relevant
the exact `PairCanonicalStateMachine` instance / epoch) **before its first `await`**, and must revalidate
that ownership **after every subsequent `await`**, before taking any observable action — persisting,
mutating state, or emitting an event. This is the same discipline sections 11–12 already apply to
`initializePair()`; this section extends it to every other async entry point, plus adds one new
engine-level primitive that per-pair state-machine ownership alone cannot provide.

### SOL-P5-001: cross-run physical persistence barrier (`PairPersistenceCoordinator`)
A pair's *physical* write to `candles_1m` and its *logical* commit ordering are different concerns. The
per-pair unified commit queue (§3) orders commits correctly **within one run's state-machine instance**,
but a `stop()`/`start()` replaces that instance — a fresh state machine has no memory of a write its
predecessor is still physically performing. Without an engine-level barrier, a new run could read a stale
DB baseline via `getLatestCanonicalCandle` while an old run's insert for an earlier minute is still
in-flight, then legitimately persist a *later* minute first: the physical row order in `candles_1m` would
invert relative to open-time order.

`PairPersistenceCoordinator` (`src/market-data/pair-persistence-coordinator.ts`) is a small, engine-level,
per-pair FIFO barrier around every physical `repository.insertCandle` call, constructed once per engine
instance and **never reset by `stop()`** — it is the one piece of state that deliberately survives a run
boundary. `enqueueWrite(pair, run)` chains each write behind the previous write's settlement (success or
failure) for that pair; `awaitSettled(pair)` lets a caller wait for the current tail without enqueueing
anything itself.

- **2B — new run joins prior persistence before reading baseline**: `#createPairStateMachine` now does
  `await this.#persistenceCoordinator.awaitSettled(pair)` as its *first* action, before calling
  `getLatestCanonicalCandle`. A new run's baseline read is therefore guaranteed to observe the prior run's
  write only after it has physically settled — never before, and never interleaved with a later write. This
  is what makes DB commit order match open-time order across a restart, closing the SOL-P5-001 race exactly.
- **2D — physical success vs. event credit are separate**: the old run's `onFinalizeCandle` callback still
  performs the enqueued write itself (it owns that promise chain), but after the write settles it
  revalidates run + state-machine identity before emitting `CANONICAL_1M_CLOSED` — so a physically-successful
  old-run write is inherited by the new run as its durable baseline (§11's warm-restart continuity), but is
  never credited via the old run's own (now-stale) event emission. Only whichever run is current when a
  write settles may publish it.

### SOL-P5-001 / 2C: prior-run persistence failure fails closed, not cold-start
If the write a new run is waiting on (via `awaitSettled`) failed rather than succeeded,
`#createPairStateMachine` immediately calls `stateMachine.latchRecoveryFault('PERSISTENCE_FAILURE', ...)`
on the freshly constructed instance before installing it. A failed predecessor write is not observable
proof of "nothing was ever there" — treating it as an ordinary cold start (no baseline, no fault) would
silently discard the fact that a minute's durability is unknown/failed. The new instance starts in
`RECOVERING` with a latched, fail-closed fault instead, blocking all future publication for that pair until
an explicit, successful recovery clears it (§7).

### SOL-P5-002: stale stream dispatch becomes fully inert
`handleStreamEnvelope` captures `dispatchRunId = this.#currentRunId` as its very first statement, before
the (potentially long) `await this.initializePair(payload.pair)` call. `!#isStopped` alone is insufficient
here: a `stop()` followed by a `start()` resets `#isStopped` back to `false` for the *new* run, so an old
dispatch resuming after that cycle would see "not stopped" and incorrectly proceed. After the
`initializePair` await resolves, dispatch is dropped inertly unless **both** `dispatchRunId ===
this.#currentRunId` **and** the state-machine instance about to be invoked is still exactly the one
currently installed for that pair (`this.#pairStates.get(pair) === stateMachine`) — defense in depth
against the epoch-number-coincidence trap described in §11.

### SOL-P5-003: stale REST recovery rejection becomes fully inert (including its `catch`)
`executeRecovery` captures `runId`, the exact originating `pairState` instance, and `recoveryEpoch` into a
single `isStillAuthoritative()` closure, checked before the initial REST await, again immediately after it,
again before latching an incomplete-coverage fault, and again before emitting
`CANONICAL_1M_RECOVERY_COMPLETED`. Critically, the same check now also gates the `catch` block: a stale
run's REST *rejection* (e.g. a network error arriving after `stop()`/`start()` moved the engine to a new
run) is logged at debug level and discarded — it can no longer latch `RECOVERY_INCOMPLETE` onto, or emit
`CANONICAL_1M_INVALID` into, a newer run's pair state. Previously the catch block latched and emitted
unconditionally regardless of which run was current; that unconditional path was the exact defect.

### SOL-P5-004: historical verification failure fails closed
`#handleLatePostFinalizationUpdate` (the historical/late-packet verification path against the persisted
canonical record) now wraps its `getPersistedCandle` read — and, separately, the subsequent
decimal-conversion/comparison logic — in their own try/catch blocks. A DB read failure latches
`PERSISTENCE_FAILURE` (via `onConflictDetected`) rather than letting the exception escape unhandled; a
conversion/comparison failure latches `CANONICAL_CONFLICT`. Either way the pair moves to `DEGRADED` with a
fault latched, so future normal candles are blocked from publishing (§7) instead of the verification
failure being silently swallowed while future candles continue on as if truth had been confirmed.

### SOL-P5-005: `start()`/`stop()`/`start()` ownership (`StartOperation`)
The bare `#startPromise: Promise<void> | null` reference could not distinguish "the in-flight start for the
run that's still current" from "an in-flight start for a run that has since been stopped and restarted" —
both look like "a non-null promise" to a caller. It is replaced with a
`StartOperation = { runId: number; promise: Promise<void> }`. `start()` reuses the in-flight operation only
when the engine is still `STARTING` **and** `operation.runId === this.#currentRunId`; otherwise it begins a
fresh operation for the current `runId`, and the async body itself revalidates `runId ===
this.#currentRunId` before flipping the lifecycle state to `RUNNING`. `stop()` explicitly nulls
`#startOperation` (in addition to bumping `#currentRunId`), so an immediate `stop()` → `start()` — even one
that races ahead of the first start's own `.finally()` cleanup — always produces a fresh, correctly-tracked
operation for an actively `RUNNING` engine with exactly one live stream listener, rather than risking a
caller being hand the stale, now-meaningless first operation's promise.

### Regression coverage
`tests/unit/market-data/phase5-cross-run-safety.test.ts` drives the real engine (not mocks of it) through
each race with manually-controlled (deferred) promises for DB writes and REST calls, reproducing every one
of SOL-P5-001 through 005 directly against production code:
- **A**: cross-run commit barrier — a slow run-A 12:00 insert genuinely blocks run-B's baseline read until
  it settles, and DB order never inverts.
- **B**: a failed run-A predecessor insert is inherited by run B as a latched `PERSISTENCE_FAILURE`, not a
  cold start.
- **C**: a run-A envelope still awaiting `initializePair` cannot mutate run B's health/freshness once
  released.
- **D**: a run-A REST recovery rejection arriving after restart emits nothing into run B.
- **E**: a historical-verification DB read failure latches a blocking fault and halts future publication.
- **F**: an immediate `stop()` + `start()` right after `start()` reaches `RUNNING` (before its own `.finally`
  fires) produces a fresh, correctly-active run rather than resurrecting the obsolete operation.
- **G**: across three consecutive runs (A → stop → B → stop → C), a stale run-A persistence callback and a
  stale run-B recovery callback both remain inert once run C is active — the model holds under repeated
  cycling, not just a single restart.

---

## 14. Phase 6 Boundary

Phase 5 is strictly scoped to 1-minute canonical market data. It contains **no** multi-timeframe aggregation logic (no 5m, 15m, 1h candle synthesis) and **no** strategy, risk, or execution dependencies. Phase 6 will consume `CANONICAL_1M_CLOSED` events to derive higher timeframes.
