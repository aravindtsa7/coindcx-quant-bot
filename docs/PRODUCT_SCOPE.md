# Frozen Product Scope

## 1. Executive Summary

The **CoinDCX Quant Futures Bot** is an automated quantitative trading platform engineered specifically and exclusively for CoinDCX INR-Margined Crypto Perpetual Futures. The system is designed from first principles to operate reliably in a 24/7 continuous market environment with institutional-grade risk controls, deterministic decimal precision, and a rigorous promotion pipeline for algorithmic trading strategies.

---

## 2. Core Operational Scope

### 2.1 Exchange & Instrument Exclusivity
- **Exchange:** CoinDCX ONLY. Multi-exchange connectivity, abstraction layers for third-party venues, and cross-exchange arbitrage are strictly out of scope.
- **Product:** CoinDCX INR-Margined Crypto Perpetual Futures ONLY. Spot trading, options, expiry futures, and non-INR margin pairs are strictly excluded.
- **Account Model:** Single CoinDCX account. Single user. Multi-tenancy, multi-user role management, and sub-account routing are strictly excluded.
- **Market Dynamics:** Continuous 24/7 operation with automatic reconnection, heartbeat monitoring, and crash-reconciliation safety routines.

### 2.2 Coin Universe & Expansion Architecture
- **Initial Coins:** Bitcoin (`BTC`) and Ethereum (`ETH`) perpetual futures against INR.
- **Dynamic Onboarding:** Architecture must not hard-code BTC, ETH, or any specific symbol into core engines, indicators, order routers, or risk calculations.
- **Future Expansion:** Additional CoinDCX Perpetual Futures contracts (such as Solana `SOL` and other liquid pairs) must be capable of being onboarded through configuration and verified data backfill without core engine modifications.

---

## 3. Strategy & Research Architecture Scope

### 3.1 Multiple Strategy Support
The system is built to support a heterogeneous library of quantitative strategies (trend-following, mean-reversion, breakout, statistical volatility, etc.). Every strategy operates under a unified lifecycle framework.

### 3.2 Strategy Promotion Pipeline
No quantitative strategy is ever deployed directly to production capital. Every strategy must progress through a mandatory, gate-controlled qualification pipeline:
1. **Backtest:** Historical verification across multiple market regimes with realistic fees, funding rates, and slippage models.
2. **Paper Trading:** Real-time simulated execution against live exchange market data in independent virtual portfolios.
3. **Shadow Mode:** Mandatory shadow gate running concurrently with live exchange feeds to benchmark real-time order queue priority, fill probability, and latency without risking capital.
4. **Tiny-Live:** Production execution with strictly bounded, minimal sizing before scaling.

### 3.3 The Coin × Strategy Matrix
- The fundamental unit of research and promotion is the **Coin × Strategy combination** (e.g. `BTC × EMA_TREND`, `ETH × RSI_MOMENTUM`).
- Strategies use a single uniform implementation across coins; coin-specific adaptations are governed strictly by external, validated parameter sets (never separate implementations like `BtcEmaStrategy`).
- Adding new coins (e.g. SOL, XRP) must never require altering the core candle engine, aggregator, indicators, backtester, strategy engine, or risk engine.

---

## 4. Risk & Capital Management Scope

### 4.1 Leverage Management
- Leverage is user-configurable per instrument up to maximum exchange-approved limits.
- Margin requirement calculations are evaluated continuously with decimal-safe precision.

### 4.2 Risk Modes
The system will provide four distinct operational risk modes:
- **`SAFE`:** Conservative leverage caps, tight stop losses, strict daily drawdown halts, low position size limits.
- **`NORMAL`:** Balanced risk parameters tailored for steady compounded returns under standard market volatility.
- **`HIGH`:** Elevated exposure limits and higher leverage ceilings for high-conviction regimes; **never** disables core safety controls, invariant circuit breakers, or exchange kill switches.
- **`CUSTOM`:** Granular user-defined thresholds conforming strictly to the platform's core safety invariants.

### 4.3 News & Event Risk Layer
A dedicated external news and macroeconomic event risk layer will serve as an independent circuit breaker, capable of adjusting exposure, widening stops, or triggering temporary trading halts during high-impact geopolitical or regulatory events.

---

## 5. Explicit Non-Goals (Out of Scope)

The following capabilities are explicitly out of scope for the architecture:
- **No Multi-Exchange Support:** No CCXT or generic exchange abstraction layers.
- **No Multi-User / Multi-Tenant Support:** Single user, single API key configuration.
- **No Spot Market Trading:** No spot order routing, spot wallet balancing, or spot asset custody.
- **No Options Trading:** No options pricing, greeks management, or options contracts.
- **No Heavy Infrastructure:** No Redis, Kafka, Kubernetes, or microservice mesh. The application is a unified, modular monolith backed by MySQL 8.
- **No Frontend / Web Dashboard in Early Phases:** Operational control is headless and CLI/API-driven; user interfaces are reserved for later phases.

