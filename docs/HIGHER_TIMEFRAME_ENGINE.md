# Generic Higher-Timeframe Engine — Phase 6 Architecture & Specification

## 1. Executive Summary & System Boundary

Phase 6 implements the **Generic Higher-Timeframe Engine** for the **CoinDCX Quant Futures Bot**. It is a pure mathematical aggregation subsystem that derives higher-timeframe candlesticks (initial production set: 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h, 1d) exclusively from authoritative Phase 5 canonical closed 1-minute candles (`CanonicalCandle1m`).

### Architectural Pipeline Flow
```
┌──────────────────────────────────────────────┐
│               CoinDCX Exchange               │
│         (Public Futures WebSocket)           │
└──────────────────────┬───────────────────────┘
                       │ (Raw socket frames)
                       ▼
┌──────────────────────────────────────────────┐
│           Phase 4: Transport Layer           │
│         (CoinDcxPublicFuturesStream)         │
└──────────────────────┬───────────────────────┘
                       │ PUBLIC_CANDLE_UPDATE (Forming snapshots, isClosed: false)
                       ▼
┌──────────────────────────────────────────────┐
│      Phase 5: Canonical 1m Market Data       │
│        (CanonicalMarketDataEngine)           │
│  - Successor-confirmed finality              │
│  - Gap detection & single-flight REST repair │
│  - MySQL 8 candles_1m immutable persistence  │
└──────────────────────┬───────────────────────┘
                       │ CANONICAL_1M_CLOSED (Only verified closed 1m candles)
                       │ + Control signals (RECOVERY_REQUIRED/COMPLETED, STALE, INVALID)
                       ▼
┌──────────────────────────────────────────────┐
│   Phase 6: Generic Higher-Timeframe Engine   │
│         (HigherTimeframeEngine)              │
│  - Pair-scoped serialized execution chain    │
│  - Phase 5 eligibility gate & resync engine  │
│  - UTC-anchored bucket boundaries            │
│  - Safe integer generic timeframe arithmetic │
│  - Exact constituent completeness (no fill)  │
│  - Isolated 64-bit Decimal context           │
│  - DerivedAggregateDecimal exact bounds      │
│  - Local MySQL candles_1m range reader       │
└──────────────────────┬───────────────────────┘
                       │ HIGHER_TIMEFRAME_CLOSED (pair, timeframeMinutes, bucketStartMs)
                       ▼
┌──────────────────────────────────────────────┐
│             Future Downstream Layers         │
│  - Phase 8: Indicator Engine (EMA, RSI, ATR) │
│  - Phase 9: Backtest Simulation Engine       │
│  - Phase 10: Strategy Research Framework     │
│  - Phase 14: Paper Trading / Shadow Engine   │
│  - Phase 17/20/21: Live Production Trading   │
└──────────────────────────────────────────────┘
```

### Strict System Boundaries & Invariants
1. **Upstream Source of Truth**: Phase 6 consumes **ONLY** authoritative Phase 5 canonical closed 1-minute candles (`CANONICAL_1M_CLOSED` live stream events and local MySQL `candles_1m` persisted records accessed via `Canonical1mRangeReader`).
2. **Prohibited Inputs**: Phase 6 MUST NEVER consume:
   - Phase 4 `PUBLIC_CANDLE_UPDATE` stream envelopes directly.
   - Forming or unfinalized 1-minute candle snapshots.
   - Exchange-provided higher-timeframe candles (e.g. CoinDCX 5m or 1h REST/WebSocket feeds).
3. **Non-Duplication Contract**: Phase 6 MUST NOT duplicate responsibilities owned by preceding phases:
   - It does not implement successor-confirmed finality (owned by Phase 5).
   - It does not perform gap REST recovery against CoinDCX (owned by Phase 5).
   - It does not handle transport generation IDs or WebSocket connection lifecycle (owned by Phase 4).
   - It does not reconcile exchange market data truth (owned by Phase 5).
   - It does not parse raw WebSocket packets or invoke CoinDCX REST endpoints.
4. **Pure Derived Truth**: Higher-timeframe candles are strictly deterministic derived values. They are not independent primary truth and are not authoritatively persisted to MySQL database tables in Phase 6.
5. **Canonical 1m Exclusivity**: Canonical 1-minute candles belong exclusively to Phase 5. Phase 6 derives higher timeframes only; allowing `timeframeMinutes = 1` would duplicate Phase 5 responsibilities. Therefore, `timeframeMinutes` must be an integer $\ge 2$.

---

## 2. Pair-Scoped Operational State Model

Phase 6 maintains an explicit, four-state lifecycle per instrument pair:

```
                      ┌──────────────────────┐
                      │     INITIALIZING     │
                      └──────────┬───────────┘
                                 │ (Startup baseline & partial buckets hydrated;
                                 │  Phase 5 is eligible)
                                 ▼
           ┌─────────────────── READY ◄──────────────────┐
           │                      │                      │
           │ (Phase 5 ineligible, │                      │
           │  gap, or fault)      │                      │
           ▼                      │                      │
       BLOCKED ───────────────────┘                      │
           │                                             │
           │ (Phase 5 becomes eligible)                  │
           ▼                                             │
      RESYNCING ─────────────────────────────────────────┘
                 (Authoritative DB range read, continuity proven,
                  catch-up emitted, Phase 5 still eligible)
```

### State Definitions & Semantics
- **`INITIALIZING`**:
  - Cold or warm startup hydration in progress.
  - Validating Phase 5 eligibility and loading initial canonical 1m baseline from local MySQL `candles_1m`.
  - Zero higher-timeframe candle publication permitted.
- **`READY`**:
  - Upstream Phase 5 currently satisfies the eligibility predicate (`state === 'HEALTHY'`, `truthFault === 'NONE'`, `recoveryRequired === false`).
  - Canonical 1m continuity is strictly proven.
  - Normal live derived higher-timeframe publication is permitted.
- **`BLOCKED`**:
  - Upstream canonical truth cannot safely be consumed (Phase 5 ineligible, gap detected, or stream stale/invalid).
  - Zero higher-timeframe candle publication permitted.
  - Zero continuity fabrication or network calls.
- **`RESYNCING`**:
  - Phase 5 has transitioned from ineligible to eligible.
  - Phase 6 is actively executing an authoritative local MySQL `candles_1m` range read to rebuild affected in-memory partial buckets and detect complete catch-up buckets.
  - Direct live event publication is blocked until resync finishes and eligibility is re-verified.

### Health Authority Invariant
Phase 6 **MUST NOT** create an independent market-truth health engine. Phase 5 remains the sole and authoritative judge of underlying 1-minute canonical health.

---

## 3. Exact Phase 5 Eligibility Predicate & Health Contract (P6A-01)

### The Phase 6 Eligibility Predicate
A Phase 5 instrument pair is defined as **eligible** for Phase 6 live progression if and only if all three conditions hold simultaneously in its current `CanonicalHealthSnapshot`:

$$\text{isPhase5Eligible}(\text{pair}) \iff (\text{state} === \text{'HEALTHY'}) \land (\text{truthFault} === \text{'NONE'}) \land (\text{recoveryRequired} === \text{false})$$

### Core Upstream Health Facts & Rules
1. **STALE & DEGRADED Self-Healing**: In Phase 5, a `STALE` pair or a fault-free `DEGRADED` pair may return to `HEALTHY` purely from valid live incoming packets without emitting `CANONICAL_1M_RECOVERY_COMPLETED`. Phase 6 must observe this transition on any incoming event and trigger resync accordingly.
2. **Interim Recovery Commits**: While Phase 5 is actively performing REST recovery, it may persist and emit canonical 1m candles while still in `RECOVERING` (`recoveryRequired: true`). Phase 6 must stay `BLOCKED` and **MUST NOT** blindly process these interim candles as normal live progress.
3. **RECOVERY_INCOMPLETE Clearing**: `RECOVERY_INCOMPLETE` is the one truth fault that can be resolved by a subsequent successful Phase 5 recovery cycle.
4. **Terminal / Fatal Truth Faults**: Phase 6 MUST NOT assume or expect that `CANONICAL_CONFLICT`, `PERSISTENCE_FAILURE`, `BUFFER_OVERFLOW`, or `TIME_INVALID` will self-heal. Phase 6 remains `BLOCKED` permanently for that pair until the host orchestrator reconciles Phase 5 truth.
5. **No Independent Fault Clearing**: Phase 6 has no authority to clear, override, or reinterpret a Phase 5 truth fault.

---

## 4. Pair-Scoped Serialized Ownership & Execution Model (P6A-04)

To prevent race conditions, chronological inversion, duplicate publications, and overlapping state mutations, Phase 6 enforces a **Single Serialized Owner per Pair**.

### Architectural Serialization Queue
Every instrument pair possesses a dedicated FIFO promise execution queue:
```typescript
class PairExecutionQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
```

### Scope of Serialization
**ALL** observable operations for a pair must execute sequentially through this serialized executor:
- Ingestion and dispatch of Phase 5 stream events (`CANONICAL_1M_CLOSED`, control signals).
- Startup baseline hydration from MySQL.
- Transitions between `READY`, `BLOCKED`, and `RESYNCING`.
- Authoritative range reads via `Canonical1mRangeReader`.
- In-memory higher-timeframe partial bucket mutations.
- Catch-up bucket staging and event publication.

### Invariants of Pair Serialization
1. **Zero Concurrency per Pair**: No live packet may be processed while a DB range read, hydration, or resync is in flight for the same pair.
2. **Complete Cross-Pair Independence**: Pair A (`BTC-INR`) and Pair B (`ETH-INR`) have distinct queues and execute concurrently without cross-pair contention or blocking.
3. **Prevention of Chronological Inversion**: A live 1m candle arriving while resync is running is queued behind resync completion.

---

## 5. Safe Generic Timeframe Contract & Arithmetic Bounds (P6A-03)

### Generic Parameter & Mathematical Range
The engine aggregates higher timeframes generically via integer duration:
$$\text{timeframeMinutes} \in \mathbb{Z}^+$$

### Exact Safe Arithmetic Contract
To prevent integer overflow, precision loss, and non-representable JavaScript numbers, every configured timeframe must satisfy the **Safe Integer Bounds Contract**:

1. **Integer & Lower Bound**:
   $$\text{Number.isSafeInteger}(\text{timeframeMinutes}) \land \text{timeframeMinutes} \ge 2$$
   *(Enforces whole minutes and preserves Phase 5 canonical 1m exclusivity).*

2. **Upper Safe Bound**:
   $$\text{timeframeMinutes} \le \left\lfloor \frac{\text{Number.MAX\_SAFE\_INTEGER}}{60\,000} \right\rfloor = 150\,119\,987\,579\text{ minutes}$$

3. **Duration Invariant**:
   $$\text{durationMs} = \text{timeframeMinutes} \times 60\,000$$
   $$\text{Number.isSafeInteger}(\text{durationMs}) === \text{true}$$

4. **Timestamp Bounds Invariant**:
   For any canonical candle timestamp $\text{openTimeMs}$ and bucket boundaries:
   - $\text{Number.isSafeInteger}(\text{openTimeMs})$
   - $\text{Number.isSafeInteger}(\text{bucketStartMs})$
   - $\text{Number.isSafeInteger}(\text{bucketEndExclusiveMs})$
   If any boundary calculation violates `isSafeInteger`, the engine fails closed immediately before using the value as a Map key, bucket boundary, or event identifier.

### Distinction: Mathematically Valid vs. Enabled Production Set
- **Mathematically Valid Generic Timeframe**: Any integer satisfying the safe arithmetic contract above ($\text{timeframeMinutes} \ge 2$ and $\text{durationMs} \le \text{MAX\_SAFE\_INTEGER}$).
- **Currently Enabled Production Set**: The frozen initial set configured for active production operations:
  $$\{2, 3, 4, 5, 10, 15, 30, 60, 240, 1440\}$$

---

## 6. UTC Bucket Anchoring & Boundary Mathematics

All higher-timeframe intervals are mathematically anchored to the Unix epoch (1970-01-01T00:00:00.000Z) in Universal Coordinated Time (UTC).

### Mathematical Contract
$$\text{durationMs} = \text{timeframeMinutes} \times 60\,000$$
$$\text{bucketStartMs} = \left\lfloor \frac{\text{canonical1m.openTimeMs}}{\text{durationMs}} \right\rfloor \times \text{durationMs}$$
$$\text{bucketEndExclusiveMs} = \text{bucketStartMs} + \text{durationMs}$$

### Absolute Rules
1. **UTC Unix Epoch Anchoring Only**: Pure integer division against Unix milliseconds.
2. **Strictly No Local Timezone / IST**: No Indian Standard Time (+05:30) or system timezone offsets.
3. **No Session or DST Adjustments**: Unbroken 24/7/365 crypto market continuity.
4. **Half-Open Intervals**: $[\text{bucketStartMs}, \text{bucketEndExclusiveMs})$.
   - First constituent: $\text{openTimeMs} = \text{bucketStartMs}$.
   - Last constituent: $\text{openTimeMs} = \text{bucketEndExclusiveMs} - 60\,000$.

---

## 7. Exact Completeness & Zero-Fabrication Contract

### The Exact $N$-Constituents Requirement
A higher-timeframe candle of duration $N = \text{timeframeMinutes}$ requires **EXACTLY $N$ contiguous, canonical closed 1-minute candles**:
$$C = \left[ c_0, c_1, \dots, c_{N-1} \right]$$
where for each index $i \in [0, N - 1]$:
$$c_i.\text{openTimeMs} = \text{bucketStartMs} + (i \times 60\,000)$$

### Completeness Invariant
A higher-timeframe candle is **CLOSED and COMPLETE** if and only if:
1. `constituentCount === expectedConstituentCount` ($N$).
2. Monotonic contiguous sequence with zero missing minutes ($\Delta = 60\,000\text{ ms}$).
3. Every constituent is a validated, finalized `CanonicalCandle1m` from Phase 5.

### Absolute Ban on Data Fabrication
If even a single constituent candle is missing:
- The bucket is **INCOMPLETE**; zero higher-TF events are published.
- **NEVER** fabricate a missing candle.
- **NEVER** interpolate prices between candles.
- **NEVER** forward-fill missing minutes with prior prices.
- **NEVER** copy previous close to manufacture a bar.
- **NEVER** insert zero-volume synthetic placeholders.

---

## 8. Pure Aggregation Mathematics & Output Domain Model (P6A-02)

### Universal Aggregation Primitive
$$\text{aggregateExactBucket}(C: \text{readonly CanonicalCandle1m}[], N: \text{number}): \text{HigherTimeframeCandle}$$

### Aggregation Formulas
1. **Open**: $\text{open} = c_0.\text{open}$ (CanonicalDecimal)
2. **High**: $\text{high} = \max_{i=0}^{N-1} (c_i.\text{high})$ (CanonicalDecimal)
3. **Low**: $\text{low} = \min_{i=0}^{N-1} (c_i.\text{low})$ (CanonicalDecimal)
4. **Close**: $\text{close} = c_{N-1}.\text{close}$ (CanonicalDecimal)
5. **Volume**: $\text{volume} = \sum_{i=0}^{N-1} c_i.\text{volume}$ (DerivedAggregateDecimal)
6. **Quote Volume**: Exact sum if all non-null, else null (DerivedAggregateDecimal | null)

### Immutable Domain Model
```typescript
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
```

### Strict Field Exclusions
To guarantee deterministic byte-level parity across runs, the following are strictly excluded from the immutable candle truth:
- **NO `generationId`**
- **NO `sequence`**
- **NO provider event timestamps**
- **NO wall-clock derived/processing timestamps**

---

## 9. Decimal Safety, Isolated Calculation Context & DerivedAggregateDecimal (P6A-02)

### The Derived Aggregate Precision Problem
Phase 5 `CanonicalDecimal` is constrained to MySQL `DECIMAL(36, 18)` (max 18 integer digits, 18 fractional scale digits).
While OHLC values inherit these bounds directly from 1m constituents, summing volume across large timeframes can exceed 18 integer digits:
- A single canonical constituent can have up to 18 integer digits.
- The maximum safe timeframe permitted by safe JavaScript arithmetic ($1.5 \times 10^8$ minutes) can contribute up to 9 additional orders of magnitude; even conservative large historical aggregates can contribute up to 12 digits.
- Therefore, volume sums require up to **30 integer digits** and **18 scale digits**, totaling **48 significant digits**.

### Specification: `DerivedAggregateDecimal`
An immutable, frozen decimal class specifically designed for higher-timeframe aggregate sums:
- **Maximum Scale**: 18 fractional digits.
- **Maximum Integer Digits**: 30 digits.
- **Maximum Total Precision**: 48 digits.
- **Forbidden**: Exponential notation (`1e-5`), `NaN`, `Infinity`, silent truncation.
- **Immutability**: Backed by validated primitive string with `Object.freeze(this)`.

### Isolated 64-Bit Calculation Context
All summation is conducted inside an isolated high-precision Decimal.js clone:
```typescript
export const AggregationDecimal = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
```

### Execution Invariants
1. **Zero Global Mutation**: Never alter global `Decimal.set()`.
2. **Decoupled String Validation**: Do NOT pass cloned Decimal instances to Phase 5's `validateCanonicalDecimalExactness(Decimal)` (which relies on `instanceof Decimal` against the shared global constructor). Instead, convert the clone result to a fixed-point string (`toFixed()`) and validate against `DerivedAggregateDecimal` constraints.
3. **Fail-Closed on Overflow**: Any sum exceeding 30 integer digits or 48 total digits fails closed immediately.

---

## 10. QuoteVolume Nullability Policy

$$\text{quoteVolume} = \begin{cases}
\sum_{i=0}^{N-1} c_i.\text{quoteVolume} & \text{if } \forall i \in [0, N-1]: c_i.\text{quoteVolume} \ne \text{null} \\
\text{null} & \text{if } \exists i \in [0, N-1]: c_i.\text{quoteVolume} == \text{null}
\end{cases}$$

- A missing quote volume is **NEVER** treated as zero.
- If even one constituent lacks quote volume, the aggregate quote volume is strictly `null`.

---

## 11. Phase 6 Narrowed Input Event Contract & Safe Type Guards (P6A-01)

### Narrowed Event Types
Phase 5 emits broad `CanonicalStreamEvent<unknown>`. Phase 6 MUST NOT perform unsafe blind casts (`payload as CanonicalCandle1m`).

```typescript
export interface Phase6CanonicalClosedEnvelope {
  readonly eventType: 'CANONICAL_1M_CLOSED';
  readonly pair: string;
  readonly timestampMs: number;
  readonly candle: CanonicalCandle1m;
}

export interface Phase6ControlEnvelope {
  readonly eventType:
    | 'CANONICAL_1M_RECOVERY_REQUIRED'
    | 'CANONICAL_1M_RECOVERY_COMPLETED'
    | 'CANONICAL_1M_STALE'
    | 'CANONICAL_1M_INVALID';
  readonly pair: string;
  readonly timestampMs: number;
}
```

### Type Guarding & Authority Invariants
1. **Narrowing Guard**: Implementation must use a strict runtime type guard validating that a `CANONICAL_1M_CLOSED` payload contains valid `openTimeMs`, `open`, `high`, `low`, `close`, and `volume` as `CanonicalDecimal`.
2. **Control Event Handling**: For control events, Phase 6 consumes the `eventType` as a wake-up signal, disregards payload specifics, and queries `canonicalEngine.getPairHealth(pair)` for current authoritative truth.

---

## 12. Resync Anchoring, Captured DB High-Watermark & Catch-Up (P6A-01, P6A-04)

### Resync Triggering Rules (BLOCKED $\rightarrow$ RESYNCING)
Whenever a Phase 5 event or health check indicates that an ineligible/blocked pair has become eligible (`isPhase5Eligible === true`), the pair transitions from `BLOCKED` to `RESYNCING`.
*Note: This transition occurs whether eligibility was restored via `CANONICAL_1M_RECOVERY_COMPLETED` or via valid live packets clearing `STALE`/`DEGRADED`.*

### Resync Protocol Steps (Executed inside Pair Serialized Queue)
1. **Confirm Upstream Eligibility**: Check that current Phase 5 health satisfies the eligibility predicate.
2. **Compute Resync Anchor (`resyncFromMs`)**:
   - Let $T_{\text{unresolved}} = \text{lastProcessedCanonicalOpenTimeMs} + 60\,000$.
   - For each configured timeframe $\text{TF}$, compute $\text{bucketStartMs}(T_{\text{unresolved}}, \text{TF})$.
   - Set $\text{resyncFromMs} = \min_{\text{TF}} \left( \left\lfloor \frac{T_{\text{unresolved}}}{\text{TF} \times 60\,000} \right\rfloor \times (\text{TF} \times 60\,000) \right)$.
3. **Capture DB High-Watermark**:
   - Query `Canonical1mRangeReader.getLatestCanonicalCandle(pair)`.
   - If null, cannot establish baseline $\rightarrow$ transition to `BLOCKED`.
   - Otherwise, record $T_{\text{high}} = \text{latestDbCandle.openTimeMs}$ as `resyncHighWatermarkMs`.
4. **Read Local Range**:
   - Call `Canonical1mRangeReader.getRange(pair, resyncFromMs, resyncHighWatermarkMs)`.
5. **Verify Exact Continuity**:
   - Validate that the fetched candles form an unbroken, minute-by-minute contiguous sequence from `resyncFromMs` to `resyncHighWatermarkMs`. If broken, remain `BLOCKED`.
6. **Rebuild Partial Buckets & Stage Complete Buckets**:
   - Feed candles into aggregation engine.
   - For every completed bucket whose identity $(\text{pair}, \text{TF}, \text{bucketStartMs})$ has **NOT** been published in the active Phase 6 run, stage it for catch-up publication.
7. **Pre-Publication Eligibility Re-Check**:
   - Query `canonicalEngine.getPairHealth(pair)` **AFTER** the DB awaits.
   - If Phase 5 became ineligible during DB reading: discard all staged catch-up events, transition to `BLOCKED`, and publish nothing.
8. **Deterministic Catch-Up Publication**:
   - If still eligible, publish staged events synchronously in deterministic order:
     1. `closeTimeExclusiveMs` ASC
     2. `timeframeMinutes` ASC
   - Advance `lastProcessedCanonicalOpenTimeMs = resyncHighWatermarkMs`.
   - Transition pair state to `READY`.
9. **Processing Queued Live Events**:
   - Live events that arrived during resync and were queued behind the serialized resync operation are now evaluated:
     - If $\text{event.openTimeMs} \le \text{resyncHighWatermarkMs}$: drop inertly (already covered by authoritative DB read).
     - If $\text{event.openTimeMs} > \text{resyncHighWatermarkMs}$: process as forward live progression.

---

## 13. Live Event Contract, Deterministic Identity & Emission Ordering (P6A-04)

### Event Structure
```typescript
export interface HigherTimeframeClosedEvent {
  readonly eventType: 'HIGHER_TIMEFRAME_CLOSED';
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bucketStartMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly eventTimeMs: number;
  readonly candle: HigherTimeframeCandle;
}
```

### Deterministic Identity & Run-Scoped Deduplication
- **Identity Key**: 3-tuple $(\text{pair}, \text{timeframeMinutes}, \text{bucketStartMs})$.
- **At-Most-Once Single-Run Publication**: A completed bucket key may be published at most once per active Phase 6 engine run.
- **Published Key Tracking**: The engine maintains a run-scoped set/watermark of published keys. Same-run resync catch-up never duplicates keys published before the block.

### Deterministic Emission Ordering
1. **Simultaneous Multi-Timeframe Close (Live)**:
   - Emitted in ascending duration order:
     $$\text{2m} \longrightarrow \text{3m} \longrightarrow \text{4m} \longrightarrow \text{5m} \longrightarrow \text{10m} \longrightarrow \text{15m} \longrightarrow \text{30m} \longrightarrow \text{60m} \longrightarrow \text{240m} \longrightarrow \text{1440m}$$
2. **Resync Catch-Up Multi-Bucket Close**:
   - Emitted in hierarchical order:
     1. Primary: `closeTimeExclusiveMs` ASC (chronological time)
     2. Secondary: `timeframeMinutes` ASC (smaller before larger)
3. **Cross-Pair Independence**: No global ordering constraints across separate pairs.

---

## 14. Deterministic Higher-Timeframe Event Time

- **Market Truth**: `HigherTimeframeCandle` contains only deterministic timestamps: `openTimeMs` and `closeTimeExclusiveMs`.
- **Event Envelope Timestamp**:
  $$\text{eventTimeMs} = \text{candle.closeTimeExclusiveMs}$$
- **Telemetry Latency**: Real-time receipt/processing wall-clock timestamps may be logged to Pino for operational telemetry, but are strictly excluded from event identity, equality comparisons, and strategy consumption.

---

## 15. Canonical 1m Local Range-Reader Contract (P6A-06)

### Interface Specification: `Canonical1mRangeReader`
```typescript
export interface Canonical1mRangeReader {
  /**
   * Retrieves the latest canonical 1m candle from local MySQL candles_1m.
   */
  getLatestCanonicalCandle(pair: string): Promise<CanonicalCandle1m | null>;

  /**
   * Retrieves a contiguous range of canonical 1m candles from local MySQL candles_1m.
   * Both endpoints are inclusive.
   */
  getRange(
    pair: string,
    fromInclusiveMs: number,
    toInclusiveMs: number
  ): Promise<readonly CanonicalCandle1m[]>;
}
```

### Exact Range Reader Validation & Error Semantics
1. **Input Validation**:
   - `pair`: non-empty, valid string.
   - `fromInclusiveMs`: safe integer, aligned to UTC minute boundary (`% 60_000 === 0`).
   - `toInclusiveMs`: safe integer, aligned to UTC minute boundary (`% 60_000 === 0`).
   - Invariant: `fromInclusiveMs <= toInclusiveMs`.
2. **Query Semantics**:
   - SQL equivalent: `WHERE pair = ? AND open_time_ms >= ? AND open_time_ms <= ? ORDER BY open_time_ms ASC`.
   - Single pair only, strictly ascending by `openTimeMs`, zero duplicates.
3. **Outcome Handling**:
   - Successful query with zero matches: returns empty array `[]`.
   - Database / Prisma connection error: **MUST THROW** (never convert to `[]`).
   - Data mapping / decimal conversion failure: **MUST THROW**.
4. **Failure Reaction**: On any thrown error, Phase 6 remains `INITIALIZING` or `BLOCKED` and publishes zero derived events.
5. **Implementation Architecture**: `PrismaCandle1mRepository` will implement both `Candle1mRepository` and `Canonical1mRangeReader`, sharing the exact same row-to-domain mapping function. No duplicate mappers.

---

## 16. Warm Start Hydration Protocol

When the engine starts or restarts:
1. Inspect Phase 5 pair health. If ineligible, stay `INITIALIZING`/`BLOCKED`.
2. Call `Canonical1mRangeReader.getLatestCanonicalCandle(pair)` $\rightarrow T_{\text{latest}}$.
3. Compute hydration start anchor:
   $$\text{hydrationFromMs} = \min_{\text{TF}} \left( \left\lfloor \frac{T_{\text{latest}}}{\text{TF} \times 60\,000} \right\rfloor \times (\text{TF} \times 60\,000) \right)$$
4. Call `Canonical1mRangeReader.getRange(pair, hydrationFromMs, T_{\text{latest}})`.
5. Verify exact minute-by-minute continuity. If discontinuous, fail closed to `BLOCKED`.
6. Hydrate forming partial buckets for all configured timeframes.
7. **Do NOT replay historical closed events** from previous runs.
8. Re-check Phase 5 eligibility after DB reading. If eligible, transition to `READY`.

---

## 17. Composed Host Lifecycle & Run Ownership (P6A-05)

### Orchestrated Host Lifecycle Order
Phase 6 cannot function without an operational Phase 5:
- **System Startup Order**:
  1. `Phase 5 CanonicalMarketDataEngine` starts and establishes stream listeners.
  2. `Phase 6 HigherTimeframeEngine` starts.
  3. Phase 6 subscribes to Phase 5 events (`phase5.subscribe(...)`).
  4. Phase 6 executes startup hydration per pair.
  5. Pairs transition to `READY` as baseline continuity is proven.
- **System Shutdown Order**:
  1. `Phase 6 HigherTimeframeEngine` stops first.
  2. Phase 6 unbinds its Phase 5 subscription handle.
  3. Phase 6 increments its internal `runId`, invalidating in-flight async operations.
  4. `Phase 5 CanonicalMarketDataEngine` stops.
- **Phase 5 Restart Orchestration**:
  A Phase 5 stop invalidates all existing subscriptions (`subscribers.clear()`). If Phase 5 restarts, host orchestration must coordinate:
  $$\text{P6.stop}() \longrightarrow \text{P5.stop}() \longrightarrow \text{P5.start}() \longrightarrow \text{P6.start}() \longrightarrow \text{Fresh Subscription} \longrightarrow \text{Hydration/Resync}$$

### Engine Run Ownership (`#currentRunId`)
- Monotonic integer `#currentRunId` incremented on every `stop()`.
- Every asynchronous Phase 6 operation captures `capturedRunId = this.#currentRunId` before its first await.
- After every await and before mutating pair state or publishing events:
  $$\text{capturedRunId} === \text{this.\#currentRunId}$$
- Stale async callbacks from previous runs become completely inert.

---

## 18. Phase 6 Subscriber Safety & Exception Isolation (P6A-05)

To prevent downstream strategy or execution listeners from crashing or corrupting the engine:
1. **Recipient Snapshotting**: Snapshot active subscribers into an array before beginning iteration.
2. **Exception Isolation**: Each subscriber invocation is wrapped in a `try/catch` block; subscriber errors are logged and swallowed.
3. **Revalidation Across Synchronous Subscriber Mutation**: If a subscriber synchronously calls `stop()` or `start()`, the dispatch loop detects `capturedRunId !== this.#currentRunId` and terminates immediately.

---

## 19. Multi-Pair Isolation & Scalability

- All queues, constituent buffers, published keys, and states are strictly partitioned by `pair: string`.
- Gaps, faults, or recovery on `BTC-INR` have zero effect on `ETH-INR`.
- Adding new assets (e.g. `SOL-INR` in Phase 16) requires zero Phase 6 code alterations.

---

## 20. Persistence Decision & Database Schema Freezing

- **Zero DB Tables in Phase 6**: No `candles_2m`, `candles_5m`, etc.
- `candles_1m` remains the single persistent market-data truth.
- Zero Prisma schema changes, zero database migrations.

---

## 21. Pure Batch / Live Parity Contract

Given an identical ordered sequence of canonical 1-minute candles $C$:
$$\text{LiveDerivation}(C, \text{TF}) \equiv \text{BatchDerivation}(C, \text{TF})$$
Both produce byte-equivalent `HigherTimeframeCandle` objects across all financial values, counts, and boundaries.

---

## 22. Mandatory Test Contract Expansion

Implementation cannot close until all of the following tests pass:

### A. Health & Resync (P6A-01)
- `STALE -> HEALTHY` without `RECOVERY_COMPLETED` triggers `RESYNCING` and resumes live derived output.
- Fault-free `DEGRADED -> HEALTHY` resyncs correctly.
- Canonical 1m candles committed before recovery-completed notification are captured by `resyncHighWatermarkMs`.
- Permanent Phase 5 truth faults (`CANONICAL_CONFLICT`, `PERSISTENCE_FAILURE`, `BUFFER_OVERFLOW`, `TIME_INVALID`) never self-heal; Phase 6 stays `BLOCKED`.
- Eligibility lost during DB resync causes staged publications to be discarded and transitions to `BLOCKED`.

### B. Pair-Scoped Serialization (P6A-04)
- Live canonical event arriving while `getRange` is pending is queued and processed only after resync settles.
- Zero chronological inversion; zero duplicate bucket emissions.
- Live events with $\text{openTimeMs} \le \text{resyncHighWatermarkMs}$ are dropped as already covered.
- Live events with $\text{openTimeMs} > \text{resyncHighWatermarkMs}$ process normally after resync reaches `READY`.

### C. Safe Arithmetic (P6A-03)
- Reject `timeframeMinutes = 1` (fails closed, reserved for Phase 5).
- Reject zero, negative, fractional, `NaN`, and non-safe-integer durations.
- Verify safe duration calculation: $\text{durationMs} \le \text{MAX\_SAFE\_INTEGER}$.
- Verify safe bucket boundary calculations for high timestamps.

### D. Derived Aggregate Decimal (P6A-02)
- Valid 1m `CanonicalDecimal` inputs near maximum representable values.
- 1,440-candle sum requiring $>18$ integer digits (e.g. 22 digits) succeeds exactly.
- Sums requiring $>30$ digits of working precision succeed without premature rounding.
- Enforce 48-digit derived aggregate precision limit; overflow fails closed without exponents or NaN.
- Quote volume nullability propagation: any null constituent yields null aggregate; all non-null yields exact sum.

### E. Composed Lifecycle (P6A-05)
- Repeated `start()` calls do not duplicate Phase 5 subscriptions.
- `stop()` unsubscribes cleanly and bumps `runId`.
- Phase 5 restart coordinates fresh subscription.
- Stale async callbacks from prior runs cannot mutate new run state or publish events.
- Synchronous subscriber stop/restart during dispatch terminates iteration safely.

### F. Canonical 1m Range Reader (P6A-06)
- Inclusive endpoints: verifies both `fromInclusiveMs` and `toInclusiveMs` are returned.
- Ascending sort order by `openTimeMs`.
- Empty range returns `[]`.
- Invalid parameters (non-safe integers, non-minute aligned, from > to) fail closed.
- Database query failure throws (never swallowed to `[]`).
- Mapping/conversion failure throws.
- Read failures keep Phase 6 `INITIALIZING` or `BLOCKED`.

### G. Warm Start Hydration
- Hydration start anchor correctly calculates the earliest required bucket start across all enabled timeframes.
- Continuity verification over the loaded range fails closed if a minute is missing.
- Startup during an upstream Phase 5 blocked condition inhibits publication.

---

## 23. Phase Exclusions & Anti-Scope

Phase 6 **MUST NOT** implement:
1. CoinDCX REST querying or WebSocket frame parsing.
2. 1-minute canonical finality or storage.
3. Phase 5 recovery duplication.
4. Higher-timeframe MySQL database tables.
5. Technical indicators (Phase 8).
6. Quantitative trading strategies (Phase 10).
7. Backtest simulation engine (Phase 9).
8. Risk / leverage position sizing (Phase 13).
9. Orders and execution state machines (Phase 17).
10. Macroeconomic news filters (Phase 24).
11. UI telemetry dashboard (Phase 25).
