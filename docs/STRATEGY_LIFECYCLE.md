# Quantitative Strategy Lifecycle

## 1. Overview

Every quantitative trading strategy implemented in the **CoinDCX Quant Futures Bot** adheres strictly to a standardized, multi-stage qualification lifecycle. The objective is to eliminate curve-fitting, prevent deployment of underperforming or regime-fragile algorithms, and rigorously preserve capital.

---

## 2. Strategy Lifecycle States

```
┌───────────────────┐
│     RESEARCH      │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ BACKTEST_APPROVED │
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
          │ (drawdown, anomaly, or operator intervention)
          ▼
┌───────────────────┐
│     SUSPENDED     │
└───────────────────┘
```

### State Definitions & Transition Criteria

1. **`RESEARCH`**:
   - Initial formulation and hypothesis development of a quantitative trading model.
   - Implements the standardized strategy interface (`evaluate(context): Signal[]`).
   - Preliminary in-sample parameter exploration and feature engineering.

2. **`BACKTEST_APPROVED`**:
   - Strategy passes rigorous out-of-sample backtesting across multiple years of canonical 1m market data.
   - **Gating Criteria:**
     - Out-of-sample Sharpe Ratio $\ge 1.5$.
     - Maximum Historical Drawdown $\le 15\%$.
     - Profit Factor $\ge 1.3$.
     - Minimum 200 trade sample across both trending and ranging market regimes.
     - Parameter robustness verified against perturbation ($\pm 20\%$ parameter variation does not destroy edge).

3. **`PAPER`**:
   - Real-time forward testing against live CoinDCX market data streams.
   - Emits virtual orders into isolated simulated execution books with simulated fee/slippage models.

4. **`PAPER_APPROVED`**:
   - Strategy completes a minimum observation period of 14 consecutive calendar days in paper trading.
   - **Gating Criteria:**
     - Paper trading PnL tracks within $15\%$ of expected model trajectory.
     - Realized slippage conforms to model expectations.
     - Zero unhandled exceptions or state synchronization failures.

5. **`SHADOW`**:
   - **Mandatory Shadow Gate:** Strategy runs concurrently alongside live production execution.
   - Evaluates real-time order generation against actual live exchange order queue state, benchmarking queue latency, theoretical fill rates, and execution drag without capital risk.

6. **`LIVE_CANDIDATE`**:
   - Strategy successfully completes shadow validation and is reviewed for production capital allocation.
   - Initial leverage caps, position boundaries, and risk limits are configured in the Risk Engine.

7. **`LIVE`**:
   - Strategy actively emits production signals routed through the Risk & Leverage Engine to CoinDCX.
   - Deploys initially in **Tiny-Live** sizing (minimum exchange notional) before scaling to target allocation.

8. **`SUSPENDED`**:
   - Strategy execution is immediately halted, open orders cancelled, and positions flattened.
   - **Trigger Conditions:**
     - Drawdown exceeds $1.5\times$ historical maximum drawdown.
     - Consecutive loss count breaches risk threshold.
     - Execution slippage exceeds expected bounds for 3 consecutive trades.
     - Manual operator kill switch triggered.

---

## 3. Core Principles of the Strategy System

### 3.1 The Coin × Strategy Matrix
The primary unit of quantitative research and promotion is the **Coin × Strategy combination**:
- Examples: `BTC × EMA_TREND`, `BTC × ATR_BREAKOUT`, `ETH × EMA_TREND`, `ETH × RSI_MOMENTUM`.
- Each combination is tracked, backtested, paper-traded, shadowed, and promoted as an independent candidate.
- A strategy may qualify for `BTC` while failing qualification for `ETH`, or vice versa.

### 3.2 Single Uniform Strategy Implementation
- **Rule:** Do NOT create separate coin-specific strategy implementations (e.g., `BtcEmaStrategy`, `EthEmaStrategy`).
- There is exactly **one** implementation of each strategy algorithm.
- Variations across coins are handled strictly via external, validated per-coin parameter sets where statistical evidence justifies divergence.

### 3.3 Independent Virtual Paper Portfolios
- During comparative research and paper testing, every active strategy operates with its own isolated virtual ledger and capital pool.
- Performance, equity curves, drawdown calculations, and margin tracking for one strategy are completely isolated from and cannot contaminate any other strategy.

### 3.4 The Mandatory Shadow Gate
- Direct promotion from paper trading to live trading is strictly forbidden.
- Shadow mode is an invariant pre-condition for live execution, ensuring real-world queue priority, network latency, and exchange behavior are verified before putting capital at risk.
