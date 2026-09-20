# Generic Coin Onboarding Lifecycle

## 1. Overview

To uphold **Invariant 4** ("No Coin-Specific Hardcoding") and **Invariant 5** ("Modular Coin Onboarding"), adding a new cryptocurrency pair (e.g., SOL-INR or XRP-INR perpetual futures) must follow a strictly governed, automated pipeline without requiring any modifications to the core trading engine, risk models, or database schemas.

---

## 2. Coin Lifecycle States

A coin contract progresses through the following sequential states:

```
┌───────────────────┐
│    DISCOVERED     │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│   DATA_LOADING    │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│    DATA_READY     │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│    BACKTESTING    │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ RESEARCH_APPROVED │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│       PAPER       │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  PAPER_APPROVED   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│      SHADOW       │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  LIVE_CANDIDATE   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│       LIVE        │
└─────────┬─────────┘
          │ (emergency or deliberate deactivation)
          ▼
┌───────────────────┐
│     DISABLED      │
└───────────────────┘
```

### State Definitions

1. **`DISCOVERED`**:
   - The contract pair has been identified from CoinDCX exchange metadata queries.
   - Initial specifications (tick size, lot size, min order notional, leverage brackets, maker/taker fee tiers) are extracted and recorded.

2. **`DATA_LOADING`**:
   - Historical trade tick data and 1-minute candles are backfilled via CoinDCX REST APIs.
   - Ingestion progress is tracked; analytical engines are locked against incomplete data.

3. **`DATA_READY`**:
   - Historical backfill is complete with zero missing intervals or unresolved gaps.
   - Higher timeframes (5m, 15m, 1h, 4h, 1d) are synthesized and verified.

4. **`BACKTESTING`**:
   - Quantitative strategy matrix is executed across historical multi-regime datasets with realistic fees and funding costs.

5. **`RESEARCH_APPROVED`**:
   - Strategy backtests exceed predefined statistical hurdles (Sharpe > 1.5, Max Drawdown < 15%, Profit Factor > 1.3, Monte Carlo p-value < 0.01).

6. **`PAPER`**:
   - Instrument runtime is active in real-time simulation against live CoinDCX WebSocket market feeds.
   - Virtual orders are simulated with realistic latency and queue estimation in isolated virtual portfolios.

7. **`PAPER_APPROVED`**:
   - Minimum 14-day paper trading period completed with live performance tracking historical backtest expectations within 10% tolerance.

8. **`SHADOW`**:
   - **Mandatory Shadow Gate:** Instrument runs concurrently with live exchange connections.
   - Shadow orders track real-time queue priority, fill probability, and latency variance without capital at risk.

9. **`LIVE_CANDIDATE`**:
   - Risk parameters, capital allocation limits, and circuit breaker thresholds are reviewed for production deployment.

10. **`LIVE`**:
    - Instrument is approved for active capital execution.
    - Initiates exclusively in tiny-live mode with strict notional caps before scaling.

11. **`DISABLED`**:
    - Trading halted either intentionally (market illiquidity, delisting) or automatically (stale data, circuit breaker breach, excessive slippage).

---

## 3. End-to-End Onboarding Flow

```
CoinDCX instrument discovery
       │
       ▼
Metadata validation (precision, tick size, limits)
       │
       ▼
Historical 1m backfill
       │
       ▼
Data validation (zero gaps, monotonic timestamps)
       │
       ▼
Higher timeframe generation (5m, 15m, 1h, 4h, 1d)
       │
       ▼
Strategy matrix backtest (Coin × Strategy combinations)
       │
       ▼
Robustness validation (walk-forward, Monte Carlo)
       │
       ▼
Paper testing (isolated virtual portfolios)
       │
       ▼
Shadow mode (live queue & fill benchmarking)
       │
       ▼
Live candidate (risk review & allocation)
       │
       ▼
Explicit promotion (tiny-live deployment)
```

---

## 4. Key Architectural Guarantees for New Coins

### 4.1 Zero Core Engine Rewrites
Adding SOL, XRP, or any additional CoinDCX Futures coin must **never** require modifying:
- Canonical 1m candle engine
- Generic higher-timeframe aggregator
- Indicator engine
- Backtesting engine
- Strategy framework
- Risk & Leverage engine

All coin behavior is governed solely by verified instrument metadata and external configuration.

### 4.2 The Coin × Strategy Matrix
- Coins are not promoted in isolation; they are qualified as **Coin × Strategy pairs** (e.g. `SOL × EMA_TREND`, `SOL × ATR_BREAKOUT`).
- Every pair maintains its own lifecycle state and qualification scorecard.

### 4.3 Unified Implementation, Separate Parameters
- The same strategy class executes for all coins.
- Per-coin parameter configurations (e.g. lookback window, threshold multipliers) are loaded dynamically from validated configuration files.

### 4.4 Independent Paper Portfolios
- During paper testing, each coin-strategy combination trades in an isolated virtual portfolio to guarantee that performance metrics remain uncorrupted by other concurrent assets.

---

## 5. Phase 16 — New-Coin Architecture Proof (SOL Verification)

Phase 16 verifies SOL compatibility through application configuration, dynamic instrument discovery, deterministic fixture tests, generic production components, and an AST boundary scanner. It does not enable SOL paper, shadow, or live execution and does not modify the protected production core.

### 5.1 Configuration and discovery

`src/app/config/coins.ts` adds the actual SOL `CoinProfile` as an `Object.freeze({ ... })` entry with `underlying: 'SOL'`, the standard timeframes, the `DEFAULT_SAFE` risk profile, leverage values represented by `Decimal`, and all execution flags disabled. `CoinRuntimeBootstrapService` discovers the active pair dynamically from the underlying.

### 5.2 Scanner proof

The TypeScript compiler API scanner checks 209 files across the 12 protected directories. It performs case-insensitive, boundary-aware detection in string literals, all template token kinds, regular-expression literals, constant string concatenations, method arguments, comparisons, and object/array/property values. Identifier detection tokenizes camelCase, PascalCase, and separator-delimited names; it does not maintain an English-word allowlist. Synthetic tests cover the acceptance-review bypasses and ordinary-word negatives.

### 5.3 Integration proof level

The 28 Phase 16 integration tests establish these boundaries:

- CoinDCX fixture schema parsing, decimal normalization, `CoinMetadata` mapping, runtime eligibility, registry, and bootstrap.
- Generic public WebSocket channel construction.
- `createCanonicalCandle1m` validation from supplied OHLCV fields, historical chunk planning, exact 5-minute aggregation, and EMA/RSI/ATR calculations. The proof does not exercise `CanonicalMarketDataEngine` trade-tick ingestion.
- A minimal `BacktestEngine` run and SOL-compatible backtest instrument specification.
- Construction of four production strategy kernels and a `StrategyRegistry` kernel. No candles are executed through those kernels and no signal is asserted. Exposure terminology is `LONG` / `SHORT` / `FLAT`.
- Strategy × coin planning through the real `planWithGitSourceVerifier` function.
- Phase 13 `verifyCurrentValuation` compatibility for unit valuation and aggregate current notional. Maintenance margin and liquidation price remain deferred.
- Construction and validation of a `PaperInstrumentEconomicsSnapshot` only. `PaperAccountKernel`, paper sessions, ledger postings, and the paper fill path are not exercised.
- Genuine Phase 12 `PASSED` output entering `rankStrategyCandidates` and producing an authoritative in-memory ranking run set. No ranking persistence is claimed.
- BTC/ETH configuration and pair-generic strategy regression checks.

### 5.4 Optional live gate

`npm run test:integration:sol-live` performs read-only discovery, checks the underlying, INR margin currency, perpetual kind, active status, and positive multiplier/tick/lot values, then reports current metadata. It does not assert an exact multiplier, tick, lot, or tier count.

For the exact fixture, scanner token set, limitations, and reproduction commands, see [PHASE16_NEW_COIN_PROOF.md](./PHASE16_NEW_COIN_PROOF.md).

The Phase 16 final acceptance run passed exactly 182 test files and 2,362 tests.
