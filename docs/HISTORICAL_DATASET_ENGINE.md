# Historical Dataset Engine — Phase 7 Architecture & Specification

## 1. Executive Summary & Purpose

Phase 7 defines the **Historical Dataset Engine** for the **CoinDCX Quant Futures Bot**. It is the authoritative subsystem responsible for acquiring, validating, persisting, identifying, exporting, and importing historical 1-minute canonical candlestick datasets.

The sole purpose of Phase 7 is to produce **deterministic, bit-for-bit reproducible, zero-fabrication historical 1-minute canonical datasets** to power:
- **Phase 8**: Indicator Engine (deterministic technical & quant calculations)
- **Phase 9**: Backtesting Engine Foundation (event-driven simulation & fee/slippage modeling)
- **Phase 10+**: Strategy Research Framework & Strategy Matrix Optimization

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CoinDCX Exchange                              │
│             (Public Futures Candlestick REST Endpoint)                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ GET /market_data/candlesticks
                                     │ (Closed 1m candles only; resolution=1, pcode=f)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  CoinDcxFuturesCandleRestReader                         │
│             (Phase 2/5 Reused Read-Only HTTP Transport)                 │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ RestCandleRecord[]
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    HistoricalBackfillService                            │
│  - Half-open range [fromInclusiveMs, toExclusiveMs)                     │
│  - Safe integer UTC-minute boundary validation                          │
│  - Bounded sequential chunking (chunkMinutes, O(chunk) memory)          │
│  - Local DB continuity scan & gap identification                        │
│  - Fetch genuine missing spans only (Zero Fabrication)                  │
│  - Convert to CanonicalCandle1m (source: REST_HISTORICAL)               │
│  - Idempotent insert with fail-closed conflict barrier                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               Immutable MySQL 8 Canonical Storage                       │
│                           (candles_1m)                                  │
│             Single source of market-truth persistence                   │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     HistoricalDatasetService                            │
│  - Bounded-memory multi-year paging: O(page) RAM, never full-array     │
│  - Completeness verification (exact N contiguous minutes)               │
│  - Pair validation: ^[A-Z0-9_.-]{1,64}$ (excludes |, CR, LF, ws)        │
│  - canonicalHashDecimal: deterministic numeric representation           │
│  - Deterministic contentSha256 (canonical logical rows, LF only)        │
│  - Deterministic datasetId (exact LF-delimited metadata envelope)       │
│  - Manifest tracking with idempotent verify-or-fail recreation          │
│  - Streaming NDJSON export (logical hash recomputed on the fly)         │
│  - Two-Phase Import: Pass 1 read-only verify -> Pass 2 atomic commit    │
│  - Import TOCTOU protection via immutable artifact snapshots            │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Verified Canonical 1m Data
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  Downstream Research & Execution                        │
│  - Phase 6: aggregateExactBucket (On-the-fly higher timeframes)         │
│  - Phase 8: Deterministic Indicator Warmup                              │
│  - Phase 9: Reproducible Backtest Simulation                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Strict Anti-Scope & System Boundaries
Phase 7 **IS NOT** and **MUST NOT IMPLEMENT**:
- Trading strategies or signal evaluation (Phase 10)
- Technical or quantitative indicators (Phase 8)
- Backtest simulation or order matching (Phase 9)
- Execution, order routing, or position tracking (Phase 17)
- Risk management or leverage calculations (Phase 13)
- Live trading or live streaming operations (Phase 5/20/21)
- Macroeconomic news calendar or sentiment analysis (Phase 24)
- Dashboard, plotting, or UI telemetry (Phase 25)
- Funding rate history or borrow ledger ingestion (Later Phase)
- Order book depth snapshots or trade tick data lakes (Later Phase)
- Coin onboarding execution (SOL onboarding is Phase 16)

---

## 2. Authoritative Historical Data Source

### Single Exchange Source
The sole authoritative external source for historical market data in Phase 7 is the **CoinDCX Futures Public 1-Minute Candlestick REST Endpoint**:
```
GET https://public.coindcx.com/market_data/candlesticks?pair=<pair>&from=<fromSec>&to=<toSec>&resolution=1&pcode=f
```

### Direct Component Reuse
- Phase 7 reuses the existing, battle-tested `CoinDcxFuturesCandleRestReader` located in:
  `src/market-data/rest-candle-reader.ts`
- **Zero Duplicate HTTP Implementations**: Under no circumstances shall a secondary HTTP transport, alternative fetching client, or ad-hoc axios/fetch wrapper be introduced.
- All CoinDCX REST requests pass through `CoinDcxFuturesCandleRestReader.fetchClosedCandles({ pair, fromMs, toMs })`.

### Closed 1m Candles Exclusivity
- Historical datasets operate **strictly and exclusively on finalized, closed 1-minute candles**.
- Forming, active, or partial 1-minute candles are categorically rejected.
- As enforced by `CoinDcxFuturesCandleRestReader`, any candle whose `timeMs >= currentMinuteStartMs` is discarded.

### Prohibition of Exchange Higher-Timeframe Data
- Phase 7 requests **only `resolution=1` (1-minute)** candles.
- Exchange-provided higher-timeframe endpoints (e.g. CoinDCX 5m, 15m, 1h, 4h, 1d REST candles) are **strictly forbidden**.
- All higher timeframes in the system are derived exclusively from canonical 1m candles via Phase 6 `aggregateExactBucket`.

---

## 3. Canonical Storage Model & Provenance Neutrality

### Reusing `candles_1m` as Single Persistent Truth
- Phase 7 persists historical candles directly into the existing, immutable MySQL 8 table:
  `candles_1m`
- **Zero Secondary Truth Tables**: Introducing a separate `historical_candles_1m` or `backfill_candles` table is forbidden. The bot maintains exactly one foundational record of 1-minute market truth.

### Identical Domain & Validation Standard
Historical candles must satisfy the exact same domain constraints as live candles finalized in Phase 5:
- Backed by `CanonicalCandle1m` domain interface.
- Financial values validated via `CanonicalDecimal` (MySQL `DECIMAL(36, 18)` constraints: scale $\le 18$, integer digits $\le 18$, total precision $\le 36$, no scientific notation).
- Timestamps: safe integer, finite, $\ge 1577836800000$ (2020-01-01 UTC), exact UTC minute alignment (`openTimeMs % 60_000 === 0`).
- Structural OHLC consistency: $\text{high} \ge \max(\text{open}, \text{close}, \text{low})$ and $\text{low} \le \min(\text{open}, \text{close}, \text{high})$. Non-negative prices and volume.
- Quote volume: genuine value preserved or explicit `null` (never fabricated as 0).

### Canonical Provenance Extension: `REST_HISTORICAL`
In Phase 7 implementation, `CanonicalCandleSource` conceptually expands:
```typescript
export type CanonicalCandleSource =
  | 'WS_FINALIZED'      // Phase 5: finalized from live WebSocket stream
  | 'REST_RECOVERY'     // Phase 5: gap-recovered via REST during live operation
  | 'REST_HISTORICAL';  // Phase 7: backfilled via historical dataset engine
```

### Exact Runtime Validation Touch-Points (P7A-04)
To eliminate any unchecked type assertion or provenance bypass, Phase 7 implementation MUST update all relevant runtime validation paths:

1. **Type Definition (`src/market-data/types.ts`)**:
   `CanonicalCandleSource` union type becomes:
   ```typescript
   export type CanonicalCandleSource = 'WS_FINALIZED' | 'REST_RECOVERY' | 'REST_HISTORICAL';
   ```
2. **Domain Factory Validation (`src/market-data/models.ts`)**:
   `createCanonicalCandle1m` runtime source validation MUST explicitly check:
   ```typescript
   if (input.source !== 'WS_FINALIZED' && input.source !== 'REST_RECOVERY' && input.source !== 'REST_HISTORICAL') {
     throw new CanonicalCandleValidationError(
       `Invalid candle source: '${input.source}'. Must be WS_FINALIZED, REST_RECOVERY, or REST_HISTORICAL.`
     );
   }
   ```
   Blind TypeScript type casts (e.g. `source as CanonicalCandleSource`) without runtime validation are strictly forbidden.
3. **Persistence Row-to-Domain Mapping (`src/market-data/persistence/candle-repository.ts`)**:
   MySQL stores `source` as `VARCHAR(32)`. The row mapping layer MUST validate the raw string against the allowed literal set before constructing `CanonicalCandle1m`:
   ```typescript
   const rawSource = row.source;
   if (rawSource !== 'WS_FINALIZED' && rawSource !== 'REST_RECOVERY' && rawSource !== 'REST_HISTORICAL') {
     throw new CanonicalCandleValidationError(
       `Persisted candle source '${rawSource}' is not a valid CanonicalCandleSource`
     );
   }
   ```
   The existing unchecked `row.source as CanonicalCandleSource` must be replaced by this fail-closed check. Unknown persisted source strings fail closed immediately.
4. **Test Verification**:
   Mandatory unit and repository integration tests must prove:
   - `REST_HISTORICAL` is accepted at runtime by `createCanonicalCandle1m`.
   - Unknown source strings are rejected with `CanonicalCandleValidationError`.
   - Database read-back of rows with source `REST_HISTORICAL` successfully reconstructs `CanonicalCandle1m`.
   - Database read-back of rows with corrupted or unrecognized source strings fails closed.
   - Existing `WS_FINALIZED` and `REST_RECOVERY` behavior remains 100% intact.

### Provenance Metadata vs. Market Truth Neutrality
- Transport and provenance fields (`source`, `finalizedAtMs`, `providerEventTimeMs`, `generationId`) are operational metadata.
- **They do not alter market-truth equality**:
  `areCanonicalCandlesIdentical(a, b)` compares strictly:
  `pair`, `openTimeMs`, `open`, `high`, `low`, `close`, `volume`, `quoteVolume`.
- Historical provenance MUST NOT affect:
  - OHLCV equality comparisons
  - `contentSha256` logical row hash
  - `datasetId` calculation
- A candle backfilled via `REST_HISTORICAL` with identical OHLCV to an existing `WS_FINALIZED` or `REST_RECOVERY` candle represents identical market truth.

### Conflict vs. Idempotency Rule
- **Identical Existing Row**: Returns `outcome: 'ALREADY_IDENTICAL'`. Operation is a safe, idempotent no-op.
- **Material Conflict**: If an incoming candle differs in OHLCV or quoteVolume from an existing persisted canonical row for the same `(pair, openTimeMs)`, the engine fails closed immediately with `CanonicalCandleConflictError`.
- **Never Overwrite**: The repository never blindly overwrites or executes mutable `UPDATE` statements on `candles_1m`.

### Authoritative Existing Quote Volume Preservation
CoinDCX historical public REST currently returns `quoteVolume = null` on futures candlestick endpoints.
- If an existing canonical DB candle already possesses a genuine non-null `quoteVolume` (e.g. from live WebSocket finalization in Phase 5), **that existing DB canonical candle remains authoritative market truth**.
- Phase 7 backfill MUST NOT overwrite, erase, or downgrade an existing non-null `quoteVolume` to null.
- Existing complete DB minutes are skipped during backfill and are never re-fetched merely to normalize provenance to `REST_HISTORICAL`.
- If an incoming backfill or import row compares `quoteVolume = null` against an existing row with `quoteVolume = <value>`, or vice versa, this constitutes a **material conflict** and fails closed.
- `quoteVolume = null` and `quoteVolume = 0` are fundamentally distinct: null indicates exchange absence of data; 0 indicates zero traded volume.

---

## 4. Historical Write Concurrency & Process Isolation

### Offline Maintenance / Research Operation
- In Phase 7, all historical write, backfill, and import operations are strictly designated as **OFFLINE maintenance and research operations**.
- **No Concurrent Live + Backfill Writers**: A backfill or dataset import process **MUST NOT** run concurrently against the same MySQL database instance while a Phase 5 live canonical writer (`CanonicalMarketDataEngine`) is actively running for that same database.
- Rationale: Live Phase 5 enforces an in-memory continuity watermark, unified commit queue, and strict successor finalization. Interleaving out-of-band historical writes into `candles_1m` during live execution would bypass Phase 5 watermark sequencing.
- Rather than introducing complex, error-prone distributed cross-process locking or table-level write locks in Phase 7, the system establishes an operational invariant: **historical writing is an offline/batch task**. Future architecture may relax this only with an explicit, coordinated shared writer barrier.
- **Read-Only Dataset Operations Independent**: Generating manifests, verifying dataset integrity, computing hashes, and exporting datasets are pure read-only operations and may execute concurrently at any time.

---

## 5. Half-Open Range Contract & Time Mathematics

### Unified Internal Range Convention
All Phase 7 components adhere strictly to the half-open interval convention:
$$[\text{fromInclusiveMs}, \text{toExclusiveMs})$$

### Strict Boundary Invariants
1. **Safe Integers**:
   `Number.isSafeInteger(fromInclusiveMs) && Number.isSafeInteger(toExclusiveMs)`
2. **Exact UTC Minute Alignment**:
   `fromInclusiveMs % 60_000 === 0`
   `toExclusiveMs % 60_000 === 0`
3. **Strict Monotonicity**:
   `fromInclusiveMs < toExclusiveMs`
4. **Historical Minimum**:
   `fromInclusiveMs >= 1577836800000` (2020-01-01T00:00:00.000Z)
5. **No Forming / Current Minute Inclusion**:
   Let $\text{currentMinuteStartMs} = \lfloor \text{nowMs} / 60\,000 \rfloor \times 60\,000$.
   $$\text{toExclusiveMs} \le \text{currentMinuteStartMs}$$
   Requests attempting to include the currently forming minute or future minutes fail closed with `INVALID_RANGE`.

### Expected Candle Count Formula
$$\text{expectedCandleCount} = \frac{\text{toExclusiveMs} - \text{fromInclusiveMs}}{60\,000}$$

### Translation to CoinDCX REST Parameters
`CoinDcxFuturesCandleRestReader.fetchClosedCandles` expects an inclusive `[fromMs, toMs]` range. The translation is exact with zero off-by-one error:
$$\text{restFromMs} = \text{fromInclusiveMs}$$
$$\text{restToMs} = \text{toExclusiveMs} - 60\,000$$

Example:
- Desired Range: `[12:00, 12:05)` (5 minutes: 12:00, 12:01, 12:02, 12:03, 12:04)
- `fromInclusiveMs` = 12:00 (e.g. 720,000)
- `toExclusiveMs` = 12:05 (e.g. 725,000)
- `expectedCandleCount` = $(725,000 - 720,000) / 60,000 = 5$
- `restToMs` = 12:04 (e.g. 724,000)

---

## 6. Resumable Chunked Backfill Engine

### Architecture of Resumability
Backfill operations must be completely resumable without requiring a dedicated job-state or progress tracking table in MySQL.

**The persistent market-truth table (`candles_1m`) is its own state machine:**
- The presence of continuous canonical rows in `candles_1m` proves what has already been retrieved and verified.
- Restarting an interrupted backfill across 2 years of data will inspect existing rows chunk by chunk, skip complete chunks with zero network calls, query only genuine missing spans, and resume seamless ingestion.

### Bounded Chunking
- Backfilling multi-year datasets must not load millions of candles into memory or execute unbounded REST queries.
- Operations are partitioned into sequential, bounded chunks of size `chunkMinutes` (default: 1,440 minutes = 1 day; configurable safe integer $\ge 1$).
- A backfill over range $[T_{\text{start}}, T_{\text{end}})$ is partitioned into $M$ disjoint chunks:
  $$\text{Chunk}_k = [\text{chunkStart}_k, \text{chunkEnd}_k)$$
  where $\text{chunkEnd}_k = \min(\text{chunkStart}_k + \text{chunkMinutes} \times 60\,000, T_{\text{end}})$.

### The 10-Step Resumable Chunk Algorithm
For each sequential chunk $[\text{chunkStart}, \text{chunkEnd})$:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Step 1: Read existing canonical rows in [chunkStart, chunkEnd - 60s]   │
│         via Canonical1mRangeReader.getRange                            │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 2: Validate existing rows (ordering, no duplicates)               │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 3: Determine exact missing contiguous minute spans                │
│         (Empty spans => Chunk already complete! Skip to Step 9)       │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Missing spans detected
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 4: For each missing span [spanFromMs, spanToExclusiveMs):         │
│         Fetch genuine candles via CoinDcxFuturesCandleRestReader       │
│         (toMs = spanToExclusiveMs - 60_000)                           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 5: Validate returned records (UTC alignment, OHLC consistency,    │
│         non-negativity, exact span boundary coverage)                  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 6: Convert to CanonicalCandle1m (source: 'REST_HISTORICAL',       │
│         finalizedAtMs: nowMs, providerEventTimeMs: null, genId: null)  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 7: Persist sequentially via Candle1mRepository.insertCandle       │
│         (INSERTED or ALREADY_IDENTICAL; conflict fails closed)         │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 8: Re-read entire chunk from MySQL via getRange                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 9: Verify exact minute-by-minute continuity and completeness:     │
│         count === expectedChunkCount && contiguous delta === 60_000ms  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Step 10: Chunk complete. Advance to Chunk k+1.                         │
└────────────────────────────────────────────────────────────────────────┘
```

### Crash Invariance
If the backfill process crashes at Step 6, 7, or anywhere mid-chunk:
- Already inserted rows remain safely in `candles_1m`.
- Rerunning the backfill reads the chunk: Step 3 detects only the remaining uninserted minutes.
- Previously committed rows return `ALREADY_IDENTICAL`.
- No duplicate rows, no data corruption, zero lost progress.

---

## 7. Zero Fabrication Policy ("No Synthetic Gaps")

### Strict Definition of Gap Filling
In the CoinDCX Quant Futures Bot, **"gap filling" means retrieving genuine, historically accurate 1-minute candlestick data from CoinDCX**.

### Absolute Ban on Synthetic Data
The engine is strictly forbidden from manufacturing data under all circumstances:
- **NO Linear Interpolation**: Never interpolate prices between missing minutes.
- **NO Forward Filling**: Never carry forward the price of minute $T$ to minute $T+1$.
- **NO Previous-Close Candles**: Never construct synthetic bars with $\text{open} = \text{high} = \text{low} = \text{close} = \text{prior}.\text{close}$.
- **NO Zero-Volume Placeholders**: Never insert artificial zero-volume candles to patch a gap.
- **NO Silent Minute Skipping**: Never skip a missing minute and treat the dataset as valid.

### Unrecoverable Gap Handling
If CoinDCX REST fails to provide data for a minute within the requested range (e.g. genuine exchange downtime or missing history):
- The chunk verification (Step 9) fails.
- The dataset remains **INCOMPLETE**.
- A manifest **CANNOT** be created.
- The dataset cannot be approved for research, indicator calculation, or backtesting.

---

## 8. Dataset Completeness & Bounded-Memory Architecture

### Dataset Completeness Specification
A historical dataset for `pair` over $[ \text{fromInclusiveMs}, \text{toExclusiveMs} )$ is defined as **COMPLETE** if and only if all of the following 8 invariants hold simultaneously:

1. **Exact Cardinality**:
   $$\text{actualCandleCount} === \frac{\text{toExclusiveMs} - \text{fromInclusiveMs}}{60\,000}$$
2. **Exact First Boundary**:
   $$\text{candles}[0].\text{openTimeMs} === \text{fromInclusiveMs}$$
3. **Exact Last Boundary**:
   $$\text{candles}[\text{last}].\text{openTimeMs} === \text{toExclusiveMs} - 60\,000$$
4. **Strict Minute Contiguity**:
   $$\forall i \in [1, N - 1]: \text{candles}[i].\text{openTimeMs} - \text{candles}[i - 1].\text{openTimeMs} === 60\,000$$
5. **Single Pair Homogeneity**:
   $$\forall i \in [0, N - 1]: \text{candles}[i].\text{pair} === \text{pair}$$
6. **Zero Duplicate Timestamps**:
   Every `openTimeMs` is distinct and strictly ascending.
7. **Canonical Structural Validity**:
   Every candle passes complete `CanonicalDecimal` and OHLC invariants.
8. **Storage Concordance**:
   Zero material conflicts with persisted rows in `candles_1m`.

If any condition fails, the dataset is **INCOMPLETE** and fails closed.

### Bounded-Memory Dataset Processing Contract (P7A-03)
Multi-year datasets encompass hundreds of thousands or millions of candles (e.g. 1 year $\approx 525,600$ candles; 3 years $\approx 1,576,800$ candles). Loading entire multi-year arrays into Node.js process heap memory causes severe memory bloat, garbage collector pauses, and out-of-memory crashes.

**Strict Invariant**: The following operations **MUST NOT load the complete historical dataset into RAM**:
1. `backfill`
2. `createManifest`
3. `verifyDataset`
4. `contentSha256` computation
5. `exportDataset`
6. `importDataset`

#### Paged Range Processing Model
All database reads across multi-year intervals must operate strictly in bounded ascending pages using the existing `Canonical1mRangeReader.getRange` semantics:
- Processing window configuration: `pageMinutes` (or `chunkMinutes`), e.g. 1,440 minutes (1 day) up to at most 10,080 minutes (1 week).
- Each page covers a half-open window: $[\text{pageFromMs}, \text{pageToExclusiveMs})$.
- Translated to current inclusive repository reader:
  ```typescript
  reader.getRange(pair, pageFromMs, pageToExclusiveMs - 60_000)
  ```
- Rows within each page are processed strictly in ascending `openTimeMs` order.

#### Bounded Continuity State Across Pages
Across page boundaries, memory consumption remains strictly $O(\text{page size})$, **NOT** $O(\text{total dataset candles})$. The processor retains only constant-space tracking state:
- `previousOpenTimeMs: number | null`
- `runningCount: number`
- `firstOpenTimeMs: number | null`
- `lastOpenTimeMs: number | null`
- `runningSha256Context: Hash` (incremental Node.js crypto `Hash` instance)

#### Boundary Continuity Verification
Between the last candle of page $k$ (`lastCandleK`) and the first candle of page $k+1$ (`firstCandleNext`), the engine explicitly verifies:
$$\text{firstCandleNext}.\text{openTimeMs} - \text{lastCandleK}.\text{openTimeMs} === 60\,000$$
Any missing minute or jump at page boundaries immediately aborts processing with `DATASET_INCOMPLETE`.

#### Incremental Content Hashing
`contentSha256` is computed by feeding each serialized logical row into `runningSha256Context.update(...)` as each page is iterated. At no point in time is the concatenated dataset string or candle array held in memory.

---

## 9. Deterministic Logical Serialization & SHA-256 Identity

### The Market-Truth Equality Problem
In a live system, a candle for 12:00 might be ingested via `WS_FINALIZED` with `generationId = 4` and `finalizedAtMs = 1720000060100`. In a backfill, the exact same minute might be ingested via `REST_HISTORICAL` with `generationId = null` and `finalizedAtMs = 1725000000000`.

To ensure that research datasets, backtests, and audits are **reproducible across machines, operating systems, runs, and ingest methods**, dataset identity must be derived **exclusively from immutable market truth**.

### Pair Validation Contract (P7A-05)
Before any dataset identity, hashing, backfill, export, or import operation commences, the symbol string must be strictly validated:
- **Exact Frozen Regex**:
  ```regexp
  ^[A-Z0-9_.-]{1,64}$
  ```
- **Rationale**: The existing MySQL schema defines `pair` as `VARCHAR(64)`. Restricting to uppercase alphanumeric characters, underscores, hyphens, and periods strictly excludes:
  - Pipe character `|` (used as the logical field delimiter)
  - CR (`\r`, `0x0D`) and LF (`\n`, `0x0A`) line break bytes
  - Spaces, tabs, and all whitespace
  - Escape characters, quotes, and control codes
- **Fail Closed**: Pairs failing this regex are rejected immediately with `INVALID_RANGE` or `CANONICAL_VALIDATION_FAILURE`.
- **No Silent Modification**: The engine MUST NOT silently uppercase, trim, or mutate invalid pair inputs.

### Numeric Hash Canonicalization: `canonicalHashDecimal` (P7A-01)
`CanonicalDecimal.value` preserves textual distinctions such as:
- `1` vs `1.0` vs `1.00`
- `0.000` vs `-0` vs `-0.0`
even though numeric canonical equality considers them identical.

**Therefore, hashing `CanonicalDecimal.value` directly is FORBIDDEN.**

Phase 7 freezes one exact conceptual normalization function:
$$\text{canonicalHashDecimal}(value) \rightarrow \text{string}$$

Its output MUST be uniquely and unambiguously determined by exact mathematical numeric value.

#### Normalization Rules
1. **Input Pre-Validation**: The input must already satisfy canonical fixed-point financial constraints (scale $\le 18$, integer digits $\le 18$, total precision $\le 36$).
2. **Scientific Notation Banned**: Scientific notation (e.g. `1e-5`, `2.4E+3`) is strictly forbidden.
3. **Exact Value Preservation**: Preserve the exact numeric value without deviation.
4. **NEVER Round**: Rounding is strictly prohibited.
5. **NEVER Truncate**: Truncation of significant digits is strictly prohibited.
6. **Strip Trailing Fractional Zeros**: Remove all redundant trailing zeros from the fractional component (e.g. `1.200` $\rightarrow$ `1.2`).
7. **Strip Redundant Decimal Point**: If stripping trailing zeros leaves the fractional part empty, remove the decimal point (e.g. `1.000` $\rightarrow$ `1`).
8. **Normalize Leading Integer Zeros**: Remove redundant leading integer zeros while preserving a single `0` for values in $(-1, 1)$ (e.g. `001.20` $\rightarrow$ `1.2`, `000.5` $\rightarrow$ `0.5`).
9. **Collapse Negative Zero**: Every representation of negative zero (`-0`, `-0.0`, `-0.000000000000000000`) must collapse to exactly:
   ```
   0
   ```
10. **Normalize Positive Zero**: Positive zero in any representation (`0`, `0.0`, `0.000`) serializes to exactly:
    ```
    0
    ```

#### Exact Canonicalization Examples
| Raw Canonical Input | Normalized Hash String | Rationale |
| :--- | :--- | :--- |
| `"1"` | `"1"` | Already canonical integer. |
| `"1.0"` | `"1"` | Trailing zero and redundant dot removed. |
| `"1.00"` | `"1"` | Redundant fractional zeros removed. |
| `"001.20"` | `"1.2"` | Leading integer zero and trailing fractional zero removed. |
| `"0.000"` | `"0"` | Zero canonicalization. |
| `"-0"` | `"0"` | Negative zero collapsed to positive zero. |
| `"-0.000"` | `"0"` | Negative fractional zero collapsed to positive zero. |
| `"10.5000"` | `"10.5"` | Trailing fractional zeros removed; significant integer 0 preserved. |
| `"0.000000000000000001"` | `"0.000000000000000001"` | All 18 fractional digits preserved (no truncation). |

#### Representation-Only & Storage Invariance
- This normalization applies **ONLY to logical dataset hashing**.
- It **DOES NOT alter persisted storage**: `CanonicalDecimal` in `candles_1m` preserves its existing representation.
- It **DOES NOT alter market truth**: Values are mathematically identical.

### Field-Level Application & Quote Volume Null Marker
`canonicalHashDecimal` is applied independently to:
- `open`
- `high`
- `low`
- `close`
- `volume`
- `quoteVolume` (when non-null)

#### Dedicated Quote Volume Null Marker: `"N"`
When `quoteVolume === null`, it MUST serialize to the explicit single-character marker:
```
N
```
`quoteVolume` null represents the total absence of quote volume data and must **NEVER** equal numeric zero:
- `quoteVolume = null` $\rightarrow$ `"N"`
- `quoteVolume = 0` $\rightarrow$ `"0"` (via `canonicalHashDecimal`)
- `"N"` and `"0"` are strictly distinct and can never collide.

### Unambiguous Logical Content-Hash Row Encoding (P7A-05)
Each canonical candle row is encoded into exact UTF-8 bytes:
```
<pair>|<openTimeMs>|<canonicalOpen>|<canonicalHigh>|<canonicalLow>|<canonicalClose>|<canonicalVolume>|<canonicalQuoteVolume>\n
```

#### Strict Serialization Invariants:
1. **UTF-8 Character Encoding**: Processed as raw UTF-8 bytes.
2. **Strict LF Byte (`0x0A`) Only**: Every row is terminated by a single LF byte (`\n`, `0x0A`). Carriage return (`\r`, `0x0D`) is strictly forbidden.
3. **Operating System Invariance**: Windows CRLF git checkout, CRLF text editors, or platform-native line ending configurations (`\r\n`) must **NEVER** alter the byte stream fed into SHA-256. Hash implementations must explicitly write `0x0A` bytes.
4. **Field Delimiter**: Single ASCII pipe `|` (`0x7C`).
5. **Exact Field Sequence (8 Fields)**:
   1. `pair`: Validated string matching `^[A-Z0-9_.-]{1,64}$`
   2. `openTimeMs`: Decimal ASCII representation of safe integer UTC millisecond timestamp
   3. `canonicalOpen`: `canonicalHashDecimal(open)`
   4. `canonicalHigh`: `canonicalHashDecimal(high)`
   5. `canonicalLow`: `canonicalHashDecimal(low)`
   6. `canonicalClose`: `canonicalHashDecimal(close)`
   7. `canonicalVolume`: `canonicalHashDecimal(volume)`
   8. `canonicalQuoteVolume`: `"N"` if null, else `canonicalHashDecimal(quoteVolume)`
6. **Delimiters Cannot Be Injected**: Because `pair` is strictly validated and all numeric values (plus `"N"`) cannot contain `|`, `\r`, or `\n`, field boundary ambiguity is mathematically impossible.

Example Canonical Logical Row:
```
B-BTC_INR|1704067200000|3715000|3718500.5|3714000|3717200|1.452|N\n
```

### Logical Hash vs. Raw NDJSON Transport Distinction
`contentSha256` is the hash of the **canonical logical row byte stream**, NOT the raw bytes of an exported NDJSON file.

- **Logical Market Truth Identity**:
  `contentSha256` represents market truth. Exporting and re-importing candles, altering JSON whitespace, or reordering JSON object keys does not alter market truth.
- **Incremental SHA-256 Feeding**:
  During export, import, or local verification, the engine constructs or parses each logical candle and feeds the exact canonical logical byte sequence into SHA-256.
- **Separation of Concerns**:
  `contentSha256 != implicit raw-file-byte hash`.
  If transport-level physical file byte integrity is required in future phases, it must be stored in a distinct, separate property (e.g. `artifactSha256`). `contentSha256` must **NEVER** be overloaded for physical file hashing.

### Deterministic Content Hash (`contentSha256`)
$$\text{contentSha256} = \text{SHA-256} \left( \sum_{i=0}^{N-1} \text{encodeLogicalRow}(\text{candles}[i]) \right)$$
- Evaluated over the ordered sequence ($i = 0, \dots, N-1$) of all contiguous minutes in the dataset.
- Format: Lowercase 64-character hexadecimal string.

### Deterministic Dataset ID Serialization (`datasetId`)
`datasetId` incorporates the dataset's immutable specifications and its `contentSha256`.

#### Exact Metadata Envelope Format:
The envelope is serialized as raw UTF-8 bytes with an explicit single LF (`0x0A`) terminating **every** line, including the final line:
```
schemaVersion:1\n
venue:COINDCX\n
market:FUTURES\n
pair:<pair>\n
fromInclusiveMs:<fromInclusiveMs>\n
toExclusiveMs:<toExclusiveMs>\n
resolutionMinutes:1\n
contentSha256:<contentSha256>\n
```

#### Deterministic Computation:
$$\text{datasetId} = \text{SHA-256}(\text{utf8Bytes}(\text{metadataEnvelope}))$$
Format: Lowercase 64-character hexadecimal string.

#### Strict Exclusions:
The following volatile, local, or transport properties are **strictly excluded** from `datasetId`:
- Manifest generation timestamp (`createdAt`)
- Data ingestion source (`WS_FINALIZED`, `REST_RECOVERY`, `REST_HISTORICAL`)
- Finalization timestamp (`finalizedAtMs`)
- Provider event timestamp (`providerEventTimeMs`)
- Live socket generation ID (`generationId`)
- MySQL internal primary keys (`id`)
- MySQL row insertion timestamp (`createdAt`)
- Local machine wall-clock time
- Random UUIDs / nonces

---

## 10. Dataset Manifest Specification & Lifecycle

### Manifest Definition
A manifest records the verified, immutable identity of a complete historical dataset.

```typescript
export interface HistoricalDatasetManifest {
  readonly datasetId: string;              // Lowercase 64-char SHA-256 hex
  readonly schemaVersion: 1;               // Frozen at 1
  readonly venue: 'COINDCX';               // Venue identifier
  readonly market: 'FUTURES';              // Market type
  readonly resolutionMinutes: 1;           // Frozen at 1m
  readonly pair: string;                   // e.g. "B-BTC_INR" (validated regex)
  readonly fromInclusiveMs: number;        // UTC minute aligned safe integer
  readonly toExclusiveMs: number;          // UTC minute aligned safe integer
  readonly expectedCandleCount: number;    // (to - from) / 60_000
  readonly actualCandleCount: number;      // Must equal expectedCandleCount
  readonly firstOpenTimeMs: number;        // Must equal fromInclusiveMs
  readonly lastOpenTimeMs: number;         // Must equal toExclusiveMs - 60_000
  readonly contentSha256: string;          // Lowercase 64-char SHA-256 hex
  readonly createdAt: Date;                // Manifest generation timestamp (metadata only)
}
```

### Manifest Finalization & Persistence Invariant
A manifest represents certified market truth. It may be persisted to the database **only after 100% of the following prerequisites are satisfied**:
1. Entire canonical range $[ \text{fromInclusiveMs}, \text{toExclusiveMs} )$ is verified in `candles_1m`.
2. Actual candle count strictly equals expected count.
3. Strict 60,000ms contiguity verified across all minute boundaries.
4. `contentSha256` fully computed via incremental canonical row hash.
5. `datasetId` fully computed and verified.
6. For dataset import specifically: Pass 1 verification succeeded, Pass 2 database commit succeeded, and the final canonical DB re-read succeeded.

`createdAt` is informational metadata only and is excluded from `datasetId` calculation.

### Manifest Creation Idempotency & Conflict Semantics (P7A-06)
Logical uniqueness for dataset manifests is strictly defined by the natural key:
$$(\text{pair}, \text{fromInclusiveMs}, \text{toExclusiveMs})$$

When `createManifest(pair, fromInclusiveMs, toExclusiveMs)` is invoked:
1. The engine inspects canonical DB truth, verifies completeness in bounded memory, and calculates the fresh `currentContentSha256` and `currentDatasetId`.
2. The engine checks for an existing manifest record matching `(pair, fromInclusiveMs, toExclusiveMs)`.

#### CASE A: Existing Manifest Matches Fresh Truth (Idempotent Success)
If an existing manifest record is found AND:
- `stored.datasetId === currentDatasetId`
- `stored.contentSha256 === currentContentSha256`
- `stored.actualCandleCount === expectedCandleCount`
- `stored.firstOpenTimeMs === fromInclusiveMs`
- `stored.lastOpenTimeMs === toExclusiveMs - 60_000`

**Result**: Return existing manifest object unchanged.
- Idempotent success.
- Zero database writes.
- `createdAt` is NOT updated.
- No duplicate records created.

#### CASE B: Existing Manifest Differs from Fresh Truth (Material Conflict)
If an existing manifest record is found BUT any stored metadata field (`datasetId`, `contentSha256`, candle counts, or boundaries) differs from freshly recomputed truth:

**Result**: **FAIL CLOSED IMMEDIATELY** with `MANIFEST_CONFLICT`.
- **NEVER** update or overwrite the existing manifest row.
- **NEVER** update `datasetId` or `contentSha256` in place.
- **NEVER** create a silent duplicate or replacement manifest.
- **NEVER** execute an upsert.

**Architectural Rationale**: Canonical historical market data is immutable. If a freshly computed dataset hash differs from an existing persisted manifest for the identical pair and time range, this indicates a severe anomaly:
- An illegal mutable update or deletion occurred in `candles_1m`.
- Corrupted rows exist in the database.
- A hash canonicalization algorithm defect exists.
Silently updating the manifest would mask data corruption and invalidate downstream research reproducibility. The engine must fail closed with an explicit error.

### Future Database Table Specification
In a future Prisma migration, a single manifest table will be added:
```prisma
model HistoricalDataset {
  datasetId           String   @id @map("dataset_id") @db.VarChar(64)
  schemaVersion       Int      @map("schema_version")
  venue               String   @db.VarChar(32)
  market              String   @db.VarChar(32)
  resolutionMinutes   Int      @map("resolution_minutes")
  pair                String   @db.VarChar(64)
  fromInclusiveMs     BigInt   @map("from_inclusive_ms")
  toExclusiveMs       BigInt   @map("to_exclusive_ms")
  expectedCandleCount Int      @map("expected_candle_count")
  actualCandleCount   Int      @map("actual_candle_count")
  firstOpenTimeMs     BigInt   @map("first_open_time_ms")
  lastOpenTimeMs      BigInt   @map("last_open_time_ms")
  contentSha256       String   @map("content_sha256") @db.VarChar(64)
  createdAt           DateTime @default(now()) @map("created_at")

  @@unique([pair, fromInclusiveMs, toExclusiveMs], map: "historical_datasets_pair_range_unique")
  @@index([pair], map: "historical_datasets_pair_idx")
  @@map("historical_datasets")
}
```

---

## 11. Streaming NDJSON Export Specification

### Two-File Export Artifact
A dataset export produces two files:
1. **Manifest File**: `dataset-<datasetId>.manifest.json`
2. **Candles Data File**: `dataset-<datasetId>.candles.ndjson`

### Streaming & Bounded-Memory Operation
- Multi-year datasets are streamed record-by-record from MySQL in bounded pages ($O(\text{page size})$ memory).
- Each record is converted to a strict JSON string and written directly to the file stream.
- The stream recomputes the logical row byte serialization on the fly and feeds it incrementally into a running SHA-256 context.
- **Hash Verification**: Upon completion, the computed streaming hash **must match `manifest.contentSha256` exactly**. If a mismatch occurs, export aborts and partial files are securely deleted.

### NDJSON Line Format
Each line in the `.candles.ndjson` file is a valid JSON object containing strictly the logical market fields:
```json
{"pair":"B-BTC_INR","openTimeMs":1704067200000,"open":"3715000.000000000000000000","high":"3718500.500000000000000000","low":"3714000.000000000000000000","close":"3717200.000000000000000000","volume":"1.452000000000000000","quoteVolume":null}
```

---

## 12. Verified NDJSON Import Specification

### Strict Import Contract
Importing a dataset accepts **only Phase 7 canonical NDJSON + manifest format**. Arbitrary or untyped CSV imports are prohibited.

### Safe Two-Phase Import Architecture (P7A-02)
To guarantee database integrity, **imported external artifact data MUST NOT enter `candles_1m` before the complete artifact is 100% verified**. Phase 7 mandates a strict two-phase pipeline:

```
==========================================================================
PASS 1 — READ-ONLY VERIFICATION (ZERO DATABASE WRITES)
==========================================================================
1. Validate manifest file schema, schemaVersion=1, venue=COINDCX, market=FUTURES
2. Validate pair via ^[A-Z0-9_.-]{1,64}$
3. Validate [fromInclusiveMs, toExclusiveMs) UTC boundaries & expectedCount
4. Stream entire seekable local NDJSON artifact line-by-line:
   - Parse each JSON line; validate field presence and types
   - Validate CanonicalDecimal constraints on open, high, low, close, volume, quoteVolume
   - Validate OHLC structure: high >= max(open, close, low) and low <= min(...)
   - Validate non-negative values
   - Validate UTC minute alignment (openTimeMs % 60_000 === 0)
   - Validate strict minute ordering & contiguity: openTimeMs[i] - openTimeMs[i-1] === 60_000
   - Validate exact boundary coverage: first === fromInclusiveMs, last === toExclusiveMs - 60_000
   - Validate exact line count === expectedCandleCount
   - Canonicalize each numeric field via canonicalHashDecimal
   - Feed canonical logical row UTF-8 LF bytes into running SHA-256 context
5. Finalize computed contentSha256; require exact match to manifest.contentSha256
6. Recompute datasetId from metadata envelope + computed hash; require exact match
   Any validation failure in Pass 1:
   => ABORT IMMEDIATELY (IMPORT_FORMAT_INVALID, HASH_MISMATCH, DATASET_INCOMPLETE)
   => ZERO CANONICAL INSERTS. ZERO DATABASE WRITES.
==========================================================================
PASS 2 — IDEMPOTENT COMMIT (EXECUTED ONLY AFTER PASS 1 FULL SUCCESS)
==========================================================================
1. Re-read the SAME VERIFIED ARTIFACT SNAPSHOT
2. Stream rows into Candle1mRepository.insertCandle (source: 'REST_HISTORICAL')
   - Outcome 'INSERTED': Row safely written
   - Outcome 'ALREADY_IDENTICAL': Safe idempotent no-op
   - Outcome 'MATERIAL_CONFLICT': Fail closed immediately (CANONICAL_CONFLICT)
3. Post-commit re-read and re-verification of the DB range
4. Persist manifest record in historical_datasets via idempotent createManifest semantics
```

### Import TOCTOU Safety & Immutable Snapshot Guarantee
A Time-Of-Check to Time-Of-Use (TOCTOU) vulnerability exists if the source artifact could be modified or replaced between Pass 1 and Pass 2.

**Strict Invariant**: Pass 2 **MUST** consume the exact same immutable artifact snapshot verified by Pass 1.

The implementation must enforce file snapshot integrity through one of the following mechanisms:
1. **Exclusive Read Lock / Immutable File Handle**: Retaining an open, locked read handle across both passes that prevents any concurrent write or rename.
2. **Verified Temporary Local Snapshot**: Copying the artifact to an isolated temporary staging directory, performing Pass 1 verification on that staging file, and executing Pass 2 strictly from that identical verified staging file.

**Prohibition**: Pass 1 verifying File A while a concurrent process mutates it into File B before Pass 2 is strictly prohibited. If snapshot immutability cannot be guaranteed, the import aborts before Pass 2.

*Note: This snapshot isolation operates purely at the filesystem level. Introducing secondary database staging tables is forbidden.*

### Crash Invariance During Pass 2
If a crash or process termination occurs during Pass 2:
- The artifact was already 100% verified in Pass 1.
- Canonical rows committed prior to the crash are valid market truth.
- Resuming or re-running the import will re-execute Pass 1 verification, then Pass 2 will resume and skip existing rows as `ALREADY_IDENTICAL`.
- The manifest is persisted only after Pass 2 completes all rows and final DB re-read succeeds.

---

## 13. Conceptual Service Interfaces

```typescript
export interface BackfillRequest {
  readonly pair: string;
  readonly fromInclusiveMs: number;
  readonly toExclusiveMs: number;
  readonly chunkMinutes?: number; // Optional, defaults to 1440
}

export interface BackfillProgress {
  readonly pair: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly currentChunkStartMs: number;
  readonly currentChunkEndMs: number;
  readonly candlesFetchedFromRest: number;
  readonly candlesAlreadyInDb: number;
}

export interface HistoricalBackfillService {
  /**
   * Executes resumable chunked backfill over [fromInclusiveMs, toExclusiveMs).
   * Offline operation: MUST NOT run concurrently with active Phase 5 live writer.
   * Operates with bounded memory complexity O(chunkMinutes).
   */
  backfill(
    request: BackfillRequest,
    onProgress?: (progress: BackfillProgress) => void
  ): Promise<{
    readonly pair: string;
    readonly fromInclusiveMs: number;
    readonly toExclusiveMs: number;
    readonly totalCandles: number;
    readonly insertedCount: number;
    readonly existingCount: number;
  }>;
}

export interface HistoricalDatasetService {
  /**
   * Inspects canonical DB records via bounded paging, validates 100% completeness,
   * calculates contentSha256, generates datasetId, and creates/retrieves manifest.
   * Idempotent: returns existing if identical; fails closed if conflicting.
   */
  createManifest(
    pair: string,
    fromInclusiveMs: number,
    toExclusiveMs: number
  ): Promise<HistoricalDatasetManifest>;

  /**
   * Retrieves an existing dataset manifest by datasetId.
   */
  getManifest(datasetId: string): Promise<HistoricalDatasetManifest | null>;

  /**
   * Verifies that local DB records for a dataset strictly match its manifest
   * using bounded page reading without loading multi-year arrays into RAM.
   */
  verifyDataset(datasetId: string): Promise<{
    readonly isValid: boolean;
    readonly error?: string;
  }>;

  /**
   * Streams a verified dataset to manifest JSON and canonical NDJSON files.
   * Uses bounded memory streaming and validates running content hash.
   */
  exportDataset(
    datasetId: string,
    outputDirectory: string
  ): Promise<{
    readonly manifestFilePath: string;
    readonly ndjsonFilePath: string;
  }>;

  /**
   * Imports a dataset via strict Two-Phase import with TOCTOU snapshot safety.
   * Pass 1: Read-only verification (zero DB writes).
   * Pass 2: Idempotent commit via Candle1mRepository.insertCandle.
   */
  importDataset(
    manifestFilePath: string,
    ndjsonFilePath: string
  ): Promise<HistoricalDatasetManifest>;
}
```

---

## 14. Batch / Higher-Timeframe Relation (Phase 6 Parity)

### Canonical 1m Exclusivity
- Phase 7 persists and exports **only canonical 1-minute candles**.
- Higher-timeframe tables (e.g. `candles_5m`, `candles_1h`) are **strictly prohibited**.

### Dynamic Derivation via Phase 6 Primitive
- Future backtesting and indicator engines will construct higher timeframes dynamically from verified 1m canonical data using the Phase 6 universal primitive:
  ```typescript
  aggregateExactBucket(candles: readonly CanonicalCandle1m[], timeframeMinutes: number): HigherTimeframeCandle
  ```
- **Batch / Live Parity Guarantee**: Because live streaming (Phase 6) and historical batch processing (Phase 7 -> 9) use the identical aggregation function and decimal arithmetic (`DerivedAggregateDecimal`), derived candles are guaranteed to be byte-equivalent across live and backtesting environments.

---

## 15. Strategy Research Reproducibility Contract

To ensure institutional-grade research integrity, every strategy experiment, parameter optimization, and backtest result must be immutable and audit-traceable.

In future phases, all backtest results will record the **Quad-Tuple Identity**:
$$(\text{strategyVersion}, \text{parameterHash}, \text{gitCommitHash}, \text{datasetId})$$

- **No Mutable Datasets**: Datasets are never referenced by mutable queries like "past 30 days" or "latest BTC data".
- Any modification to market data changes `contentSha256` and produces a new `datasetId`.
- An experiment executed years later against `datasetId` will operate on the exact same market truth down to the last decimal digit.

### Export / Import Round-Trip Determinism Invariant
The historical dataset engine guarantees the following round-trip invariant:
$$\text{Canonical DB Truth} \xrightarrow{\text{Export}} \text{Artifact Files} \xrightarrow{\text{Import into Clean DB}} \text{Canonical DB Truth}$$

Recomputing `contentSha256` and `datasetId` on the imported database records **MUST produce the exact same hashes** down to the bit:
$$\text{contentSha256}_{\text{initial}} === \text{contentSha256}_{\text{imported}}$$
$$\text{datasetId}_{\text{initial}} === \text{datasetId}_{\text{imported}}$$

While provenance metadata (`source: WS_FINALIZED` vs `source: REST_HISTORICAL`) may legitimately differ across ingest methods, market truth equality and identity hashing are completely provenance-neutral.

---

## 16. Fail-Closed Error Taxonomy

Phase 7 operations default to a fail-closed posture across eleven explicit error categories:

| Error Code | Description | Reaction |
| :--- | :--- | :--- |
| `INVALID_RANGE` | Boundaries non-safe integer, unaligned, from $\ge$ to, pair regex mismatch, or includes forming minute. | Reject immediately; zero DB or REST operations. |
| `REST_FAILURE` | CoinDCX HTTP request timeout, 5xx status, or network failure. | Abort chunk; report pair and failed time range. |
| `REST_INCOMPLETE` | CoinDCX returned partial data or missed requested minutes. | Abort chunk; refuse to fabricate missing bars. |
| `CANONICAL_VALIDATION_FAILURE` | Price negative, high < low, scale > 18, scientific notation, or non-minute timestamp. | Reject candle; abort backfill immediately. |
| `CANONICAL_CONFLICT` | Incoming candle materially conflicts with existing canonical row in DB (OHLCV or quoteVolume mismatch). | Fail closed immediately; latch conflict fault. |
| `DB_FAILURE` | MySQL connection lost, disk full, or Prisma query exception. | Abort operation; throw unhandled error. |
| `DATASET_INCOMPLETE` | Missing minutes, broken contiguity across pages, or cardinality mismatch. | Refuse manifest creation; refuse export. |
| `HASH_MISMATCH` | Computed content hash does not match expected manifest hash. | Reject import/export; zero database writes. |
| `IMPORT_FORMAT_INVALID` | NDJSON malformed, missing required fields, or non-canonical format. | Abort import in Pass 1; zero database writes. |
| `MANIFEST_CONFLICT` | Existing manifest metadata differs from freshly recomputed canonical DB truth. | Fail closed immediately; refuse overwrite or update. |
| `TOCTOU_VIOLATION` | Source artifact file mutated or modified between import Pass 1 and Pass 2. | Abort import immediately before Pass 2 database writes. |

---

## 17. Mandatory Test Matrix for Future Phase 7 Implementation

Future implementation of Phase 7 must implement and pass the following comprehensive test suite:

### 1. Range Boundary & Off-by-One Tests
- Reject non-safe integer boundaries (`NaN`, `Infinity`, $1.5$).
- Reject unaligned timestamps (`1704067200001`).
- Reject inverted ranges (`from >= to`).
- Reject ranges reaching or exceeding `currentMinuteStartMs`.
- Verify exact count: `(to - from) / 60_000`.
- Verify CoinDCX REST translation: `restToMs === toExclusiveMs - 60_000`.

### 2. Resumability & Chunk Planning Tests
- Partition range into expected chunk boundaries for varying `chunkMinutes` (e.g. 1m, 60m, 1440m).
- Completely populated chunk in DB triggers zero REST requests.
- Partially populated chunk fetches only the exact missing sub-intervals.
- Multiple separated gaps in a chunk generate distinct targeted REST requests.
- Crash simulation: interrupted chunk resumes and completes without duplicate inserts.

### 3. Repository Idempotency & Conflict Tests
- Inserting identical candle returns `ALREADY_IDENTICAL` with zero error.
- Inserting candle with modified close price throws `CanonicalCandleConflictError`.
- Inserting candle with modified volume throws `CanonicalCandleConflictError`.
- Inserting candle with null quoteVolume against existing non-null throws conflict.

### 4. Zero Fabrication & Gap Enforcement Tests
- Simulated REST response with missing minute fails chunk validation.
- Engine never forward fills or generates synthetic candles.
- Incomplete range prevents manifest generation.

### 5. P7A-01: Numeric Hash Canonicalization Tests
- `"1"`, `"1.0"`, `"1.00"` produce identical `canonicalHashDecimal` string `"1"`.
- Trailing fractional zeros removed (`"001.20"` $\rightarrow$ `"1.2"`).
- Empty fractional component strips decimal point (`"5.000"` $\rightarrow$ `"5"`).
- Leading integer zeros normalized (`"007.89"` $\rightarrow$ `"7.89"`, `"000.5"` $\rightarrow$ `"0.5"`).
- Negative zero representations (`"-0"`, `"-0.0"`, `"-0.000000000000000000"`) collapse to `"0"`.
- Positive zero representations (`"0"`, `"0.0"`, `"0.000"`) serialize to `"0"`.
- No rounding or truncation: all 18 scale digits preserved (`"0.000000000000000001"`).
- `quoteVolume = null` serializes to `"N"`, strictly distinct from numeric `"0"`.
- Scientific notation rejected.
- Changing candle source (`WS_FINALIZED` vs `REST_HISTORICAL`) does not change `contentSha256`.

### 6. P7A-05: Logical Row Serialization & Pair Validation Tests
- Valid pairs (e.g. `"B-BTC_INR"`, `"ETH_USDT"`, `"SOL-PERP"`) pass validation.
- Pairs containing `|`, `\r`, `\n`, spaces, or tabs are rejected immediately (fail closed).
- Lowercase pairs (e.g. `"b-btc_inr"`) rejected per frozen regex (no silent transformation).
- Logical row uses LF (`0x0A`) byte only; Windows CRLF checkout produces identical logical row bytes.
- Deterministic known SHA-256 test fixture matches pre-calculated expected hash value.

### 7. Logical Hash vs. NDJSON Transport Tests
- Benign NDJSON formatting variations (whitespace between JSON fields, alternate key order) produce identical logical `contentSha256`.
- Direct file byte hashing verified to be separate from logical `contentSha256`.

### 8. Dataset ID Deterministic Serialization Tests
- Exact LF-terminated metadata envelope produces deterministic lowercase 64-char hex `datasetId`.
- Changing any envelope field changes `datasetId`.
- Changing `createdAt`, `source`, `generationId`, or DB `id` produces identical `datasetId`.

### 9. P7A-02: Safe Two-Phase Import Pre-Verification Tests
- Tampered row at end of NDJSON file detected in Pass 1; causes ZERO database writes.
- `contentSha256` mismatch detected in Pass 1; causes ZERO database writes.
- `datasetId` mismatch detected in Pass 1; causes ZERO database writes.
- Invalid decimal or broken OHLC detected in Pass 1; causes ZERO database writes.
- Broken minute contiguity detected in Pass 1; causes ZERO database writes.
- Simulated crash during Pass 2: restart re-runs Pass 1, then Pass 2 resumes idempotently via `ALREADY_IDENTICAL`.
- Manifest record never created or persisted if import fails at any point.

### 10. Import TOCTOU Protection Tests
- Modifying or tampering with NDJSON file between Pass 1 and Pass 2 is detected; import aborts before Pass 2 writes.
- Verified temporary snapshot mechanism guarantees Pass 2 reads the identical byte stream verified in Pass 1.

### 11. P7A-03: Bounded-Memory Multi-Year Processing Tests
- `createManifest` over 1-year and 3-year simulated datasets operates within bounded heap memory ($O(\text{page size})$).
- `verifyDataset` processes database rows page-by-page without loading full array.
- Incremental `Hash.update()` verified across page boundaries.
- Continuity gap occurring exactly on page boundary is detected and fails closed.
- Memory consumption remains flat across 1,000 to 1,000,000 candles.

### 12. P7A-04: Provenance & Exact Runtime Touch-Points Tests
- `createCanonicalCandle1m` accepts source `REST_HISTORICAL`.
- `createCanonicalCandle1m` rejects unknown source strings (e.g. `'CSV_IMPORT'`, `'MANUAL'`) at runtime.
- Repository row-to-domain mapper explicitly validates `source` column and fails closed on unknown strings.
- Database read-back of `REST_HISTORICAL` rows successfully reconstructs valid `CanonicalCandle1m`.
- Provenance changes do not alter `areCanonicalCandlesIdentical` outcome.

### 13. Authoritative Quote Volume Preservation Tests
- Backfill of historical candles with `quoteVolume = null` against existing canonical DB candles with genuine non-null `quoteVolume` preserves the existing non-null row.
- Inserting a candle with `quoteVolume = null` when a persisted row has `quoteVolume = 100` throws `CanonicalCandleConflictError`.
- Duplicate insertion of `quoteVolume = null` against `quoteVolume = 0` throws `CanonicalCandleConflictError`.

### 14. P7A-06: Manifest Recreation Idempotency & Conflict Tests
- Calling `createManifest` on an already-manifested range with identical data returns existing manifest object (idempotent no-op, `createdAt` preserved, zero writes).
- Calling `createManifest` on a range where canonical data has been altered or corrupted throws `MANIFEST_CONFLICT` (fail closed, zero updates/overwrites).

### 15. Export / Import Round-Trip Tests
- End-to-end round trip: DB $\rightarrow$ `exportDataset` $\rightarrow$ clear DB $\rightarrow$ `importDataset` $\rightarrow$ re-read DB produces bit-for-bit identical `contentSha256` and `datasetId`.

### 16. Phase 6 Aggregation Parity Tests
- Higher-timeframe candles (5m, 1h, 1d) aggregated from backfilled 1m canonical candles match live-aggregated candles byte-for-byte.
