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
