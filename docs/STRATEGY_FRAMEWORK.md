# Strategy Framework & First 4 Strategies — Phase 10 Architecture & Specification

## 1. Executive Summary & System Boundary

Phase 10 establishes the **Strategy Framework & First 4 Strategies** for the **CoinDCX Quant Futures Bot**. It defines a strictly environment-neutral, deterministic quantitative strategy architecture where the **identical pure strategy kernel** executes without alteration across all operational environments:

- **Historical Event-Driven Backtest** (Phase 9 / Phase 11)
- **Real-Time Paper Trading** (Phase 14)
- **24/7 Shadow Execution** (Phase 19)
- **Live Production Trading** (Phase 17, 20, 21, 22)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           UPSTREAM MARKET & INDICATOR TRUTH                     │
│                                                                                 │
│   Phase 5: Canonical 1m Market Data (CanonicalCandle1m)                         │
│   Phase 6: Generic Higher-Timeframe Engine (HigherTimeframeCandle)              │
│   Phase 8: Indicator Engine (IndicatorKernel<T>, IndicatorPoint<T>)             │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Closed candles & verified indicator points
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      PHASE 10 ENVIRONMENT ADAPTER LAYER                         │
│                                                                                 │
│   - Receives environment context (e.g. Phase 9 BacktestEvaluationContext)       │
│   - Sanitizes & strips account equity, position state, open orders, clocks      │
│   - Constructs immutable StrategyEvaluationSnapshot (closed market truth only)  │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Sanitized StrategyEvaluationSnapshot
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      PHASE 10 PURE STRATEGY KERNEL (ISOLATED)                   │
│                                                                                 │
│   - Pre-Strategy Required Indicator Validation Contract (presence, freshness)   │
│   - Pure analytical state machine (Zero account, zero order, zero risk awareness)│
│   - Trigger-timeframe gating (Evaluates ONLY on closed trigger candle)          │
│   - Reuses Phase 8 indicator points directly (Zero duplicated math)             │
│   - Emits abstract target exposure: WARMING (null) or READY (LONG, SHORT, FLAT) │
│   - 128-digit isolated decimal arithmetic (StrategyCalcDecimal)                 │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Immutable StrategyDecision
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     PHASE 10 MANDATORY DECISION AUDIT SINK                      │
│                                                                                 │
│   - StrategyDecisionSink.writeDecision(decision) MUST succeed BEFORE action     │
│   - Emits immutable StrategyDecisionDispatchRecord (status, actionBatchSha256) │
│   - Prevents any decision from silently vanishing without audit trace           │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Persisted StrategyDecision
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      DOWNSTREAM RECONCILIATION & EXECUTION                      │
│                                                                                 │
│   - Backtest Adapter: Reconciles target exposure with simulated position        │
│   - Phase 13 Risk Engine: Dynamic sizing, leverage, liquidation buffers         │
│   - Phase 14 / 17: Order intent dispatch to Paper or Live Exchange APIs         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### The Central Architectural Law: Environment Parity
> **Core Architectural Law:** The exact same pure strategy code, kernel classes, and decision logic that execute in live trading MUST execute in backtest, paper trading, and shadow mode. No backtest-specific strategy logic, mock evaluation paths, or simulation superpowers may be introduced into the strategy core.

To uphold this law:
1. **Unidirectional Dependency:** Pure strategy logic lives in `src/strategies/core/**` and MUST NEVER import backtest engines, exchange clients, order APIs, risk engines, account balances, positions, or active order records.
2. **Environment Adapters Translate:** Orchestration adapters (such as `StrategyBacktestParticipantAdapter`) bridge the environment to the strategy by sanitizing incoming inputs into an environment-neutral snapshot, calling `kernel.evaluate(snapshot)`, writing the resulting decision to `StrategyDecisionSink`, and reconciling the abstract target exposure into concrete actions.
3. **No Financial Position Awareness in Kernel:** Pure strategies do not decide *how many contracts to buy* or *what orders to cancel*; they decide *what the market regime dictates our exposure should be* (`LONG`, `SHORT`, `FLAT`, or `WARMING`).

---

## 2. Phase Boundary & Non-Goals

Phase 10 has strict responsibilities. To prevent scope creep and architectural contamination, ownership boundaries are frozen as follows:

### 2.1 Owned by Phase 10
- **Strategy Identity & Versioning:** Semantic strategy IDs, semantic versions, parameter schemas, and canonical parameter hashing.
- **Canonical Decimal & Parameter Normalization:** Exact lexical rules normalizing numeric-equivalent decimal parameters (e.g. `"2"`, `"2.0"`, `"002.000"` $\to$ `"2"`) and arrays before hashing.
- **Per-Timeframe Bootstrap Identity:** Authoritative `indicatorBootstrapIdentity` binding each distinct required timeframe's Phase 8 bootstrap origin into `strategyInstanceId`.
- **Pre-Strategy Input Validation Contract:** Strict structural validation of required indicator presence, pair match, timeframe match, timestamps, freshness, and null-regression detection before warmup/ready handling.
- **Environment-Neutral Strategy Kernel:** Stateful, purely analytical evaluation contracts and lifecycles with deterministic mutation ordering.
- **Trigger-Timeframe Scheduling:** Exact closed-candle evaluation triggers and multi-timeframe synchronization rules.
- **Indicator Requirement Bindings:** Explicit, declarative bindings reusing Phase 8 indicator kernels.
- **Warmup Discrimination:** Safe, non-actionable `WARMING` state machine preventing accidental liquidation during indicator bootstrap.
- **Abstract Strategy Decisions:** Deterministic `StrategyDecision` emitting abstract target exposure (`LONG`, `SHORT`, `FLAT`).
- **Mandatory Decision Audit Sink:** Phase-10-owned `StrategyDecisionSink` and `StrategyDecisionDispatchRecord` ensuring durable audit before adapter action translation.
- **First 4 Generic Strategies:** Production-ready implementations of EMA Trend, ATR Breakout, RSI Momentum, and Multi-Timeframe Trend.
- **Backtest Research Adapter:** A thin translation adapter proving Phase 9 backtest compatibility with fixed research quantity bound to Phase 9 participant identity.
- **Deterministic Decision Audit Lineage:** Canonical SHA-256 decision IDs and stable machine-readable reason codes.

### 2.2 Explicitly NOT Owned by Phase 10 (Deferred)
- **Phase 11 (Strategy Matrix & Optimization):** Grid search, parameter optimization, walk-forward analysis, cross-validation matrices, and multi-regime simulation.
- **Phase 12 (Research Validation Lab):** Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, Monte Carlo permutations, and overfitting detection.
- **Phase 13 (Risk & Leverage Engine):** Position sizing, portfolio risk budget, dynamic leverage, margin utilization, daily loss limits, liquidation safety, and risk rejection.
- **Phase 14 (Paper Trading):** Real-time WebSocket feed ingestion and virtual live execution.
- **Phase 17 (CoinDCX Live Execution):** Signed REST/WS order submission, client order IDs, and real exchange order dispatch.
- **Phase 18 (Reconciliation & Crash Recovery):** Exchange position synchronization, orphan order cleanup, and startup reconciliation.

### 2.3 Prohibited Capabilities in Phase 10 Strategy Core
No strategy kernel in Phase 10 may:
- Choose leverage (e.g. 5x, 10x).
- Choose account risk percentage (e.g. 1%, 2%).
- Calculate margin or required collateral.
- Submit CoinDCX or exchange orders.
- Access API credentials or secret keys.
- Access exchange REST or WebSocket APIs.
- Query or inspect account equity or cash balances.
- Query or inspect open exchange positions.
- Query or inspect pending or open orders.
- Inspect wall-clock time (`Date.now()`, `new Date()`).

---

## 3. Required Dependency Direction & Import Isolation

The dependency architecture is strictly unidirectional:

$$\text{Market Data (Phase 5/6)} \longrightarrow \text{Indicators (Phase 8)} \longrightarrow \text{Pure Strategy Core (Phase 10)} \longrightarrow \text{Strategy Decision}$$
$$\text{Strategy Decision} \longrightarrow \text{Strategy Decision Sink} \longrightarrow \text{Environment Adapter} \longrightarrow \text{Backtest / Risk / Execution}$$

### 3.1 Strict Directory Boundary Rules
- Files inside `src/strategies/core/**` and `src/strategies/implementations/**`:
  - **MAY import:**
    - `src/indicators/types` (e.g. `IndicatorPoint`, `PriceSource`)
    - `src/indicators/decimal` or strategy-local decimal utilities
    - Strategy-local types, errors, registry, and parameter utilities
  - **MUST NOT import:**
    - `src/backtest/**` (any file, type, or error from backtest)
    - `src/market-data/**` transport or live stream files (only read-only normalized candle snapshots are accepted)
    - `src/exchange/**`, `src/coin-runtime/**`, or external network libraries
    - Any account, position, order, or risk state
- Files inside `src/strategies/adapters/**` (e.g. `StrategyBacktestParticipantAdapter`):
  - **MAY import:**
    - `src/strategies/core/**`
    - `src/strategies/implementations/**`
    - `src/backtest/**` (types and contracts required to implement `BacktestParticipantAdapter`)
  - Serves strictly as a one-way translation bridge.

---

## 4. Strategy Input Snapshot & Normalized Candle View

### 4.1 Sanitized Strategy Evaluation Snapshot (`StrategyEvaluationSnapshot`)
Strategies receive an environment-neutral, read-only snapshot containing exclusively closed market truth and finalized indicator values:

```typescript
export interface StrategyEvaluationSnapshot {
  /** The trading pair being evaluated (e.g., 'BTC-INR'). */
  readonly pair: string;

  /** The exact evaluation timestamp in UTC epoch milliseconds (equals trigger candle closeTimeExclusiveMs). */
  readonly evaluationTimeMs: number;

  /** The trigger-timeframe candle that closed exactly at evaluationTimeMs. */
  readonly triggerClosedCandle: StrategyCandleSnapshot;

  /** Map of all candles that closed at or before evaluationTimeMs, keyed by timeframeMinutes. */
  readonly latestClosedCandleByTimeframe: ReadonlyMap<number, StrategyCandleSnapshot>;

  /** List of all candles that closed exactly at this evaluation timestamp T. */
  readonly candlesClosedAtThisTimestamp: readonly StrategyCandleSnapshot[];

  /** Latest indicator points finalized at or before evaluationTimeMs, keyed by strategy indicator alias. */
  readonly latestIndicatorPointByAlias: ReadonlyMap<string, IndicatorPoint<unknown>>;
}
```

### 4.2 Explicit Sanitization of Phase 9 Context
The Phase 9 backtest engine provides `BacktestEvaluationContext`, which contains simulation artifacts (`currentPosition`, `accountEquity`, `openOrders`).
The Phase 10 Backtest Adapter must **explicitly sanitize** this context before forwarding it to the strategy kernel:
- `currentPosition` is **STRIPPED**
- `accountEquity` is **STRIPPED**
- `openOrders` is **STRIPPED**
- Candle objects are mapped to immutable `StrategyCandleSnapshot` representations.

### 4.3 Normalized Strategy Candle Snapshot (`StrategyCandleSnapshot`)
All financial prices and volumes are represented as exact strings (or isolated `StrategyCalcDecimal` instances). Floating-point `number` and JavaScript `Date` instances are prohibited:

```typescript
export interface StrategyCandleSnapshot {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly quoteVolume: string | null;
}
```

---

## 5. Pre-Strategy Analytical-Input Validation Contract (P10-SPEC-01)

To guarantee that malformed or missing indicator inputs can never masquerade as legitimate warmup or cause runtime crashes, every strategy kernel executes a unified, non-bypassable **Required Indicator Validation Contract** before evaluating any strategy-specific warmup or signal logic.

### 5.1 The Six Mandatory Input Checks
For **every** declared `StrategyIndicatorRequirement`:

1. **Alias Presence Check:**
   - The declared `requirement.alias` **MUST** exist in `snapshot.latestIndicatorPointByAlias`.
   - If missing: **FAIL CLOSED** immediately with `STRATEGY_INPUT_INVALID`. A missing alias is **NEVER** treated as `WARMING`.
2. **Pair Identity Check:**
   - `indicatorPoint.pair` **MUST** strictly equal `snapshot.pair`.
   - If mismatched: **FAIL CLOSED** immediately with `STRATEGY_PAIR_MISMATCH`.
3. **Timeframe Identity Check:**
   - `indicatorPoint.timeframeMinutes` **MUST** strictly equal `requirement.timeframeMinutes`.
   - If mismatched: **FAIL CLOSED** immediately with `STRATEGY_TIMEFRAME_MISMATCH`.
4. **Closed Bar Timestamp Integrity:**
   - Require: `indicatorPoint.openTimeMs < indicatorPoint.closeTimeExclusiveMs`.
   - Require: `indicatorPoint.closeTimeExclusiveMs <= snapshot.evaluationTimeMs`.
   - If future point (`closeTimeExclusiveMs > evaluationTimeMs`): **FAIL CLOSED** with `STRATEGY_INPUT_FUTURE_DATA`.
   - If malformed time: **FAIL CLOSED** with `STRATEGY_INPUT_INVALID`.
5. **Trigger-Timeframe Freshness Rule:**
   - For any indicator bound to `triggerTimeframeMinutes`:
     - Because the trigger timeframe closed at evaluation timestamp $T = \text{evaluationTimeMs}$, its indicator point **MUST** correspond to that newly closed trigger candle:
       $$\text{indicatorPoint.closeTimeExclusiveMs} === \text{snapshot.evaluationTimeMs}$$
       $$\text{indicatorPoint.openTimeMs} === \text{snapshot.triggerClosedCandle.openTimeMs}$$
     - An older trigger-timeframe indicator point is strictly prohibited and fails closed with `STRATEGY_INPUT_INVALID`.
6. **Higher-Timeframe Freshness Rule:**
   - For an indicator bound to a higher timeframe $HTF > \text{triggerTimeframeMinutes}$:
     - **Case A (HTF Closed at T):** If a candle for $HTF$ is present in `snapshot.candlesClosedAtThisTimestamp` at timestamp $T$, its indicator point **MUST** correspond to that newly finalized candle (`closeTimeExclusiveMs === T` and matching `openTimeMs`).
     - **Case B (HTF Did NOT Close at T):** The latest prior closed point is allowed only where $\text{indicatorPoint.closeTimeExclusiveMs} < T$. Unfinalized, forming, or future points are strictly prohibited.

### 5.2 Legitimate Warmup vs. Impossible Null (Null-Regression Detection)
Each strategy kernel instance deterministically tracks whether each required indicator alias has ever produced a non-null value within the continuous calculation segment:

```typescript
// Kernel analytical state tracking
private readonly #indicatorReadySeenByAlias = new Set<string>();
```

#### The Two Null Rules:
- **Rule A (Legitimate Warmup):**
  If a structurally valid indicator point has `point.value === null` **AND** `!#indicatorReadySeenByAlias.has(alias)`:
  This represents legitimate Phase 8 indicator warmup. The strategy evaluates to:
  $$\text{status} = \text{'WARMING'}, \quad \text{targetExposure} = \text{null}$$
- **Rule B (Impossible Null / Null Regression):**
  If `point.value === null` **AND** `#indicatorReadySeenByAlias.has(alias)`:
  An indicator that has already completed warmup within a continuous calculation segment cannot mathematically regress to `null`. This represents an upstream corruption or state fault. The kernel **FAILS CLOSED** immediately with `STRATEGY_INPUT_INVALID` and transitions to `isTerminated = true`. It is **NEVER** silently reset to `WARMING`.

### 5.3 Deterministic Mutation & Lifecycle Ordering
To preserve strict audit parity across failures, internal kernel state mutations must strictly follow this order:

1. Validate complete snapshot structure (pair match, safe timestamps, strictly increasing evaluation timestamps).
2. Validate every required indicator binding via the Section 5.1 checks.
3. Validate timestamp/order/freshness for trigger and higher timeframes.
4. Inspect indicator values and evaluate null-regression rules.
5. Determine whether the outcome is legitimate `WARMING` or `READY`.
6. Construct the immutable `StrategyDecision` (including SHA-256 `decisionId`).
7. **State Mutation Phase (ONLY after successful decision construction):**
   - Advance `decisionSequence` by 1.
   - For each required alias whose value is non-null, add to `#indicatorReadySeenByAlias`.
   - Update strategy-specific causal reference state (e.g. ATR `previousReadyClose` and `previousReadyAtr`).

If any validation, numeric, or canonicalization failure occurs during steps 1–6, the strategy kernel terminates immediately (`isTerminated = true`), and **no partial state mutation survives**.

---

## 6. Strategy Identity, Parameter Hashing & Instance Identity

### 6.1 Strategy Definition Identity
Every quantitative strategy definition possesses immutable static metadata:
- `strategyId`: Machine-readable string constant identifying the strategy algorithm (e.g. `'EMA_TREND'`, `'ATR_BREAKOUT'`, `'RSI_MOMENTUM'`, `'MULTI_TIMEFRAME_TREND'`). Parameters MUST NOT be encoded into `strategyId`.
- `strategyVersion`: Semantic version string (e.g. `'1.0.0'`). Any change to strategy decision logic, indicator requirements, or parameter schemas requires incrementing `strategyVersion`.

### 6.2 Canonical Decimal Parameter Normalization (P10-SPEC-03)
To ensure that numeric-equivalent parameter representations (e.g. `"2"`, `"2.0"`, `"002.000"`) produce the exact same strategy identity and hash, all decimal strategy parameters (such as ATR `breakoutMultiplier`, RSI `longThreshold`, RSI `shortThreshold`) undergo strict lexical canonicalization before validation and hashing.

#### A. Input Syntax Validation
Accepted decimal strings must conform to:
$$^{\wedge}-?[0-9]+(\.[0-9]+)?\$$
- Allowed: Optional leading `'-'`, one or more integer digits, optional decimal point followed by one or more digits.
- Examples accepted: `"2"`, `"2.0"`, `"2.00"`, `"002.000"`, `"0.50"`, `"-0"`, `"-0.000"`.
- Rejected (fail closed with `INVALID_STRATEGY_PARAMETER`): Leading `'+'`, whitespace, scientific notation (`"1e5"`), empty string, missing integer part (`".5"`), missing fractional part (`"2."`), `NaN`, `Infinity`, commas, underscores. No trimming is performed before validation.

#### B. Canonical Form Rules
After syntax verification:
1. Strip redundant leading integer zeros (e.g. `"002"` $\to$ `"2"`).
2. Keep a single `'0'` if the integer part becomes empty (e.g. `"00.5"` $\to$ `"0.5"`).
3. Strip trailing fractional zeros (e.g. `"2.500"` $\to$ `"2.5"`).
4. Remove decimal point if fractional part becomes empty (e.g. `"2.00"` $\to$ `"2"`).
5. Normalize every numeric zero (`"-0"`, `"-0.0"`, `"-000.000"`) to `"0"`.
6. Never emit exponent notation or leading `'+'`.

| Raw Input String | Canonical Form |
| :--- | :--- |
| `"2"` | `"2"` |
| `"2.0"` | `"2"` |
| `"2.00"` | `"2"` |
| `"002.000"` | `"2"` |
| `"0.50"` | `"0.5"` |
| `"00.0500"` | `"0.05"` |
| `"-0"` | `"0"` |
| `"-0.000"` | `"0"` |
| `"-01.500"` | `"-1.5"` |

Business range validation (e.g. `breakoutMultiplier > 0`, `0 < shortThreshold < longThreshold < 100`) executes using exact decimal arithmetic **after** canonicalization.
Because `"2"`, `"2.0"`, `"2.00"`, and `"002.000"` canonicalize to the identical string `"2"`, they produce the **SAME** `normalizedParameters` and **SAME** `parameterHash`.

### 6.3 Normalization of Non-Decimal Fields
- **Periods & Timeframes:** Safe positive integers only (`Number.isSafeInteger(v) && v >= 1`). Fractional numbers or numeric strings are rejected.
- **Price Sources:** Must strictly match allowed Phase 8 `PriceSource` enum constants (`'CLOSE'`, `'OPEN'`, `'HIGH'`, `'LOW'`, `'HL2'`, `'HLC3'`, `'OHLC4'`). Case-folding is prohibited.
- **Multi-Timeframe Arrays:** Caller-supplied timeframes array (e.g. `[15, 5]`) is validated for safe supported integers, checked for duplicates before canonicalization (duplicates such as `[5, 15, 5]` fail closed with `INVALID_STRATEGY_PARAMETER`), and sorted strictly ascending $\to$ `[5, 15]`. Both `[15, 5]` and `[5, 15]` normalize to the identical canonical representation `[5, 15]`.
- **Unknown Keys & Undefined:** Disallowed object keys or `undefined` values fail closed immediately.

### 6.4 Parameter Hash (`parameterHash`)
$$\text{parameterHash} = \text{SHA-256}(\text{Canonical Normalized Parameter JSON bytes})$$
1. Computed strictly over normalized, deeply frozen parameters.
2. Formatted as UTF-8 bytes with recursive lexicographical sorting of object keys.
3. Callers cannot alter `parameterHash` through raw formatting or post-construction mutation.

### 6.5 Canonical Per-Timeframe Bootstrap Identity & Strategy Instance ID (P10-SPEC-02)
To eliminate ambiguity when multi-timeframe strategies derive indicators from different calculation segments, bootstrap origins are tracked per timeframe:

```typescript
export interface StrategyIndicatorBootstrapIdentityEntry {
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
}
```

#### Rules for `indicatorBootstrapIdentity`:
- Must contain **exactly one** entry for every distinct timeframe used by the strategy's indicator requirements.
- No duplicate timeframes; no unneeded timeframes.
- `timeframeMinutes`: Safe positive integer supported by Phase 6 / Phase 5.
- `bootstrapStartOpenTimeMs`: Safe integer $\ge 0$, minute-aligned ($t \pmod{60\,000} === 0$).
- Normalized **strictly ascending** by `timeframeMinutes`.
- Recursively frozen and immutable.

#### The Authoritative `strategyInstanceId` Formula:
$$\text{strategyInstanceId} = \text{SHA-256}\left(\text{Canonical Strategy Instance Identity JSON bytes}\right)$$

The hashed canonical JSON envelope binds:
```json
{
  "indicatorBootstrapIdentity": [
    { "bootstrapStartOpenTimeMs": 1704067200000, "timeframeMinutes": 5 },
    { "bootstrapStartOpenTimeMs": 1704067200000, "timeframeMinutes": 15 }
  ],
  "pair": "BTC-INR",
  "parameterHash": "<64-hex>",
  "strategyId": "MULTI_TIMEFRAME_TREND",
  "strategyVersion": "1.0.0"
}
```
- A scalar bootstrap start time is **NOT** authoritative for identity.
- Changing the bootstrap origin for **ANY** required timeframe changes `strategyInstanceId`.
- Random UUIDs, system clocks, and machine metadata are prohibited.

---

## 7. Strategy Kernel Contract & Lifecycle

```typescript
export interface StrategyKernel {
  /** Static strategy identity and configuration. */
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly pair: string;

  /** Authoritative per-timeframe bootstrap origins. */
  readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];

  /** The timeframe on which this strategy evaluates. */
  readonly triggerTimeframeMinutes: number;

  /** Declarative Phase 8 indicator requirements needed by this strategy. */
  readonly indicatorRequirements: readonly StrategyIndicatorRequirement[];

  /** True if the kernel encountered an unrecoverable input, invariant, or numeric violation. */
  readonly isTerminated: boolean;

  /** Evaluates a closed market snapshot and returns an immutable StrategyDecision. */
  evaluate(snapshot: StrategyEvaluationSnapshot): StrategyDecision;
}
```

### 7.1 Kernel State Isolation
A strategy kernel is a stateful analytical machine.
- **Allowed Internal State:** Pure mathematical and analytical memory (e.g., `#indicatorReadySeenByAlias`, previous ATR reference candle, previous ATR value, and `decisionSequence`).
- **Prohibited Internal State:** Current exchange position, account equity, available margin, order IDs, fill history, simulated fees, or live execution state.
- **Termination Invariant:** If `evaluate()` throws due to malformed input, invalid timestamps, or numeric error, the kernel transitions to `isTerminated = true` and fails closed on all subsequent invocations (`STRATEGY_TERMINATED`). Silent recovery or resetting state is prohibited.

---

## 8. Trigger-Timeframe Scheduling & Multi-Timeframe Law

### 8.1 Trigger-Timeframe Semantics
- Strategies do **NOT** evaluate on arbitrary 1-minute ticks or forming intrabar updates.
- A strategy evaluates if and only if its configured `triggerTimeframeMinutes` has a finalized candle present in `snapshot.candlesClosedAtThisTimestamp`.
- If the trigger timeframe did NOT close at evaluation timestamp $T$:
  - No strategy evaluation occurs.
  - `decisionSequence` does NOT increment.
  - No `StrategyDecision` or `decisionId` is emitted.
- For a 1m trigger: evaluates every closed 1m bar.
- For a 5m trigger: evaluates only on exact closed 5m boundaries (e.g. 00:05, 00:10, 00:15 UTC).

### 8.2 Same-Timestamp Multi-Timeframe Law
Phase 9 guarantees that when multiple timeframes close at timestamp $T$, the pipeline executes in strict chronological and dependency order:
$$\text{1m Close} \longrightarrow \text{HTFs Close in Ascending Order} \longrightarrow \text{Indicators Updated at } T \longrightarrow \text{Strategy Evaluation at } T$$

Therefore:
1. If timeframes $5\text{m}$, $15\text{m}$, and $60\text{m}$ all close at timestamp $T$, a Multi-Timeframe strategy evaluating at $T$ observes **all newly finalized indicator points at timestamp $T$**.
2. For any higher timeframe that did **not** close at timestamp $T$, the strategy reads its **latest prior closed value**.
3. A strategy must **never** read forming, unfinalized HTF candles.
4. Any indicator point with `closeTimeExclusiveMs > snapshot.evaluationTimeMs` fails closed immediately (`STRATEGY_INPUT_FUTURE_DATA`).

---

## 9. Strategy Decisions, Abstract Target Exposure & Decision ID

### 9.1 Discriminated Decision Status
Strategy decisions are modeled as a discriminated union:

```typescript
export type StrategyDecisionStatus = 'WARMING' | 'READY';

export type StrategyTargetExposure = 'LONG' | 'SHORT' | 'FLAT';

export interface StrategyDecision {
  /** Deterministic SHA-256 hash identifying this exact decision. */
  readonly decisionId: string;

  /** Monotonic sequence counter per strategy instance, starting at 1. */
  readonly decisionSequence: number;

  /** Strategy instance and definition bindings. */
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly pair: string;

  /** Evaluation timestamp in UTC epoch milliseconds. */
  readonly evaluationTimeMs: number;
  readonly triggerTimeframeMinutes: number;

  /** Decision lifecycle status: WARMING (indicators not ready) vs READY. */
  readonly status: StrategyDecisionStatus;

  /** Abstract target exposure. Always null when status === 'WARMING'. */
  readonly targetExposure: StrategyTargetExposure | null;

  /** Stable machine-readable reason codes explaining the analytical rationale. */
  readonly reasonCodes: readonly string[];
}
```

### 9.2 The Non-Actionable Warmup Law (Critical Safety Rule)
> **Critical Architectural Law:** Missing or null indicator output caused by legitimate Phase 8 warmup is `WARMING`. It is NEVER `LONG`, `SHORT`, `FLAT`, or `EXIT`. A `WARMING` decision has `targetExposure: null` and is STRICTLY NON-ACTIONABLE.

- Environment adapters (backtest, paper, live) **MUST NOT** convert `WARMING` into an order or position exit.
- Treating warmup as `FLAT` would cause premature, unintended liquidation of active positions during indicator bootstrap or reconnects.
- `decisionSequence` increments on every actual trigger evaluation, including `WARMING` evaluations, preserving unbroken audit sequence.

### 9.3 Target Exposure vs. Order Execution
`StrategyTargetExposure` represents **analytical desired exposure**:
- `'LONG'`: The analytical model desires net positive market exposure.
- `'SHORT'`: The analytical model desires net negative market exposure.
- `'FLAT'`: The analytical model desires zero market exposure.

It does **NOT** represent order actions (`BUY`, `SELL`), execution order types (`MARKET`, `LIMIT`), order quantities, leverage, or margin. Environment orchestration translates target exposure into concrete orders.

### 9.4 Reason Code Canonicalization
- `reasonCodes` is an immutable, duplicate-free array emitted in strategy-defined canonical order.
- Current Phase 10 strategies emit exactly one reason code per decision.
- Future multi-code strategies must define deterministic ordering in their specifications; runtime arbitrary sorting is barred unless declared.

### 9.5 Deterministic Decision ID Calculation (`decisionId`)
`decisionId` is cryptographically bound to the decision contents:

$$\text{decisionId} = \text{SHA-256}\left(\text{Canonical Decision Identity JSON bytes}\right)$$

The hashed payload contains all fields of `StrategyDecision` **excluding** the `decisionId` field itself:
- `strategyInstanceId`
- `decisionSequence`
- `evaluationTimeMs`
- `triggerTimeframeMinutes`
- `status`
- `targetExposure` (serialized as `null` or string)
- `reasonCodes` (canonical array of strings)

Replaying the identical input sequence produces bit-for-bit identical decision sequences and decision IDs.

---

## 10. Indicator Reuse & Declarative Requirements

Phase 10 **MUST NOT** implement mathematical indicator calculations (no EMA formulas, no ATR formulas, no RSI formulas). All indicators are direct reuses of Phase 8 `IndicatorKernel`.

### 10.1 Declarative Indicator Requirements & Unique Aliases
Each strategy statically or dynamically declares its indicator requirements:

```typescript
export interface StrategyIndicatorRequirement {
  /** Unique alias within the strategy instance (e.g. 'ema.fast', 'atr'). */
  readonly alias: string;

  /** Phase 8 indicator type identifier (e.g. 'EMA', 'ATR', 'RSI'). */
  readonly indicatorType: 'EMA' | 'ATR' | 'RSI' | 'SMA' | 'MACD' | 'BOLLINGER' | 'SUPERTREND';

  /** Aggregated timeframe for this indicator. */
  readonly timeframeMinutes: number;

  /** Indicator-specific parameter configuration. */
  readonly parameters: Readonly<Record<string, unknown>>;

  /** Price source if applicable (e.g. 'CLOSE', 'HL2', 'OHLC4'). */
  readonly priceSource?: PriceSource;
}
```

#### Unique Alias Rule:
When strategy indicator requirements are constructed, every alias within a strategy instance **MUST BE UNIQUE**. Registering duplicate aliases fails closed immediately (`INVALID_STRATEGY_PARAMETER`). No last-write-wins Map behavior is permitted.

### 10.2 Phase 8 Binding Factory & Bootstrap Verification
The runtime instantiates genuine Phase 8 kernels using the strategy's requirements and environment bootstrap origins:
- Before the strategy instance becomes runnable, the runtime **MUST VERIFY** that for each required indicator:
  $$\text{IndicatorKernel.segment.bootstrapStartOpenTimeMs} === \text{indicatorBootstrapIdentity}[TF].\text{bootstrapStartOpenTimeMs}$$
- Also verify `segment.pair`, `segment.timeframeMinutes`, `segment.indicatorType`, `segment.parameters`, and `segment.priceSource`.
- Any mismatch fails closed immediately (`STRATEGY_INPUT_INVALID`).
- The backtest adapter maps these bindings to Phase 9 `BacktestIndicatorBinding`. The pure strategy core remains completely unaware of Phase 9 binding types.

---

## 11. Strategy Numeric Context & Decimal Arithmetic

All strategy internal threshold checks, comparisons, and breakout calculations must be performed using exact decimal math.
- **Isolated Calculation Decimal:** An isolated clone of Decimal.js:
  ```typescript
  export const StrategyCalcDecimal = Decimal.clone({
    precision: 128,
    rounding: Decimal.ROUND_HALF_UP,
    toExpNeg: -160,
    toExpPos: 160,
  });
  ```
- **Banned Numeric Functions:**
  - `Number(priceString)`
  - `parseFloat(priceString)`
  - Native operators (`+`, `-`, `*`, `/`) on prices or indicator values
  - Global `Decimal.set(...)` mutations
- Safe integer arithmetic (`timeframeMinutes`, `decisionSequence`, timestamps) is permitted using JavaScript safe integers (`Number.isSafeInteger`).

---

## 12. Strategy Registry Architecture

`StrategyRegistry` provides a centralized, deterministic catalog of strategy definitions:

```typescript
export interface StrategyDefinition<TParams = Record<string, unknown>> {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly schema: unknown; // Zod schema or parameter validator
  createKernel(config: {
    pair: string;
    parameters: TParams;
    indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];
  }): StrategyKernel;
}

export class StrategyRegistry {
  public register(definition: StrategyDefinition): void;
  public get(strategyId: string, strategyVersion: string): StrategyDefinition;
  public list(): readonly { strategyId: string; strategyVersion: string }[];
  public has(strategyId: string, strategyVersion: string): boolean;
}
```

### Registry Guarantees:
1. **Uniqueness:** Registering an identical `strategyId` and `strategyVersion` fails closed (`STRATEGY_REGISTRY_CONFLICT`).
2. **Exact Version Resolution:** Lookups require explicit `strategyVersion`. No floating `"latest"` lookups.
3. **No Coin Hardcoding:** The registry knows nothing of `BTC`, `ETH`, or `SOL`. Strategy definitions are generic across all eligible pairs.
4. **Extensibility:** Onboarding a new strategy requires registering its definition without modifying existing registry core code.

---

## 13. Specifications for First 4 Strategies

Every strategy below executes the **Common Required Indicator Validation Contract (Section 5)** before any strategy-specific logic.

### 13.1 Strategy 1: EMA Trend V1 (`EMA_TREND`, v1.0.0)

#### A. Metadata & Parameters
- `strategyId`: `'EMA_TREND'`, `strategyVersion`: `'1.0.0'`
- Parameters:
  ```typescript
  export interface EmaTrendParameters {
    readonly timeframeMinutes: number;
    readonly fastPeriod: number;
    readonly slowPeriod: number;
    readonly priceSource: PriceSource;
  }
  ```
- Validation: `timeframeMinutes >= 1` (supported), `fastPeriod >= 1`, `slowPeriod >= 2`, `fastPeriod < slowPeriod`, `priceSource` valid enum.

#### B. Indicator Requirements
1. `alias: 'ema.fast'`, `indicatorType: 'EMA'`, `timeframeMinutes`, `parameters: { period: fastPeriod }`, `priceSource`
2. `alias: 'ema.slow'`, `indicatorType: 'EMA'`, `timeframeMinutes`, `parameters: { period: slowPeriod }`, `priceSource`

#### C. Evaluation Procedure at Closed Trigger Bar T
1. **Execute Common Indicator Validation:** Validate presence, pair, timeframe, freshness, and null-regression for `'ema.fast'` and `'ema.slow'`. Missing alias fails closed with `STRATEGY_INPUT_INVALID`.
2. Let `fastPoint = snapshot.latestIndicatorPointByAlias.get('ema.fast')!`
3. Let `slowPoint = snapshot.latestIndicatorPointByAlias.get('ema.slow')!`
4. If `fastPoint.value === null || slowPoint.value === null`:
   - Return: `status: 'WARMING'`, `targetExposure: null`, `reasonCodes: ['EMA_WARMING']`
5. If both non-null:
   - Let $F = \text{StrategyCalcDecimal}(\text{fastPoint.value.value})$
   - Let $S = \text{StrategyCalcDecimal}(\text{slowPoint.value.value})$
   - If $F > S$: `status: 'READY'`, `targetExposure: 'LONG'`, `reasonCodes: ['EMA_FAST_ABOVE_SLOW']`
   - If $F < S$: `status: 'READY'`, `targetExposure: 'SHORT'`, `reasonCodes: ['EMA_FAST_BELOW_SLOW']`
   - If $F == S$: `status: 'READY'`, `targetExposure: 'FLAT'`, `reasonCodes: ['EMA_FAST_EQUALS_SLOW']`
6. Execute Section 5.3 State Mutation Phase after successful decision construction.

---

### 13.2 Strategy 2: ATR Breakout V1 (`ATR_BREAKOUT`, v1.0.0)

#### A. Metadata & Parameters
- `strategyId`: `'ATR_BREAKOUT'`, `strategyVersion`: `'1.0.0'`
- Parameters:
  ```typescript
  export interface AtrBreakoutParameters {
    readonly timeframeMinutes: number;
    readonly atrPeriod: number;
    readonly breakoutMultiplier: string; // Exact canonical decimal string, e.g. "1.5"
  }
  ```
- Validation: `timeframeMinutes >= 1` (supported), `atrPeriod >= 1`, `breakoutMultiplier` canonical decimal string $> 0$.

#### B. Indicator Requirements
1. `alias: 'atr'`, `indicatorType: 'ATR'`, `timeframeMinutes`, `parameters: { period: atrPeriod }`

#### C. Analytical Kernel State
- `previousReadyClose: Decimal | null = null`
- `previousReadyAtr: Decimal | null = null`

#### D. Evaluation Procedure at Closed Trigger Bar T
1. **Execute Common Indicator Validation:** Validate presence, pair, timeframe, freshness, and null-regression for `'atr'`. Missing alias fails closed with `STRATEGY_INPUT_INVALID`.
2. Let `atrPoint = snapshot.latestIndicatorPointByAlias.get('atr')!`
3. If `atrPoint.value === null`:
   - Return: `status: 'WARMING'`, `targetExposure: null`, `reasonCodes: ['ATR_INDICATOR_WARMING']`
   - Reference state remains unmodified.
4. If `atrPoint.value !== null` and (`previousReadyClose === null || previousReadyAtr === null`):
   - **First Ready Reference Observation:**
   - Construct decision: `status: 'WARMING'`, `targetExposure: null`, `reasonCodes: ['ATR_REFERENCE_WARMING']`
   - **AFTER decision construction:**
     $$\text{previousReadyClose} = \text{StrategyCalcDecimal}(\text{snapshot.triggerClosedCandle.close})$$
     $$\text{previousReadyAtr} = \text{StrategyCalcDecimal}(\text{atrPoint.value.value})$$
   - Return decision.
5. If `atrPoint.value !== null` and prior reference exists:
   - Let $C_{\text{curr}} = \text{StrategyCalcDecimal}(\text{snapshot.triggerClosedCandle.close})$
   - Let $C_{\text{prev}} = \text{previousReadyClose}!$
   - Let $A_{\text{prev}} = \text{previousReadyAtr}!$
   - Let $M = \text{StrategyCalcDecimal}(\text{parameters.breakoutMultiplier})$
   - Calculate envelopes strictly from **prior** bar values:
     $$\text{upperBreakout} = C_{\text{prev}} + (A_{\text{prev}} \times M)$$
     $$\text{lowerBreakout} = C_{\text{prev}} - (A_{\text{prev}} \times M)$$
   - If $C_{\text{curr}} > \text{upperBreakout}$: `status: 'READY'`, `targetExposure: 'LONG'`, `reasonCodes: ['ATR_BREAKOUT_UP']`
   - Else if $C_{\text{curr}} < \text{lowerBreakout}$: `status: 'READY'`, `targetExposure: 'SHORT'`, `reasonCodes: ['ATR_BREAKOUT_DOWN']`
   - Else: `status: 'READY'`, `targetExposure: 'FLAT'`, `reasonCodes: ['ATR_NO_BREAKOUT']`
   - **AFTER decision construction:**
     $$\text{previousReadyClose} = C_{\text{curr}}$$
     $$\text{previousReadyAtr} = \text{StrategyCalcDecimal}(\text{atrPoint.value.value})$$
6. Execute Section 5.3 State Mutation Phase.

---

### 13.3 Strategy 3: RSI Momentum V1 (`RSI_MOMENTUM`, v1.0.0)

#### A. Metadata & Parameters
- `strategyId`: `'RSI_MOMENTUM'`, `strategyVersion`: `'1.0.0'`
- Parameters:
  ```typescript
  export interface RsiMomentumParameters {
    readonly timeframeMinutes: number;
    readonly period: number;
    readonly longThreshold: string;  // Canonical decimal string, e.g. "70"
    readonly shortThreshold: string; // Canonical decimal string, e.g. "30"
    readonly priceSource: PriceSource;
  }
  ```
- Validation: `timeframeMinutes >= 1`, `period >= 1`, $0 < \text{shortThreshold} < \text{longThreshold} < 100$ (evaluated on canonical decimal values), `priceSource` valid.

#### B. Indicator Requirements
1. `alias: 'rsi'`, `indicatorType: 'RSI'`, `timeframeMinutes`, `parameters: { period }`, `priceSource`

#### C. Evaluation Procedure at Closed Trigger Bar T
1. **Execute Common Indicator Validation:** Validate presence, pair, timeframe, freshness, and null-regression for `'rsi'`. Missing alias fails closed with `STRATEGY_INPUT_INVALID`.
2. Let `rsiPoint = snapshot.latestIndicatorPointByAlias.get('rsi')!`
3. If `rsiPoint.value === null`:
   - Return: `status: 'WARMING'`, `targetExposure: null`, `reasonCodes: ['RSI_WARMING']`
4. If `rsiPoint.value !== null`:
   - Let $R = \text{StrategyCalcDecimal}(\text{rsiPoint.value.value})$
   - Let $T_{\text{long}} = \text{StrategyCalcDecimal}(\text{parameters.longThreshold})$
   - Let $T_{\text{short}} = \text{StrategyCalcDecimal}(\text{parameters.shortThreshold})$
   - If $R \ge T_{\text{long}}$: `status: 'READY'`, `targetExposure: 'LONG'`, `reasonCodes: ['RSI_LONG_THRESHOLD']`
   - Else if $R \le T_{\text{short}}$: `status: 'READY'`, `targetExposure: 'SHORT'`, `reasonCodes: ['RSI_SHORT_THRESHOLD']`
   - Else: `status: 'READY'`, `targetExposure: 'FLAT'`, `reasonCodes: ['RSI_NEUTRAL']`
5. Execute Section 5.3 State Mutation Phase.

---

### 13.4 Strategy 4: Multi-Timeframe Trend V1 (`MULTI_TIMEFRAME_TREND`, v1.0.0)

#### A. Metadata & Parameters
- `strategyId`: `'MULTI_TIMEFRAME_TREND'`, `strategyVersion`: `'1.0.0'`
- Parameters:
  ```typescript
  export interface MultiTimeframeTrendParameters {
    readonly timeframes: readonly number[]; // Normalized strictly ascending, e.g. [5, 15, 60]
    readonly fastPeriod: number;
    readonly slowPeriod: number;
    readonly priceSource: PriceSource;
  }
  ```
- Validation: `timeframes.length >= 2`, supported safe integers, no duplicates, `fastPeriod >= 1`, `slowPeriod >= 2`, `fastPeriod < slowPeriod`, `priceSource` valid.
- Trigger Timeframe: Smallest timeframe $\min(\text{timeframes})$.

#### B. Indicator Requirements
For each $TF \in \text{timeframes}$:
1. `alias: 'tf.' + TF + '.ema.fast'`, `indicatorType: 'EMA'`, `timeframeMinutes: TF`, `parameters: { period: fastPeriod }`, `priceSource`
2. `alias: 'tf.' + TF + '.ema.slow'`, `indicatorType: 'EMA'`, `timeframeMinutes: TF`, `parameters: { period: slowPeriod }`, `priceSource`

#### C. Evaluation Procedure at Closed Trigger Bar T
1. **Execute Common Indicator Validation:** For every $TF \in \text{timeframes}$, validate presence, pair, timeframe, freshness (fresh bar if $TF$ closed at $T$, latest prior closed bar if $TF$ did not close at $T$), and null-regression for `'tf.' + TF + '.ema.fast'` and `'tf.' + TF + '.ema.slow'`.
   - Any missing alias fails closed with `STRATEGY_INPUT_INVALID`. No optional chaining or undefined fallthrough.
2. For every $TF \in \text{timeframes}$:
   - Let `fastPoint = snapshot.latestIndicatorPointByAlias.get('tf.' + TF + '.ema.fast')!`
   - Let `slowPoint = snapshot.latestIndicatorPointByAlias.get('tf.' + TF + '.ema.slow')!`
   - If `fastPoint.value === null || slowPoint.value === null`:
     - Return immediately: `status: 'WARMING'`, `targetExposure: null`, `reasonCodes: ['MTF_WARMING']`
3. Directional state per timeframe:
   - For every $TF$:
     - Let $F_{TF} = \text{StrategyCalcDecimal}(\text{fastPoint.value.value})$
     - Let $S_{TF} = \text{StrategyCalcDecimal}(\text{slowPoint.value.value})$
     - If $F_{TF} > S_{TF}$: `state = BULLISH`
     - If $F_{TF} < S_{TF}$: `state = BEARISH`
     - If $F_{TF} == S_{TF}$: `state = NEUTRAL`
4. Unanimous Consensus Rule:
   - If **ALL** timeframes are `BULLISH`: `status: 'READY'`, `targetExposure: 'LONG'`, `reasonCodes: ['MTF_ALL_BULLISH']`
   - Else if **ALL** timeframes are `BEARISH`: `status: 'READY'`, `targetExposure: 'SHORT'`, `reasonCodes: ['MTF_ALL_BEARISH']`
   - Else: `status: 'READY'`, `targetExposure: 'FLAT'`, `reasonCodes: ['MTF_MIXED']`
5. Execute Section 5.3 State Mutation Phase.

---

## 14. Mandatory Decision Audit Sink & Lineage Contract (P10-SPEC-05)

### 14.1 Phase-10-Owned Strategy Decision Sink
Every trigger evaluation (WARMING, READY LONG, READY SHORT, READY FLAT) emits exactly one immutable `StrategyDecision`.
To ensure zero lost signals, Phase 10 defines a mandatory audit boundary:

```typescript
export interface StrategyDecisionSink {
  writeDecision(decision: StrategyDecision): Promise<void> | void;
}
```

### 14.2 Mandatory Audit Ordering Before Adapter Action
Before an environment adapter performs target reconciliation or returns any order action:
1. The `StrategyDecision` **MUST BE SUCCESSFULLY WRITTEN** to the `StrategyDecisionSink`.
2. If `writeDecision()` throws or fails:
   - The adapter **FAILS CLOSED** immediately.
   - **NO ORDER INTENT OR RECONCILIATION ACTION IS RETURNED**.
   - No decision may silently vanish.

### 14.3 Strategy Decision Dispatch Record
The adapter records the result of its target reconciliation:

```typescript
export type StrategyDispatchStatus =
  | 'WARMING_NO_ACTION'
  | 'READY_NO_ACTION'
  | 'ACTION_BATCH_RETURNED'
  | 'ADAPTER_REJECTED';

export interface StrategyDecisionDispatchRecord {
  readonly decisionId: string;
  readonly strategyInstanceId: string;
  readonly evaluationTimeMs: number;
  readonly dispatchStatus: StrategyDispatchStatus;
  readonly actionBatchSha256: string | null;
}
```
- When actions are returned (`ACTION_BATCH_RETURNED`), `actionBatchSha256` is the deterministic SHA-256 hash of the canonical JSON representation of `BacktestActionBatch`.
- If reconciliation fails (e.g. active orders detected), `dispatchStatus = 'ADAPTER_REJECTED'`, and the adapter fails closed.
- Does not invent Phase 9 order IDs.

### 14.4 Lineage Boundary Scope
- **Phase 10 Guarantees:**
  $$\text{StrategyDecision} \longrightarrow \text{StrategyDecisionSink} \longrightarrow \text{StrategyDecisionDispatchRecord}$$
- **Later Phases Guarantee:**
  $$\text{StrategyDecisionDispatchRecord} \longrightarrow \text{RiskDecision} \longrightarrow \text{ExecutionIntent} \longrightarrow \text{ExchangeOrder} \longrightarrow \text{Fill}$$
- All downstream phases reference the stable Phase 10 `decisionId`.

---

## 15. Backtest Research Adapter Architecture (P10-SPEC-06)

`StrategyBacktestParticipantAdapter` implements Phase 9 `BacktestParticipantAdapter` to prove strategy portability.

### 15.1 Adapter Configuration & Fixed Research Quantity
```typescript
export interface StrategyBacktestAdapterConfig {
  readonly kernel: StrategyKernel;
  readonly fixedResearchQuantity: string; // Exact canonical decimal string, e.g. "0.01"
  readonly decisionSink: StrategyDecisionSink;
}
```

#### Invariant: Fixed Research Quantity is an Adapter Concern
- `fixedResearchQuantity` is validated and canonicalized using Section 6.2 rules.
- It is **NOT** a strategy parameter and is **NOT** part of pure strategy `parameterHash`.
- Pure strategy code has zero awareness of `fixedResearchQuantity`.

### 15.2 Phase 9 Backtest Participant & Run Identity Binding (P10-SPEC-06)
To ensure that changing `fixedResearchQuantity` alters the Phase 9 backtest run identity deterministically:
1. `participantId`: `'STRATEGY_BACKTEST_ADAPTER'`
2. `participantVersion`: `'1.0.0'`
3. `participant.parameterHash`: SHA-256 lowercase hex over canonical normalized adapter configuration:
   ```json
   {
     "fixedResearchQuantity": "0.01",
     "strategyInstanceId": "<64-hex>"
   }
   ```
4. `participant.gitCommitHash`: Configured repository git commit hash.

#### The Core Identity Invariant:
$$\text{Same Strategy Parameters} + \text{Different fixedResearchQuantity} \implies \begin{cases} \text{SAME pure strategy parameterHash} \\ \text{SAME strategyInstanceId} \\ \text{DIFFERENT Phase 9 participant.parameterHash} \\ \text{DIFFERENT Phase 9 runId} \end{cases}$$

### 15.3 Open-Order Safety & Fail-Closed Invariant
- If `context.openOrders.length > 0`:
  The adapter records `dispatchStatus: 'ADAPTER_REJECTED'` and throws `STRATEGY_BACKTEST_ADAPTER_BUSY` ("Cannot reconcile strategy target exposure while active open orders exist").
  It fails closed rather than stacking duplicate exposure-changing orders.

### 15.4 Target Exposure to Phase 9 Market Order Mapping

| Target Exposure | Current Simulated Position | Action / Order Intent Generated | Dispatch Status |
| :--- | :--- | :--- | :--- |
| **`WARMING`** | Any | **No orders submitted** (`submitOrders: []`). | `WARMING_NO_ACTION` |
| **`FLAT`** | `FLAT` | **No orders submitted**. | `READY_NO_ACTION` |
| **`FLAT`** | `LONG` ($Q$) | `SELL`, `quantity = Q`, `reduceOnly = true`, `type = MARKET` | `ACTION_BATCH_RETURNED` |
| **`FLAT`** | `SHORT` ($Q$) | `BUY`, `quantity = Q`, `reduceOnly = true`, `type = MARKET` | `ACTION_BATCH_RETURNED` |
| **`LONG`** | `FLAT` | `BUY`, `quantity = fixedResearchQuantity`, `reduceOnly = false`, `type = MARKET` | `ACTION_BATCH_RETURNED` |
| **`LONG`** | `LONG` | **No orders submitted** (target already satisfied). | `READY_NO_ACTION` |
| **`LONG`** | `SHORT` ($Q$) | `BUY`, `quantity = Q + fixedResearchQuantity`, `reduceOnly = false`, `type = MARKET`<br>*(Phase 9 reversal closes short $Q$ and opens long fixed quantity)* | `ACTION_BATCH_RETURNED` |
| **`SHORT`** | `FLAT` | `SELL`, `quantity = fixedResearchQuantity`, `reduceOnly = false`, `type = MARKET` | `ACTION_BATCH_RETURNED` |
| **`SHORT`** | `SHORT` | **No orders submitted** (target already satisfied). | `READY_NO_ACTION` |
| **`SHORT`** | `LONG` ($Q$) | `SELL`, `quantity = Q + fixedResearchQuantity`, `reduceOnly = false`, `type = MARKET`<br>*(Phase 9 reversal closes long $Q$ and opens short fixed quantity)* | `ACTION_BATCH_RETURNED` |

---

## 16. Error Handling Model

All Phase 10 operations fail closed on invariant breaches using structured, typed errors:

```typescript
export type StrategyErrorCode =
  | 'INVALID_STRATEGY_PARAMETER'
  | 'STRATEGY_REGISTRY_CONFLICT'
  | 'STRATEGY_NOT_FOUND'
  | 'STRATEGY_PAIR_MISMATCH'
  | 'STRATEGY_TIMEFRAME_MISMATCH'
  | 'STRATEGY_EVALUATION_ORDER_VIOLATION'
  | 'STRATEGY_INPUT_INVALID'
  | 'STRATEGY_INPUT_FUTURE_DATA'
  | 'STRATEGY_NUMERIC_FAILURE'
  | 'STRATEGY_TERMINATED'
  | 'STRATEGY_BACKTEST_ADAPTER_BUSY';
```

---

## 17. Required Executable Verification Suite

Implementation of Phase 10 must provide exhaustive test suites proving compliance across the following verified areas:

### A. Missing Required Indicator (P10-SPEC-01)
- For EMA, ATR, RSI, and MTF strategies: omit a required indicator alias from `latestIndicatorPointByAlias`.
- Assert kernel throws `STRATEGY_INPUT_INVALID` and terminates (`isTerminated = true`).
- Assert missing alias NEVER produces `WARMING` and NEVER defaults to `FLAT`.

### B. Indicator Mismatch (P10-SPEC-01)
- Supply indicator point with wrong pair $\implies$ fails closed with `STRATEGY_PAIR_MISMATCH`.
- Supply indicator point with wrong timeframe $\implies$ fails closed with `STRATEGY_TIMEFRAME_MISMATCH`.

### C. Null-Regression Detection (P10-SPEC-01)
- Feed valid null points during initial warmup $\implies$ emits `status: 'WARMING'`.
- Feed non-null point $\implies$ emits `status: 'READY'`.
- Subsequently feed `null` for that same alias in continuous segment $\implies$ throws `STRATEGY_INPUT_INVALID` and terminates.

### D. Indicator Freshness (P10-SPEC-01)
- Trigger timeframe closes at $T$, but trigger indicator point has `closeTimeExclusiveMs < T` $\implies$ throws `STRATEGY_INPUT_INVALID`.
- Multi-timeframe strategy: HTF candle closes at $T$, but supplied indicator point is older than $T$ $\implies$ throws `STRATEGY_INPUT_INVALID`.
- Multi-timeframe strategy: HTF candle does NOT close at $T$, but supplied indicator point is latest prior closed point $\implies$ accepted.

### E. Authoritative Bootstrap Identity (P10-SPEC-02)
- Replaying identical strategy configuration + identical per-timeframe bootstrap origins produces identical `strategyInstanceId`.
- Changing the bootstrap origin of ANY timeframe changes `strategyInstanceId`.
- Instantiating Phase 8 kernel with origin differing from `indicatorBootstrapIdentity` fails before execution.

### F. Canonical Decimal Parameter Normalization (P10-SPEC-03)
- `"2"`, `"2.0"`, `"2.00"`, `"002.000"` produce the identical `normalizedParameters` and identical `parameterHash`.
- `"0.50"` and `"00.500"` produce identical `parameterHash`.
- Numerically different values produce different `parameterHash`.
- MTF `timeframes: [15, 5]` and `[5, 15]` produce identical canonical array `[5, 15]` and identical hash.
- MTF duplicate timeframes `[5, 15, 5]` fail validation (`INVALID_STRATEGY_PARAMETER`).

### G. Mandatory Decision Audit Sink (P10-SPEC-05)
- `WARMING` decision is written to sink before returning $\implies$ dispatch record is `WARMING_NO_ACTION`.
- `READY` decision with matching side written to sink $\implies$ dispatch record is `READY_NO_ACTION`.
- `READY` decision with order written to sink before orders returned $\implies$ dispatch record contains `actionBatchSha256`.
- If `decisionSink.writeDecision()` throws $\implies$ adapter fails closed, zero orders submitted.
- If adapter reconciliation fails after decision sink write $\implies$ decision remains written in sink; dispatch record states `ADAPTER_REJECTED`.

### H. Fixed Research Quantity & Phase 9 Identity Binding (P10-SPEC-06)
- Same strategy instance evaluated with different `fixedResearchQuantity`:
  - Pure strategy `parameterHash` is UNCHANGED.
  - `strategyInstanceId` is UNCHANGED.
  - Phase 9 `participant.parameterHash` CHANGES.
  - Phase 9 `runId` CHANGES.

---

## 18. High-Risk Architectural Checklist

| ID | High-Risk Question | Specification Resolution | Status |
| :--- | :--- | :--- | :--- |
| **P10-I01** | Can pure strategy code access Phase 9 account/position/open-order state? | **NO.** Pure strategy core receives only sanitized `StrategyEvaluationSnapshot`. Account/position data is explicitly stripped by the adapter. | **CLOSED** |
| **P10-I02** | Can equivalent decimal parameters hash differently? | **NO.** Canonical decimal normalization converts `"2"`, `"2.0"`, `"002.000"` to `"2"` before hashing. | **CLOSED** |
| **P10-I03** | Can absent or mismatched required indicator become WARMING? | **NO.** Required indicator validation contract runs first; missing/mismatched alias fails closed with `STRATEGY_INPUT_INVALID` / `STRATEGY_PAIR_MISMATCH`. | **CLOSED** |
| **P10-I04** | Can a previously ready indicator regress to null and restart warmup? | **NO.** Kernel tracks `#indicatorReadySeenByAlias`. A null point after ready state fails closed with `STRATEGY_INPUT_INVALID`. | **CLOSED** |
| **P10-I05** | Can EMA fast == slow generate a directional signal? | **NO.** Exact equality emits `FLAT` with `EMA_FAST_EQUALS_SLOW`. | **CLOSED** |
| **P10-I06** | Can ATR breakout use current bar ATR or current bar close in breakout envelope? | **NO.** Envelope strictly uses $C_{\text{prev}}$ and $A_{\text{prev}}$. Reference update occurs strictly *after* evaluating current bar. | **CLOSED** |
| **P10-I07** | Can RSI thresholds accept inverted bounds? | **NO.** Validation requires $0 < \text{shortThreshold} < \text{longThreshold} < 100$ on canonical decimal values. | **CLOSED** |
| **P10-I08** | Can MTF bootstrap origin change without altering strategy identity? | **NO.** `strategyInstanceId` binds authoritative `indicatorBootstrapIdentity` for every configured timeframe. | **CLOSED** |
| **P10-I09** | Can backtest strategy implementation differ from live strategy logic? | **NO.** Backtest and live execution use the exact same `StrategyKernel` class. Only external adapters differ. | **CLOSED** |
| **P10-I10** | Can WARMING decision trigger order submission or position closure? | **NO.** WARMING has `targetExposure: null` and emits zero orders (`WARMING_NO_ACTION`). | **CLOSED** |
| **P10-I11** | Can active open orders exist during backtest adapter reconciliation? | **NO.** Adapter fails closed immediately with `STRATEGY_BACKTEST_ADAPTER_BUSY`. | **CLOSED** |
| **P10-I12** | Can future market data alter strategy decisions at timestamp $T$? | **NO.** Strict no-lookahead poison test verifies decisions through $T$ are identical. | **CLOSED** |
| **P10-I13** | Can a generated decision vanish before audit? | **NO.** `StrategyDecisionSink.writeDecision` is mandatory before adapter reconciliation. | **CLOSED** |
| **P10-I14** | Can fixed research quantity alter backtest run without altering Phase 9 run identity? | **NO.** `fixedResearchQuantity` binds Phase 9 `participant.parameterHash` and `runId`. | **CLOSED** |
