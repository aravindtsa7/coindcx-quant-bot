# Backtest Engine Foundation — Phase 9 Architecture & Specification

## 1. Executive Summary & Purpose

Phase 9 implements the **Backtest Engine Foundation** for the **CoinDCX Quant Futures Bot**. It provides a strictly deterministic, high-performance, event-driven historical simulation environment operating exclusively on verified Phase 7 canonical 1-minute datasets.

Phase 9 is:
- **Deterministic Offline Event Replay:** A single-pass causal timeline driven exclusively by historical bar timestamps, completely decoupled from system wall clocks.
- **Cryptographic Dataset Binding:** A two-pass research verification and streaming replay contract proving that canonical candle stream bytes match the verified Phase 7 dataset manifest before any backtest execution begins.
- **Conservative OHLCV Execution Simulation:** Mathematically rigorous order fill mechanics designed for 1-minute candles without fabricating unverifiable intrabar path, queue priority, or micro-latency.
- **Exact Cost & Ledger Accounting:** Comprehensive tracking of maker and taker exchange fees, non-negative spread and slippage cost attribution, causal perpetual futures funding cash flows, and exact position reversal accounting evaluated via a deterministic accounting ledger.
- **Auditable Result Generation:** Cryptographically verifiable simulation runs where every immutable configuration, ordered event sequence, and financial ledger produces bit-for-bit identical SHA-256 hashes (`runId`, `eventLedgerSha256`, `resultSha256`) across repeated executions.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UPSTREAM INPUT TRUTH                              │
│                                                                             │
│  Phase 7: HistoricalDatasetManifest + Cryptographically Bound 1m Stream     │
│  Phase 2/3: Discovered BacktestInstrumentSpec (Discovered Constraints)      │
│  Explicit Funding Rate Schedule (Verified Historical or Explicit Model)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Streaming Canonical 1m Candles
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       REPLAY & DERIVATION PIPELINE                          │
│                                                                             │
│  Phase 6: aggregateExactBucket(...) [Sole HTF aggregation primitive]        │
│  Phase 8: IndicatorKernel Instances [Exact incrementally updated kernels]   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Closed Multi-Timeframe Snapshots
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      EVALUATION & ORCHESTRATION PORT                        │
│                                                                             │
│  Immutable BacktestEvaluationContext (Simulation time T, closed data only)  │
│  External Participant Callback (Decoupled from Phase 10 Strategy Framework) │
│  Output: Deterministic Order Intents (Actions eligible at T+1m open)        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Order Intents (Next-Bar Open)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  PHASE 9 SIMULATED EXECUTION ENGINE                         │
│                                                                             │
│  - Phase A: Bar Open Activation, Order Cancellation & Market Fills          │
│  - Phase B: Conservative Intrabar OHLC Execution (ADVERSE_FIRST OCO + Seq)   │
│  - Phase C: Bar Close Mark-to-Market & HTF / Indicator Derivation           │
│  - Phase D: Causal Funding Settlement (surviving positions at T)            │
│  - Phase E: Evaluation Snapshot Assembly (closed market truth at T)         │
│  - 128-digit Isolated Decimal Context (BacktestCalcDecimal, ROUND_HALF_UP)  │
│  - Single Net Position (FLAT, LONG, SHORT) & Linear Futures Accounting      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Executed Fills & Ledger Transitions
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 AUDITABLE DETERMINISTIC ACCOUNTING & SINK                   │
│                                                                             │
│  - Monotonic BacktestEvent Sequence (eventLedgerSha256, LF-framed)          │
│  - Deterministic Accounting Ledger (Realized PnL, Unrealized PnL, Fees)     │
│  - Terminal Position & Terminal Open Orders (No synthetic liquidation)      │
│  - Deterministic SHA-256 Identifiers: runId, resultSha256                   │
│  - Pluggable Sink Architecture with Fail-Closed Sink Failure Semantics      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Scope & Strict Non-Goals

### 2.1 In-Scope (Phase 9 Foundation)
1. **Single-Pair Replay:** Exactly one instrument pair per simulation run.
2. **Cryptographically Bound Dataset Ingestion:** A two-pass verification contract consuming canonical 1-minute candles verified bit-for-bit against a Phase 7 `HistoricalDatasetManifest`.
3. **Pipelined Multi-Timeframe Synthesis:** Dynamic derivation of configured higher timeframes via Phase 6 `aggregateExactBucket` using common bootstrap alignment.
4. **Indicator Kernel Integration:** Incremental evaluation of real Phase 8 `IndicatorKernel` instances bound to the run's actual derived candle origins.
5. **Causal Event Loop:** Explicit 5-phase per-bar progression ensuring zero lookahead bias and causal next-bar order activation and cancellation.
6. **Order Types & Conservative Execution:** Strict all-or-none fills for `MARKET`, `POST_ONLY_LIMIT`, and `STOP_MARKET` orders, including intrabar `ADVERSE_FIRST` OCO candidate reduction merged into global sequence ordering, raw-open post-only marketability rejection, strict penetration for resting limits, gap-through stop pricing, strictly positive simulated execution prices, and whole-order rejection for reduce-only excess.
7. **Complete Financial Accounting:** 128-digit decimal precision (`BacktestCalcDecimal`) tracking initial equity, reversal realized gross PnL on closing quantity only, single fill fees, causal funding debits/credits, non-negative spread/slippage cost attribution, mark-to-market unrealized PnL, and terminal open order disclosure without synthetic liquidation.
8. **Cryptographic Lineage & Bounded Memory:** Defensive deep freezing of run inputs, recursive key-sorted canonical JSON, newline-framed `eventLedgerSha256`, deterministic `resultSha256`, and core replay working memory $O(\text{working state})$ decoupled from streaming sinks.

### 2.2 Explicit Non-Goals (Deferred to Later Phases)
To preserve architectural integrity and avoid overclaiming simulation fidelity, the following domains are strictly excluded from Phase 9:

- **Strategy Framework & Signal Definitions (Phase 10):** Phase 9 does not define strategy interfaces, signal schemas (`LONG`, `SHORT`, `FLAT`), parameter profiles, or indicators-to-signals logic. Phase 9 exposes only a low-level, simulator-specific evaluation port. Pure Phase 10 strategies are completely decoupled from backtest simulator mechanics.
- **Strategy Matrix Backtesting & Optimization (Phase 11):** Grid search, walk-forward analysis, genetic parameter optimization, and multi-regime simulation matrices belong to Phase 11.
- **Advanced Statistical Metrics (Phase 12):** Sharpe ratio, Sortino ratio, Calmar ratio, max drawdown curves, profit factor, expectancy, Monte Carlo permutations, and overfitting tests belong to Phase 12. Phase 9 emits only raw trades, fills, snapshots, and accounting ledger points.
- **Risk & Dynamic Leverage Engine (Phase 13):** Dynamic account sizing, margin utilization, liquidation buffer simulation, leverage tiers, and daily loss circuit breakers belong to Phase 13. Phase 9 accepts explicit quantities and does not simulate margin liquidation.
- **Paper Trading & Live WebSockets (Phase 14):** Real-time order simulation against live market feeds belongs to Phase 14. Phase 9 is entirely offline.
- **Live Order Submission & Exchange Reconciliation (Phases 17 & 18):** Live credentials, REST order dispatch, client order ID tracking, and exchange state reconciliation are prohibited in Phase 9.
- **Multi-Coin Portfolio Allocation (Phase 22):** Cross-pair capital rebalancing and portfolio-level risk allocation are prohibited.

---

## 3. Existing Upstream Contracts Reused

Phase 9 strictly adheres to the principle of zero duplicated mathematics by directly consuming the frozen contracts of preceding phases:

| Phase | Module / Contract | Location | Role in Phase 9 |
| :--- | :--- | :--- | :--- |
| **Phase 7** | `HistoricalDatasetManifest` | `src/market-data/historical/index.ts` | Authoritative dataset identity, boundaries, expected counts, and content hash. |
| **Phase 7** | `canonicalHashDecimal` | `src/market-data/historical/index.ts` | Exact textual decimal normalization for canonical row hashing. |
| **Phase 7** | `encodeHistoricalLogicalRow` | `src/market-data/historical/index.ts` | Exact byte encoding for canonical logical rows (`pair\|time\|O\|H\|L\|C\|V\|QV\n`). |
| **Phase 7** | `computeDatasetId` | `src/market-data/historical/index.ts` | Exact canonical envelope calculation for `datasetId`. |
| **Phase 7** | `CanonicalCandle1m` | `src/market-data/types.ts` | Atomic 1-minute input candles. |
| **Phase 7** | `Canonical1mRangeReader` | `src/market-data/higher-timeframe/types.ts` | Paged repository access for canonical historical bars. |
| **Phase 6** | `aggregateExactBucket` | `src/market-data/higher-timeframe/aggregate-exact-bucket.ts` | The **sole** higher-timeframe aggregation mathematics primitive. |
| **Phase 6** | `timeframe.ts` | `src/market-data/higher-timeframe/timeframe.ts` | Timeframe validation, duration calculations, and bucket boundary math. |
| **Phase 8** | `IndicatorKernel<T>` | `src/indicators/types.ts` | Real incremental indicator calculation kernels. |
| **Phase 8** | `adaptCanonicalCandle1m`<br>`adaptHigherTimeframeCandle`<br>`adaptIndicatorCandle` | `src/indicators/candle/adapter.ts` | Normalized candle view adapters feeding indicator kernels. |
| **Phase 8** | `IndicatorCalculationSegmentIdentity` | `src/indicators/types.ts` | Segment identity enforcing frozen `bootstrapStartOpenTimeMs`. |
| **Phase 2/3** | `InstrumentMetadata` | `src/coin-runtime/types.ts` | Discovered tick size (`priceIncrement`), step size (`quantityIncrement`), `minQuantity`, `minTradeSize`, `minNotional`, and multiplier (`unitContractValue`). |

---

## 4. Single-Pair Simulation Scope

Each Phase 9 backtest run is strictly bounded to:
1. **Exactly ONE Instrument Pair** (e.g., `BTC-INR` or `ETH-INR`).
2. **Exactly ONE Canonical Historical Dataset**.
3. **Exactly ONE Deterministic Event Timeline**.

Multi-coin portfolio backtesting is explicitly barred. Cross-instrument capital allocation, multi-symbol correlation analysis, and cross-coin event interleaving introduce non-deterministic ordering ambiguities and belong to Phase 22. Running multi-coin analyses in research is achieved by launching independent, parallel Phase 9 backtest runs per instrument.

---

## 5. Historical Dataset Verification Contract & Stream Binding (P9-SPEC-01)

### 5.1 The Binding Ambiguity & Immutable Two-Pass Research Contract
A critical integrity requirement of Phase 9 is eliminating any possibility of dataset substitution:
> **Core Architectural Law:** A Phase 9 production research run MUST NOT accept a valid `HistoricalDatasetManifest` $A$ paired with a different canonical candle stream $B$. Valid manifest $A$ + candle stream $B$ is **NEVER ACCEPTED**.

To guarantee bit-for-bit cryptographic binding without retaining multi-year datasets in memory, production research runs execute under a frozen **Two-Pass Input Contract**:

```
                          PRODUCTION TWO-PASS PIPELINE

  [ Historical Source ]
           │
           ├─► PASS 1: FULL MANIFEST VERIFICATION
           │     1. Stream entire manifest range [fromInclusiveMs, toExclusiveMs).
           │     2. Prove continuity, exact candle count, and boundary timestamps.
           │     3. Compute content SHA-256 via encodeHistoricalLogicalRow.
           │     4. Assert computed contentSha256 === manifest.contentSha256.
           │     5. Assert computed datasetId === manifest.datasetId.
           │     6. PASS 1 FAILURE ──► DATASET_IDENTITY_MISMATCH (Run Fails Closed).
           │
           └─► PASS 2: STREAMING REPLAY (Only After Pass 1 Succeeds)
                 1. Stream replay slice [bootstrapFromInclusiveMs, replayToExclusiveMs).
                 2. Read from the IDENTICAL immutable Phase 7 canonical source identity.
                 3. Feed replay engine O(working state).
```

### 5.2 Pass 1 — Manifest Verification
Before `RUN_STARTED`, `REPLAYING`, evaluation, orders, fills, or any valid backtest event is emitted:
1. The historical adapter must verify the **COMPLETE** manifest range:
   $$[\text{manifest.fromInclusiveMs}, \text{manifest.toExclusiveMs})$$
   not merely the requested Phase 9 replay subset.
2. Verification must prove:
   - `pair`: Matches configured run pair exactly.
   - `exact minute order`: Monotonically increasing by exactly 60,000 ms.
   - `exact continuity`: Zero missing, duplicate, or backwards minutes.
   - `expectedCandleCount` and `actualCandleCount`: Exactly equal $(\text{toExclusiveMs} - \text{fromInclusiveMs}) / 60\,000$.
   - `firstOpenTimeMs`: Exactly equals $\text{manifest.fromInclusiveMs}$.
   - `lastOpenTimeMs`: Exactly equals $\text{manifest.toExclusiveMs} - 60\,000$.
   - `contentSha256`: Bit-for-bit match against the manifest hash.
   - `datasetId`: Bit-for-bit match against the manifest `datasetId`.
3. **Exact Phase 7 Hash Contract:** The content hash bytes **MUST** use the exact Phase 7 canonical logical-row contract already frozen in Phase 7:
   - The logical row is formatted as:
     $$\text{pair} \mid \text{openTimeMs} \mid \text{open} \mid \text{high} \mid \text{low} \mid \text{close} \mid \text{volume} \mid \text{quoteVolume} \ \backslash\text{n}$$
   - Encoded via UTF-8 bytes using Phase 7 exported primitives:
     ```typescript
     encodeHistoricalLogicalRow(row: HistoricalLogicalRow): Buffer
     canonicalHashDecimal(value: CanonicalDecimal | string): string
     computeDatasetId(pair: string, range: HistoricalRange, contentSha256: string): string
     ```
   - Quote volume is formatted as `'N'` if `null`, or `canonicalHashDecimal(quoteVolume)`.
   - Prohibitions: JSON candle hashing, alternate decimal normalization, alternate field order, and alternate newline framing are **strictly forbidden**.

### 5.3 Pass 2 — Replay
1. Only after full manifest verification in Pass 1 succeeds may Phase 9 stream the replay span:
   $$[\text{bootstrapFromInclusiveMs}, \text{replayToExclusiveMs})$$
   into the simulation event loop.
2. Production Pass 2 must read from the **SAME immutable Phase 7 canonical source identity** used for verification. Historical canonical rows represented by a completed manifest are immutable under the Phase 7 offline/no-concurrent-writer safety boundary.
3. If the adapter cannot guarantee the same immutable source across verification and replay, the engine must **fail closed**.
4. Unit tests and local testing fixtures may use deterministic in-memory verified fixtures where Pass 1 and Pass 2 stream from the same verified immutable array.

### 5.4 Fail-Closed Verification Rules
Any mismatch during Pass 1 or Pass 2 terminates the run immediately:
- Manifest mismatch / content mismatch / source substitution: `DATASET_IDENTITY_MISMATCH` $\to$ run `FAILED` $\to$ `isValid = false` $\to$ no valid result.
- Missing candle / gap: `DATASET_GAP`.
- Timestamp out-of-order or duplicate: `DATASET_ORDER_VIOLATION`.
- Structural OHLC violation ($high < low$, $high < open$, $high < close$, $low > open$, $low > close$, or negative volume): `DATASET_ORDER_VIOLATION`.
- Replay range outside manifest range: `DATASET_RANGE_INVALID`.

Synthetic gap filling, linear interpolation, previous-close copying, and forward-filling are **strictly prohibited**.

---

## 6. Streaming Input & Memory Guarantees

### 6.1 Core Replay Engine vs. Event/Result Sink
To ensure deterministic execution and scalability across multi-year 1-minute datasets without memory exhaustion, the architecture strictly distinguishes two memory layers:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CORE REPLAY ENGINE MEMORY LAYER                          │
│                                                                             │
│  Bounded strictly to working state:                                         │
│  - Active HTF constituent ring buffers (bounded to M elements)              │
│  - Phase 8 indicator kernels (bounded to O(period) or O(1))                 │
│  - Active orders (bounded to maxOpenOrders <= 100)                          │
│  - Single net position & running accounting accumulators                    │
│  - Small monotonic sequence counters                                        │
│                                                                             │
│  Core Engine Memory = O(working state) != O(historical candle count)        │
│  MUST NOT retain historical candles, fills, trades, or event objects!       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Emits Frozen BacktestEvent Snapshots
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PLUGGABLE BACKTEST EVENT SINK                           │
│                                                                             │
│  - InMemoryBacktestSink: For tests and small research runs.                 │
│    Intentionally retains O(total emitted records) in caller memory.         │
│  - StreamingBacktestSink: For multi-year production research runs.          │
│    Streams events directly to disk/storage or computes rolling hashes.      │
│  - Core BacktestRunResult summary does not require full fill/trade arrays.  │
└─────────────────────────────────────────────────────────────────────────────┘
```

The core replay engine must never accumulate raw historical candles, executed fills, closed trades, or emitted events in memory:
$$\text{Memory}_{\text{core}} = O(\text{Active HTF Buffers} + \text{Indicator State} + \text{Open Orders} + \text{Position State})$$
$$\text{Memory}_{\text{core}} \ne O(\text{Total Historical Candle Count})$$

If the user-facing result API exposes fill or trade collections, those collections are sink-produced references or optional collected materializations, never mandatory core replay working state.

### 6.2 Fatal Event Sink Failure Semantics (P9-SPEC-12)
Event sink persistence is an essential component of the audit ledger. Therefore, event sink failure is **FATAL**:
1. If the injected `BacktestEventSink` throws an error or fails to persist an event:
   - The simulation engine halts immediately.
   - The run transitions to state `FAILED`.
   - `isValid` is set to `false`.
   - The terminal error code is set to `BACKTEST_RUN_FAILED` with the preserved root-cause error and context.
   - No valid `COMPLETED` result may be published.
   - The audit ledger is marked incomplete; fabricating a complete `eventLedgerSha256` upon sink failure is strictly barred.
   - Diagnostic failure metadata may be returned to caller diagnostics outside the valid event ledger.
2. Log-and-continue, silent event drop, and optimistic error swallowing are **strictly prohibited**.

---

## 7. Backtest Time Boundaries & Exact Range Semantics

A backtest run defines four strictly ordered, minute-aligned UTC epoch millisecond boundaries:

```
dataset.fromInclusiveMs
   │
   ▼
[======================== HISTORICAL DATASET ========================)
   │                                                                 │
   ├───────────────┬───────────────────┬─────────────────┬───────────┤
   │               │                   │                 │           │
   ▼               ▼                   ▼                 ▼           ▼
bootstrapFrom   evaluationFrom     evaluationTo      replayTo    dataset.toExclusiveMs
InclusiveMs     InclusiveMs        ExclusiveMs       ExclusiveMs
```

### 7.1 Strict Ordering Constraint
$$\text{dataset.fromInclusiveMs} \le \text{bootstrapFromInclusiveMs} \le \text{evaluationFromInclusiveMs} < \text{evaluationToExclusiveMs} \le \text{replayToExclusiveMs} \le \text{dataset.toExclusiveMs}$$

Every boundary timestamp must be:
- A JavaScript safe integer (`Number.isSafeInteger(t) === true`).
- A UTC epoch millisecond value.
- Exact 60,000 ms (1-minute) aligned (`t % 60_000 === 0`).

### 7.2 Exact Edge & Replay Range Semantics
When referring to the **backtest replay range**, the architecture explicitly specifies the half-open interval:
$$[\text{bootstrapFromInclusiveMs}, \text{replayToExclusiveMs})$$

All four edges have unambiguous operational definitions:
1. **`bootstrapFromInclusiveMs`:**
   - The open timestamp of the first replayed canonical 1m source candle.
   - This candle spans $[\text{bootstrapFromInclusiveMs}, \text{bootstrapFromInclusiveMs} + 60\,000)$.
2. **`evaluationFromInclusiveMs`:**
   - The first eligible evaluation timestamp, inclusive.
   - Strategy evaluation callbacks may first occur at this timestamp (observing data closed at or before this timestamp).
3. **`evaluationToExclusiveMs`:**
   - Strategy evaluation at exactly this timestamp is **strictly forbidden**.
   - No evaluation callbacks occur at or after this timestamp.
4. **`replayToExclusiveMs`:**
   - Replay consumption barrier: source candle OPEN timestamps are consumed only while $\text{openTimeMs} < \text{replayToExclusiveMs}$.
   - Therefore, the **final replayed source candle** in the backtest is:
     $$[\text{replayToExclusiveMs} - 60\,000, \text{replayToExclusiveMs})$$
   - Its CLOSE is processed at $\text{replayToExclusiveMs}$, including: execution finalization, mark-to-market valuation, analysis closure, and any funding event scheduled at $\text{replayToExclusiveMs}$.
   - No evaluation occurs at $\text{replayToExclusiveMs}$ because $\text{evaluationToExclusiveMs} \le \text{replayToExclusiveMs}$ prohibits evaluation at or after $\text{evaluationToExclusiveMs}$.

### 7.3 Functional Boundary Roles
1. **`[bootstrapFromInclusiveMs, evaluationFromInclusiveMs)` — Warmup Period:**
   - Canonical 1m candles are streamed to populate higher-timeframe buckets and warm up Phase 8 indicator kernels.
   - Intrabar execution and evaluation callbacks are **disabled**.
   - No orders may be submitted, activated, or filled.
2. **`[evaluationFromInclusiveMs, evaluationToExclusiveMs)` — Active Strategy Evaluation Window:**
   - Full simulation active.
   - At each closed bar boundary, the external evaluation port is invoked to generate strategy actions.
   - Simulated orders are activated and filled.
3. **`[evaluationToExclusiveMs, replayToExclusiveMs)` — Terminal Observation Window:**
   - Evaluation callbacks are **halted**; no new strategy orders may be submitted.
   - Existing open orders and positions remain active and continue to execute against market truth.
   - Allows observation of natural position exits, trailing stops, or terminal market behaviour without strategy interference.

---

## 8. Multi-Timeframe Bootstrap Alignment & Indicator Binding

### 8.1 Higher-Timeframe Common Bootstrap Alignment
To prevent unaligned constituent slices or fabricated partial bars, `bootstrapFromInclusiveMs` must be aligned to **EVERY** configured higher timeframe bucket $M \in \text{configuredTimeframes}$:
$$\text{bucketStartMs}(\text{bootstrapFromInclusiveMs}, M) === \text{bootstrapFromInclusiveMs}$$
$$\iff \text{bootstrapFromInclusiveMs} \pmod{M \times 60\,000} === 0$$

- If any configured higher timeframe is not aligned to `bootstrapFromInclusiveMs`, the run fails closed immediately at validation with `TIMEFRAME_CONFIGURATION_INVALID`.
- Fabricating hidden pre-bootstrap constituent minutes to complete an unaligned bucket is strictly prohibited.

### 8.2 Phase 8 Indicator Binding Contract
Indicators are integrated using real Phase 8 `IndicatorKernel` instances bound via an immutable descriptor:

```typescript
export interface BacktestIndicatorBinding<T = unknown> {
  readonly key: string;
  readonly timeframeMinutes: number;
  readonly kernel: IndicatorKernel<T>;
}
```

**Origin Binding Rules:**
1. **1m Indicator Kernel:**
   - The kernel's `segment.bootstrapStartOpenTimeMs` must exactly equal `bootstrapFromInclusiveMs`.
2. **HTF Indicator Kernel (timeframe $M$):**
   - The kernel's `segment.bootstrapStartOpenTimeMs` must bind to the **actual first Phase 6 `HigherTimeframeCandle` open timestamp produced by the run for $M$**.
   - Under common bootstrap alignment, this derived candle open timestamp equals `bootstrapFromInclusiveMs`. The engine binds to the actual derived candle open rather than assuming or fabricating it.
   - The Phase 8 exact-origin contract remains authoritative: indicator state is valid only within the segment defined by that origin.
3. **Warmup Null Preservation:** Phase 8 kernels emit `value: null` during warmup. The backtest engine must preserve `null` values; coercing warmup `null` to `0`, `NaN`, or synthetic numbers is prohibited.
4. **Pure Adapter Feeding:** Candles are adapted exclusively using Phase 8's `adaptCanonicalCandle1m` or `adaptHigherTimeframeCandle`.

---

## 9. Higher-Timeframe Derivation Rule

Phase 9 **never** implements OHLC candle aggregation logic.

For every higher-timeframe bar closing at timestamp $T$:
```typescript
const htfCandle = aggregateExactBucket(constituent1mCandles, timeframeMinutes);
```
- **Sole Primitive:** Phase 6 `aggregateExactBucket` is the only permissible aggregation function.
- **Completeness:** Exactly $M$ contiguous canonical 1m constituent candles must be supplied.
- **Failure Mode:** Any missing, duplicate, or discontinuous constituent fails the run immediately with `TIMEFRAME_CONFIGURATION_INVALID` or `DATASET_GAP`.
- **Prohibitions:** Third-party resampling libraries, exchange-provided HTF candles, and custom Phase 9 aggregation loops are banned.

---

## 10. Event Clock & Critical No-Lookahead Contract

The **only** clock within the simulation engine is historical event time.
- **Prohibited:** `Date.now()`, `new Date()` (for decision logic), wall-clock intervals, `setTimeout`, `setImmediate`, process scheduling, and local timezones.
- **Visibility Barrier:** A canonical 1-minute bar spanning $[t, t + 60\,000\text{ ms})$ has an opening timestamp $t$ and an exclusive closing timestamp $t + 60\,000\text{ ms}$.
- **No Lookahead:** The bar's $high$, $low$, and $close$ are completely unknown until $t + 60\,000\text{ ms}$. At bar open $t$, only historical data up to $t$ is visible.

---

## 11. Exact Per-Bar Event Sequence & Cancellation Causality

To eliminate lookahead bias and establish strict deterministic causality, every canonical 1-minute bar $\text{BAR} = [\text{openTimeMs}, \text{closeTimeExclusiveMs})$ progresses through five immutable phases:

```
BAR = [openTimeMs, closeTimeExclusiveMs)

  │
  ├─► PHASE A: BAR OPEN (simulationTimeMs = openTimeMs)
  │     1. Apply cancellations and order modifications accepted at previous evaluation boundary.
  │     2. Activate pending orders submitted from previous evaluation boundary.
  │     3. Process eligible MARKET fills using this bar's OPEN as raw reference price.
  │
  ├─► PHASE B: INTRABAR EXECUTION (Engine-Private OHLC)
  │     4. Determine eligible resting POST_ONLY_LIMIT, STOP_MARKET, and OCO exit orders against bar OHLC.
  │     5. Apply ADVERSE_FIRST to eligible OCO pairs, then sort all candidates by orderSequence ascending.
  │     6. Sequentially revalidate and execute fills; immediately cancel and emit sibling on OCO fill.
  │
  ├─► PHASE C: BAR CLOSE (simulationTimeMs = closeTimeExclusiveMs)
  │     7. Finalize execution fills and update position state.
  │     8. Mark open position to bar CLOSE for unrealized PnL and equity accounting.
  │     9. Publish finalized 1m candle to analysis pipeline.
  │    10. Synthesize closing Higher Timeframe candles via aggregateExactBucket (ascending duration order).
  │    11. Update Phase 8 IndicatorKernel instances for all candles closed at this timestamp.
  │
  ├─► PHASE D: FUNDING SETTLEMENT (simulationTimeMs = closeTimeExclusiveMs)
  │    12. If a funding event is scheduled at closeTimeExclusiveMs, apply funding to surviving position.
  │    13. Emit FUNDING_APPLIED event (even if FLAT, fundingPnl = 0).
  │
  └─► PHASE E: EVALUATION SNAPSHOT (simulationTimeMs = closeTimeExclusiveMs)
       14. Assemble immutable BacktestEvaluationContext from closed data (including funding just applied).
       15. If within [evaluationFromInclusiveMs, evaluationToExclusiveMs), invoke external evaluation callback.
       16. Output order intents and cancellations become effective NO EARLIER than NEXT bar open.
```

### 11.1 Same-Timestamp Causality & Cancellation Causality
Bar Close (Phase C), Funding (Phase D), and Evaluation (Phase E) occur at timestamp $T = \text{closeTimeExclusiveMs}$. The next bar's Open (Phase A) occurs at the identical timestamp $T$.

Causality is established by the **strict order of operations**, not timestamp inequality:
$$\text{Prior Bar Close} \longrightarrow \text{Funding Settlement} \longrightarrow \text{Evaluation Callback} \longrightarrow \text{Next Bar Open}$$

1. An order generated at evaluation timestamp $T$ can **never** fill on the bar that closed at $T$. It fills at earliest on the next bar opening at $T$.
2. **Cancellation Causality:** A cancellation action accepted at evaluation timestamp $T$ becomes effective at the **NEXT source bar open at $T$ BEFORE any order activation, market fills, or intrabar fills for that bar**:
   - If the next bar opens with a gap that would breach the cancelled order's trigger or limit price, **the cancellation wins**.
   - The cancelled order is marked `CANCELLED` at bar open and **cannot fill in that next bar**.
   - This is an explicit conservative causal guarantee preventing lookahead or optimistic fill race conditions.

---

## 12. Multi-Timeframe Same-Timestamp Ordering

When multiple timeframes close at the identical timestamp $T$:
1. The canonical **1m bar closes first**.
2. Derived higher-timeframe bars close in **strictly ascending `timeframeMinutes` order** (e.g., $2\text{m} \to 3\text{m} \to 5\text{m} \to 15\text{m} \to 1\text{h} \to 4\text{h} \to 1\text{d}$).
3. Indicators bound to those timeframes are updated immediately following the closure of their respective candle.
4. All candle closures and indicator updates at $T$ complete **before** funding settlement and the evaluation callback at $T$.

A strategy evaluating at $T$ observes fully finalized bars for all timeframes closing at $T$. It can **never** observe forming or partial candles.

---

## 13. Immutable Evaluation Snapshot

The external evaluation port receives a frozen, read-only snapshot:

```typescript
export interface BacktestEvaluationContext {
  readonly simulationTimeMs: number;
  readonly latestClosed1mCandle: CanonicalCandle1m;
  readonly latestClosedCandleByTimeframe: ReadonlyMap<number, CanonicalCandle1m | HigherTimeframeCandle>;
  readonly candlesClosedAtThisTimestamp: readonly (CanonicalCandle1m | HigherTimeframeCandle)[];
  readonly latestIndicatorPointByKey: ReadonlyMap<string, IndicatorPoint<unknown>>;
  readonly currentPosition: BacktestPositionSnapshot;
  readonly accountEquity: BacktestEquitySnapshot;
  readonly openOrders: readonly BacktestOrderSnapshot[];
}
```

**Security & Isolation Guarantees:**
- Contains no references to mutable engine internals.
- Exposes no future bars or unclosed intrabar data.
- Contains no network clients, database connections, or system clock handles.
- All values are deeply frozen.

---

## 14. Strategy Boundary & External Orchestration Port

Phase 9 strictly decouples simulation execution from strategy definition:
- **Phase 10 Owns:** Strategy interfaces, signal schemas (`LONG`, `SHORT`, `FLAT`), parameter profiles, and strategy state.
- **Phase 9 Exposes:** A generic execution orchestration port:

```typescript
export interface BacktestParticipantAdapter {
  onEvaluation(context: BacktestEvaluationContext): Promise<BacktestActionBatch> | BacktestActionBatch;
}

export interface BacktestActionBatch {
  readonly cancelOrderIds?: readonly string[];
  readonly submitOrders?: readonly BacktestOrderIntent[];
}
```

### 14.1 Uniform Strategy Decoupling Contract
> **Architectural Boundary:** The generic Phase 9 participant port is **NOT** the Phase 10 strategy interface.

1. Phase 10 pure strategy logic receives only analytical market data permitted by **Invariant 9** (closed candles, indicator values) and produces abstract signals.
2. The operational flow in research and live trading is unified:
   $$\text{Pure Strategy Logic} \longrightarrow \text{Abstract Signal} \longrightarrow \text{Environment Orchestrator / Risk Adapter} \longrightarrow \text{Execution Pipe}$$
3. Backtest-specific account, order, or simulator states must **never** become hidden inputs to pure Phase 10 strategy logic. There are no backtest-only strategy superpowers.

---

## 15. Financial Decimal Architecture & Price Positivity (P9-SPEC-03)

Native JavaScript floating-point (`number`) arithmetic is **strictly prohibited** across all financial, balance, order, and position calculations.

### 15.1 Isolated Calculation Decimal (`BacktestCalcDecimal`)
All internal financial mathematics executes within an isolated Decimal.js context:
```typescript
export const BacktestCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -160,
  toExpPos: 160,
});
```
This context handles all calculations for prices, quantities, notional values, contract multipliers, fees, funding, spread, slippage, realized/unrealized PnL, and equity.

### 15.2 Public Envelope (`BacktestDecimal`)
All public-facing outputs are wrapped in an immutable, signed `BacktestDecimal` contract matching the Phase 8 envelope philosophy:
- Maximum fractional digits (scale): $\le 18$
- Maximum integer digits: $\le 30$
- Maximum total precision: $\le 48$
- Fixed-point string representation only (scientific exponent notation barred)
- Quantization: `ROUND_HALF_UP`
- Negative zero normalization: `"-0"` $\to$ `"0"`
- Non-finite values (`NaN`, `Infinity`, `-Infinity`) fail closed immediately (`BACKTEST_NUMERIC_FAILURE`).

**Quantization Boundary Rule:** 128-digit internal calculation values are never repeatedly quantized to 18 decimal places during intermediate steps. Quantization occurs solely when emitting final immutable public snapshots.

### 15.3 Execution Price Positivity Contract
For `MARKET` and `STOP_MARKET` adverse execution math:
1. Computed simulated execution price **MUST be strictly $> 0$**.
2. Any zero, negative, NaN, Infinity, or numeric overflow fails closed immediately (`BACKTEST_NUMERIC_FAILURE`).
3. Cost configuration sanity check: To guarantee that adverse `SELL` adjustments cannot produce a non-positive price, cost parameters must satisfy:
   $$\text{halfSpreadRate} + \text{marketSlippageRate} < 1$$
   $$\text{halfSpreadRate} + \text{stopSlippageRate} < 1$$
   with all rates $\ge 0$. Any configuration violating these bounds fails closed at validation with `COST_MODEL_INVALID`. All arithmetic exact decimal.

---

## 16. Discovered Instrument Specification Snapshot (P9-SPEC-02)

To preserve **Invariant 4** (No Coin-Specific Hardcoding), the engine accepts an immutable instrument specification mapped from Phase 2/3:

```typescript
export interface BacktestInstrumentSpec {
  readonly pair: string;
  readonly priceIncrement: BacktestDecimal;       // Tick size
  readonly quantityIncrement: BacktestDecimal;    // Quantity step size (lot step)
  readonly minQuantity: BacktestDecimal;          // Minimum order quantity
  readonly minTradeSize: BacktestDecimal;         // Minimum trade size (distinct constraint)
  readonly minNotional: BacktestDecimal;          // Minimum trade notional
  readonly contractMultiplier: BacktestDecimal;    // unitContractValue
  readonly instrumentSpecSnapshotId: string;      // Canonical SHA-256 hash of spec
}
```

Do not collapse `minQuantity` and `minTradeSize` as the exchange and repository enforce them independently.

### 16.1 Constraint Validation Timing
1. **At Order Submission:**
   The engine validates using exact `BacktestCalcDecimal` arithmetic (native `Number` modulo is barred):
   - `pair` matches spec pair.
   - `quantity > 0`.
   - `quantity % quantityIncrement === 0` (exact divisibility).
   - `quantity >= minQuantity`.
   - `quantity >= minTradeSize`.
   - If `limitPrice` present: `limitPrice > 0` and `limitPrice % priceIncrement === 0`.
   - If `stopPrice` present: `stopPrice > 0` and `stopPrice % priceIncrement === 0`.
2. **Minimum Notional Validation:**
   - Because `MARKET` execution prices are not known until activation/fill, `minNotional` is validated using the **actual simulated execution price before position mutation or fill commitment**.
   - For priced orders (`POST_ONLY_LIMIT`), submission performs a conservative pre-check, but actual fill-time executed notional validation remains authoritative.
3. Constraint violation fails closed with `INSTRUMENT_CONSTRAINT_VIOLATION`. No fill or position mutation occurs.

---

## 17. Linear Perpetual Futures Accounting & Reversal PnL (P9-SPEC-05)

Phase 9 supports CoinDCX INR-Margined Perpetual Futures. All PnL is linear and margined in INR using the instrument's contract multiplier ($M = \text{unitContractValue}$):

### 17.1 Long Position PnL
$$\text{Gross Realized PnL} = (\text{Exit Price} - \text{Entry Price}) \times \text{Closing Quantity} \times M$$

### 17.2 Short Position PnL
$$\text{Gross Realized PnL} = (\text{Entry Price} - \text{Exit Price}) \times \text{Closing Quantity} \times M$$

### 17.3 Position Weighted-Average Entry Price
When scaling into an existing position of quantity $Q_{\text{existing}}$ at price $P_{\text{existing}}$ with a fill of quantity $Q_{\text{fill}}$ at price $P_{\text{fill}}$:
$$P_{\text{new}} = \frac{(Q_{\text{existing}} \times P_{\text{existing}}) + (Q_{\text{fill}} \times P_{\text{fill}})}{Q_{\text{existing}} + Q_{\text{fill}}}$$

### 17.4 Exact Reversal Accounting
When an opposing fill exceeds open position quantity, it partially closes the existing position and opens a reversed position:
- Existing position quantity: $Q_{\text{existing}}$.
- Opposing fill quantity: $Q_{\text{fill}}$.
- Closing quantity: $\text{closingQuantity} = \min(Q_{\text{existing}}, Q_{\text{fill}})$.
- **Realized PnL Rule:** Realized PnL is calculated **ONLY** on $\text{closingQuantity}$. Never on the full fill quantity if the fill reverses.
- Remaining opening quantity: $\text{remainingQuantity} = Q_{\text{fill}} - \text{closingQuantity}$.
- If $\text{remainingQuantity} > 0$:
  - A new position in the reversed direction is opened with quantity $\text{remainingQuantity}$ at the **SAME fill price**.
  - The opening portion generates **ZERO realized PnL** at entry.
- **Single Fee Calculation:** One fill receives **ONE** exchange fee calculation based on the total executed notional ($Q_{\text{fill}} \times \text{fillPrice} \times M$). The engine does not charge duplicate close-leg + open-leg fees.

---

## 18. Order Model & Resource Bounds (P9-SPEC-10)

### 18.1 Supported Order Types
Phase 9 foundation supports exactly three deterministic order types:
1. **`MARKET`:** Immediate execution at next bar open with adverse spread and slippage.
2. **`POST_ONLY_LIMIT`:** Passive resting limit order; strictly rejected if marketable at activation.
3. **`STOP_MARKET`:** Protective or breakout stop order triggered when intrabar price crosses `stopPrice`.

Time In Force is foundation **GTC** (Good 'Til Cancelled). Deterministic cancellation is supported.

### 18.2 Order Identification
Order IDs are deterministically generated from the run ID and a monotonic sequence counter:
$$\text{orderId} = \langle \text{runId} \rangle\text{:ORDER:}\langle \text{sequence} \rangle$$
No random UUIDs or wall-clock timestamps are permitted.

### 18.3 Order Lifecycle State Machine
```
              [SUBMISSION AT EVALUATION BOUNDARY]
                                │
                                ▼
                       PENDING_ACTIVATION
                                │
             ┌──────────────────┼──────────────────┐
             │ (Marketable      │ (Legitimate      │ (Cancelled
             │  Post-Only)      │  Activation)     │  Before Open)
             ▼                  ▼                  ▼
          REJECTED             OPEN            CANCELLED
                                │
             ┌──────────────────┴──────────────────┐
             │ (Execution                          │ (Explicit
             │  Condition Met)                     │  Cancellation)
             ▼                                     ▼
           FILLED                              CANCELLED
```

### 18.4 Resource Bounds & `maxOpenOrders` in Run Identity
To prevent unbounded order state and memory exhaustion:
- Default `maxOpenOrders`: `20`. Hard upper ceiling: `100`.
- **Run Identity Binding:** The effective `maxOpenOrders` is an immutable parameter frozen directly into `BacktestRunManifest`. Altering `maxOpenOrders` alters `runId`.
- **Active Order Accounting:** Only `PENDING_ACTIVATION` and `OPEN` orders count toward `maxOpenOrders`. Terminal states (`FILLED`, `CANCELLED`, `REJECTED`) do not count.
- **OCO Orders:** Each leg of an OCO pair counts as an individual active order toward `maxOpenOrders`.
- Exceeding `maxOpenOrders` upon submitting an order rejects the order with `ORDER_INVALID`. Unbounded order state allocation is barred.

---

## 19. Conservative Fill Mechanics & Zero Queue Fabrication

### 19.1 Fundamental Principle: No Partial-Fill or Queue Fabrication
1-minute OHLCV candles provide four boundary prices and total aggregate volume. They do **not** reveal:
- The sequence of intrabar price fluctuations.
- Order-book depth or queue position.
- Volume traded at specific price points.

Therefore, Phase 9 enforces:
1. **All-or-None Fills:** Simulated orders execute for their full quantity or do not execute.
2. **Zero Queue Fabrication:** The engine never simulates microsecond order-book queue progression.
3. **Result Disclosure:** Every run result explicitly records `partialFillModel: 'NOT_MODELED_PHASE9'` and `queueModel: 'NOT_MODELED_PHASE9'`.

---

## 20. Execution Fill Models & Post-Only Marketability

### 20.1 Market Order Fill Model
- Submitted at evaluation boundary $T$.
- **Earliest Fill:** Next canonical bar opening at $T$.
- **Raw Reference Price:** Next bar $\text{OPEN}$.
- **Adverse Adjustment:** Half-spread + configured market slippage.
  - **BUY:** $\text{fillPrice} = \text{OPEN} \times (1 + \text{halfSpreadRate} + \text{marketSlippageRate})$
  - **SELL:** $\text{fillPrice} = \text{OPEN} \times (1 - \text{halfSpreadRate} - \text{marketSlippageRate})$
- Execution price positivity is strictly enforced ($\text{fillPrice} > 0$). Fee class: `TAKER`.

### 20.2 Post-Only Limit Order Fill Model
- **Initial Activation Check (at Bar Open):**
  - BUY Limit with $\text{limitPrice} \ge \text{bar.OPEN}$: Rejected as `POST_ONLY_WOULD_TAKE`.
  - SELL Limit with $\text{limitPrice} \le \text{bar.OPEN}$: Rejected as `POST_ONLY_WOULD_TAKE`.
  - **Rationale:** Raw $\text{bar.OPEN}$ represents the actual consolidated transaction price opening the 1-minute interval. Synthesizing a hypothetical bid/ask from `halfSpreadBps` at bar open would introduce an unverified micro-spread assumption without order-book depth truth. Using raw $\text{bar.OPEN}$ provides a strict, deterministic, and conservative crossing barrier that rejects any order that would execute against the opening print.
- **Resting Intrabar Execution (Strict Penetration):**
  - BUY Limit fills **only** if market trades strictly through: $\text{bar.LOW} < \text{limitPrice}$.
  - SELL Limit fills **only** if market trades strictly through: $\text{bar.HIGH} > \text{limitPrice}$.
- **Equality Touch Rule:** A mere touch ($\text{bar.LOW} = \text{limitPrice}$ or $\text{bar.HIGH} = \text{limitPrice}$) does **NOT** fill. In the absence of queue visibility, assuming execution on a boundary touch is overly optimistic.
- **Fill Price:** Exactly $\text{limitPrice}$ (no price improvement fabrication). Fee class: `MAKER`.
- **Resting Gap-Through:** Previously resting limit orders that are gapped through on a subsequent bar fill at their original $\text{limitPrice}$ with no favorable price improvement.

### 20.3 Stop-Market Order Fill Model
- **Trigger Conditions:**
  - BUY STOP triggers when $\text{bar.HIGH} \ge \text{stopPrice}$.
  - SELL STOP triggers when $\text{bar.LOW} \le \text{stopPrice}$.
- **Gap-Through Protection:**
  - If the bar $\text{OPEN}$ has already gapped adversely past the stop:
    - BUY: If $\text{bar.OPEN} > \text{stopPrice}$, raw reference is $\text{bar.OPEN}$.
    - SELL: If $\text{bar.OPEN} < \text{stopPrice}$, raw reference is $\text{bar.OPEN}$.
  - Otherwise, raw reference is $\text{stopPrice}$.
- **Adverse Adjustment:** Half-spread + stop slippage.
  - BUY: $\text{fillPrice} = \text{rawReference} \times (1 + \text{halfSpreadRate} + \text{stopSlippageRate})$
  - SELL: $\text{fillPrice} = \text{rawReference} \times (1 - \text{halfSpreadRate} - \text{stopSlippageRate})$
- Execution price positivity is strictly enforced ($\text{fillPrice} > 0$). Fee class: `TAKER`.

---

## 21. Intrabar Ambiguity & Global Execution Order (P9-SPEC-04)

During Phase B (Intrabar Execution), the engine resolves same-bar order eligibility through a deterministic 5-step total order algorithm:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 PHASE B DETERMINISTIC EXECUTION ALGORITHM                   │
│                                                                             │
│  STEP 1: IDENTIFY ELIGIBLE ACTIVE INTRABAR ORDERS                           │
│          Evaluate all active orders against bar OHLC without mutating state.│
│                                                                             │
│  STEP 2: REDUCE OCO GROUPS VIA ADVERSE_FIRST                                │
│          For each OCO group where multiple mutually-exclusive legs are      │
│          simultaneously eligible, select ONE candidate:                     │
│          - LONG position: downside protective stop wins over target.        │
│          - SHORT position: upside protective stop wins over target.         │
│                                                                             │
│  STEP 3: MERGE & SORT BY GLOBAL ORDER SEQUENCE                              │
│          Collect all selected OCO candidates and all eligible independent   │
│          non-OCO candidates. Sort ALL candidates by engine-assigned         │
│          orderSequence ascending. (Selected OCO candidate uses its own      │
│          orderSequence).                                                    │
│                                                                             │
│  STEP 4: SEQUENTIAL EXECUTION & REVALIDATION                                │
│          Iterate candidates in sorted order. Before each fill, revalidate   │
│          against current order/position state (earlier fills in the same    │
│          bar may have mutated exposure).                                    │
│                                                                             │
│  STEP 5: IMMEDIATE OCO SIBLING CANCELLATION                                 │
│          When an OCO candidate fills, immediately cancel its sibling leg    │
│          and emit ORDER_CANCELLED deterministically before processing the   │
│          next execution candidate.                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

This algorithm defines complete precedence:
- It does **not** process all OCO groups unconditionally before independent orders.
- It does **not** rely on JavaScript `Map` or `Object.keys()` iteration order.
- It preserves strict engine sequence ordering across all participants.

---

## 22. Single Net Position & Reduce-Only Constraints (P9-SPEC-06)

### 22.1 One Net Position Invariant
Each pair operates exactly one net position state:
$$\text{Position Side} \in \{ \text{FLAT}, \text{LONG}, \text{SHORT} \}$$
Hedge mode (simultaneous long and short positions on the same pair) is prohibited.

### 22.2 Reduce-Only Excess Whole-Order Rejection
To eliminate ambiguity in position reduction, the engine enforces strict local validation on all `reduceOnly` orders:
1. A `reduceOnly` order submitted while **FLAT** is rejected immediately (`ORDER_INVALID`).
2. A `reduceOnly` order in the same direction as the current position is rejected immediately (`ORDER_INVALID`).
3. If a `reduceOnly` order's quantity **exceeds the current opposing position quantity**:
   - The engine **REJECTS THE WHOLE ORDER** (`ORDER_INVALID`).
   - The engine does **NOT** cap the order quantity to position size.
   - The engine does **NOT** partially fill it.
   - The engine does **NOT** reverse the position.
4. **All-or-None Invariant:** All Phase 9 simulated fills remain all-or-none. An executed fill whose quantity is smaller than the current position partially reduces that position; this represents genuine position reduction, **not** a simulated partial fill.

---

## 23. Cost Accounting & Funding Model (P9-SPEC-07, P9-SPEC-08)

### 23.1 Exchange Trading Fees
Configured via exact decimal fractions (`makerFeeRate`, `takerFeeRate`):
$$\text{Executed Notional} = \text{Quantity} \times \text{Fill Price} \times \text{contractMultiplier}$$
$$\text{Fee} = \text{Executed Notional} \times \text{Fee Rate}$$
Fees are assessed on every fill (entry, increase, reduction, and reversal). The engine tracks `makerFees`, `takerFees`, and `totalFees` separately.

### 23.2 Spread & Slippage Cost Attribution Formulas (P9-SPEC-07)
Let:
- $R$ = the exact raw execution reference price used for this fill.
- $Q$ = absolute executed quantity.
- $M$ = instrument `contractMultiplier`.
- $\text{halfSpreadRate} = \text{halfSpreadBps} / 10\,000$.
- $\text{slippageRate} = \text{marketSlippageBps} / 10\,000$ (or $\text{stopSlippageBps} / 10\,000$).

The non-negative cost attribution components are:
$$\text{spreadCostAttribution} = R \times \text{halfSpreadRate} \times Q \times M$$
$$\text{slippageCostAttribution} = R \times \text{slippageRate} \times Q \times M$$

- **Raw Reference $R$:** For `MARKET`, $R = \text{next bar OPEN}$. For `STOP_MARKET`, $R = \text{bar OPEN}$ for gap-through, otherwise $\text{stopPrice}$. The identical $R$ is used for both spread and slippage.
- For `POST_ONLY_LIMIT`, $\text{spreadCostAttribution} = 0$ and $\text{slippageCostAttribution} = 0$ (the fill price is exactly the limit price; Phase 9 does not fabricate maker spread capture).
- **No Double Deduction:** Spread and slippage costs are embedded directly into the executed fill price. They are reported in the ledger for attribution analysis, but are **never** subtracted a second time from cash equity.

### 23.3 Perpetual Funding Model & Schedule Boundaries (P9-SPEC-08)
Because historical OHLCV does not contain authoritative funding mark prices, funding payments are supplied as an explicit deterministic schedule:

```typescript
export interface BacktestFundingEvent {
  readonly fundingTimeMs: number;
  readonly fundingRate: BacktestDecimal;
  readonly referencePrice: BacktestDecimal;
}

export interface BacktestFundingSchedule {
  readonly sourceId: string;
  readonly contentSha256: string;
  readonly fidelity: 'VERIFIED_SCHEDULE' | 'ASSUMPTION' | 'TEST_ONLY';
  readonly events: readonly BacktestFundingEvent[];
}
```

A funding schedule supplied to a Phase 9 run may contain events **ONLY** within the interval:
$$\text{bootstrapFromInclusiveMs} < \text{fundingTimeMs} \le \text{replayToExclusiveMs}$$

- **Boundary Rationale:** Every valid funding timestamp corresponds to the CLOSE of a replayed canonical source bar. A funding event at exactly `bootstrapFromInclusiveMs` is invalid because no replayed source bar ending at that timestamp belongs to the run. A funding event at exactly `replayToExclusiveMs` is valid because the final replayed source bar closes at that timestamp.
- Any event outside this allowed interval terminates the run with `FUNDING_SCHEDULE_INVALID`. Do not silently ignore it.
- Funding timestamps must be safe integers, 1-minute aligned, strictly increasing, and unique.

### 23.4 Signed Funding Formula & Event Emission
For **EVERY** valid funding event in the schedule, the engine emits exactly one `FUNDING_APPLIED` event (even if the position is FLAT and `fundingPnl = 0`):
$$\text{positionSign} = \begin{cases} +1 & \text{if LONG} \\ -1 & \text{if SHORT} \\ 0 & \text{if FLAT} \end{cases}$$
$$\text{Funding Notional} = |Q| \times \text{funding.referencePrice} \times M$$
$$\text{Funding PnL} = -\text{positionSign} \times \text{Funding Notional} \times \text{fundingRate}$$

- Funding uses the schedule `referencePrice`; silently substituting candle close is prohibited.
- Positive rate: LONG pays, SHORT receives. Negative rate: LONG receives, SHORT pays.
- Positive `fundingPnl`: credit to account equity. Negative `fundingPnl`: debit from account equity.
- Funding applies to the position that survived through the close of the bar ending at $T$. A position closed during that bar does not pay funding at $T$. A position opened at next bar open does not retroactively pay funding at $T$.
- Evaluation context at $T$ includes funding that was just applied at $T$.

---

## 24. Deterministic Accounting Ledger & Terminal State (P9-SPEC-09)

### 24.1 Deterministic Accounting Ledger Identities
The simulation engine maintains a single-currency deterministic accounting ledger evaluated at each bar close:
$$\text{netPnl} = \text{realizedGrossPnl} + \text{unrealizedGrossPnl} + \text{fundingPnl} - \text{totalFees}$$
$$\text{equity} = \text{initialEquity} + \text{netPnl}$$
$$\iff \text{equity} = \text{initialEquity} + \text{realizedGrossPnl} + \text{unrealizedGrossPnl} + \text{fundingPnl} - \text{totalFees}$$

Spread and slippage costs are embedded in executed fill prices and are **not** subtracted again.

### 24.2 Mark-to-Market Valuation
At each canonical 1m bar close:
- The open position is marked to the bar's $\text{CLOSE}$ price.
- Unrealized PnL is computed using the instrument contract multiplier.
- Equity is recalculated and recorded.

### 24.3 Terminal Open Position & Terminal Open Orders Policy (P9-SPEC-09)
At $\text{replayToExclusiveMs}$:
1. **Terminal Open Position:**
   - If a position remains open, it remains **OPEN**.
   - It is marked to the final closed candle in the replay range ($[\text{replayToExclusiveMs} - 60\,000, \text{replayToExclusiveMs})$).
   - Unrealized PnL is reported in `financialSummary`.
   - The engine does **not** fabricate an exit trade, pretend a future candle exists, charge an artificial exit fee, or force-close the position.
2. **Terminal Open Orders:**
   - Any order remaining in state `PENDING_ACTIVATION` or `OPEN` is reported directly in `terminalOpenOrders: readonly BacktestOrderSnapshot[]`.
   - The engine does **not** synthetically fill, cancel, reject, or expire unresolved orders merely because replay ended.
   - Final source bar is fully processed, funding at `replayToExclusiveMs` is applied if scheduled, and the terminal snapshot is produced.

---

## 25. Run Lifecycle, Immutable Input Snapshot & Failure Semantics (P9-SPEC-11)

### 25.1 Immutable Run Input Snapshot
Before `runId` is computed:
1. The engine defensively normalizes, deep-copies, and recursively freezes all behavior-affecting run inputs (timeframes, instrument spec, cost configuration, funding schedule and its event array, ambiguity policy, maxOpenOrders, participant identity/version/config hash, initial equity, the four time boundaries, and dataset manifest identity).
2. TypeScript `readonly` alone is insufficient; objects are deeply and recursively frozen.
3. The simulation replays exclusively from this immutable snapshot. No caller mutation can alter simulation behavior.

### 25.2 Fatal Failure Semantics
The run progresses through:
$$\text{CREATED} \longrightarrow \text{VALIDATING} \longrightarrow \text{REPLAYING} \longrightarrow \text{COMPLETED}$$
$$\text{VALIDATING or REPLAYING} \longrightarrow \text{FAILED}$$

The following conditions are **FATAL** and transition the run to terminal `FAILED`:
- Dataset identity or manifest hash mismatch (`DATASET_IDENTITY_MISMATCH`)
- Dataset gap or continuity error (`DATASET_GAP`, `DATASET_ORDER_VIOLATION`)
- Timeframe configuration error (`TIMEFRAME_CONFIGURATION_INVALID`)
- Indicator calculation failure (`INDICATOR_FAILURE`)
- Cost model invalidity (`COST_MODEL_INVALID`)
- Funding schedule violation (`FUNDING_SCHEDULE_INVALID`)
- Numeric failure or price non-positivity (`BACKTEST_NUMERIC_FAILURE`, `BACKTEST_OVERFLOW`)
- Event sink persistence failure (`BACKTEST_RUN_FAILED`)
- Hash canonicalization failure or internal invariant violation

Once `FAILED`, the run terminates immediately: no further evaluation, no order processing, and no valid final research result (`isValid = false`).

### 25.3 Stable Error Codes
```typescript
export type BacktestErrorCode =
  | 'INVALID_BACKTEST_CONFIG'
  | 'DATASET_IDENTITY_MISMATCH'
  | 'DATASET_RANGE_INVALID'
  | 'DATASET_ORDER_VIOLATION'
  | 'DATASET_GAP'
  | 'TIMEFRAME_CONFIGURATION_INVALID'
  | 'INDICATOR_FAILURE'
  | 'COST_MODEL_INVALID'
  | 'FUNDING_SCHEDULE_INVALID'
  | 'ORDER_INVALID'
  | 'ORDER_STATE_INVALID'
  | 'POST_ONLY_WOULD_TAKE'
  | 'POSITION_CONFLICT'
  | 'INSTRUMENT_CONSTRAINT_VIOLATION'
  | 'BACKTEST_OVERFLOW'
  | 'BACKTEST_NUMERIC_FAILURE'
  | 'BACKTEST_RUN_FAILED';
```

---

## 26. Cryptographic Identifiers & Canonical Hashing

### 26.1 Backtest Run Manifest
The run manifest contains every behavior-changing parameter:

```typescript
export interface BacktestRunManifest {
  readonly schemaVersion: 1;
  readonly venue: 'COINDCX';
  readonly market: 'FUTURES';
  readonly pair: string;
  readonly datasetId: string;
  readonly datasetContentSha256: string;
  readonly bootstrapFromInclusiveMs: number;
  readonly evaluationFromInclusiveMs: number;
  readonly evaluationToExclusiveMs: number;
  readonly replayToExclusiveMs: number;
  readonly configuredTimeframes: readonly number[];
  readonly instrumentSpecSnapshotId: string;
  readonly costModel: {
    readonly makerFeeRate: string;
    readonly takerFeeRate: string;
    readonly halfSpreadBps: string;
    readonly marketSlippageBps: string;
    readonly stopSlippageBps: string;
  };
  readonly fundingSchedule: {
    readonly sourceId: string;
    readonly contentSha256: string;
    readonly fidelity: string;
  };
  readonly intrabarAmbiguityPolicy: 'ADVERSE_FIRST';
  readonly maxOpenOrders: number;
  readonly engineSemanticVersion: string;
  readonly participant: {
    readonly participantId: string;
    readonly participantVersion: string;
    readonly parameterHash: string;
    readonly gitCommitHash: string;
  };
  readonly initialEquity: string;
}
```

### 26.2 Canonical Serialization Rules
1. UTF-8 encoding without BOM.
2. Object keys sorted lexicographically (ASCII) **recursively at every nesting depth**.
3. Arrays preserve specified semantic order.
4. Decimal values formatted as canonical fixed-point strings.
5. Timestamps and integer counters formatted as base-10 JSON integers.
6. Zero `Date` serialization, zero local filesystem paths, zero machine names, zero runtime duration, and zero wall-clock `createdAt` fields in hash identity.

$$\text{runId} = \text{SHA256}(\text{CanonicalJson}(\text{BacktestRunManifest (excluding runId)}))$$

---

## 27. Event Ledger, Framing & Result Cryptographic Lineage

### 27.1 Monotonic Event Sequence & Lineage Framing
Every state transition produces an immutable `BacktestEvent` with monotonic sequence starting at 1:
```typescript
export interface BacktestEvent {
  readonly sequence: number;
  readonly eventTimeMs: number;
  readonly type: BacktestEventType;
  readonly runId: string;
  readonly entityId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
```

### 27.2 Concatenated Newline-Framed Event Ledger Hash
$$\text{eventLedgerSha256} = \text{SHA256}\left(\sum_{e \in \text{events}} \left(\text{CanonicalJson}(e) + \text{`\textbackslash n'}\right)\right)$$
Each event is serialized to canonical JSON, followed by a single LF byte (`0x0A`). The SHA-256 hash of the concatenated framed bytes defines `eventLedgerSha256`.

### 27.3 Result Cryptographic Hash
The result hash covers the complete simulation outcome, excluding non-deterministic runtime fields (duration, createdAt, machine metadata, logs):
```typescript
export interface BacktestResultHashPayload {
  readonly runId: string;
  readonly terminalStatus: 'COMPLETED' | 'FAILED';
  readonly isValid: boolean;
  readonly pair: string;
  readonly datasetId: string;
  readonly timeRange: {
    readonly bootstrapFromInclusiveMs: number;
    readonly evaluationFromInclusiveMs: number;
    readonly evaluationToExclusiveMs: number;
    readonly replayToExclusiveMs: number;
  };
  readonly financialSummary: BacktestFinancialSummary;
  readonly fidelity: BacktestFidelityDisclosure;
  readonly totalFills: number;
  readonly totalClosedTrades: number;
  readonly terminalPosition: BacktestPositionSnapshot | null;
  readonly terminalOpenOrders: readonly BacktestOrderSnapshot[];
  readonly eventLedgerSha256: string;
}
```
Fills and closed trades are bound transitively through `eventLedgerSha256`.
$$\text{resultSha256} = \text{SHA256}(\text{CanonicalJson}(\text{BacktestResultHashPayload}))$$

### 27.4 Fatal Event Sink Failure Handling (P9-SPEC-12)
If the event sink encounters an error:
- The run halts immediately and marks state `FAILED`.
- `isValid` is set to `false`.
- Diagnostic failure metadata may be returned outside the valid event ledger.
- Fabricating a complete `eventLedgerSha256` or `resultSha256` upon sink failure is strictly barred.

---

## 28. Result Contract & Fidelity Disclosures

### 28.1 Result Contract Structure
```typescript
export interface BacktestRunResult {
  readonly runId: string;
  readonly resultSha256: string;
  readonly eventLedgerSha256: string;
  readonly pair: string;
  readonly datasetId: string;
  readonly timeRange: {
    readonly bootstrapFromInclusiveMs: number;
    readonly evaluationFromInclusiveMs: number;
    readonly evaluationToExclusiveMs: number;
    readonly replayToExclusiveMs: number;
  };
  readonly isValid: boolean;
  readonly terminalStatus: 'COMPLETED' | 'FAILED';
  readonly terminalError?: string;
  readonly totalFills: number;
  readonly totalClosedTrades: number;
  readonly terminalPosition: BacktestPositionSnapshot | null;
  readonly terminalOpenOrders: readonly BacktestOrderSnapshot[];
  readonly financialSummary: {
    readonly initialEquity: BacktestDecimal;
    readonly finalEquity: BacktestDecimal;
    readonly realizedGrossPnl: BacktestDecimal;
    readonly unrealizedGrossPnl: BacktestDecimal;
    readonly netPnl: BacktestDecimal;
    readonly makerFees: BacktestDecimal;
    readonly takerFees: BacktestDecimal;
    readonly totalFees: BacktestDecimal;
    readonly fundingPnl: BacktestDecimal;
    readonly spreadCostAttribution: BacktestDecimal;
    readonly slippageCostAttribution: BacktestDecimal;
  };
  readonly fidelity: BacktestFidelityDisclosure;
}
```

### 28.2 Explicit Fidelity Disclosures
Every result must disclose its mathematical fidelity boundaries:
```typescript
export interface BacktestFidelityDisclosure {
  readonly marketDataFidelity: 'CANONICAL_1M';
  readonly executionFidelity: 'CONSERVATIVE_1M_OHLCV';
  readonly partialFillModel: 'NOT_MODELED_PHASE9';
  readonly queueModel: 'NOT_MODELED_PHASE9';
  readonly riskEngine: 'NOT_APPLIED_PHASE9';
  readonly leverageModel: 'NOT_MODELED_PHASE9';
  readonly liquidationModel: 'NOT_MODELED_PHASE9';
  readonly fundingFidelity: 'VERIFIED_SCHEDULE' | 'ASSUMPTION' | 'TEST_ONLY';
}
```

---

## 29. Resource Bounds & Safety Limits

- **`maxOpenOrders`:** Bound to $[1, 100]$ (Default: `20`). Enforced before order acceptance; validated against active orders (`PENDING_ACTIVATION` + `OPEN`). Exceeding rejects order intent (`ORDER_INVALID`). Frozen into `BacktestRunManifest`.
- **Timeframe Constituent Buffers:** Ring buffers bounded to $M = \text{timeframeMinutes}$ elements.
- **Indicator Kernels:** Bounded memory $O(\text{period})$ or $O(1)$.
- **Core Engine State:** $O(\text{working state})$. No retention of full historical candle arrays or event logs.

---

## 30. Implementation Evidence & Verification Test Matrix

| Category | Test Case / Fixture | Assertion / Required Behavior |
| :--- | :--- | :--- |
| **DATA** | Pass 1 Manifest Verification | Verifies entire manifest range $[from, to)$ using Phase 7 hash contract. |
| **DATA** | Dataset Identity Mismatch | Rejects corrupted hash, substituted stream, or mismatched `datasetId` (`DATASET_IDENTITY_MISMATCH`). |
| **DATA** | Manifest A + Stream B Rejection | Asserts that valid manifest $A$ with different stream $B$ is NEVER accepted. |
| **DATA** | Discontinuous Minute Gap | Rejects missing minute in dataset (`DATASET_GAP`). |
| **DATA** | Out-of-Order / Duplicate Minute | Rejects backwards or duplicate timestamp (`DATASET_ORDER_VIOLATION`). |
| **DATA** | Streaming Memory Verification | Validates core engine memory remains $O(\text{working state})$ across multi-year data. |
| **TIME** | System Wall-Clock Ban | Verifies that modifying system time does not affect simulation outcome. |
| **TIME** | Forming Bar Secrecy | Asserts evaluation context cannot observe bar OHLC before bar close. |
| **TIME** | Same-Timestamp Causality | Order submitted at 10:00 fills on bar 10:00 OPEN at earliest, never bar 09:59. |
| **TIME** | Cancellation Causality | Cancellation accepted at $T$ becomes effective at next bar open before any fills; wins over gap-through. |
| **TIME** | Replay Range Boundary Semantics | Final source bar $[replayTo - 60k, replayTo)$ processed; close at $replayTo$; no evaluation at $replayTo$. |
| **HTF** | Common Bootstrap Alignment | Asserts $bootstrapFrom \pmod{M \times 60k} === 0$ for all HTFs; rejects unaligned configs. |
| **HTF** | `aggregateExactBucket` Parity | Verifies exact Phase 6 derivation parity with zero custom aggregation math. |
| **HTF** | HTF Ascending Close Order | Ascending duration order: 1m $\to$ 2m $\to$ 5m $\to$ 15m $\to$ 1h before evaluation. |
| **INDICATORS**| Kernel Origin Binding | 1m bound to $bootstrapFrom$; HTF kernel bound to actual first derived HTF candle open. |
| **INDICATORS**| Warmup Null Preservation | Confirms indicator warmup emits `null`, never converted to `0`. |
| **INDICATORS**| Kernel Error Fail-Closed | Indicator calculation failure terminates run with `INDICATOR_FAILURE`. |
| **EXECUTION** | Price Positivity Enforcement | Computed MARKET/STOP fill price must be $> 0$; non-positive price fails closed (`BACKTEST_NUMERIC_FAILURE`). |
| **EXECUTION** | Cost Model Bounds Validation | Rejects configurations where halfSpreadRate + slippageRate $\ge 1$ (`COST_MODEL_INVALID`). |
| **EXECUTION** | Post-Only Raw Open Rejection | Rejects marketable BUY limit $\ge \text{open}$ or SELL $\le \text{open}$ (`POST_ONLY_WOULD_TAKE`). |
| **EXECUTION** | Limit Strict Penetration | BUY Limit at 100: bar LOW = 100.00 $\to$ NO FILL; bar LOW = 99.99 $\to$ FILL AT 100. |
| **EXECUTION** | Stop-Market Gap-Through | Market opens past stop: fills at bar OPEN + slippage (not at stopPrice). |
| **EXECUTION** | OCO Intrabar Precedence | ADVERSE_FIRST reduces OCO group to 1 candidate, sorted with independent orders by `orderSequence` ascending. |
| **EXECUTION** | Immediate OCO Cancellation | When chosen OCO leg fills, sibling is cancelled immediately before next candidate fills. |
| **EXECUTION** | Reduce-Only Excess Whole Reject| Opposing order quantity > open position rejected in WHOLE; no partial fill, no cap, no reversal. |
| **POSITION** | Reversal Realized PnL | Realized PnL calculated ONLY on closing quantity; opening portion opens at fill price with 0 PnL; single fee. |
| **POSITION** | Weighted-Average Entry | Exact 128-digit precision on partial entry scale-ins. |
| **CONSTRAINTS**| Instrument Constraint Validation| Validates tickSize, quantityStep, minQuantity, minTradeSize at submission; minNotional at fill. |
| **COSTS** | Spread/Slippage Attribution | Formulas $R \times \text{rate} \times Q \times M$ reported as attribution; not deducted twice from equity. |
| **COSTS** | Funding Schedule Boundaries | Rejects events outside $(bootstrapFrom, replayTo]$ (`FUNDING_SCHEDULE_INVALID`). |
| **COSTS** | Funding Applied Emission | Emits FUNDING_APPLIED for every schedule event (even when FLAT, fundingPnl = 0). |
| **TERMINAL** | Terminal Open Position | Position left OPEN at replay end; marked to final close; no fake exit fee. |
| **TERMINAL** | Terminal Open Orders | Unresolved orders reported in `terminalOpenOrders`; no synthetic fills or cancellations. |
| **RESOURCES** | `maxOpenOrders` In Manifest | Changing `maxOpenOrders` changes `runId`; active orders capped; rejects excess. |
| **SINK** | Event Sink Write Failure | Sink write error immediately terminates run with `FAILED` and `isValid = false` (`BACKTEST_RUN_FAILED`). |
| **DETERMINISM**| Canonical JSON & Framing | Recursive key sorting, trailing LF framing; bit-for-bit identical `runId`, `eventLedgerSha256`, `resultSha256`. |
