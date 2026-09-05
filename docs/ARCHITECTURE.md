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

### 2.6 Indicator Engine
- Deterministic, zero-side-effect computational library for technical and quantitative indicators (EMA, RSI, ATR, Bollinger Bands, etc.).
- Operates exclusively on decimal-safe inputs and arrays of validated candles.

### 2.7 Strategy Research Lab
- Unified framework hosting quantitative strategy definitions.
- Defines a standardized interface: `onCandle(context): Signal[]`.
- Strategies are completely decoupled from execution channels, exchange APIs, and account balances.

### 2.8 Backtesting Engine
- High-fidelity event-driven simulation environment.
- Models maker/taker fee structures, funding payments, order queue latency, and slippage based on candle liquidity profiles.
- Validates strategy performance across distinct historical market regimes.

### 2.9 Risk & Leverage Engine
- The non-bypassable guardian standing between strategy signals and order execution.
- Computes position sizing, margin utilization, liquidation distance, and leverage limits.
- Evaluates circuit breakers: max account drawdown, single-trade risk, daily loss limits, and consecutive loss halts.

### 2.10 Paper Trading & Shadow Mode
- **Paper Trading:** Executes strategy signals in real-time against exchange WebSocket feeds with a virtual ledger.
- **Shadow Mode:** Runs alongside live production accounts, submitting shadow orders in lockstep to benchmark fill probabilities, slippage, and queue delays.

### 2.11 Execution Engine
- State machine managing the lifecycle of an order: `INTENT_CREATED` → `SUBMITTED` → `ACKNOWLEDGED` → `PARTIALLY_FILLED` → `FILLED` / `CANCELLED` / `REJECTED`.
- Handles intelligent order routing, post-only enforcement, and partial fill tracking.

### 2.12 Reconciliation & Crash Recovery
- Runs immediately on startup before any trading loops begin.
- Fetches ground-truth exchange positions, open orders, and balances from CoinDCX.
- Resolves inconsistencies between local database state and exchange state; cancels dangling orphan orders.

### 2.13 News Risk Layer
- Asynchronous risk modifier ingesting macroeconomic event calendars and high-impact crypto news.
- Dynamically reduces risk scores, throttles leverage, or commands temporary position closure ahead of volatility spikes.

### 2.14 Monitoring & Logging Subsystem
- Structured JSON logging powered by Pino with automatic sensitive field redaction.
- Emits operational heartbeats, latency metrics, and error rates.

### 2.15 Quant Dashboard (Later Phase)
- Planned visualization interface for equity curves, open positions, risk metrics, and strategy health.

