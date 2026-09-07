# System Architecture

## 1. Architectural Philosophy

The **CoinDCX Quant Futures Bot** is built as a highly deterministic, modular TypeScript monolith backed by MySQL 8. It adheres strictly to:
- **Separation of Concerns:** Each module encapsulates a single domain with explicit interfaces.
- **Fail-Safe Operations:** Systems default to a safe, non-executing state upon encountering unhandled exceptions or data discrepancies.
- **Decimal Exactness:** Floating-point arithmetic is banned across financial, balance, order, and risk calculations.
- **Data Integrity:** The canonical 1-minute candle is the foundational source of truth from which all higher timeframes and indicators are derived.

```
                    ┌───────────────────────────────────────────┐
                    │               CoinDCX Exchange             │
                    │   (REST v1/v2/v3 + Public/Private WS)     │
                    └─────────────────────┬─────────────────────┘
                                          │
                                          ▼
                    ┌───────────────────────────────────────────┐
                    │         CoinDCX Integration Layer          │
                    │   (Authentication, Rate Limits, Transport)│
                    └──────────────┬─────────────┬──────────────┘
                                   │             │
                    ┌──────────────▼───┐     ┌───▼──────────────┐
                    │ Market Data Pipe │     │  Execution Pipe  │
                    └──────────────┬───┘     └───▲──────────────┘
                                   │             │
                                   ▼             │
                    ┌──────────────────┐         │
                    │ Canonical 1m DB  │         │
                    └──────────────┬───┘         │
                                   │             │
                                   ▼             │
                    ┌──────────────────┐         │
                    │  Timeframe Agg   │         │
                    │ (5m, 15m, 1h...) │         │
                    └──────────────┬───┘         │
                                   │             │
                                   ▼             │
                    ┌──────────────────┐         │
                    │ Indicator Engine │         │
                    └──────────────┬───┘         │
                                   │             │
                                   ▼             │
┌──────────────┐    ┌──────────────────┐         │
│  News Risk   ├───►│  Strategy Lab /  │         │
│    Layer     │    │  Coin Runtime    │         │
└──────────────┘    └──────────────┬───┘         │
                                   │ (Signals)   │
                                   ▼             │
                    ┌──────────────────┐         │
                    │  Risk & Leverage ├─────────┘ (Validated Intents)
                    │      Engine      │
                    └──────────────┬───┘
                                   │
                                   ▼
                    ┌──────────────────┐
                    │  Reconciliation  │
                    │ & Crash Recovery │
                    └──────────────────┘
```

---

## 2. Planned High-Level Modules

### 2.1 CoinDCX Integration
- Encapsulates all transport-level HTTP and WebSocket communication with CoinDCX.
- Manages HMAC-SHA256 request signing, nonce synchronization, and rate-limit credit tracking.
- Normalizes raw exchange responses into strictly typed domain models.

### 2.2 Coin Runtime Layer
- Spawns and manages isolated runtime containers per active instrument (e.g., `BTC-INR`, `ETH-INR`).
- Ensures that issues or crashes in one coin's runtime do not cascade to other coins.
- Dynamically loads instrument configuration (tick size, lot size, margin tiers) discovered from the exchange.

### 2.3 Market Data
- Receives real-time public trade streams, order book snapshots, and ticker updates.
- Employs strict sequence and gap detection to identify missed packets or stale feeds.
- Buffers raw trade ticks for canonical bar synthesis.

### 2.4 Canonical 1m Store
- The definitive, immutable record of 1-minute OHLCV candles persisted to MySQL 8.
- Serves as the single source of truth across backtesting, paper trading, shadow mode, and live execution.
- Bars are finalized authoritatively by Phase 5 using successor-confirmed finality (requiring observation of a valid strictly later minute; wall-clock advance alone never finalizes a candle), gap detection with REST recovery barriers, and strict persist-before-publish guarantees.

### 2.5 Timeframe Aggregation
- Pure mathematical aggregation engine that synthesizes generic higher timeframes (initial production-supported set: 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h, 1d) strictly from authoritative Phase 5 canonical closed 1m candles.
- Core architecture is generic for safe integer durations (`Number.isSafeInteger(timeframeMinutes) && timeframeMinutes >= 2`, preserving Phase 5 canonical 1m exclusivity) with UTC Unix-anchored bucket boundaries and exact constituent completeness ($N$ contiguous 1m candles; zero data fabrication or forward-filling).
- Enforces pair-scoped serialized execution across all operations (live processing, startup hydration, and resync) to eliminate race conditions and chronological inversion.
- Controlled by an explicit pair operational state model (`INITIALIZING`, `READY`, `BLOCKED`, `RESYNCING`) gated strictly by Phase 5 eligibility (`state === 'HEALTHY'`, `truthFault === 'NONE'`, `recoveryRequired === false`).
- Employs an isolated 64-bit calculation context and `DerivedAggregateDecimal` bounds (scale $\le 18$, integer $\le 30$, precision $\le 48$) to prevent precision truncation during multi-candle summation.
- Guarantees deterministic live/batch parity: the identical pure aggregation primitive (`aggregateExactBucket`) is executed across live streaming, historical dataset processing, indicator warmup, and backtesting, ensuring byte-equivalent derived market data.
- Reads exclusively from local MySQL `candles_1m` via `Canonical1mRangeReader` with zero external exchange calls and zero higher-timeframe database tables.
- Subordinate to Phase 5 host lifecycle: Phase 6 starts after Phase 5, unsubscribes and stops before Phase 5, and tracks engine-level run ownership to isolate stale async callbacks.

### 2.6 Historical Dataset Engine
- Deterministic, reproducible acquisition, verification, manifest tracking, export, and import of canonical 1-minute historical datasets.
- Reuses the existing read-only `CoinDcxFuturesCandleRestReader` against the public CoinDCX Futures candlestick REST endpoint (`resolution=1`, closed 1m candles only).
- Enforces half-open interval contract `[fromInclusiveMs, toExclusiveMs)` aligned to exact UTC minutes, strictly excluding the forming/current minute.
- Operates a resumable, chunked backfill engine without job-state database tables: derives progress directly from continuous canonical rows in `candles_1m`, fetches only genuine missing spans, and inserts via idempotent repository semantics.
- Enforces a strict zero-fabrication policy: interpolation, forward-filling, previous-close copying, and zero-volume filling are categorically barred. Datasets with unrecoverable exchange gaps fail closed as incomplete.
- Reuses existing immutable MySQL 8 `candles_1m` as the single canonical storage table (`source: 'REST_HISTORICAL'`) under identical `CanonicalDecimal` and structural OHLC validation. Conflict with existing rows fails closed (`CanonicalCandleConflictError`).
- Designated as an offline maintenance/research operation: historical writes must not run concurrently with an active Phase 5 live canonical writer on the same bot/database.
- Establishes deterministic SHA-256 dataset identity: `contentSha256` hashed over ordered canonical logical rows (market truth only, excluding transport metadata) and lowercase 64-character hex `datasetId` hashed over schema, venue, market, pair, range, and content hash.
- Manages dataset manifests (`HistoricalDatasetManifest`) and streaming NDJSON export/import with streaming hash verification for low memory consumption across multi-year datasets.
- Preserves Phase 6 batch/live parity: stores canonical 1m truth only; higher timeframes are derived dynamically via `aggregateExactBucket`.

### 2.7 Indicator Engine
- Deterministic, zero-side-effect computational layer for technical and quantitative indicators (SMA, EMA, Wilder RMA, ATR, RSI, MACD, Bollinger Bands, DMI/ADX, SuperTrend, Donchian Channel, UTC-day VWAP, Volume SMA, Volume Ratio).
- Consumes strictly closed, validated market data truth from Phase 5 `CanonicalCandle1m` (timeframe = 1m) and Phase 6 `HigherTimeframeCandle` via a normalized, read-only `IndicatorCandle` view; does not duplicate candle aggregation.
- Operates within deterministic calculation segments defined by `bootstrapStartOpenTimeMs`; exact recursive indicator state parity across restarts requires replaying continuous closed candles from the identical bootstrap origin (claims that "recent warmup candles" reconstruct recursive state are strictly barred).
- Executes within an isolated 128-digit Decimal calculation context (`IndicatorCalcDecimal`, `ROUND_HALF_UP`) with total prohibition of native floating-point math, providing deterministic headroom for Bollinger squared sums (up to 77 digits) and VWAP price-volume accumulations (up to 88 digits).
- Strictly prevents internal state contamination: recursive indicator states retain full 128-digit precision and never feed rounded 18dp public outputs back into recursive state machines.
- Enforces strict prefix determinism (zero lookahead): indicator output for candle $t$ depends strictly on candles $\le t$ within the calculation segment; future candles never alter past results; centered windows and retroactive repainting are barred.
- Guarantees exact batch/incremental parity: batch computations feed the identical sequential state kernel as live incremental processing; batch results equal incremental results timestamp-by-timestamp across all supported indicators.
- Employs deterministic warmup alignment: emits explicit `value: null` (never `0`, `NaN`, `Infinity`, or fake seeds) until mathematical warmup conditions are met.
- Enforces runtime safety on UTC-day VWAP: requires `floor(openTimeMs / 86_400_000) === floor((closeTimeExclusiveMs - 1) / 86_400_000)`, failing closed on candles genuinely straddling UTC midnight without synthetic splitting or open-day attribution.
- Enforces universal parameter boundary $1 \le period \le 100\,000$ (`MAX_INDICATOR_PERIOD`) and bounded memory guarantees ($O(period)$ for rolling indicators, $O(1)$ for recursive state machines).
- Maintains complete state isolation per instrument pair, timeframe, indicator type, parameter set, and bootstrap origin with zero module-global mutable state; multi-timeframe strategies combine independent indicator instances.
- Zero indicator database persistence: indicators are pure derived mathematical transformations; restart and recovery replay closed warmup candles from the segment origin.
- Explicitly defers true Volume Profile pending canonical trade-level price-volume data; synthetic intrabar volume distribution heuristics across OHLCV candles are strictly prohibited.
- Complete mathematical specifications, recurrence relations, precision budgets, and verification fixtures are frozen in `docs/INDICATOR_ENGINE.md`.

### 2.8 Strategy Framework (Phase 10)
- Environment-neutral, deterministic quantitative strategy architecture where the **identical pure strategy kernel** executes across historical backtesting, paper trading, shadow evaluation, and live production trading without environment-specific branches.
- Enforces strict unidirectional dependency, fail-closed input validation, and auditable dispatch:
  $$\text{Closed Market Truth} \longrightarrow \text{Phase 8 Indicator Kernels} \longrightarrow \text{Sanitized StrategyEvaluationSnapshot} \longrightarrow \text{Pure Strategy Kernel} \longrightarrow \text{StrategyDecision} \longrightarrow \text{StrategyDecisionSink} \longrightarrow \text{Environment Adapter} \longrightarrow \text{Dispatch Audit} \longrightarrow \text{Downstream Actions}$$
- **Zero Account / Order Awareness in Strategy Core:** The pure strategy core (`src/strategies/core/**`) is strictly prohibited from importing backtest engines, exchange clients, order APIs, risk engines, account equity, cash balances, exchange positions, or active orders.
- **Pre-Strategy Input Validation Contract:** Enforces strict structural checks (alias presence, pair match, timeframe match, closed timestamps, trigger freshness, and HTF same-timestamp freshness) and null-regression detection before warmup/ready handling. Malformed or missing indicator truth fails closed and never silently becomes warmup or flat.
- **Mandatory Decision Audit Sink:** Every actual trigger evaluation writes an immutable `StrategyDecision` to `StrategyDecisionSink` before any environment adapter reconciliation occurs. If the sink fails, the adapter fails closed with zero order output.
- **Environment Adapters Sanitize & Reconcile:** Adapters (e.g. `StrategyBacktestParticipantAdapter`) sanitize incoming runtime context (explicitly stripping account, position, and open-order fields) into an immutable `StrategyEvaluationSnapshot`, call `kernel.evaluate(snapshot)`, record a `StrategyDecisionDispatchRecord`, and reconcile abstract target exposures with environment-specific execution mechanisms.
- **Discriminated Non-Actionable Warmup:** Legitimate indicator warmup emits `status: 'WARMING'` with `targetExposure = null`; converting warmup into `FLAT` or generating exit orders during warmup is strictly prohibited, preventing accidental position liquidation during bootstrap.
- **Abstract Target Exposure:** Pure strategies emit desired market direction (`LONG`, `SHORT`, `FLAT`), never concrete orders (`BUY`, `SELL`), order types (`MARKET`, `LIMIT`), quantities, or leverage.
- **Trigger-Timeframe Scheduling:** Strategies evaluate if and only if their configured `triggerTimeframeMinutes` candle closes at evaluation timestamp $T$; multi-timeframe strategies observe newly finalized higher-timeframe candles and indicators closing at $T$ in ascending order, or their latest prior closed values.
- **Deterministic Identity & Canonical Normalization:** Exact decimal parameter canonicalization normalizes numeric-equivalent values (`"2"`, `"2.0"`, `"002.000"` $\to$ `"2"`) before SHA-256 `parameterHash` computation; analytical run segments bind authoritative per-timeframe `indicatorBootstrapIdentity` entries into `strategyInstanceId`; and adapter-only `fixedResearchQuantity` binds Phase 9 participant and run identity without leaking into strategy parameter hash.
- **Isolated Decimal Arithmetic:** Threshold and breakout math evaluates within an isolated 128-digit Decimal context (`StrategyCalcDecimal`, `ROUND_HALF_UP`) with native floating-point math strictly prohibited.
- **First 4 Parameterized Strategies:** Core implementations for EMA Trend V1 (`EMA_TREND`), ATR Breakout V1 (`ATR_BREAKOUT`), RSI Momentum V1 (`RSI_MOMENTUM`), and Multi-Timeframe Trend V1 (`MULTI_TIMEFRAME_TREND`).
- Complete specifications and verification contracts are frozen in `docs/STRATEGY_FRAMEWORK.md`.

### 2.9 Backtesting Engine
- High-performance, strictly deterministic offline event replay and simulation environment operating on verified Phase 7 canonical 1m datasets.
- Cryptographically bound dataset ingestion via a two-pass contract: Pass 1 verifies the complete manifest range `[fromInclusiveMs, toExclusiveMs)` against Phase 7 canonical logical-row hashing primitives (`encodeHistoricalLogicalRow`, `canonicalHashDecimal`, `computeDatasetId`); Pass 2 streams the replay span `[bootstrapFromInclusiveMs, replayToExclusiveMs)` from the identical immutable source. A valid manifest paired with a substituted candle stream is never accepted.
- Reuses Phase 6 `aggregateExactBucket` as the sole higher-timeframe aggregation primitive with common bootstrap alignment across all configured HTFs, and Phase 8 `IndicatorKernel` instances bound to actual derived candle origins, maintaining strict batch/incremental parity.
- Enforces strict no-lookahead causality: evaluation at timestamp $T$ observes only market data closed by $T$; decisions at $T$ become eligible for simulated execution no earlier than the next canonical source bar opening at $T$; order cancellations accepted at $T$ take effect at the next bar open before any fills, winning against open gap-throughs.
- Implements conservative 1m OHLCV execution semantics: all-or-none fills with zero synthetic partial-fill or queue priority fabrication; strictly positive execution prices ($> 0$); raw `bar.OPEN` post-only marketability rejection barrier; strict price penetration for resting `POST_ONLY_LIMIT` orders (`bar.low < limitPrice` for BUY, `bar.high > limitPrice` for SELL; equality touches do not fill); gap-through reference pricing for `STOP_MARKET` orders; intrabar OCO ambiguity resolved via `ADVERSE_FIRST` candidate reduction merged into a global `orderSequence` ascending total order; and whole-order rejection for reduce-only excess.
- Evaluates within an isolated 128-digit Decimal calculation context (`BacktestCalcDecimal`, `ROUND_HALF_UP`) with public 18-decimal quantization (`BacktestDecimal`) and linear perpetual futures accounting using discovered instrument metadata constraints (`priceIncrement`, `quantityIncrement`, `minQuantity`, `minTradeSize`, `minNotional`, and `contractMultiplier`).
- Exact reversal accounting: realized PnL is computed strictly on closing quantity ($\min(Q_{\text{existing}}, Q_{\text{fill}})$), the opening remainder generates zero realized PnL at entry, and exactly one trading fee is assessed on total executed notional.
- Deterministic accounting ledger: maintains `netPnl = realizedGrossPnl + unrealizedGrossPnl + fundingPnl - totalFees` and `equity = initialEquity + netPnl`; embedded spread and slippage cost attributions are tracked for reporting without double-counting.
- Causal funding cash flows: funding schedules are bounded to `(bootstrapFromInclusiveMs, replayToExclusiveMs]`; exactly one `FUNDING_APPLIED` event is emitted per scheduled timestamp (even when flat) and applies strictly to positions surviving through bar close at $T$ before evaluation at $T$.
- Guaranteed terminal disclosure: unresolved active orders are preserved in `terminalOpenOrders` and terminal open positions are marked at the final closed candle without synthetic liquidation, fake fees, or fake cancellations.
- Resource bounds & immutable snapshots: all behavior-affecting inputs are defensively normalized and deeply frozen before `runId` computation; `maxOpenOrders` (default 20, ceiling 100) enters run manifest identity; core replay memory is bounded to $O(\text{working state})$ decoupled from pluggable event sinks; and event sink write failures fail closed immediately (`isValid = false`, terminal `FAILED`).
- Auditable cryptographic lineage: deterministic JSON serialization with recursive key sorting at every nesting depth, newline-framed event ledger hashing (`eventLedgerSha256`), and comprehensive result hashing (`resultSha256`).
- Preserves strategy boundaries: pure Phase 10 strategies emit abstract signals through standardized interfaces; Phase 9 executes orders through research orchestration adapters without backtest-specific state leakage or live side effects.

### 2.10 Risk & Leverage Engine
- The non-bypassable guardian standing between strategy signals and order execution.
- Computes position sizing, margin utilization, liquidation distance, and leverage limits.
- Evaluates circuit breakers: max account drawdown, single-trade risk, daily loss limits, and consecutive loss halts.

### 2.11 Paper Trading & Shadow Mode
- **Paper Trading:** Executes strategy signals in real-time against exchange WebSocket feeds with a virtual ledger.
- **Shadow Mode:** Runs alongside live production accounts, submitting shadow orders in lockstep to benchmark fill probabilities, slippage, and queue delays.

### 2.12 Execution Engine
- State machine managing the lifecycle of an order: `INTENT_CREATED` → `SUBMITTED` → `ACKNOWLEDGED` → `PARTIALLY_FILLED` → `FILLED` / `CANCELLED` / `REJECTED`.
- Handles intelligent order routing, post-only enforcement, and partial fill tracking.

### 2.13 Reconciliation & Crash Recovery
- Runs immediately on startup before any trading loops begin.
- Fetches ground-truth exchange positions, open orders, and balances from CoinDCX.
- Resolves inconsistencies between local database state and exchange state; cancels dangling orphan orders.

### 2.14 News Risk Layer
- Asynchronous risk modifier ingesting macroeconomic event calendars and high-impact crypto news.
- Dynamically reduces risk scores, throttles leverage, or commands temporary position closure ahead of volatility spikes.

### 2.15 Monitoring & Logging Subsystem
- Structured JSON logging powered by Pino with automatic sensitive field redaction.
- Emits operational heartbeats, latency metrics, and error rates.

### 2.16 Quant Dashboard (Later Phase)
- Planned visualization interface for equity curves, open positions, risk metrics, and strategy health.

