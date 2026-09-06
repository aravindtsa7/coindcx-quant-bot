# Indicator Engine — Phase 8 Architecture & Specification

## 1. Executive Summary & System Boundary

Phase 8 implements the **Indicator Engine** for the **CoinDCX Quant Futures Bot**. It is a pure, deterministic, zero-side-effect technical and quantitative indicator computation layer shared across the entire trading platform lifecycle:

- **Historical Research & Dataset Analysis** (Phase 7 / Phase 12)
- **High-Performance Event-Driven Backtesting** (Phase 9 / Phase 11)
- **Strategy Research Framework** (Phase 10)
- **Real-Time Paper Trading** (Phase 14)
- **24/7 Shadow Evaluation** (Phase 19)
- **Production Live Strategy Execution** (Phase 17, 20, 21, 22)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UPSTREAM MARKET DATA TRUTH                        │
│                                                                             │
│  Phase 5: CanonicalCandle1m         Phase 6: HigherTimeframeCandle          │
│  (1-minute closed truth)            (Synthesized derived closed truth:      │
│                                      2m, 3m, 5m, 15m, 1h, 4h, 1d, ...)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Validated closed candles only
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PHASE 8: INDICATOR CANDLE ADAPTER                        │
│                                                                             │
│  - Normalized read-only indicator candle view (IndicatorCandle)             │
│  - Strict stream continuity & monotonic ordering validation                 │
│  - Fail-closed gap and duplicate detection                                  │
│  - Zero data fabrication (no interpolation, forward-filling, or synthetic)  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Ordered, contiguous IndicatorCandle stream
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PHASE 8: INDICATOR ENGINE                           │
│                                                                             │
│  Mathematical Primitives:                                                   │
│    Rolling Sum, Mean, Min, Max | Population Variance & StdDev (sqrt)        │
│    EMA Recurrence | Wilder RMA Recurrence | True Range                      │
│                                                                             │
│  Core Indicator Kernels:                                                    │
│    SMA | EMA | Wilder RMA | ATR | RSI | MACD | Bollinger Bands             │
│    DMI / ADX | SuperTrend | Donchian Channel | UTC-Day VWAP                │
│    Volume SMA | Volume Ratio                                               │
│                                                                             │
│  Execution Architecture:                                                    │
│    - Deterministic Calculation Segment (Frozen bootstrapStartOpenTimeMs)    │
│    - Dual Batch & Incremental Parity (Batch feeds identical incremental)    │
│    - Prefix Determinism (No lookahead: candle t depends strictly on <= t)   │
│    - High-Precision Isolated Calculation Context (128-digit Decimal)       │
│    - Immutable IndicatorDecimal Output (negative support, max 18dp fixed)   │
│    - Internal recursive state never contaminated by rounded output          │
│    - Exact chronological alignment (null before mathematical warmup)        │
│    - Complete state isolation (per-pair, per-timeframe, per-parameters)    │
│    - Bounded Memory Guarantee (O(period) rolling, O(1) recursive)           │
│    - Pure derived compute (Zero database writes, zero indicator tables)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Immutable IndicatorPoint<T> stream
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DOWNSTREAM CONSUMERS                                │
│                                                                             │
│  Phase 9: Backtest Simulation Engine                                        │
│  Phase 10: Quantitative Strategy Framework                                 │
│  Phase 14: Paper Trading Engine                                             │
│  Phase 19: 24/7 Shadow Engine                                               │
│  Phase 20+: Live Multi-Regime Production Execution                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Invariant
$$\text{Same Ordered Closed Candle Truth} + \text{Same Parameters} + \text{Same bootstrapStartOpenTimeMs} \implies \text{Exactly Same Aligned Outputs}$$

This invariant holds unconditionally across:
1. **Provenance**: Historical REST dataset backfill vs. real-time WebSocket live streaming.
2. **Timeframe**: 1-minute canonical candles vs. Phase 6 derived higher-timeframe candles.
3. **Execution Mode**: Bulk historical batch calculation vs. incremental candle-by-candle live execution.

### Strict System Boundaries
The Indicator Engine is strictly a mathematical transformation pipeline. It contains:
- **NO** exchange network calls, WebSocket connections, or REST client interactions.
- **NO** database reads or writes (no Prisma models, no MySQL tables, no disk caches).
- **NO** order placement, order sizing, or client order ID generation.
- **NO** strategy signal generation (`LONG`, `SHORT`, `FLAT`).
- **NO** risk management, leverage evaluation, or margin checks.
- **NO** execution logic, slippage modeling, or fee calculation.
- **NO** wall-clock-dependent mathematics (no `Date.now()`, `new Date()`, or timer triggers).

---

## 2. Upstream Market Truth & Normalized Candle View

### Supported Candle Sources
The Indicator Engine consumes **ONLY** verified, closed candles from two authoritative upstream sources:
1. **Phase 5 `CanonicalCandle1m`**: Finalized 1-minute canonical candles.
2. **Phase 6 `HigherTimeframeCandle`**: Higher-timeframe candles synthesized exclusively by Phase 6 `aggregateExactBucket` / `HigherTimeframeEngine`.

Under no circumstances does Phase 8 consume:
- Raw WebSocket packets or transport envelopes.
- Forming, unfinalized, or partial candle snapshots (`isClosed: false`).
- Exchange-provided higher-timeframe candles (e.g. CoinDCX 5m or 1h REST endpoints).

### Non-Duplication Contract
Phase 8 **MUST NOT** duplicate candle aggregation logic. Timeframe aggregation belongs exclusively to Phase 6. All higher-timeframe inputs to Phase 8 must be produced upstream by Phase 6.

### Normalized Indicator Candle View (`IndicatorCandle`)
To decouple indicator mathematical kernels from transport-specific metadata (such as `generationId`, `finalizedAtMs`, `source`), Phase 8 defines a single, uniform, read-only candle adapter interface:

```typescript
export interface IndicatorCandle {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
  readonly quoteVolume: Decimal | null;
}
```

#### Mapping Rules:
- **From `CanonicalCandle1m`**:
  - `pair`: `candle.pair`
  - `timeframeMinutes`: `1`
  - `openTimeMs`: `candle.openTimeMs`
  - `closeTimeExclusiveMs`: `candle.closeTimeExclusiveMs`
  - `open`: `toIndicatorCalcDecimal(candle.open.value)`
  - `high`: `toIndicatorCalcDecimal(candle.high.value)`
  - `low`: `toIndicatorCalcDecimal(candle.low.value)`
  - `close`: `toIndicatorCalcDecimal(candle.close.value)`
  - `volume`: `toIndicatorCalcDecimal(candle.volume.value)`
  - `quoteVolume`: `candle.quoteVolume ? toIndicatorCalcDecimal(candle.quoteVolume.value) : null`
- **From `HigherTimeframeCandle`**:
  - `pair`: `candle.pair`
  - `timeframeMinutes`: `candle.timeframeMinutes`
  - `openTimeMs`: `candle.openTimeMs`
  - `closeTimeExclusiveMs`: `candle.closeTimeExclusiveMs`
  - `open`: `toIndicatorCalcDecimal(candle.open.value)`
  - `high`: `toIndicatorCalcDecimal(candle.high.value)`
  - `low`: `toIndicatorCalcDecimal(candle.low.value)`
  - `close`: `toIndicatorCalcDecimal(candle.close.value)`
  - `volume`: `toIndicatorCalcDecimal(candle.volume.value)`
  - `quoteVolume`: `candle.quoteVolume ? toIndicatorCalcDecimal(candle.quoteVolume.value) : null`

---

## 3. Input Validation, Stream Continuity & Calculation Segment Boundaries

Before an indicator state machine processes any candle, the incoming candle and stream continuity must be provably valid.

### Validation Rules
1. **Instrument Identity**: `pair` must be a non-empty string and must strictly match the indicator instance's configured pair. Mismatch throws `PAIR_MISMATCH`.
2. **Timeframe Uniformity**: `timeframeMinutes` must be a safe integer $\ge 1$ and must strictly match the indicator instance's configured timeframe. Mismatch throws `TIMEFRAME_MISMATCH`.
3. **Timestamp Integrity**:
   - `openTimeMs` must be a safe non-negative integer (`Number.isSafeInteger(openTimeMs) && openTimeMs >= 0`).
   - `openTimeMs` must be perfectly aligned to the timeframe bucket:
     $$\text{openTimeMs} \pmod{\text{timeframeMinutes} \times 60\,000} = 0$$
   - `closeTimeExclusiveMs` must satisfy:
     $$\text{closeTimeExclusiveMs} = \text{openTimeMs} + \text{timeframeMinutes} \times 60\,000$$
4. **Strict Chronological Monotonicity**:
   For each incoming candle $t$ following candle $t-1$:
   $$\text{openTimeMs}_t > \text{openTimeMs}_{t-1}$$
   Any out-of-order or duplicate timestamp throws `CANDLE_ORDER_VIOLATION`.
5. **Zero Gap Tolerance (Contiguity Law)**:
   For an indicator stream operating on timeframe $T$ minutes:
   $$\text{openTimeMs}_t = \text{openTimeMs}_{t-1} + T \times 60\,000$$
   If $\text{openTimeMs}_t > \text{openTimeMs}_{t-1} + T \times 60\,000$, a gap has occurred. The engine **FAILS CLOSED** immediately by throwing `CANDLE_GAP`.
6. **Stream Failures Terminate the Calculation Segment**:
   When an active indicator instance encounters `CANDLE_GAP`, `CANDLE_ORDER_VIOLATION`, `PAIR_MISMATCH`, or `TIMEFRAME_MISMATCH`, it fails closed.
   It **MUST NOT**:
   - Bridge the gap or skip missing candles.
   - Silently reset recurrence or internal accumulators.
   - Continue processing with a new seed.
   To resume indicator calculations after market truth is repaired or recovered:
   - The caller must create or rebuild a valid calculation segment explicitly.
   - If claiming continuity with the existing calculation segment, the caller must replay from the **SAME** `bootstrapStartOpenTimeMs` over the now-complete continuous truth.
   - If the caller chooses a new bootstrap origin, that is explicitly a **NEW** calculation segment with a distinct identity.
7. **Zero Data Fabrication**:
   The engine **MUST NOT**:
   - Linearly or spline interpolate missing prices.
   - Forward-fill or carry forward the previous close.
   - Synthesize zero-volume phantom bars.
8. **OHLC Structural Validity**:
   - $open > 0$, $high > 0$, $low > 0$, $close > 0$, $volume \ge 0$.
   - $high \ge \max(open, close)$
   - $low \le \min(open, close)$
   - $high \ge low$
   - Any structural violation throws `INVALID_CANDLE_INPUT`.

---

## 4. Lookahead Prevention, Prefix Determinism & Segment Scope

### Prefix Determinism Law
Let $S$ be an indicator calculation segment defined by origin $c_{\text{bootstrap}} = c_0$ and sequence of closed candles $C = [c_0, c_1, \dots, c_t, \dots, c_N]$.
The indicator output at candle $t$, denoted $I(t)$, depends **ONLY** on the prefix subsequence $C_{\le t} = [c_0, c_1, \dots, c_t]$.

$$\forall t \in [0, N], \quad I(t; C_{\le t}) \equiv I(t; C_{\le N})$$

### Architectural Guarantees
1. **Strict Future Independence**: Appending future candles $c_{t+1}, c_{t+2}, \dots$ to a series must **NEVER** alter, retroactively adjust, or recalculate any previously computed output $I(t)$ within that calculation segment.
2. **Batch / Prefix Identity**: Bulk processing over $N$ candles from origin $c_0$ and bulk processing over any prefix $M < N$ candles from origin $c_0$ produce bit-for-bit identical outputs for all indices $0 \le i \le M$.
3. **Prohibited Constructs**:
   - Centered moving windows (e.g. windows spanning $[t - k, t + k]$).
   - Lookahead smoothing filters (e.g. two-pass forward-backward zero-lag filters).
   - ZigZag or swing pivots that retroactively repaint past pivot points when future highs/lows appear.
   - Normalization based on dataset-wide global statistics (e.g. min-max scaling across an entire historical range).

---

## 5. Price Sources & Scalar Extraction

### Supported Price Sources
For indicators operating on a univariate price series (SMA, EMA, Wilder RMA, RSI, MACD, Bollinger Bands), Phase 8 provides deterministic scalar price extraction:

| Source Identifier | Mathematical Definition | Formula Description |
| :--- | :--- | :--- |
| `CLOSE` (Default) | $close$ | Closing price of the candle |
| `OPEN` | $open$ | Opening price of the candle |
| `HIGH` | $high$ | Highest price of the candle |
| `LOW` | $low$ | Lowest price of the candle |
| `HL2` | $\frac{high + low}{2}$ | Median price |
| `HLC3` | $\frac{high + low + close}{3}$ | Typical price |
| `OHLC4` | $\frac{open + high + low + close}{4}$ | Weighted average price |

### Execution Rules
- Scalar price extraction must be performed entirely within the 128-digit decimal context.
- Divisors (2, 3, 4) must be exact integer decimals.
- Indicators requiring full bar geometry by mathematical definition (ATR, DMI/ADX, SuperTrend, Donchian Channel, VWAP) **MUST NOT** accept an arbitrary price source; they consume the required OHLCV attributes directly according to their frozen mathematical formulas.

---

## 6. Decimal Architecture, 128-Digit Precision Budget & Rounding

### Total Prohibition of Native Floating-Point
Native JavaScript IEEE 754 floating-point numbers (`number`, `parseFloat`, `Math.*`) are **STRICTLY FORBIDDEN** in all financial and indicator calculations.
- **NEVER** use `Number(candle.close)`.
- **NEVER** use `Math.sqrt(...)` — use `Decimal.sqrt()`.
- **NEVER** use `Math.abs(...)` — use `Decimal.abs()`.
- **NEVER** use native operators `+`, `-`, `*`, `/` on prices, volumes, or indicator values.

### Allowed Integer Usage
Safe JavaScript integers (`number`) are permitted **ONLY** for non-financial control indexing:
- Moving average period lengths ($N$, where $1 \le N \le 100\,000$).
- Loop counters and array indices ($i, t$).
- Timeframe duration minutes (`timeframeMinutes`).
- Millisecond timestamps (`openTimeMs`).

### Isolated High-Precision Calculation Context (`IndicatorCalcDecimal`)
All internal indicator calculations execute in an isolated Decimal constructor clone:

```typescript
export const IndicatorCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -160,
  toExpPos: 160,
});
```

- **Precision**: 128 decimal digits.
- **Rounding**: `ROUND_HALF_UP` (deterministic financial tie-breaking).
- **Exponent Thresholds**: $\pm 160$, ensuring wide non-scientific fixed representation.
- **Immutability**: Global `Decimal` configuration is never touched or mutated.

### Mathematical Precision Budget & Headroom Justification
Why is 64-digit precision insufficient, and why is 128 digits required?

1. **Upstream Input Exact Bounds**:
   - `CanonicalDecimal` (Phase 5): scale $\le 18$, integer digits $\le 18$, total precision $\le 36$.
   - `DerivedAggregateDecimal` (Phase 6): scale $\le 18$, integer digits $\le 30$, total precision $\le 48$.

2. **Bollinger Bands Price-Difference Squared Summation**:
   - A single price difference $(x_t - \mu_t)$ has precision bounded by the price domain ($\le 36$ digits).
   - Squaring this difference $(x_t - \mu_t)^2$ produces a term with up to:
     $$36 + 36 = 72 \text{ significant digits}$$
   - Under `MAX_INDICATOR_PERIOD = 100_000`, the finite sum of up to 100,000 such squared terms requires up to $\lceil \log_{10}(100\,000) \rceil = 5$ additional integer digits:
     $$\le 72 + 5 = 77 \text{ significant digits before division}$$
   - At 64 digits, finite intermediate squared summations would truncate significant digits before the variance division!

3. **VWAP Finite Product and Accumulation**:
   - Typical price $HLC3$ is bounded by the price domain ($\le 36$ digits).
   - Higher-timeframe volume from Phase 6 is bounded to $\le 48$ significant digits.
   - The finite product $HLC3 \times volume$ requires up to:
     $$36 + 48 = 84 \text{ significant digits}$$
   - Across a full UTC day at 1-minute resolution (1,440 candles), accumulating these products requires $\lceil \log_{10}(1\,440) \rceil \approx 4$ additional digits:
     $$\le 84 + 4 = 88 \text{ significant digits before division}$$
   - At 64 digits, intermediate price-volume products and daily cumulative sums would prematurely round.

4. **128-Digit Guarantee**:
   - 128 digits provides a minimum 40-digit deterministic safety headroom above the 88-digit finite accumulation bound.
   - This headroom accommodates multi-step intermediate products and chained indicators without precision leakage.

### Exactness vs. Unavoidable Rounding
- **Finite Arithmetic Exactness**: Bounded additions, subtractions, and multiplications over exact inputs are preserved within the 128-digit context without premature truncation.
- **Deterministic Non-Terminating Rounding**: Operations that mathematically produce non-terminating expansions (division, square root, EMA/RMA smoothing multipliers $\alpha = \frac{2}{N+1}$ or $\frac{1}{N}$) round deterministically at 128 digits using `ROUND_HALF_UP`.
- **Zero Claim of Infinite Precision**: Phase 8 claims deterministic high-precision containment, not mathematically infinite representation.
- **Output Boundary Only**: 18-decimal-place quantization occurs strictly when exporting to public `IndicatorDecimal`. Public rounded values are **NEVER** fed back into recursive calculations.

---

## 7. Public Output Decimal (`IndicatorDecimal`) & Quantization

### Output Type: `IndicatorDecimal`
Phase 8 defines an immutable value object: `IndicatorDecimal`.

Unlike `DerivedAggregateDecimal` (from Phase 6, which forbids negative values because volume is strictly non-negative), `IndicatorDecimal` **MUST SUPPORT NEGATIVE VALUES** to accommodate oscillators and differential indicators (e.g. MACD line, MACD histogram, momentum).

### Public Output Invariants
1. **Scale**: Fractional digits $\le 18$.
2. **Integer Digits**: Significant integer digits $\le 30$.
3. **Total Precision**: Significant digits $\le 48$.
4. **Fixed-Point Formatting Only**: Scientific notation (`1e-5`, `2.4E+7`) is strictly forbidden in string representations.
5. **Zero Normalization**: All variations of zero, including negative zero (`-0`, `-0.0`, `-0.000000000000000000`), must normalize to exactly `"0"`.
6. **Canonical Representation**:
   - Strip redundant leading integer zeros (e.g. `"007.5"` $\to$ `"7.5"`, `"-00.5"` $\to$ `"-0.5"`).
   - Strip redundant trailing fractional zeros (e.g. `"12.34000"` $\to$ `"12.34"`, `"10.0"` $\to$ `"10"`).
   - Remove trailing decimal points (e.g. `"10."` $\to$ `"10"`).

### Output Quantization & Recursive Isolation Invariant
All public values exposed by `IndicatorPoint` are quantized to a maximum of 18 decimal places using:
$$\text{quantizedValue} = \text{rawCalcDecimal.toDecimalPlaces}(18, \text{Decimal.ROUND\_HALF\_UP})$$

> [!IMPORTANT]
> **Internal Recursive State Isolation Law**:
> Recursive indicator kernels (such as EMA, Wilder RMA, ATR, RSI, and SuperTrend) **MUST NEVER** feed the 18-decimal-place quantized public `IndicatorDecimal` back into their recursive state.
> The recursive state (e.g. $EMA_{t-1}$) must remain stored internally as a full 128-digit `IndicatorCalcDecimal`.
> This guarantees zero accumulation of serialization rounding errors over thousands of iterations.

---

## 8. Calculation Segment, Deterministic Bootstrap Origin & Parity Architecture

### 8.1 The Indicator Calculation Segment
To eliminate ambiguity regarding state reproduction and restart, Phase 8 formally defines the concept of an **`IndicatorCalculationSegment`**.

An indicator calculation segment represents an unbroken, continuous, deterministic indicator evaluation sequence. Its immutable identity consists of:
```typescript
export interface IndicatorCalculationSegmentIdentity {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly indicatorType: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly priceSource?: string;
  readonly bootstrapStartOpenTimeMs: number;
}
```

- **`bootstrapStartOpenTimeMs`**: The exact `openTimeMs` of the **FIRST** closed candle belonging to that calculation segment.
- **Segment Determinism**: For a given calculation segment, all indicator states and outputs are derived deterministically from the exact ordered candle sequence beginning at `bootstrapStartOpenTimeMs`.

### 8.2 Recursive Bootstrap & Restart Contract
For recursive indicators whose current state mathematically depends on all past inputs:
- Exponential Moving Average (EMA)
- Wilder Running Moving Average (Wilder RMA)
- Average True Range (ATR)
- Relative Strength Index (RSI)
- MACD Signal Line (EMA of MACD)
- Directional Movement Index & ADX (DMI / ADX)
- SuperTrend

> [!CAUTION]
> **Prohibition of "Latest Warmup Window" for Recursive State Reconstruction**:
> Phase 8 **STRICTLY FORBIDS** claiming that an existing recursive indicator state can be reconstructed by taking merely the "last $N$ candles" or "recent warmup window".
>
> **Example**:
> An EMA(20) initialized at bootstrap origin $A$ that has processed 50,000 candles cannot be reconstructed by taking only the latest 20 candles and reseeding their SMA.
> Seeding an SMA on the latest 20 candles creates an entirely new recurrence trajectory with distinct intermediate numerical values!
>
> **Restart Invariant**:
> In the absence of persisted state, reconstructing an exact recursive indicator state requires replaying the closed candle stream from the **SAME** `bootstrapStartOpenTimeMs` through the identical incremental kernel.

### 8.3 Warmup vs. History Reconstruction
Phase 8 explicitly distinguishes between two separate concepts:
1. **Warmup Required to Produce First Value**: The minimum number of contiguous closed candles needed before an indicator emits its first non-null output (e.g. 20 candles for EMA20, 15 candles for RSI14, 28 candles for ADX14).
2. **History Required to Reconstruct an Existing Recursive State**: The exact continuous candle sequence starting from `bootstrapStartOpenTimeMs` that produced that specific recursive state.

If an operational caller chooses a different bootstrap origin $B > A$ (for example, on bot restart after a multi-day maintenance window):
- This is explicitly a **NEW** indicator calculation segment with identity $B$.
- Outputs from segment $B$ are **NOT** claimed to be byte-identical to segment $A$.
- Callers must choose a deterministic bootstrap origin intentionally before starting a run; Phase 8 never silently derives it from system wall-clock time.

### 8.4 Dual Processing Architecture: Batch & Incremental Parity
Phase 8 provides two complementary execution interfaces:
1. **Incremental Kernel (`IndicatorKernel<T>`)**:
   - Processes one closed candle at a time: `update(candle: IndicatorCandle): IndicatorPoint<T>`.
   - Maintains private internal state machines (rolling buffers, previous recurrence values).
   - Designed for live trading event loops and real-time streaming feeds.
2. **Batch Adapter (`compute<T>(candles: readonly IndicatorCandle[]): readonly IndicatorPoint<T>[]`)**:
   - Computes indicator values across a historical array of closed candles.
   - Designed for historical backtesting and parameter optimization.

```
                  ┌─────────────────────────────────────────┐
                  │          Batch Input: Candles[]         │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼ Chronological iteration
                  ┌─────────────────────────────────────────┐
                  │       Same Incremental Kernel           │
                  │       kernel.update(candle_t)           │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │    Batch Result === Incremental Result  │
                  │    (Bit-for-bit parity at every t)      │
                  └─────────────────────────────────────────┘
```

#### Batch / Incremental Parity Law
$$\forall t \ge \text{bootstrapStartOpenTimeMs}, \quad \text{batchResult}[t].\text{value} \equiv \text{incrementalState.update}(c_t).\text{value}$$

The batch adapter **MUST NOT** implement separate vectorized mathematics. It instantiates the exact incremental kernel and feeds the candles in strictly chronological order from `bootstrapStartOpenTimeMs`.

### 8.5 Bounded Memory Contract
Phase 8 strictly bounds memory utilization:
- **Rolling Indicators (SMA, Donchian, Volume SMA)**: Consume at most $O(period)$ memory. They **MUST NOT** retain the full historical candle stream merely to compute moving averages.
- **Extrema Indicators (Donchian)**: Maintain bounded double-ended queues ($O(period)$).
- **Recursive Indicators (EMA, Wilder RMA, RSI, ATR)**: Maintain $O(1)$ internal state after seed initialization.
- **Bollinger Bands**: Maintains bounded $O(period)$ price window and rolling accumulators.
- **Replay Memory**: The bootstrap replay mechanism streams candles through the incremental kernel; Phase 8 never accumulates an $O(\text{total run history})$ array of past candles in memory.

---

## 9. Output Alignment, Time Synchronization & Warmup Contract

### Standard Output Point Structure
Every indicator emits points conforming to the generic interface:

```typescript
export interface IndicatorPoint<T> {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly value: T | null;
}
```

### 1:1 Alignment Law
For every input closed candle, the indicator engine emits **EXACTLY ONE** corresponding `IndicatorPoint`.
The array length of the output series strictly equals the array length of the input series:
$$\text{output.length} === \text{input.length}$$
Output timestamps (`openTimeMs`, `closeTimeExclusiveMs`) perfectly match the candle's timestamps.

### Warmup Representation: `null` Invariant
Before an indicator has ingested sufficient closed candles to satisfy its mathematical warmup period:
$$\text{point.value} \equiv \text{null}$$

The engine **MUST NEVER** emit `0`, `NaN`, `Infinity`, `-1`, or fabricated seed values to represent uninitialized or warming-up states. A value of `0` is a valid mathematical output (e.g. MACD crossing zero, flat RSI differential) and must never be conflated with "not ready".

### Partial Warmup for Multi-Value Indicators
For indicators emitting composite structures (e.g. MACD, DMI/ADX), sub-components must be emitted as soon as their specific mathematical prerequisite is satisfied:
- **MACD**: When slow EMA is warm ($P_s$ candles) but signal EMA is not yet warm ($P_s + P_{sig} - 1$ candles):
  $$\{ \text{macd}: \text{IndicatorDecimal}, \text{signal}: \text{null}, \text{histogram}: \text{null} \}$$
- **DMI / ADX**: When $+DI$ and $-DI$ are warm ($N+1$ candles) but ADX smoothing is not yet warm ($2N$ candles):
  $$\{ \text{plusDI}: \text{IndicatorDecimal}, \text{minusDI}: \text{IndicatorDecimal}, \text{adx}: \text{null} \}$$

---

## 10. Parameter Validation, Bounds & Resource Safety

### Maximum Indicator Period Bound
Phase 8 freezes an explicit, universal parameter upper bound:

$$\text{MAX\_INDICATOR\_PERIOD} = 100\,000$$

### Parameter Validation Rules
1. **Period Parameters ($N$)**:
   - Must be a safe JavaScript integer: `Number.isSafeInteger(period)`.
   - Must satisfy:
     $$1 \le period \le \text{MAX\_INDICATOR\_PERIOD}$$
   - Any violation (e.g. $period = 0$, $period = 100\,001$, $period = \text{Number.MAX\_SAFE\_INTEGER}$, floats, negative numbers) **FAILS CLOSED** immediately with `INVALID_INDICATOR_PARAMETER`.
   - This bound applies universally to: SMA, EMA, RMA, ATR, RSI, Bollinger Bands, DMI/ADX, Donchian Channel, Volume SMA, Volume Ratio, MACD `fastPeriod`, `slowPeriod`, `signalPeriod`, SuperTrend `atrPeriod`.
2. **Multipliers ($k, m$)**:
   - Must be valid decimal-safe strings or `IndicatorCalcDecimal` instances.
   - Must be strictly positive: $multiplier > 0$.
   - Must not use native float conversion.
3. **Indicator-Specific Parameter Ordering**:
   - MACD: Requires `fastPeriod < slowPeriod`.
4. **Parameter Immutability**:
   - Indicator parameters are frozen at instantiation (`Object.freeze`).

### Architectural Justification for `MAX_INDICATOR_PERIOD = 100_000`
- CoinDCX perpetual futures trade 24/7.
- At 1-minute resolution, 100,000 candles represent:
  $$\frac{100\,000 \text{ minutes}}{1\,440 \text{ minutes/day}} \approx 69.44 \text{ continuous days}$$
- This duration far exceeds any standard technical indicator window (typical EMA lookbacks range from 9 to 200 bars; ATR and RSI from 7 to 28 bars).
- Longer-horizon quantitative research should derive higher timeframes via Phase 6 (e.g. 1h, 4h, 1d) rather than allocating multi-million-candle 1-minute rolling buffers.
- The 100,000 bound provides a hard, fail-fast circuit breaker against configuration typos, overflow bugs, and unbounded memory consumption. Any future increase requires an explicit architecture revision supported by empirical memory benchmarks.

---

## 11. Shared High-Precision Mathematical Primitives

To eliminate code duplication and maintain mathematical consistency, Phase 8 encapsulates foundational calculations into reusable primitives operating at 128-digit precision.

```
                         ┌───────────────────────────┐
                         │   Shared Math Primitives  │
                         └─────────────┬─────────────┘
                                       │
         ┌──────────────┬──────────────┼──────────────┬──────────────┐
         ▼              ▼              ▼              ▼              ▼
    Rolling Sum    Rolling Min    EMA Recurrence  Wilder RMA     True Range
    Rolling Mean   Rolling Max    (alpha=2/(N+1)) (alpha=1/N)    (high-low, gap)
         │                                            │              │
         ├──────────────────────┐                     ├──────────────┘
         ▼                      ▼                     ▼
    Population Var        Bollinger Bands            ATR
    & StdDev (sqrt)                                   │
         │                                            ▼
         ▼                                        SuperTrend
    Bollinger Bands
```

### 11.1 Rolling Sum & Rolling Mean
Maintains an internal sliding window buffer of size $N$ in 128-digit precision:
$$\text{Sum}_t = \sum_{i=0}^{N-1} x_{t-i}, \quad \text{Mean}_t = \frac{\text{Sum}_t}{N}$$
Maintains exact Decimal values to eliminate cumulative subtraction drift.

### 11.2 Rolling Min & Rolling Max
Implemented using double-ended monotonic queues (deques) achieving $O(1)$ amortized time per candle:
- Tracks candidates in monotonically decreasing (max) or increasing (min) order.
- Bounded memory $O(N)$.

### 11.3 Population Variance & Population Standard Deviation
For a window of $N$ values with mean $\mu$:
$$\sigma^2 = \frac{1}{N} \sum_{i=0}^{N-1} (x_i - \mu)^2, \quad \sigma = \sqrt{\sigma^2}$$

> [!IMPORTANT]
> Phase 8 uses **population variance** (divisor $N$), NOT sample variance (divisor $N - 1$), adhering strictly to standard financial band formulas (e.g. John Bollinger).
> Standard deviation is computed via `IndicatorCalcDecimal.sqrt()`.

### 11.4 Exponential Moving Average (EMA) Recurrence
- Multiplier: $\alpha = \frac{2}{N + 1}$
- Seed ($t = N - 1$): SMA of the first $N$ values:
  $$EMA_{N-1} = \frac{1}{N} \sum_{i=0}^{N-1} x_i$$
- Recurrence ($t \ge N$):
  $$EMA_t = \alpha \cdot x_t + (1 - \alpha) \cdot EMA_{t-1}$$
- $EMA_{t-1}$ stored internally in 128-digit precision.

### 11.5 Wilder's Running Moving Average (Wilder RMA) Recurrence
J. Welles Wilder's smoothing technique ($\alpha = \frac{1}{N}$):
- Seed ($t = N - 1$): SMA of the first $N$ values:
  $$RMA_{N-1} = \frac{1}{N} \sum_{i=0}^{N-1} x_i$$
- Recurrence ($t \ge N$):
  $$RMA_t = \frac{RMA_{t-1} \cdot (N - 1) + x_t}{N} = RMA_{t-1} + \frac{x_t - RMA_{t-1}}{N}$$
- Shared by ATR, RSI, and DMI/ADX.

### 11.6 True Range (TR)
Calculated for candle $t$:
- Initial candle in stream ($t = 0$):
  $$TR_0 = high_0 - low_0$$
- Subsequent candles ($t \ge 1$):
  $$TR_t = \max\Big( high_t - low_t, \; |high_t - close_{t-1}|, \; |low_t - close_{t-1}| \Big)$$
- Strictly non-negative ($TR \ge 0$).

---

## 12. Comprehensive Specification of Supported Indicators

### 12.1 Simple Moving Average (SMA)
- **Parameters**: `period` ($1 \le N \le 100\,000$), `priceSource` (default: `CLOSE`).
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).
- **Formula**:
  $$SMA_t = \frac{1}{N} \sum_{i=0}^{N-1} price_{t-i}$$
- **Boundary**: $N = 1$ is valid and outputs the source price directly.

### 12.2 Exponential Moving Average (EMA)
- **Parameters**: `period` ($1 \le N \le 100\,000$), `priceSource` (default: `CLOSE`).
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).
- **Seed**: SMA over first $N$ prices.
- **Formula**:
  $$\alpha = \frac{2}{N + 1}, \quad EMA_t = \alpha \cdot price_t + (1 - \alpha) \cdot EMA_{t-1}$$
- **State**: $EMA_{t-1}$ stored internally in 128-digit precision.

### 12.3 Wilder Running Moving Average (Wilder RMA)
- **Parameters**: `period` ($1 \le N \le 100\,000$), `priceSource` (default: `CLOSE`).
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).
- **Seed**: SMA over first $N$ prices.
- **Formula**:
  $$RMA_t = \frac{RMA_{t-1} \cdot (N - 1) + price_t}{N}$$

### 12.4 Average True Range (ATR)
- **Parameters**: `period` ($1 \le N \le 100\,000$).
- **Input**: True Range ($TR$).
- **Smoothing**: Wilder RMA.
- **Warmup**: Because $TR_0 = high_0 - low_0$ is defined on the first candle, $N$ True Range values exist across the first $N$ candles. First ATR appears at candle index $N - 1$ ($N$-th candle).
- **Seed**: SMA over first $N$ TR values.
- **Formula**:
  $$ATR_t = \frac{ATR_{t-1} \cdot (N - 1) + TR_t}{N}$$

### 12.5 Relative Strength Index (RSI)
- **Parameters**: `period` ($1 \le N \le 100\,000$), `priceSource` (default: `CLOSE`).
- **Price Changes**: Defined for $t \ge 1$:
  $$\Delta_t = price_t - price_{t-1}, \quad gain_t = \max(\Delta_t, 0), \quad loss_t = \max(-\Delta_t, 0)$$
- **Warmup**: Computing $N$ price changes requires $N + 1$ candles ($t = 0, \dots, N$). First valid RSI appears at candle index $N$ ($(N+1)$-th candle).
- **Seed ($t = N$)**:
  $$avgGain_N = \frac{1}{N} \sum_{i=1}^N gain_i, \quad avgLoss_N = \frac{1}{N} \sum_{i=1}^N loss_i$$
- **Recurrence ($t > N$)**:
  $$avgGain_t = \frac{avgGain_{t-1} \cdot (N - 1) + gain_t}{N}, \quad avgLoss_t = \frac{avgLoss_{t-1} \cdot (N - 1) + loss_t}{N}$$
- **RSI Calculation & Zero Invariants**:
  - If $avgGain_t = 0 \land avgLoss_t = 0 \implies RSI_t = 50$ (flat line).
  - If $avgLoss_t = 0 \land avgGain_t > 0 \implies RSI_t = 100$ (monotonically rising).
  - If $avgGain_t = 0 \land avgLoss_t > 0 \implies RSI_t = 0$ (monotonically falling).
  - Otherwise:
    $$RS_t = \frac{avgGain_t}{avgLoss_t}, \quad RSI_t = 100 - \frac{100}{1 + RS_t} = \frac{100 \cdot avgGain_t}{avgGain_t + avgLoss_t}$$
- **Bounds**: $0 \le RSI_t \le 100$.

### 12.6 Moving Average Convergence Divergence (MACD)
- **Parameters**: `fastPeriod` ($P_f$), `slowPeriod` ($P_s$), `signalPeriod` ($P_{sig}$), `priceSource` (default: `CLOSE`).
- **Constraints**: $1 \le P_f < P_s \le 100\,000$, $1 \le P_{sig} \le 100\,000$.
- **Components**:
  - Fast EMA: $EMA(price, P_f)$
  - Slow EMA: $EMA(price, P_s)$
  - MACD Line: $MACD_t = EMA(price, P_f)_t - EMA(price, P_s)_t$
  - Signal Line: $Signal_t = EMA(MACD, P_{sig})_t$
  - Histogram: $Hist_t = MACD_t - Signal_t$
- **Warmup Schedule**:
  - Slow EMA ready: at candle $P_s$.
  - MACD Line ready: at candle index $P_s - 1$ ($P_s$-th candle).
  - Signal Line Seed: SMA of first $P_{sig}$ valid MACD values.
  - Signal Line & Histogram ready: at candle index $P_s + P_{sig} - 2$ ($(P_s + P_{sig} - 1)$-th candle).
- **Output States**:
  - $t < P_s - 1$: `value = null`
  - $P_s - 1 \le t < P_s + P_{sig} - 2$:
    $$\{ \text{macd}: \text{IndicatorDecimal}, \text{signal}: \text{null}, \text{histogram}: \text{null} \}$$
  - $t \ge P_s + P_{sig} - 2$:
    $$\{ \text{macd}: \text{IndicatorDecimal}, \text{signal}: \text{IndicatorDecimal}, \text{histogram}: \text{IndicatorDecimal} \}$$
- **Internal Signal State**: Consumes 128-digit precision MACD values, never 18dp rounded values.

### 12.7 Bollinger Bands
- **Parameters**: `period` ($1 \le N \le 100\,000$), `multiplier` ($k > 0$, decimal-safe), `priceSource` (default: `CLOSE`).
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).
- **Components**:
  - Middle Band: $Middle_t = SMA(price, N)_t$
  - Population Variance: $\sigma^2_t = \frac{1}{N} \sum_{i=0}^{N-1} (price_{t-i} - Middle_t)^2$
  - Standard Deviation: $\sigma_t = \sqrt{\sigma^2_t}$
  - Upper Band: $Upper_t = Middle_t + k \cdot \sigma_t$
  - Lower Band: $Lower_t = Middle_t - k \cdot \sigma_t$
- **Output Structure**:
  $$\{ \text{middle}: \text{IndicatorDecimal}, \text{upper}: \text{IndicatorDecimal}, \text{lower}: \text{IndicatorDecimal}, \text{stdDev}: \text{IndicatorDecimal} \}$$

### 12.8 Directional Movement Index & ADX (DMI / ADX)
- **Parameters**: `period` ($1 \le N \le 100\,000$).
- **Raw Directional Movement ($t \ge 1$)**:
  $$upMove_t = high_t - high_{t-1}, \quad downMove_t = low_{t-1} - low_t$$
  $$+DM_t = \begin{cases} upMove_t & \text{if } upMove_t > downMove_t \land upMove_t > 0 \\ 0 & \text{otherwise} \end{cases}$$
  $$-DM_t = \begin{cases} downMove_t & \text{if } downMove_t > upMove_t \land downMove_t > 0 \\ 0 & \text{otherwise} \end{cases}$$
  *(Ties where $upMove_t == downMove_t$ result in $+DM_t = 0$ and $-DM_t = 0$)*
- **Smoothing**: Wilder RMA over period $N$ for $TR$, $+DM$, and $-DM$.
- **Directional Indicators ($t \ge N$)**:
  $$+DI_t = \begin{cases} \frac{100 \cdot RMA(+DM, N)_t}{RMA(TR, N)_t} & \text{if } RMA(TR, N)_t > 0 \\ 0 & \text{if } RMA(TR, N)_t = 0 \end{cases}$$
  $$-DI_t = \begin{cases} \frac{100 \cdot RMA(-DM, N)_t}{RMA(TR, N)_t} & \text{if } RMA(TR, N)_t > 0 \\ 0 & \text{if } RMA(TR, N)_t = 0 \end{cases}$$
- **Directional Index ($DX_t$)**:
  $$DX_t = \begin{cases} \frac{100 \cdot |+DI_t - -DI_t|}{+DI_t + -DI_t} & \text{if } (+DI_t + -DI_t) > 0 \\ 0 & \text{if } (+DI_t + -DI_t) = 0 \end{cases}$$
- **Average Directional Index ($ADX_t$)**:
  Wilder RMA of valid $DX$ values over period $N$.
  - First valid $DX$ is generated at candle $N + 1$ (index $N$).
  - Seeding the ADX RMA requires $N$ sequential valid $DX$ values.
  - Therefore, the first valid ADX appears at candle index:
    $$\text{Index}_{\text{ADX}} = N + (N - 1) = 2N - 1 \quad \implies \quad 2N\text{-th candle}$$
    *(Example: For standard $N = 14$, $+DI/-DI$ appear at candle 15 (index 14); $ADX$ appears at candle 28 (index 27)).*
- **Output States**:
  - $t < N$: `value = null`
  - $N \le t < 2N - 1$:
    $$\{ \text{plusDI}: \text{IndicatorDecimal}, \text{minusDI}: \text{IndicatorDecimal}, \text{adx}: \text{null} \}$$
  - $t \ge 2N - 1$:
    $$\{ \text{plusDI}: \text{IndicatorDecimal}, \text{minusDI}: \text{IndicatorDecimal}, \text{adx}: \text{IndicatorDecimal} \}$$

### 12.9 SuperTrend
- **Parameters**: `atrPeriod` ($1 \le N \le 100\,000$), `multiplier` ($m > 0$, decimal-safe).
- **Underlying**: Phase 8 ATR ($ATR(N)$).
- **Basic Bands ($t \ge N - 1$)**:
  $$hl2_t = \frac{high_t + low_t}{2}, \quad basicUpper_t = hl2_t + m \cdot ATR_t, \quad basicLower_t = hl2_t - m \cdot ATR_t$$
- **Deterministic Seed Initialization (at first ATR-ready candle $t = N - 1$)**:
  $$finalUpper_{N-1} = basicUpper_{N-1}, \quad finalLower_{N-1} = basicLower_{N-1}$$
  $$direction_{N-1} = \text{DOWN}, \quad supertrend_{N-1} = finalUpper_{N-1}$$
- **Recurrence ($t \ge N$)**:
  - **Final Upper Band**:
    $$finalUpper_t = \begin{cases} basicUpper_t & \text{if } basicUpper_t < finalUpper_{t-1} \lor close_{t-1} > finalUpper_{t-1} \\ finalUpper_{t-1} & \text{otherwise} \end{cases}$$
  - **Final Lower Band**:
    $$finalLower_t = \begin{cases} basicLower_t & \text{if } basicLower_t > finalLower_{t-1} \lor close_{t-1} < finalLower_{t-1} \\ finalLower_{t-1} & \text{otherwise} \end{cases}$$
  - **Direction & SuperTrend Value**:
    $$\text{If } supertrend_{t-1} == finalUpper_{t-1} \text{ (previous state DOWN)}:$$
    $$\begin{cases} direction_t = \text{DOWN}, \; supertrend_t = finalUpper_t & \text{if } close_t \le finalUpper_t \\ direction_t = \text{UP}, \; supertrend_t = finalLower_t & \text{if } close_t > finalUpper_t \end{cases}$$
    $$\text{If } supertrend_{t-1} == finalLower_{t-1} \text{ (previous state UP)}:$$
    $$\begin{cases} direction_t = \text{UP}, \; supertrend_t = finalLower_t & \text{if } close_t \ge finalLower_t \\ direction_t = \text{DOWN}, \; supertrend_t = finalUpper_t & \text{if } close_t < finalLower_t \end{cases}$$
- **Output Structure**:
  $$\{ \text{value}: \text{IndicatorDecimal}, \text{direction}: \text{'UP'} \mid \text{'DOWN'} \}$$
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).

### 12.10 Donchian Channel
- **Parameters**: `period` ($1 \le N \le 100\,000$).
- **Window**: The last $N$ closed candles **INCLUDING** current candle $t$ (candles from $t - N + 1$ to $t$).
- **Components**:
  $$Upper_t = \max_{i=0}^{N-1} high_{t-i}, \quad Lower_t = \min_{i=0}^{N-1} low_{t-i}, \quad Middle_t = \frac{Upper_t + Lower_t}{2}$$
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).
- **Output Structure**:
  $$\{ \text{upper}: \text{IndicatorDecimal}, \text{lower}: \text{IndicatorDecimal}, \text{middle}: \text{IndicatorDecimal} \}$$

> [!IMPORTANT]
> **Lookahead & Strategy Offset Invariant**:
> The Donchian Channel output at candle $t$ mathematically includes candle $t$'s own high and low.
> In a classic channel breakout strategy where an entry signal is evaluated at the close of candle $t$, the strategy must compare candle $t$'s price against the channel established by the **preceding** candles (i.e. output at $t - 1$).
> Phase 8 **DOES NOT** secretly shift the indicator output. Shifting logic belongs to strategy signal rules in Phase 10.

### 12.11 UTC-Day Anchored VWAP
- **Anchor**: `UTC_DAY` (00:00:00 UTC).
- **Reset Trigger**: When a candle's `openTimeMs` crosses midnight UTC:
  $$\lfloor \text{openTimeMs}_t / 86\,400\,000 \rfloor > \lfloor \text{openTimeMs}_{t-1} / 86\,400\,000 \rfloor$$
- **Mandatory Runtime Invariant for Every Candle**:
  Let $\text{DAY\_MS} = 86\,400\,000$. Every candle consumed by UTC-day VWAP must satisfy:
  $$\lfloor \text{openTimeMs} / \text{DAY\_MS} \rfloor \equiv \lfloor (\text{closeTimeExclusiveMs} - 1) / \text{DAY\_MS} \rfloor$$
  If this equality fails, the candle genuinely straddles UTC midnight across two calendar days.
  The engine **FAILS CLOSED** immediately with `INVALID_CANDLE_INPUT`.
  - The engine **MUST NOT** attribute the entire straddling candle to the day of `openTimeMs`.
  - The engine **MUST NOT** split the candle synthetically.
- **Current Phase 6 Enabled Timeframes vs. Generic Engine**:
  - Current enabled Phase 6 timeframes: 2, 3, 4, 5, 10, 15, 30, 60, 240, 1440 minutes all divide 1,440 minutes exactly and use epoch-aligned bucket boundaries. Thus, none of the currently enabled timeframes straddle UTC midnight.
  - A 1440m candle spanning from midnight inclusive ($00:00:00$) to next midnight exclusive ($24:00:00$) is completely valid because $\text{closeTimeExclusiveMs} - 1$ ($23:59:59.999$) falls entirely within the opening UTC calendar day.
  - However, because Phase 6 supports generic integer durations $\ge 2$ (e.g. 7m, 13m), future durations could produce midnight-straddling candles. The runtime boundary check is therefore mandatory.
- **Typical Price**:
  $$HLC3_t = \frac{high_t + low_t + close_t}{3}$$
- **Accumulation**:
  $$cumVol_t = \sum_{\tau = \text{anchor}}^t volume_\tau, \quad cumPV_t = \sum_{\tau = \text{anchor}}^t (HLC3_\tau \cdot volume_\tau)$$
- **VWAP Value**:
  $$VWAP_t = \begin{cases} \frac{cumPV_t}{cumVol_t} & \text{if } cumVol_t > 0 \\ \text{null} & \text{if } cumVol_t = 0 \end{cases}$$
- **Division by Zero Rule**: If cumulative volume across the day is zero, VWAP returns `null`. It never emits `0` or throws an unhandled error.

### 12.12 Volume Moving Average (Volume SMA)
- **Parameters**: `period` ($1 \le N \le 100\,000$).
- **Formula**:
  $$VolumeSMA_t = \frac{1}{N} \sum_{i=0}^{N-1} volume_{t-i}$$
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).

### 12.13 Volume Ratio
- **Parameters**: `period` ($1 \le N \le 100\,000$).
- **Formula**:
  $$VolumeRatio_t = \begin{cases} \frac{volume_t}{VolumeSMA(volume, N)_t} & \text{if } VolumeSMA_t > 0 \\ \text{null} & \text{if } VolumeSMA_t = 0 \end{cases}$$
- **Warmup**: First valid output at candle index $N - 1$ ($N$-th candle).

---

## 13. True Volume Profile — Explicit Deferral Rationale

### The Data-Truth Conflict
The original high-level roadmap mentioned "Volume Profile". In Phase 8-A, the architecture formally identifies that **True Volume Profile cannot be computed from OHLCV candlestick data**.

Candlestick aggregation discards intrabar liquidity distribution:
- A candle reports aggregate volume executed over the entire time interval.
- It does **NOT** report at what specific price levels within the $[low, high]$ range that volume was transacted.

```
Actual Market Activity                     OHLCV Candle Data
  Price                                      Price
    │                                          │
    │      * * (High trade volume at level P1) │        ┌─────┐
 P1 ┼─────────██████████                       │        │     │
    │      *                                   │  High ─┼─────┼─
    │                                          │        │     │
 P2 ┼─────────██ (Low trade volume at level P2)│        │     │
    │                                          │   Low ─┴─────┴─
    └─────────────────────── Time              └───────────────── Time
    (Trade-level executions known)             (Intrabar distribution LOST)
```

### Prohibited Heuristics
Phase 8 **REFUSES TO FABRICATE DATA**. The following common approximations are categorically banned:
1. **Uniform Distribution**: Dividing candle volume equally across all price ticks between high and low.
2. **Close-Only Assignment**: Assigning 100% of candle volume to the close price.
3. **Triangular / Gaussian Heuristics**: Assuming volume follows a synthetic normal distribution centered at $HL2$ or $HLC3$.

### Formal Deferral Decision
**True Volume Profile is DEFERRED** until a dedicated trade-level / tick-level historical backfill and live market data feed is integrated.
Phase 8 fulfills volume feature requirements exclusively through authoritative candle-level volume metrics: **Volume SMA** and **Volume Ratio**.

---

## 14. State Isolation, Thread Safety & Multi-Timeframe Decoupling

### 14.1 Instance State Isolation
Every indicator instance encapsulates its own private state:
- Zero module-level global variables.
- Zero cross-talk between instances.
- Independent instances for different coins (e.g. BTC vs ETH), different timeframes (e.g. 1m vs 5m), and different parameter sets (e.g. EMA 20 vs EMA 50).

### 14.2 Multi-Timeframe Decoupling
An indicator instance is bound to exactly one calculation segment:
$$\text{IndicatorInstance} \iff (\text{pair}, \text{timeframeMinutes}, \text{parameters}, \text{bootstrapStartOpenTimeMs})$$
- A single indicator state machine **MUST NEVER** accept mixed 1m and 5m candles.
- Multi-timeframe strategies (e.g. 1h Trend + 5m Entry) instantiate distinct 1h and 5m indicator instances.
- Downstream strategy layers (Phase 10) are responsible for synchronizing and correlating multi-timeframe indicator points.

---

## 15. Error Model & Fail-Closed Hierarchy

All Phase 8 errors inherit from a base `IndicatorError`:

```typescript
export abstract class IndicatorError extends Error {
  public abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

### Error Taxonomy

| Error Code | Classification | Trigger Condition | Fail-Safe Behavior |
| :--- | :--- | :--- | :--- |
| `INVALID_INDICATOR_PARAMETER` | Configuration | $N < 1$, $N > 100\,000$, $fast \ge slow$, $multiplier \le 0$ | Throws on construction; execution halted |
| `INVALID_CANDLE_INPUT` | Data Integrity | $high < low$, negative prices/vol, or VWAP midnight straddle | Throws immediately; stream invalidated |
| `PAIR_MISMATCH` | Stream Violation | Candle pair does not match instance pair | Throws immediately; stream halted |
| `TIMEFRAME_MISMATCH` | Stream Violation | Candle timeframe does not match instance timeframe | Throws immediately; stream halted |
| `CANDLE_ORDER_VIOLATION` | Continuity | Incoming candle $openTimeMs \le previous.openTimeMs$ | Throws immediately; stream halted |
| `CANDLE_GAP` | Continuity | Incoming candle skips expected bucket boundary | Throws immediately; fail closed |
| `INDICATOR_OVERFLOW` | Arithmetic Bounds | Output exceeds scale 18, integer 30, or precision 48 | Throws immediately; numeric failure |
| `INDICATOR_NUMERIC_FAILURE` | Arithmetic Core | Unexpected division by zero or NaN generation | Throws immediately; fail closed |

> [!NOTE]
> Emitting `value: null` during mathematical warmup is **NOT** an error; it is standard operational alignment.

---

## 16. Downstream Integration & Cross-Phase Contract

```
┌────────────────────────────────────────────────────────┐
│ Phase 5: Canonical 1m Store                            │
│ Phase 6: Generic Higher-Timeframe Engine               │
│ Phase 7: Historical Dataset Engine                     │
└───────────────────────────┬────────────────────────────┘
                            │ Authoritative Market Data
                            ▼
┌────────────────────────────────────────────────────────┐
│ Phase 8: Deterministic Indicator Engine                │
└───────────────────────────┬────────────────────────────┘
                            │ Deterministic IndicatorPoint<T>
                            ▼
┌────────────────────────────────────────────────────────┐
│ Downstream Quant Applications                          │
│                                                        │
│ Phase 9: Backtest Simulation Engine                    │
│ Phase 10: Standardized Strategy Framework              │
│ Phase 14: Real-Time Paper Trading                      │
│ Phase 19: 24/7 Shadow Execution Mode                   │
│ Phase 20+: Live Multi-Regime Production Execution      │
└────────────────────────────────────────────────────────┘
```

### Absolute Architecture Ban
Strategies in Phase 10 or execution routines in Phase 17/20/21 **MUST NEVER** implement private or ad-hoc indicator calculations. All technical and quantitative analysis across backtesting, paper trading, and live execution must consume the identical Phase 8 Indicator Engine.

---

## 17. Mandatory Future Test Matrix & Verification Fixtures

When Phase 8 production code is implemented, the test suite must strictly satisfy this comprehensive verification matrix:

### 1. Calculation Segment & Deterministic Bootstrap Parity
- [ ] **Same-Origin Restart Parity**: Continuous incremental run from bootstrap origin $A$ vs. restart/replay from the SAME origin $A$ produces bit-for-bit identical outputs and internal states at every common timestamp across all indicators.
- [ ] **Shortened-Origin Non-Equivalence**: Replaying only the latest $N$ warmup candles from a later origin $B > A$ must **NOT** be asserted equivalent to segment $A$ for recursive indicators (EMA, RMA, ATR, RSI, MACD signal, ADX, SuperTrend). Proves divergence between different origins.
- [ ] **Batch vs. Incremental Parity from Origin $A$**: For every supported indicator, `batchCompute(candles)` equals sequential `incrementalKernel.update(candle)` from the same `bootstrapStartOpenTimeMs`.
- [ ] **Prefix Determinism from Origin $A$**: Appending future candles after index $M$ does not alter output at any index $\le M$ within calculation segment $A$.
- [ ] **Gap Repair & Replay Contract**: Replaying from original bootstrap origin $A$ over complete repaired market truth produces deterministic results.
- [ ] **New Segment on Gap**: Choosing a new origin following a gap establishes a distinct calculation segment identity.

### 2. 128-Digit Decimal Architecture & Precision Headroom
- [ ] **Zero Native Float**: Verifies zero native JavaScript floating-point math across all calculation paths.
- [ ] **Precision Headroom Beyond 64 Digits**: Proves that intermediate price $\times$ HTF volume multiplications and large Bollinger squared sums ($\approx 77\text{--}88$ digits) do not truncate at the old 64-digit boundary.
- [ ] **128-Digit Context Rounding**: Proves deterministic rounding (`ROUND_HALF_UP`) at 128 digits for non-terminating divisions and square roots.
- [ ] **Negative IndicatorDecimal**: Confirms full support for negative values in oscillators and histograms.
- [ ] **Zero Normalization**: Confirms `-0`, `-0.0`, etc. normalize to `"0"`.
- [ ] **Fixed-Point String Formatting**: Confirms zero scientific notation.
- [ ] **Output Boundary Isolation**: Proves that public 18dp quantization occurs strictly at output creation and is never fed back into 128-digit internal recursive state.
- [ ] **Bounds Rejection**: Verifies rejection of values exceeding scale 18, integer 30, or precision 48.

### 3. UTC-Day VWAP Midnight Safety
- [ ] **1m Intra-Day Candle**: Accepted and accumulated into daily state.
- [ ] **Current Enabled HTF Candles**: 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h candles strictly within a single UTC day are accepted.
- [ ] **1440m Midnight-to-Midnight Candle**: Spanning $00:00$ inclusive to $24:00$ exclusive is accepted because $\text{closeTimeExclusiveMs} - 1$ falls on the opening day.
- [ ] **Midnight-Straddling Candle Rejection**: A synthetic candle genuinely spanning across midnight (e.g. $23:55$ to $00:05$) is rejected immediately with `INVALID_CANDLE_INPUT`.
- [ ] **Zero Candle Splitting**: Proves engine never splits candles or silently attributes straddling candles to open day.
- [ ] **UTC Midnight Reset**: Confirms cumulative price-volume and volume reset to zero when crossing midnight UTC.
- [ ] **Zero Cumulative Volume**: Returns `null` without throwing division-by-zero errors.

### 4. Parameter Validation & Bounded Resources
- [ ] **Boundary Period $N = 1$**: Accepted where formula permits (e.g. SMA, Donchian).
- [ ] **Maximum Period $N = 100\,000$**: Accepted without allocation failure.
- [ ] **Exceeded Period $N = 100\,001$**: Rejected immediately with `INVALID_INDICATOR_PARAMETER`.
- [ ] **Extreme Value $N = \text{Number.MAX\_SAFE\_INTEGER}$**: Rejected with `INVALID_INDICATOR_PARAMETER`.
- [ ] **Invalid Period Formats**: $N = 0$, negative numbers, non-integers, and unsafe integers rejected before candle processing.
- [ ] **MACD Parameter Hierarchy**: Rejects $P_f \ge P_s$, $P_s > 100\,000$, or $P_{sig} > 100\,000$.
- [ ] **Bounded Memory Verification**: Confirms rolling indicators maintain $O(N)$ memory and recursive indicators maintain $O(1)$ memory without accumulating $O(\text{total run history})$ candle arrays.

### 5. Input Validation & Stream Integrity
- [ ] Accepts valid Phase 5 `CanonicalCandle1m` inputs.
- [ ] Accepts valid Phase 6 `HigherTimeframeCandle` inputs.
- [ ] Proves byte-for-byte identical output given identical candle values regardless of provenance (`REST_HISTORICAL` vs `WS_LIVE`).
- [ ] Rejects mismatched pair strings (`PAIR_MISMATCH`).
- [ ] Rejects mismatched timeframe durations (`TIMEFRAME_MISMATCH`).
- [ ] Rejects unaligned bucket timestamps.
- [ ] Rejects duplicate candle timestamps (`CANDLE_ORDER_VIOLATION`).
- [ ] Rejects timestamp backward steps (`CANDLE_ORDER_VIOLATION`).
- [ ] Rejects candle gaps without interpolation or silent bridging (`CANDLE_GAP`).
- [ ] Rejects invalid OHLC geometry ($high < low$, $close > high$, etc.).

### 6. Warmup Boundaries & Output Alignment
- [ ] Verifies output length strictly equals input length for all indicators.
- [ ] Confirms `value === null` prior to exact first-valid candle index.
- [ ] Verifies exact warmup index for every indicator:
  - SMA($N$): index $N - 1$
  - EMA($N$): index $N - 1$
  - Wilder RMA($N$): index $N - 1$
  - TR: index $0$
  - ATR($N$): index $N - 1$
  - RSI($N$): index $N$
  - MACD($P_f, P_s, P_{sig}$): MACD line at $P_s - 1$; Signal line & Histogram at $P_s + P_{sig} - 2$
  - Bollinger Bands($N$): index $N - 1$
  - DMI / ADX($N$): $+DI/-DI$ at index $N$; ADX at index $2N - 1$
  - SuperTrend($N$): index $N - 1$
  - Donchian Channel($N$): index $N - 1$
  - UTC-Day VWAP: index $0$ of UTC day (if volume $> 0$)
  - Volume SMA($N$): index $N - 1$
  - Volume Ratio($N$): index $N - 1$

### 7. Mathematical Verification via Hand-Calculated Fixtures
- [ ] **SMA / EMA / RMA**: Verified against verified hand-calculated tabular fixtures.
- [ ] **RSI**:
  - Monotonically increasing prices $\to$ exactly $100$ after warmup.
  - Monotonically decreasing prices $\to$ exactly $0$ after warmup.
  - Perfectly flat prices $\to$ exactly $50$ after warmup.
  - Verified against Wilder's original 14-period published fixture.
- [ ] **True Range & ATR**:
  - Gap-up True Range ($high - close_{prev}$).
  - Gap-down True Range ($close_{prev} - low$).
  - Inside-bar True Range ($high - low$).
  - Wilder initial SMA seed and recursive smoothing.
- [ ] **MACD**:
  - Fast and slow EMA seeding.
  - Signal line EMA seeding from MACD values.
  - Negative histogram values during bearish momentum.
- [ ] **Bollinger Bands**:
  - Constant price series $\to \sigma = 0$, upper = lower = middle.
  - Population variance divisor ($N$) vs sample variance divisor ($N-1$).
  - Decimal square root exactness.
- [ ] **DMI / ADX**:
  - $+DM$ and $-DM$ selection rules.
  - Tie conditions resulting in zero for both directional movements.
  - Zero True Range handling ($+DI = -DI = 0$).
  - Zero DX denominator handling ($DX = 0$).
  - Double Wilder smoothing warmup schedule ($2N - 1$).
- [ ] **SuperTrend**:
  - Deterministic seed initialization ($direction = DOWN, supertrend = finalUpper$).
  - Band carry-forward rules.
  - Flip from DOWN to UP on close breakout.
  - Flip from UP to DOWN on close breakdown.
- [ ] **Donchian Channel**:
  - Current closed candle included in high/low extrema.
  - Rolling window eviction of old extrema.
  - Strategy-level prior bar breakout logic uses $t-1$.
- [ ] **Volume Features**:
  - Volume SMA calculation.
  - Volume Ratio calculation.
  - Zero Volume SMA returns `null` for Volume Ratio.

### 8. State Isolation & Replay Recovery
- [ ] Confirms distinct instances of the same indicator type do not interfere with each other.
- [ ] Confirms replaying historical candles from `bootstrapStartOpenTimeMs` yields identical state and output as continuous live execution.
- [ ] Verifies zero network, database, or timer dependencies.

---

## 18. Proposed Implementation Architecture & Module Organization

When implemented in production, Phase 8 will reside in `src/indicators/`:

```
src/indicators/
├── index.ts                           # Public barrel export
├── types.ts                           # IndicatorCandle, IndicatorPoint, PriceSource
├── errors.ts                          # Typed error hierarchy
├── decimal/
│   ├── indicator-calc-decimal.ts      # 128-digit Decimal calculation context
│   └── indicator-decimal.ts           # Immutable output Decimal value object
├── candle-adapter/
│   ├── indicator-candle-adapter.ts    # CanonicalCandle1m & HigherTimeframeCandle adapters
│   └── stream-validator.ts            # Monotonicity, continuity & VWAP midnight validator
├── primitives/
│   ├── price-extractor.ts             # CLOSE, OPEN, HIGH, LOW, HL2, HLC3, OHLC4
│   ├── rolling-sum.ts                 # High-precision rolling sum (O(period) memory)
│   ├── rolling-extrema.ts             # O(1) monotonic deque rolling min/max
│   ├── variance.ts                    # Population variance & standard deviation
│   ├── ema-kernel.ts                  # Pure EMA recurrence state machine (O(1) state)
│   ├── rma-kernel.ts                  # Pure Wilder RMA recurrence state machine (O(1) state)
│   └── true-range.ts                  # Pure True Range calculator
├── kernels/
│   ├── sma.ts                         # SMA incremental & batch
│   ├── ema.ts                         # EMA incremental & batch
│   ├── rma.ts                         # Wilder RMA incremental & batch
│   ├── atr.ts                         # ATR incremental & batch
│   ├── rsi.ts                         # RSI incremental & batch
│   ├── macd.ts                        # MACD incremental & batch
│   ├── bollinger.ts                   # Bollinger Bands incremental & batch
│   ├── adx.ts                         # DMI / ADX incremental & batch
│   ├── supertrend.ts                  # SuperTrend incremental & batch
│   ├── donchian.ts                    # Donchian Channel incremental & batch
│   ├── vwap.ts                        # UTC-Day VWAP incremental & batch
│   └── volume.ts                      # Volume SMA & Volume Ratio
```

This modular structure maintains high cohesion, clean isolation of primitives, and zero external technical-indicator dependencies, leveraging the existing production-tested `decimal.js` library.
