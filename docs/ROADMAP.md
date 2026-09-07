# Development Roadmap

This document defines the frozen, sequential 26-phase development roadmap for the **CoinDCX Quant Futures Bot**. Each phase builds deterministically upon the foundations established by preceding phases.

---

| Phase | Name | Description | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | **Frozen Documentation** | Establish core architectural source of truth, scope boundaries, invariants, onboarding procedures, and strategy lifecycle. | COMPLETE |
| **Phase 1** | **Foundation** | Node.js + strict TypeScript setup, Express server, MySQL 8 + Prisma persistence, Zod configuration, decimal arithmetic, structured logging with secret redaction, health API, graceful shutdown, Vitest, Docker, and GitHub Actions CI. | COMPLETE |
| **Phase 2** | **CoinDCX Read Layer** | Read-only REST API client for CoinDCX: instrument metadata discovery, contract specifications, order book snapshots, historical trade queries, and rate-limit tracking. | COMPLETE |
| **Phase 3** | **Coin Runtime Layer** | Dynamic, isolated per-coin operational supervisor; coin configuration loading without hardcoded symbol logic. | COMPLETE |

| **Phase 4** | **Public/Private WebSockets** | Real-time WebSocket connection manager: public trade feeds, order book depth feeds, private user execution updates, automatic reconnection, and heartbeat management. | COMPLETE |
| **Phase 5** | **Canonical 1m Market Data** | Transport 1m candle update -> canonical 1m finalization, successor-confirmed finality, gap detection, REST recovery barrier, and immutable persistence of finalized 1-minute OHLCV candles to MySQL 8. | COMPLETE |
| **Phase 6** | **Generic Higher-Timeframe Engine** | Pure mathematical aggregation engine deriving generic higher-timeframe candles (initial supported set: 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h, 1d; safe integer `timeframeMinutes >= 2`) exclusively from canonical 1m data with exact completeness, isolated 64-bit decimal arithmetic, pair-scoped serialization, and deterministic batch/live parity. | COMPLETE |
| **Phase 7** | **Historical Dataset Engine** | Deterministic, reproducible historical canonical 1m dataset engine: resumable chunked REST backfill via CoinDcxFuturesCandleRestReader, zero synthetic gap-filling, immutable MySQL candles_1m persistence, deterministic SHA-256 content/datasetId hashing, manifest tracking, streaming NDJSON export/import, and Phase 6 higher-timeframe parity. | COMPLETE |
| **Phase 8** | **Indicator Engine** | Deterministic technical-indicator computation engine (SMA, EMA, Wilder RMA, ATR, RSI, MACD, Bollinger Bands, DMI/ADX, SuperTrend, Donchian Channel, UTC-day VWAP, Volume SMA, Volume Ratio) operating on validated closed candles with strict 128-digit isolated decimal precision, dual incremental/batch parity, zero lookahead, and deterministic warmup alignment; true Volume Profile is explicitly deferred pending canonical trade-level price-volume data. | COMPLETE |
| **Phase 9** | **Backtest Engine Foundation** | Deterministic, reproducible, event-driven backtest simulation engine operating strictly on verified Phase 7 canonical 1m datasets: two-pass cryptographic dataset binding, exact Phase 6 higher-timeframe and Phase 8 indicator kernel reuse, causal next-bar event loop with cancellation causality, conservative OHLCV execution semantics (all-or-none fills, raw-open post-only rejection, resting strict penetration, gap-through stop-market, intrabar OCO adverse-first with global sequence total ordering, whole-order reduce-only excess rejection), exact reversal accounting on closing quantity, deterministic accounting ledger, explicit fees, spread/slippage attribution, causal funding boundaries, immutable input snapshot, maxOpenOrders in run identity, terminal open orders reporting, fail-closed sink failure, and deterministic SHA-256 run/ledger/result hashing. | COMPLETE |
| **Phase 10** | **Strategy Framework & First 4 Strategies** | Environment-neutral quantitative strategy framework, deterministic strategy identity and canonical parameter hashing (parameterHash, strategyInstanceId), discriminated non-actionable warmup state model (WARMING vs. READY), abstract target-exposure decisions (LONG, SHORT, FLAT), exact trigger-timeframe scheduling, same-timestamp multi-timeframe synchronization, Phase 8 indicator kernel reuse, first four parameterized strategies (EMA Trend, ATR Breakout, RSI Momentum, Multi-Timeframe Trend), and thin Phase 9 research backtest adapter. | CURRENT |
| **Phase 11** | **Strategy Matrix Backtesting** | Parameter optimization grid, walk-forward analysis, cross-validation, and multi-regime simulation. | PLANNED |
| **Phase 12** | **Research Validation Lab** | Statistical validation suite: Sharpe ratio, Sortino ratio, max drawdown, profit factor, expectancy, Monte Carlo permutation testing, and overfitting detection. | Planned |
| **Phase 13** | **Risk + Leverage Engine** | Real-time position sizing, margin utilization calculations, dynamic leverage limits, daily drawdown limits, and emergency kill switches. | Planned |
| **Phase 14** | **Paper Trading** | Real-time simulated execution engine operating against live exchange market data feeds with a virtual ledger. | Planned |
| **Phase 15** | **Strategy Ranking** | Composite performance scoring and ranking system to evaluate and qualify strategies for paper and shadow trading. | Planned |
| **Phase 16** | **New-Coin Architecture Proof** | Formal architectural validation: onboard SOL using only dynamic metadata discovery and configuration without altering core engine code. | Planned |
| **Phase 17** | **CoinDCX Live Execution** | Production order execution engine: signed authenticated order dispatch, client order ID tracking, post-only orders, and partial fill handlers. | Planned |
| **Phase 18** | **Reconciliation + Crash Recovery** | Startup reconciliation engine: state alignment between database and CoinDCX exchange, orphan order cleanup, and position integrity guarantees. | Planned |
| **Phase 19** | **24/7 Shadow Mode** | Parallel order evaluation running alongside production capital to measure execution slippage, queue priority, and latency variance. | Planned |
| **Phase 20** | **Tiny Live BTC** | Minimal-notional live trading rollout on BTC-INR perpetual futures under strict `SAFE` risk mode. | Planned |
| **Phase 21** | **Tiny Live ETH** | Minimal-notional live trading rollout on ETH-INR perpetual futures under strict `SAFE` risk mode. | Planned |
| **Phase 22** | **Multi-Strategy / Regime** | Multi-strategy portfolio allocation, regime detection (trending vs. ranging vs. high volatility), and dynamic capital weight balancing. | Planned |
| **Phase 23** | **Production New-Coin Onboarding** | Operational pipeline for onboarding additional liquid CoinDCX perpetual futures into live trading. | Planned |
| **Phase 24** | **News Risk Engine** | Asynchronous external macroeconomic calendar and news sentiment filter functioning as a circuit breaker. | Planned |
| **Phase 25** | **Quant Dashboard** | Telemetry, equity curve charting, real-time exposure tracking, and operational control dashboard. | Planned |

