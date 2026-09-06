# Core System Invariants

The following 21 invariants are non-negotiable architectural and operational laws governing the **CoinDCX Quant Futures Bot**. No feature, performance optimization, refactoring, or hotfix may violate these rules.

---

### Invariant 1: CoinDCX Only
The platform integrates exclusively with CoinDCX. No generic multi-exchange abstraction layers, adapters, or cross-exchange routing logic shall be introduced into the codebase.

### Invariant 2: INR Futures Only
Trading logic, margin calculations, collateral tracking, and PnL reporting operate exclusively on CoinDCX INR-Margined Perpetual Crypto Futures contracts. Spot, Options, and foreign currency contracts are strictly barred.

### Invariant 3: Single User
The bot is engineered for a single user operating a single CoinDCX account. Multi-tenancy, authentication delegation, and user role isolation layers are out of scope and prohibited.

### Invariant 4: No Coin-Specific Hardcoding
Coin-specific values (e.g., symbol names, tick sizes, step sizes, price precision, min/max notional limits, leverage brackets) must never be hard-coded into core trading, risk, or data engines. All instrument parameters must be supplied via dynamic exchange metadata discovery or external coin configuration.

### Invariant 5: Modular Coin Onboarding
Onboarding a new coin (such as SOL) must never require altering the core engine, risk calculators, order state machines, or database schemas. All coin additions are strictly driven by configuration and verified historical data backfill.

### Invariant 6: Canonical 1m Market Data Truth
The finalized 1-minute candle is the foundational source of truth for all quantitative analysis. All market data ingestion paths converge onto canonical 1m candles stored in MySQL.

### Invariant 7: Higher Timeframe Derivation
All configured higher timeframes (including the initial production-supported set: 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h, 1d) must be mathematically synthesized exclusively from authoritative canonical 1m candles using exact constituent completeness without data fabrication. The core aggregation engine is strictly generic for safe integer durations (`timeframeMinutes: integer >= 2`, preserving canonical 1m exclusivity in Phase 5) and must not hardcode timeframe durations or coin symbols. All operations must be serialized per pair and strictly gated by upstream canonical health; derived aggregate sums must maintain exact decimal precision without silent truncation. Exchange-provided higher-timeframe candles must not be used as authoritative data sources.

### Invariant 8: Stale Data Protection
Incomplete, missing, or stale market data must immediately inhibit new live trade entries. If the latency between the current timestamp and the latest finalized candle exceeds predefined safety thresholds, signal processing for that instrument must halt.

### Invariant 9: Complete Strategy Decoupling
Strategies are pure analytical components. A strategy cannot access network sockets, call exchange APIs directly, query account balances, or construct execution orders. Strategies emit only abstract signals (`LONG`, `SHORT`, `FLAT`) with confidence and intent parameters.

### Invariant 10: Non-Bypassable Risk Engine
All strategy signals must pass through the central Risk & Leverage Engine before reaching the execution layer. There is no execution path in the software that bypasses risk validation.

### Invariant 11: Invariant Core Safety Controls in High Risk Mode
Selecting `HIGH` risk mode may elevate leverage caps or position sizing parameters, but it must never disable core safety controls, invariant circuit breakers, liquidation buffers, or exchange kill switches.

### Invariant 12: Idempotent Order State Management
An order with an unknown, pending, or ambiguous state must never be blindly retried or re-submitted. The system must query exchange ground-truth or wait for reconciliation before taking remedial action.

### Invariant 13: Fill-Derived Position Truth
A position's size, average entry price, and realized PnL are determined solely by confirmed exchange execution fills, never by sent order quantities or unconfirmed optimistic state updates.

### Invariant 14: Mandatory Startup Reconciliation
Reconciliation between local database records and actual CoinDCX open positions, orders, and balances must complete successfully before any live strategy execution loops are initialized.

### Invariant 15: Crash Recovery Idempotency
Application restart, process crashes, or infrastructure reboots must never cause duplicate orders or duplicate positions. Startup routines must discover existing active orders and reconcile them with active state machines.

### Invariant 16: Zero Credential Leakage
API credentials, API secrets, signing keys, and session tokens must never be written to application logs, exposed in HTTP error responses, emitted over telemetry, or committed to version control.

### Invariant 17: Uniform Strategy Implementation
The identical strategy code and logic that executes in live trading must be used in backtesting, paper trading, and shadow mode. No separate "live" and "simulation" strategy forks are permitted.

### Invariant 18: Realistic Cost Modeling
Backtesting and simulation environments must account for realistic taker/maker trading fees, 8-hour perpetual funding rate debits/credits, and market impact slippage. Cost-free backtests are strictly invalid.

### Invariant 19: Full Audit Lineage
Every production trade must be completely traceable from end to end:
`Signal Generation` → `Risk Evaluation` → `Execution Intent` → `Exchange Order` → `Execution Fills` → `Position Update` → `Position Exit`.

### Invariant 20: Explicit Live Trading Activation
Live trading capabilities must remain physically disabled until explicit, multi-phase verification is complete and later-phase activation approval is granted. Live order placement code paths must not exist in early foundations.

### Invariant 21: Deterministic Historical Datasets & Zero Data Fabrication
Historical 1-minute research datasets must be acquired exclusively from genuine CoinDCX Futures closed candlestick REST data, persisted directly to the single canonical `candles_1m` store under the exact same `CanonicalDecimal` and structural OHLC validation as live candles, and identified deterministically by SHA-256 content hashing of logical market truth. Missing intervals must be retrieved genuine from the exchange or marked incomplete; synthetic gap fabrication (interpolation, forward-filling, previous-close copying, zero-volume insertion, or silent minute skipping) is strictly prohibited. Historical backfill and import write operations must execute as offline tasks without concurrent live Phase 5 writers.

### Invariant 22: Deterministic Indicator Engine & Zero Lookahead
Technical indicators derive strictly from closed, validated Phase 5 canonical 1m (`CanonicalCandle1m`) or Phase 6 higher-timeframe (`HigherTimeframeCandle`) candles through pure, deterministic decimal arithmetic. All calculations execute within an unbroken calculation segment bound to an explicit `bootstrapStartOpenTimeMs`. For recursive indicators, exact state and output parity across restarts requires replaying continuous closed candles from the identical bootstrap origin (claims that "recent warmup candles" can reconstruct an existing recursive state are strictly barred). All intermediate calculations execute within an isolated 128-digit decimal context (`IndicatorCalcDecimal`, `ROUND_HALF_UP`) with native floating-point math strictly forbidden, producing immutable `IndicatorDecimal` outputs quantized to maximum 18 decimal places without feeding rounded values back into recursive state machines. The engine enforces prefix determinism (zero lookahead within the calculation segment; output at candle $t$ depends only on candles $\le t$), strict stream continuity (failing closed on gaps, duplicates, or out-of-order candles without synthetic interpolation or forward-filling), exact batch/incremental parity (batch execution feeds the identical incremental state kernel), complete state isolation (no module-global mutable state; independent instances across pairs, timeframes, parameters, and bootstrap origins), deterministic warmup semantics (emitting `null` before mathematical readiness, never `0`, `NaN`, `Infinity`, or fake seeds), universal period parameter bounds ($1 \le period \le 100\,000$), bounded memory guarantees ($O(period)$ for rolling indicators, $O(1)$ for recursive states, never accumulating total run history), runtime midnight safety for UTC-day VWAP (rejecting candles spanning two UTC calendar days), and zero indicator database persistence (state is reproducible via segment replay). Authoritative Volume Profile calculation is strictly deferred pending canonical trade-level price-volume data; synthetic intrabar volume distribution heuristics are barred. Identical closed candle truth with identical parameters and identical bootstrap origin must yield bit-for-bit identical indicator outputs.
