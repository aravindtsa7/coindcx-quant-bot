# Strategy × Coin Matrix & Parameter Research — Phase 11 Architecture & Specification

## 1. Executive Summary & System Boundary

Phase 11 defines the **Strategy × Coin Matrix & Deterministic Parameter Research Engine** for the **CoinDCX Quant Futures Bot**. It is the authoritative research orchestration subsystem responsible for systematically exploring multi-coin, multi-strategy, multi-parameter quantitative hypothesis spaces.

Phase 11 answers one fundamental question:
> **For each configured coin/pair, for each configured Phase 10 strategy, and for each explicit legal parameter candidate:**
> *What deterministic Phase 9 backtest run must execute, what exact cryptographic identity does that research cell possess, and what raw reproducible evidence was produced?*

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          RESEARCH CATALOGS & CONFIGURATION                      │
│                                                                                 │
│   Phase 7: HistoricalDatasetManifest (Exact datasetId & contentSha256)          │
│   Phase 10: StrategyRegistry (StrategyDefinition, normalizeParameters)          │
│   Phase 11: Parameter Candidate Specification (Finite grids, predeclared space) │
│   Git Source: Verified clean working tree & auto-captured full commit OID       │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Canonical Plan Definition (Defensive Deep Copy)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                   PHASE 11: CANONICAL MATRIX PLAN EXPANSION                     │
│                                                                                 │
│   - Input-side defensive copy & deep freezing against caller mutation           │
│   - Deterministic candidate space normalization & dimension sorting             │
│   - Phase 10 validation authority: definition.normalizeParameters(candidate)   │
│   - Explicit duplicate parameter rejection (Fail-closed on collisions)          │
│   - Versioned bootstrap policy (P11_INDICATOR_BOOTSTRAP_V1: EMA/ATR/RSI only)   │
│   - Cartesian cell expansion in canonical total order                           │
│   - Cryptographic identity generation: matrixPlanId & matrixCellId              │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Ordered Immutable StrategyCoinMatrixCell[]
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                 PHASE 11: RESEARCH ORCHESTRATION LAYER (PARALLEL/BATCH)         │
│                                                                                 │
│   - Source integrity check: Verify clean HEAD before first cell and execution   │
│   - Strict environment parity: Zero research strategy mocks or forks            │
│   - Authoritative Phase 9 path: normalizeBacktestInputs & sha256CanonicalJson   │
│   - Binds fixedResearchQuantity to Phase 9 participant.parameterHash & runId    │
│   - Replays identical Phase 9 BacktestEngine & Phase 10 StrategyKernel          │
│   - Concurrency determinism: Worker scheduling cannot alter output ordering    │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Deterministic BacktestRunOutcome per Cell
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                 RAW RESEARCH EVIDENCE LEDGER & RESULT MODEL                     │
│                                                                                 │
│   - Immutable StrategyCoinMatrixCellResult with authoritative Phase 9 runId     │
│   - Discriminated terminal results: COMPLETED (real BacktestRunResult) | FAILED   │
│   - Pre-engine failures record MatrixCellFailure with outcome: null             │
│   - Source check: Verify clean HEAD prior to declaring matrix COMPLETED         │
│   - Fail-closed matrix completion: Failed cells NEVER silently vanish           │
│   - Discrete execution states: PLANNED, RUNNING; terminal: COMPLETED, FAILED    │
│   - Overall matrix status: COMPLETED, PARTIAL, FAILED                           │
│   - Zero wall-clock durations or timestamps in canonical research evidence      │
│   - Anti-Scope: NO winner selection, NO ranking, NO automatic promotion         │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Raw Research Evidence (Read-Only)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         DOWNSTREAM RESEARCH CONSUMERS                           │
│                                                                                 │
│   Phase 12: Research Validation Lab (Sharpe, Drawdown, Overfitting, Monte Carlo)│
│   Phase 13: Risk & Leverage Engine (Capital sizing, liquidation buffers)        │
│   Phase 15: Strategy Ranking & Paper Trading Promotion                         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Strict Boundary: Research Orchestrator vs. Downstream Disciplines
Phase 11 is strictly a **Research Orchestration** layer.
- **Phase 11 Owns:**
  - Deterministic parameter candidate space definitions and finite grid expansion.
  - Input-side defensive copying and freezing of all caller-owned parameter and configuration inputs.
  - Verification and binding of authoritative Phase 10 strategy definitions and Phase 7 historical datasets.
  - Verified Git source state enforcement (clean tree check and auto-captured full commit OID).
  - Versioned indicator bootstrap policy enforcement (`P11_INDICATOR_BOOTSTRAP_V1`).
  - Canonical matrix planning and cryptographic identity generation (`matrixPlanId`, `matrixCellId`).
  - Authoritative Phase 9 `runId` construction via Phase 9's real `normalizeBacktestInputs` and `sha256CanonicalJson`.
  - Execution orchestration invoking the genuine Phase 9 `BacktestEngine` and Phase 10 `StrategyBacktestParticipantAdapter`.
  - Immutable aggregation and canonical ordering of raw execution results.
  - Bounded memory, fail-closed partial/error semantics, and concurrency-invariant ordering.
- **Phase 11 Explicitly DOES NOT Own (Strict Non-Goals):**
  - **Statistical Approval & Overfitting Checks (Deferred to Phase 12):** Phase 11 does not compute Sharpe, Sortino, Calmar, profit factor, max drawdown curves, walk-forward degradation, or Monte Carlo p-values.
  - **Risk & Sizing Engine (Deferred to Phase 13):** Phase 11 executes with fixed nominal research quantities (`fixedResearchQuantity`). It does not calculate dynamic margin, equity percentage sizing, leverage brackets, or portfolio-level risk limits.
  - **Strategy Promotion & Winner Selection (Deferred to Phase 15):** Phase 11 never selects a "best" parameter, "winning" coin, or "approved" strategy. A positive backtest PnL does not qualify any strategy for deployment.
  - **Production State Mutation:** Phase 11 outputs are strictly read-only evidence. Generating research results never mutates the Coin Registry, Strategy Registry, runtime supervisor state, paper configurations, or live parameters.
  - **Live Exchange Interfacing:** Phase 11 executes purely offline on historical datasets. Zero network calls to exchange trading or private endpoints are permitted.

---

## 2. Research Universe & Generic Coin Architecture

### 2.1 Initial Research Universe
The initial baseline research universe comprises:
- **Instruments:** `BTC-INR`, `ETH-INR` (CoinDCX INR Perpetual Futures).
- **Phase 10 Strategies:**
  - `EMA_TREND` (v1.0.0)
  - `ATR_BREAKOUT` (v1.0.0)
  - `RSI_MOMENTUM` (v1.0.0)
  - `MULTI_TIMEFRAME_TREND` (v1.0.0)

### 2.2 Invariant 4 & 5 Compliance: Zero Hardcoding
Core Matrix orchestration code **must never hardcode** `BTC-INR`, `ETH-INR`, or the initial four strategies.
- Pairs and strategies are dynamic configuration inputs.
- The matrix engine accepts an arbitrary set of valid trading pairs and arbitrary registered Phase 10 strategy definitions.
- Onboarding `SOL-INR` (Phase 16), a future 5th strategy, or version `2.0.0` of an existing strategy requires only supplying their respective configuration descriptors and dataset manifests, requiring **zero code modifications** to the Phase 11 matrix engine.

---

## 3. Parameter Candidate Space Specification

### 3.1 Predeclared Finite Space Law (Critical No-Lookahead Rule)
> **Core Architectural Law:** The parameter candidate space for every strategy in a matrix plan must be completely declared and frozen **prior to backtest execution**. Adaptive parameter generation, genetic algorithms, Bayesian optimization loops, reinforcement learning, and heuristic adjustments driven by previous backtest outcomes are **strictly prohibited** in Phase 11.

All parameter exploration in Phase 11 is strictly deterministic, finite grid/list exploration.

### 3.2 Candidate Space Schema
A strategy candidate space specification defines explicit finite candidate values for every parameter required by the strategy's Phase 10 schema:

```typescript
export type ParameterPrimitiveValue = string | number | boolean;

export interface StrategyParameterCandidateSpace {
  readonly strategyId: string;
  readonly strategyVersion: string;
  /**
   * Finite candidate sets per parameter key.
   * Every declared parameter in the strategy definition must have at least one candidate value.
   */
  readonly dimensions: Readonly<Record<string, readonly unknown[]>>;
}
```

### 3.3 Deterministic Dimension Normalization & Lexicographical Sorting
To ensure that candidate definition ordering does not affect canonical matrix identity:
1. **Dimension Key Order:** Parameter dimension keys are sorted in strict lexicographical (ASCII byte) order:
   $$k_1 < k_2 < \dots < k_n$$
2. **Dimension Value Ordering:** Candidate arrays for each parameter dimension are sorted deterministically before expansion:
   - **Integer Values (periods, timeframes):** Sorted numerically ascending ($5 < 15 < 60$).
   - **Decimal Strings (multipliers, thresholds):** Canonicalized via Phase 10 `normalizeCanonicalDecimalString` and sorted by exact numerical value ascending via `StrategyCalcDecimal.cmp`.
   - **PriceSource Enums:** Sorted lexicographically (`'CLOSE' < 'HL2' < 'HLC3' < 'LOW' < 'OPEN' < 'OHLC4'`).
   - **Array Parameters (e.g. MTF `timeframes`):** Each inner array is sorted ascending (e.g., `[5, 15]`), and the collection of array candidates is sorted lexicographically by element values.
3. **Empty Dimensions:** Any dimension with zero candidate values fails closed immediately with `INVALID_PARAMETER_SPACE` ("Dimension must contain at least one candidate value").

### 3.4 Deterministic Cartesian Expansion
The matrix expansion generates the full Cartesian product across all normalized dimensions in deterministic order:
$$\prod_{i=1}^n D_i = D_1 \times D_2 \times \dots \times D_n$$

Where dimension keys are iterated in lexicographical order, and values are iterated in their normalized sorted order.

### 3.5 Phase 10 Authority & Zero Duplicate Validation (P11-SPEC-01)
Phase 11 **MUST NOT** implement secondary validation logic for strategy parameters.
- Phase 10 `StrategyDefinition.normalizeParameters(rawCandidate)` is the **sole authoritative validator**.
- Every raw parameter combination generated by Cartesian expansion is passed directly through `definition.normalizeParameters(rawCandidate)`.
- If Phase 10 throws `INVALID_STRATEGY_PARAMETER`, candidate expansion fails closed immediately. Phase 11 does not silently skip, catch-and-ignore, or repair invalid candidates.

### 3.6 Explicit Duplicate Candidate Rejection
If two raw candidates produce identical Phase 10 `normalizedParameters` (and therefore identical `parameterHash`):
- For example, supplying both `"2.0"` and `"2.00"` for ATR `breakoutMultiplier`, or `[15, 5]` and `[5, 15]` for MTF `timeframes`.
- Phase 11 **rejects the plan with a structured error**: `DUPLICATE_PARAMETER_CANDIDATE`.
- Silent deduplication is prohibited; the plan author must explicitly specify distinct logical candidates.

---

## 4. Dataset Binding & Temporal Windows

### 4.1 Authoritative Phase 7 Dataset Binding
Every pair in a matrix plan must explicitly bind to an authoritative Phase 7 dataset identity:
```typescript
export interface MatrixPairDatasetBinding {
  readonly pair: string;
  readonly datasetId: string;
  readonly datasetContentSha256: string;
}
```
- **Prohibitions:** "Latest available dataset", filesystem directory scanning, wildcards, and auto-discovered datasets are **strictly prohibited**.
- The matrix plan freezes the exact `datasetId` and `datasetContentSha256`. If the dataset is modified or re-acquired, the matrix plan identity changes deterministically.
- The bound dataset's `pair` must strictly equal the matrix pair; mismatched bindings fail closed immediately (`DATASET_PAIR_MISMATCH`).

### 4.2 Research Window Contract
A matrix plan specifies an exact research window in safe integer UTC epoch milliseconds:
$$\text{analysisStartMs} < \text{analysisEndExclusiveMs}$$
- Both timestamps must be exact 60,000 ms (1-minute) aligned.
- All comparable cells within a matrix plan share the exact same declared research window.

### 4.3 Mapping to Phase 9 Replay Boundaries
For every cell in the matrix, the research window maps to Phase 9 `BacktestRunManifest` time boundaries:
1. **`evaluationFromInclusiveMs`:** Set to `analysisStartMs`. Strategy evaluation callbacks first begin at this timestamp.
2. **`evaluationToExclusiveMs`:** Set to `analysisEndExclusiveMs`. Strategy evaluation halts at this timestamp.
3. **`replayToExclusiveMs`:** Set to `analysisEndExclusiveMs`. The final replayed source candle closes at this timestamp, where terminal mark-to-market and accounting closure finalize.
4. **`bootstrapFromInclusiveMs`:** Deterministically computed per the Section 5 Versioned Indicator Bootstrap policy ($\le \text{analysisStartMs}$).

### 4.4 Fail-Closed Dataset Coverage Barrier
Before executing any backtest run, the engine validates that the bound Phase 7 dataset covers the entire span:
$$[\text{manifest.fromInclusiveMs}, \text{manifest.toExclusiveMs}) \supseteq [\text{bootstrapFromInclusiveMs}, \text{replayToExclusiveMs})$$

If the dataset cannot completely cover both the indicator bootstrap warmup and the active analysis window, the cell fails closed with `DATASET_COVERAGE_GAP`. Silently shortening the backtest window is strictly barred.

---

## 5. Versioned Indicator Bootstrap Policy & Instance Identity

### 5.1 The Multi-Timeframe Bootstrap Challenge
Phase 10 enforces `strategyInstanceId` bound to `indicatorBootstrapIdentity`:
```typescript
export interface StrategyIndicatorBootstrapIdentityEntry {
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
}
```
If different backtest workers or different execution runs derive different bootstrap origins for the same strategy parameters, they produce different `strategyInstanceId` values, destroying research reproducibility.

### 5.2 Versioned Policy Identity (`bootstrapPolicyId`)
To eliminate any ambiguity and prevent heuristic guessing, Phase 11 binds an explicit versioned bootstrap policy:
```typescript
export const PHASE11_INDICATOR_BOOTSTRAP_POLICY_V1 = 'P11_INDICATOR_BOOTSTRAP_V1' as const;
export type MatrixBootstrapPolicyId = typeof PHASE11_INDICATOR_BOOTSTRAP_POLICY_V1;
```
- `bootstrapPolicyId` is frozen in `StrategyCoinMatrixPlan` and hashed directly into `matrixPlanId`.
- Changing the bootstrap policy changes the research behavior and alters `matrixPlanId`.

### 5.3 Phase 11 v1 Supported Warmup Domain
Phase 11 v1 explicitly supports matrix planning **ONLY** for strategy indicator requirements whose `indicatorType` is:
- **`EMA`**
- **`ATR`**
- **`RSI`**

This completely covers the Phase 10 initial four strategies (`EMA_TREND`, `ATR_BREAKOUT`, `RSI_MOMENTUM`, `MULTI_TIMEFRAME_TREND`), which depend exclusively on EMA, ATR, and RSI.

#### Fail-Closed on Unsupported Indicator Types:
If any strategy definition declares an indicator requirement whose `indicatorType` is:
- **`SMA`**
- **`MACD`**
- **`BOLLINGER`**
- **`SUPERTREND`**
- or any future indicator type not explicitly registered under the active `bootstrapPolicyId`

The matrix plan **FAILS CLOSED IMMEDIATELY** during plan normalization before `matrixPlanId` calculation or backtest execution with structured error:
`MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY`.
Silently guessing a warmup formula or inferring lookback from a generic `period` field is **strictly prohibited**.

### 5.4 Exact Warmup Formula Contract (`P11_INDICATOR_BOOTSTRAP_V1`)
For each requirement $req$ of supported types (`EMA`, `ATR`, `RSI`):
1. **Indicator Warmup Bars ($\text{warmupBars}(req)$):**
   - For `EMA`:
     $$\text{warmupBars}(req) = 3 \times \text{positiveSafeInteger}(req.\text{parameters.period})$$
   - For `ATR`:
     $$\text{warmupBars}(req) = 3 \times \text{positiveSafeInteger}(req.\text{parameters.period})$$
   - For `RSI`:
     $$\text{warmupBars}(req) = 3 \times \text{positiveSafeInteger}(req.\text{parameters.period})$$
2. **Safe Integer Arithmetic Validation:**
   The period must be a Phase 10/8 verified positive safe integer $\le 100\,000$ (`MAX_STRATEGY_PERIOD`).
   The multiplication $3 \times period \times req.\text{timeframeMinutes} \times 60\,000$ is verified to not exceed `Number.MAX_SAFE_INTEGER`.
3. **Timeframe-Level Warmup Lookback:**
   Where multiple indicator requirements share the same timeframe $TF$:
   $$\text{minWarmupMinutes}_{TF} = \max_{req \in Req(TF)} (\text{warmupBars}(req)) \times TF$$
4. **Common Temporal Alignment Formula:**
   To uphold Phase 9 Higher-Timeframe Common Bootstrap Alignment (Phase 9 Invariant, Section 8.1):
   - Let $M_{\text{lcm}} = \text{LCM}(\text{all configured timeframes in cell})$.
   - Let $\text{targetWarmupMs} = \max_{TF}(\text{minWarmupMinutes}_{TF}) \times 60\,000$.
   - Let $\text{rawBootstrapStartMs} = \text{analysisStartMs} - \text{targetWarmupMs}$.
   - Compute the bucket-aligned bootstrap origin:
     $$\text{bootstrapFromInclusiveMs} = \lfloor \frac{\text{rawBootstrapStartMs}}{M_{\text{lcm}} \times 60\,000} \rfloor \times (M_{\text{lcm}} \times 60\,000)$$
5. **Per-Timeframe Entry Construction:**
   For each distinct timeframe $TF$ required by the strategy:
   $$\text{entry}_{TF} = \{ \text{timeframeMinutes}: TF, \text{bootstrapStartOpenTimeMs}: \text{bootstrapFromInclusiveMs} \}$$
   Entries are sorted strictly ascending by `timeframeMinutes`.

### 5.5 Future Indicator Extensibility Policy
- **Adding Strategies with Existing Supported Indicators:** Adding a new strategy (e.g. strategy #5) that requires only `EMA`, `ATR`, and/or `RSI` requires **zero matrix core changes**.
- **Adding Strategies with New Indicator Types:** Adding a strategy requiring `SMA`, `MACD`, `BOLLINGER`, or `SUPERTREND` requires an explicit extension to the versioned bootstrap policy registry (e.g. introducing `P11_INDICATOR_BOOTSTRAP_V2`). This extension must:
  1. Define exact mathematical warmup bar formulas for the new indicators.
  2. Implement discriminating test fixtures.
  3. Increment policy identity to `P11_INDICATOR_BOOTSTRAP_V2`.
  4. Change `matrixPlanId` accordingly.

This enforces clean version boundaries without ad-hoc heuristics.

---

## 6. Phase 9 Reuse, Authoritative Run-ID & Environment Parity

### 6.1 Absolute Environment Parity Law
> **Core Architectural Law:** Phase 11 MUST NOT implement a simplified, "fast", or specialized research backtest simulator. Every research cell MUST execute through the REAL Phase 9 `BacktestEngine` consuming the REAL Phase 10 `StrategyKernel` via `StrategyBacktestParticipantAdapter`.

Prohibitions:
- `ResearchEmaStrategy` or vectorized Pandas/NumPy evaluation: **STRICTLY PROHIBITED**.
- Mocking the Phase 9 accounting ledger: **STRICTLY PROHIBITED**.
- Skipping fee calculation, slippage attribution, or funding settlement: **STRICTLY PROHIBITED**.
- All-in-memory shortcuts that bypass Phase 9's two-pass dataset verification contract: **STRICTLY PROHIBITED**.

### 6.2 Matrix Backtest Execution Configuration Contract (`MatrixBacktestExecutionConfig`)
Phase 11 v1 matrix-level deterministic backtest configuration binds the common Phase 9 run inputs that are shared across matrix cells within a plan:

```typescript
export interface MatrixBacktestExecutionConfig {
  readonly initialEquity: string;

  readonly costModel: {
    readonly makerFeeRate: string;
    readonly takerFeeRate: string;
    readonly halfSpreadBps: string;
    readonly marketSlippageBps: string;
    readonly stopSlippageBps: string;
  };

  readonly intrabarAmbiguityPolicy: 'ADVERSE_FIRST';
  readonly maxOpenOrders: number;
  readonly engineSemanticVersion: string;
}
```

#### Deterministic Rules & Bounds:
1. **Decimal Canonical Normalization:** All decimal fields (`initialEquity`, `makerFeeRate`, `takerFeeRate`, `halfSpreadBps`, `marketSlippageBps`, `stopSlippageBps`) are validated and normalized using the actual Phase 9 canonical decimal normalization path (`BacktestDecimal`, `toBacktestCalcDecimal`). Native JS floating-point arithmetic is strictly prohibited.
2. **Positive Equity:** `initialEquity` must be a positive decimal string ($> 0$, e.g. `"100000.00"`).
3. **Cost Model Bounds:** Cost rates must be non-negative ($\ge 0$). As enforced by Phase 9, half spread plus market slippage rate and half spread plus stop slippage rate must each be strictly less than one ($< 1$).
4. **Order Concurrency Limits:** `maxOpenOrders` must be a safe integer between 1 and 100 inclusive (default: 20, ceiling: 100).
5. **Engine Semantic Version:** `engineSemanticVersion` is explicitly bound (default: `'9.0.0'`).
6. **Intrabar Ambiguity:** Fixed to `'ADVERSE_FIRST'`.
7. **No Implicit Sizing:** No implicit strategy or risk sizing parameters are embedded in the backtest configuration.
8. **Plan Identity Binding:** `MatrixBacktestExecutionConfig` is a direct property of `StrategyCoinMatrixPlan` and is hashed directly into `matrixPlanId`.
9. **Exclusion of Pair-Specific Funding:** Funding schedules are pair-specific and are explicitly **excluded** from `MatrixBacktestExecutionConfig`. Each pair binds its own funding schedule in `MatrixPairCatalogEntry`.

### 6.3 `verificationPageMinutes` Non-Identity Specification
Phase 9 `normalizeBacktestInputs` supports `verificationPageMinutes` for memory-bounded dataset verification chunking, but `verificationPageMinutes` is **NOT** part of `BacktestRunManifest` or Phase 9 `runId`.

For Phase 11 v1:
- `verificationPageMinutes` is **NOT** part of deterministic research identity:
  - It is **NOT** part of `matrixPlanId`.
  - It is **NOT** part of `matrixCellId`.
  - It is **NOT** part of `matrixResultSha256`.
- The engine uses the Phase 9 default (1440 minutes, 24 hours) unless an execution-only runtime option is explicitly passed to the worker.
- If exposed as runtime worker tuning, changing `verificationPageMinutes` must **never** alter canonical research results, cell outcomes, or cryptographic identities.
- Phase 11 specifications and code must never falsely claim that Phase 9 `runId` binds `verificationPageMinutes`.

### 6.4 `configuredTimeframes` Derivation Rule
For each cell, the `configuredTimeframes` array passed to Phase 9 `normalizeBacktestInputs` must be derived deterministically from the actual Phase 10 strategy kernel indicator requirements:
1. **Extraction:** Collect the `timeframeMinutes` from all declared `indicatorRequirements` of the strategy kernel.
2. **Filter Higher Timeframes Only ($> 1$):**
   $$\text{configuredTimeframes} = \{ TF \in \text{kernelRequirements} \mid TF > 1 \}$$
   - **Critical Rule:** 1m is **NEVER** included in `configuredTimeframes`. Phase 9 treats canonical 1m as the base candle stream and `configuredTimeframes` strictly as derived higher timeframes.
3. **Sort Ascending:** Sort the resulting distinct timeframe values numerically ascending (e.g. `[5, 15, 60]`).
4. **Bucket Alignment Verification:** Phase 9 `normalizeBacktestInputs` re-verifies that `bootstrapFromInclusiveMs` is strictly aligned to the bucket start of every configured higher timeframe:
   $$\text{bucketStartMs}(\text{bootstrapFromInclusiveMs}, TF) === \text{bootstrapFromInclusiveMs} \quad \forall TF \in \text{configuredTimeframes}$$

### 6.5 Authoritative Phase 9 Manifest & RunId Construction Path (P11-SPEC-02)
Phase 11 **MUST NOT** implement a duplicate canonical JSON serializer, a parallel manifest serializer, or a custom `runId` hashing function.
- Phase 11 directly imports and invokes the actual Phase 9 production manifest builder:
  ```typescript
  import { normalizeBacktestInputs } from '../backtest/manifest';
  import { sha256CanonicalJson } from '../backtest/canonical-json';
  ```
- To construct a finalized cell:
  1. Instantiate the actual Phase 10 kernel for the strategy candidate (`definition.createKernel(...)`).
  2. Build the actual Phase 10 participant adapter identity:
     ```typescript
     const participant = buildStrategyBacktestParticipantIdentity({
       kernel,
       fixedResearchQuantity: pairCatalogEntry.fixedResearchQuantity,
       gitCommitHash: plan.sourceIdentity.gitCommitHash,
     });
     ```
  3. Derive `configuredTimeframes` per Section 6.4.
  4. Collect actual runtime pair resources (`datasetManifest`, `instrumentSpec`, `costModel`, `fundingSchedule`).
  5. Invoke actual Phase 9 `normalizeBacktestInputs(...)`, which returns:
     $$\{ \text{manifest}: \text{BacktestRunManifest}, \text{runId}: \text{string}, \dots \}$$
  6. The returned `runId` is the **authoritative `expectedRunId`** assigned to `cell.expectedRunId`.
  7. For evidence verification only, assert:
     $$\text{cell.expectedRunId} === \text{sha256CanonicalJson}(\text{normalized.manifest})$$
     using the actual Phase 9 `sha256CanonicalJson`.
  8. When the cell executes via `BacktestEngine.run()`, the resulting `cellResult.runId` must strictly equal `cell.expectedRunId`. A mismatch fails closed immediately (`RUN_ID_MISMATCH`).

### 6.6 RunId Sensitivity & Identity Propagation
Phase 9 `runId` is sensitive to every behavior-altering backtest input. Altering any of the following parameters must deterministically produce a different `expectedRunId` and `matrixCellId`:
1. `datasetId` or `datasetContentSha256`
2. `bootstrapFromInclusiveMs`, `evaluationFromInclusiveMs`, `evaluationToExclusiveMs`, `replayToExclusiveMs`
3. `configuredTimeframes` (derived from strategy indicator requirements)
4. `instrumentSpecSnapshotId` (re-verified by Phase 9)
5. `costModel` (maker fee, taker fee, spread bps, slippage bps)
6. `fundingSchedule` (`sourceId`, `contentSha256`, `fidelity`)
7. `intrabarAmbiguityPolicy` (`ADVERSE_FIRST`)
8. `maxOpenOrders`
9. `engineSemanticVersion`
10. `initialEquity`
11. `participant.parameterHash` (which binds `strategyInstanceId` and `fixedResearchQuantity`)
12. `participant.gitCommitHash` (which binds the verified clean source commit)

Phase 11 enforces that all sensitivity changes propagate directly through the Phase 9 production code path.

### 6.7 Fixed Research Quantity Binding
Phase 10 adapter requires `fixedResearchQuantity`.
In Phase 11:
- `fixedResearchQuantity` must be explicitly declared per pair in the matrix plan (e.g., `0.01` for `BTC-INR`, `0.1` for `ETH-INR`).
- Default values or implicit fallbacks are barred.
- As proven in Phase 10 (P10-SPEC-06), altering `fixedResearchQuantity`:
  - **Does NOT** alter the pure strategy's `parameterHash` or `strategyInstanceId`.
  - **DOES** alter Phase 9's `participant.parameterHash` and Phase 9 `runId`.
- Phase 11 matrix cell identity cryptographically binds Phase 9 `runId`, ensuring complete lineage transparency.

### 6.8 Cross-Coin Comparison Safety Warning
> [!WARNING]
> Raw net PnL from a `BTC-INR` cell and an `ETH-INR` cell is **NOT directly comparable** in Phase 11.
> Because `fixedResearchQuantity` represents different nominal capital exposures across different asset prices and contract multipliers, a strategy showing +₹50,000 on BTC and +₹30,000 on ETH cannot be declared "better on BTC" without capital-weighted, margin-normalized risk evaluation. Phase 11 records raw reproducible evidence; Phase 12 and Phase 15 perform statistical and ranking normalization.

---

## 7. Verified Git Source Identity & Clean Working-Tree Contract

### 7.1 The Untrusted Commit Hash Problem
Accepting an arbitrary caller-provided `gitCommitHash` string risks producing research artifacts claiming clean Git commit $A$ while executing on uncommitted or dirty code $B$.
To preserve absolute cryptographic reproducibility, Phase 11 enforces an authoritative **Verified Git Source Contract**.

### 7.2 Contract A: Plan Finalization (Auto-Capture & Cleanliness)
When a `StrategyCoinMatrixPlan` is finalized:
1. **Auto-Capture Full Commit OID:**
   The orchestrator queries the actual local repository state equivalent to:
   ```bash
   git rev-parse HEAD
   ```
   - Must return the **full 40-character (or 64-character SHA-256) hex commit OID**. Short hashes (e.g. `e04bc18`) are strictly prohibited in plan identity.
2. **Strict Clean Working-Tree Check:**
   The orchestrator inspects working-tree cleanliness equivalent to:
   ```bash
   git status --porcelain=v1 --untracked-files=all
   ```
   - The output **MUST BE EMPTY**.
   - If any tracked modified file, staged file, or untracked non-ignored file exists:
     The plan creation **FAILS CLOSED** immediately with structured error:
     `MATRIX_SOURCE_DIRTY`.
3. **Ignored Files Scoping:**
   Files matching `.gitignore` (e.g. local SQLite DBs, temporary download caches) are excluded from the Git working-tree cleanliness check. Behaviorally relevant files (such as historical datasets) are bound by their own cryptographic identities (`datasetId`, `contentSha256`).
4. **Binding to Plan Identity:**
   The auto-captured actual commit OID is assigned to `sourceIdentity.gitCommitHash` and bound into `matrixPlanId` and downstream Phase 10 / Phase 9 `participantIdentity.gitCommitHash`.

### 7.3 Contract B: Serialized / Prebuilt Plan Execution
If an existing, serialized `StrategyCoinMatrixPlan` is loaded from disk or API for execution:
1. The orchestrator independently inspects the current repository state (`git rev-parse HEAD` and working tree cleanliness) **before dispatching any cell**.
2. **Commit Verification:**
   $$\text{actualCurrentCommitOID} === \text{plan.sourceIdentity.gitCommitHash}$$
   If mismatched: fails closed with `MATRIX_SOURCE_COMMIT_MISMATCH`.
3. **Cleanliness Verification:**
   If the current working tree has any tracked, staged, or untracked non-ignored modifications:
   Fails closed with `MATRIX_SOURCE_DIRTY`.
4. Silently overwriting the plan's stored commit hash is **strictly prohibited**.

### 7.4 Contract C: Execution Boundary Invariance
To ensure the executable source cannot be modified mid-run:
1. Source state is verified before the first cell executes.
2. Source state is re-verified before dispatching each batch of cells OR the execution runtime runs within an isolated environment guaranteeing executable immutability.
3. Source state is verified **a final time** immediately before the matrix status is finalized as `COMPLETED`.
4. If the source repository HEAD changes or the tree becomes dirty during execution:
   The run **FAILS CLOSED** with `MATRIX_SOURCE_DIRTY` or `MATRIX_SOURCE_COMMIT_MISMATCH`, and **MUST NOT** report `COMPLETED`.

### 7.5 Contract D: Environment Without Git Metadata
For Phase 11 v1, if authoritative Git source metadata cannot be verified (e.g. shallow clone without Git CLI, stripped directory):
- The engine **FAILS CLOSED** with `MATRIX_SOURCE_STATE_UNAVAILABLE`.
- Fallbacks to environment variables, manual strings, package versions, timestamps, hostnames, or process IDs are **strictly prohibited**.

### 7.6 Testability Seam vs. Production Contract
To ensure rigorous unit and integration testing without weakening production integrity:
1. **Public Production Contract:** Production entry points (`runStrategyCoinMatrix`, `planStrategyCoinMatrix`, etc.) MUST always invoke the real Git source verifier querying local repository state directly (`git rev-parse HEAD`, `git status --porcelain=v1 --untracked-files=all`). Callers cannot supply an arbitrary `gitCommitHash` to bypass repository verification.
2. **Internal Dependency Seam:** Implementation may define an internal source inspection abstraction (e.g. `GitSourceVerifier`) that defaults to the real Git process executor. An internal seam may be injected strictly within internal unit tests.
3. **Public API Seam Protection:** The internal test seam **MUST NOT** be exported from the public Phase 11 barrel (`src/matrix/index.ts`) or public API.
4. **Isolated Temporary Git Repositories:** Unit tests for Git source verification should construct isolated temporary Git repositories (`fs.mkdtemp`, `git init`, `git commit`) so that working-tree dirtiness during ongoing active development in the main workspace does not force weakening the production clean-tree rule.
5. **Mandatory Test Cases:** Real Git integration test suites must explicitly cover:
   - Clean temporary repository (succeeds)
   - Tracked modified file (fails closed with `MATRIX_SOURCE_DIRTY`)
   - Staged uncommitted file (fails closed with `MATRIX_SOURCE_DIRTY`)
   - Untracked non-ignored file (fails closed with `MATRIX_SOURCE_DIRTY`)
   - Different commit HEAD OID (fails closed with `MATRIX_SOURCE_COMMIT_MISMATCH`)
6. **Controlled Mid-Run Invalidation:** Orchestration tests may use the internal seam to simulate repository state becoming dirty mid-run, verifying that all pending cells fail and the matrix terminates with status `FAILED`.

---

## 8. Canonical Matrix Plan Contract & Plan ID

### 8.1 Input-Side Defensive Immutability (P11-SPEC-03)
To ensure that caller-owned mutable objects or arrays cannot alter a matrix plan after construction:
- All input arguments (pair arrays, strategy candidate space definitions, candidate value arrays, multi-timeframe arrays, dataset binding structures, backtest execution configurations) are **deep-copied and deep-frozen** upon plan ingestion.
- Subsequent push operations, property reassignments, or deletions on caller-owned objects have **zero effect** on:
  - Frozen plan contents
  - `matrixPlanId`
  - Canonical cell total sequence
  - `matrixCellIds`
  - Pure strategy `parameterHash` and `strategyInstanceId`
  - Phase 9 `runId` and execution results.

### 8.2 Canonical Plan Interface (`StrategyCoinMatrixPlan`)
```typescript
import type { BacktestFundingFidelity } from '../backtest/types';

export interface MatrixStrategyCatalogEntry {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly candidateSpace: StrategyParameterCandidateSpace;
}

export interface MatrixPairCatalogEntry {
  readonly pair: string;
  readonly datasetBinding: MatrixPairDatasetBinding;
  readonly fixedResearchQuantity: string;
  readonly instrumentSpecSnapshotId: string;
  readonly fundingScheduleBinding: {
    readonly sourceId: string;
    readonly contentSha256: string;
    readonly fidelity: BacktestFundingFidelity;
  };
}

export interface StrategyCoinMatrixPlan {
  readonly schemaVersion: 1;
  readonly planName: string;
  readonly bootstrapPolicyId: MatrixBootstrapPolicyId;
  readonly researchWindow: {
    readonly analysisStartMs: number;
    readonly analysisEndExclusiveMs: number;
  };
  readonly pairs: readonly MatrixPairCatalogEntry[];
  readonly strategies: readonly MatrixStrategyCatalogEntry[];
  readonly backtestConfig: MatrixBacktestExecutionConfig;
  readonly sourceIdentity: {
    readonly gitCommitHash: string; // Full 40-hex or 64-hex commit OID
  };
}
```

### 8.3 Plan-Build & Execution Runtime Resources Contract (`MatrixPairExecutionResources`)
To maintain clean separation between the canonical research specification and concrete runtime environment objects:
- **Canonical Plan (Artifact A):** Stores authoritative cryptographic identities and configuration hashes (`datasetId`, `datasetContentSha256`, `instrumentSpecSnapshotId`, `fundingScheduleBinding`, `gitCommitHash`).
- **Runtime Execution Resources (Artifact B):** The concrete in-memory or filesystem resources required by Phase 9 `BacktestEngine` and `normalizeBacktestInputs` to execute backtest runs.

Phase 11 binds execution resources via the pair resource contract using real Phase 7/9 types:
```typescript
import type { HistoricalDatasetManifest } from '../market-data/historical';
import type {
  BacktestDatasetSource,
  BacktestFundingSchedule,
  BacktestInstrumentSpec,
} from '../backtest/types';

export interface MatrixPairExecutionResources {
  readonly pair: string;
  readonly datasetManifest: HistoricalDatasetManifest;
  readonly datasetSource: BacktestDatasetSource;
  readonly instrumentSpec: BacktestInstrumentSpec;
  readonly fundingSchedule: BacktestFundingSchedule;
}
```

### 8.4 Resource Identity Verification Rules
Before any cell's `expectedRunId` is finalized and again prior to executing Phase 9 `BacktestEngine`, the matrix engine validates resource identity equality:
1. **Dataset Pair Match:**
   $$\text{datasetManifest.pair} === \text{planPair.pair}$$
2. **Dataset Identity Match:**
   $$\text{datasetManifest.datasetId} === \text{planPair.datasetBinding.datasetId}$$
   $$\text{datasetManifest.contentSha256} === \text{planPair.datasetBinding.datasetContentSha256}$$
3. **Instrument Spec Match:**
   $$\text{instrumentSpec.pair} === \text{planPair.pair}$$
   $$\text{instrumentSpec.instrumentSpecSnapshotId} === \text{planPair.instrumentSpecSnapshotId}$$
   - In addition, Phase 9 `normalizeBacktestInputs` recomputes and verifies the instrument snapshot:
     $$\text{computeBacktestInstrumentSpecSnapshotId}(\text{normalizedInstrument}) === \text{planPair.instrumentSpecSnapshotId}$$
4. **Funding Schedule Match:**
   $$\text{fundingSchedule.sourceId} === \text{planPair.fundingScheduleBinding.sourceId}$$
   $$\text{fundingSchedule.contentSha256} === \text{planPair.fundingScheduleBinding.contentSha256}$$
   $$\text{fundingSchedule.fidelity} === \text{planPair.fundingScheduleBinding.fidelity}$$
   - In addition, Phase 9 `normalizeBacktestInputs` strictly re-verifies chronological event ordering within `(bootstrapFromInclusiveMs, replayToExclusiveMs]` and confirms that `computeBacktestFundingScheduleContentSha256(events) === planPair.fundingScheduleBinding.contentSha256`.
5. **Fail-Closed on Mismatch:** Any discrepancy between provided execution resources and frozen plan bindings fails closed immediately with `RESOURCE_IDENTITY_MISMATCH` or `DATASET_IDENTITY_MISMATCH`. No mismatched resource may silently proceed.

### 8.5 Explicit Distinction: Dataset Source vs. Git Source
Phase 11 strictly differentiates between two fundamentally distinct source identity concepts:
1. **Git Executable Source Identity:**
   - Property: `plan.sourceIdentity.gitCommitHash`
   - Purpose: Cryptographic identity of the code repository executing the research.
   - Destination: Passed into Phase 10 adapter and Phase 9 manifest as `participant.gitCommitHash`.
2. **Historical Dataset Source Identity:**
   - Property: `datasetSource.sourceIdentity` (from `MatrixPairExecutionResources.datasetSource`)
   - Purpose: Identifier of the historical market data storage mechanism (e.g. `'LOCAL_FS'`, `'MEMORY'`, `'S3'`).
   - Destination: Passed into Phase 9 `normalizeBacktestInputs({ sourceIdentity: datasetSource.sourceIdentity, ... })`.

**Critical Boundary:** These two fields are never conflated. A dataset source string must **NEVER** be assigned to `participant.gitCommitHash`.

### 8.6 Deterministic Matrix Plan ID (`matrixPlanId`)
$$\text{matrixPlanId} = \text{SHA-256}\left(\text{CanonicalJson}(\text{StrategyCoinMatrixPlan})\right)$$

**Canonicalization Rules:**
1. UTF-8 encoding without BOM.
2. Object keys sorted lexicographically (ASCII byte order) recursively at all depths.
3. `pairs` array sorted strictly ascending by `pair` name, with each entry binding `datasetBinding`, `fixedResearchQuantity`, `instrumentSpecSnapshotId`, and `fundingScheduleBinding`.
4. `strategies` array sorted strictly ascending by `strategyId`, then `strategyVersion`.
5. Candidate dimensions within each strategy sorted lexicographically by dimension key, and dimension values sorted per Section 3.3.
6. `backtestConfig` serialized with normalized decimal strings (`"100000.00"`, `"0.0002"`, `"0.0005"`, `"1.5"`, `"2.0"`).
7. Zero wall-clock timestamps (`Date.now()`), zero runtime durations, zero hostnames, and zero process IDs in the hash payload.

Any change to the pair catalog, dataset hash, analysis window, strategy candidate spaces, execution parameters, funding schedule binding, bootstrap policy ID, or repository git commit alters `matrixPlanId`.

---

## 9. Matrix Cell Contract & Canonical Cell Ordering

### 9.1 Matrix Cell Definition (`StrategyCoinMatrixCell`)
Each legal combination of pair $\times$ strategy $\times$ normalized parameter candidate represents exactly one immutable `StrategyCoinMatrixCell`:

```typescript
export interface StrategyCoinMatrixCell {
  readonly matrixCellId: string;
  readonly matrixPlanId: string;
  readonly cellSequence: number;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly normalizedParameters: Readonly<Record<string, unknown>>;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly datasetId: string;
  readonly datasetContentSha256: string;
  readonly timeRange: {
    readonly bootstrapFromInclusiveMs: number;
    readonly evaluationFromInclusiveMs: number;
    readonly evaluationToExclusiveMs: number;
    readonly replayToExclusiveMs: number;
  };
  readonly fixedResearchQuantity: string;
  readonly expectedRunId: string; // From Phase 9 normalizeBacktestInputs
}
```

### 9.2 Deterministic Cell ID (`matrixCellId`)
$$\text{matrixCellId} = \text{SHA-256}\left(\text{CanonicalJson}(\text{StrategyCoinMatrixCellIdentityPayload})\right)$$

The hashed payload contains:
```json
{
  "datasetContentSha256": "<64-hex>",
  "datasetId": "<64-hex>",
  "expectedRunId": "<64-hex>",
  "fixedResearchQuantity": "0.01",
  "matrixPlanId": "<64-hex>",
  "pair": "BTC-INR",
  "parameterHash": "<64-hex>",
  "strategyId": "EMA_TREND",
  "strategyInstanceId": "<64-hex>",
  "strategyVersion": "1.0.0",
  "timeRange": {
    "bootstrapFromInclusiveMs": 1704067200000,
    "evaluationFromInclusiveMs": 1704153600000,
    "evaluationToExclusiveMs": 1706745600000,
    "replayToExclusiveMs": 1706745600000
  }
}
```
- Completely independent of memory addresses or array indexes.
- Guaranteed unique per distinct research evaluation.

### 9.3 Canonical Cell Total Ordering
Cells within a matrix plan are placed into a strict canonical sequence:
1. `pair`: Lexicographical ascending (`'BTC-INR' < 'ETH-INR'`).
2. `strategyId`: Lexicographical ascending (`'ATR_BREAKOUT' < 'EMA_TREND'`).
3. `strategyVersion`: Semantic version ascending (`'1.0.0' < '1.1.0'`).
4. `parameterHash`: Hex string ascending.
5. `strategyInstanceId`: Hex string ascending.
6. `expectedRunId`: Hex string ascending.

`cellSequence` is assigned as a 1-based monotonic integer in this canonical order ($1, 2, \dots, N$).
This sequence is completely decoupled from execution completion order or worker thread assignment.

---

## 10. Result Model & Matrix Execution Lifecycle

### 10.1 Transient Execution Lifecycle vs. Terminal Result Model
Each research cell progresses through explicit transient lifecycle states during execution:

```
[ PLANNED ] ──► [ RUNNING ] ──► [ COMPLETED ] (Valid Phase 9 BacktestRunResult)
                     │
                     └──► [ FAILED ] (Matrix-level error or Phase 9 BacktestFailedRunResult)
```

```typescript
export type MatrixCellExecutionState =
  | 'PLANNED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';
```

However, the canonical **final matrix result** contains **only terminal cell results** (`COMPLETED` or `FAILED`).

### 10.2 Final Cell Result Discriminated Union
Phase 11 v1 defines an authoritative discriminated union for terminal cell results:

```typescript
import type {
  BacktestRunResult,
  BacktestFailedRunResult,
} from '../backtest/types';

export interface MatrixCellFailure {
  readonly code: MatrixErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface MatrixCellResultBase {
  readonly matrixCellId: string;
  readonly cellSequence: number;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly datasetId: string;
  readonly expectedRunId: string;
}

export interface MatrixCellCompletedResult extends MatrixCellResultBase {
  readonly status: 'COMPLETED';
  readonly runId: string;
  readonly outcome: BacktestRunResult;
  readonly failure: null;
}

export interface MatrixCellFailedResult extends MatrixCellResultBase {
  readonly status: 'FAILED';
  readonly runId: string | null;
  readonly outcome: BacktestFailedRunResult | null;
  readonly failure: MatrixCellFailure;
}

export type StrategyCoinMatrixCellResult =
  | MatrixCellCompletedResult
  | MatrixCellFailedResult;
```

#### Invariants on `COMPLETED` Cell Result:
- `status === 'COMPLETED'`
- `runId === expectedRunId`
- `outcome.runId === expectedRunId`
- `outcome.terminalStatus === 'COMPLETED'`
- `outcome.isValid === true`
- `failure === null`

#### Invariants on `FAILED` Cell Result & Pre-Engine vs. Engine Failure:
- `status === 'FAILED'`
- `failure` is a non-null, structured `MatrixCellFailure`.
- **Pre-Engine Failure (Engine Never Ran):** If cell execution fails before `BacktestEngine.run()` starts (e.g., strategy instantiation failure, parameter validation failure, runtime resource mismatch, dataset coverage gap, or cache integrity rejection):
  - `outcome = null` (strictly null; no fabricated `BacktestRunOutcome` is ever constructed).
  - `runId = null` (unless an authoritative `expectedRunId` was already computed before failure).
  - `failure.code` is the genuine `MatrixErrorCode`.
- **Phase 9 Failed Run (Engine Ran & Failed):** If `BacktestEngine.run()` completes with a failed run (`outcome.terminalStatus === 'FAILED'`):
  - `outcome` preserves the genuine `BacktestFailedRunResult`.
  - `outcome.errorCode` preserves the genuine Phase 9 `BacktestErrorCode`.
  - Phase 11 **MUST NOT** rewrite or suppress the Phase 9 error as a fake matrix-only outcome.
  - `failure` wraps the failure with `code: 'CELL_EXECUTION_FAILED'` and descriptive diagnostic message.

### 10.3 Planning-Time Structural Failure vs. Execution-Time Failure
Phase 11 enforces a strict boundary between planning errors and execution failures:
1. **Planning-Time Structural Failures:**
   - Any condition that prevents the construction of a valid, immutable canonical matrix plan or valid cell definitions—such as invalid candidate dimensions, duplicate normalized candidate parameters, unsupported indicator bootstrap policies, invalid Git repository state, or invalid backtest configurations—**FAILS PLAN FINALIZATION IMMEDIATELY**.
   - These structural failures throw `StrategyCoinMatrixError`.
   - The engine **NEVER** fabricates a `StrategyCoinMatrixPlanResult` for a plan that never achieved valid status.
2. **Execution-Time Cell Failures:**
   - Once a valid, immutable plan has been constructed, any subsequent failure during execution (runtime dataset read error, engine simulation failure, resource mismatch discovered at execution time, or unexpected adapter exception) produces a terminal `FAILED` cell result.
   - **No cell disappears:** `cellResults.length` must strictly equal the planned cell count ($N$).

### 10.4 Overall Matrix Plan Status
```typescript
export type MatrixPlanStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface StrategyCoinMatrixPlanResult {
  readonly matrixPlanId: string;
  readonly planName: string;
  readonly status: MatrixPlanStatus;
  readonly totalCells: number;
  readonly completedCells: number;
  readonly failedCells: number;
  readonly cellResults: readonly StrategyCoinMatrixCellResult[];
  readonly matrixResultSha256: string;
}
```

#### Final Status Transitions:
1. **`COMPLETED`:** All $N$ planned cells finished with `status: 'COMPLETED'` AND the final Git source verification check passes cleanly.
2. **`PARTIAL`:** Under a still-valid verified Git source identity, at least one cell is `COMPLETED` and at least one cell is `FAILED`.
3. **`FAILED`:**
   - Zero cells completed; OR
   - Matrix-wide source integrity fails at any point during execution or finalization.

#### Mid-Run Git Source Invalidation Rule:
If the local repository HEAD changes or the working tree becomes dirty mid-run:
- The matrix **MUST NOT** report `COMPLETED` or ordinary `PARTIAL` research success.
- Overall matrix status becomes **`FAILED`**.
- Every planned cell that has not yet completed is terminalized as **`FAILED`** with `failure.code = 'MATRIX_SOURCE_DIRTY'` or `'MATRIX_SOURCE_COMMIT_MISMATCH'`.
- Already-completed cell evidence may remain recorded for audit traceability, but the overall matrix artifact is marked `FAILED` and is invalid for research conclusions.
- `cellResults.length` still strictly equals $N$.

### 10.5 Elimination of Wall-Clock Durations from Canonical Results
To preserve bit-for-bit reproducible research evidence across different hardware, CPUs, and execution environments:
- **Zero Durations:** `durationMs`, elapsed runtime, wall-clock start/end timestamps, hostnames, and process IDs are **STRICTLY EXCLUDED** from canonical:
  - `StrategyCoinMatrixCellResult`
  - `StrategyCoinMatrixPlanResult`
  - `matrixResultSha256` payload
- If runtime performance telemetry is desired for operational monitoring, it must reside in an external, non-canonical telemetry channel and must **never** affect research identities or canonical JSON hashes.
- For Phase 11 v1, runtime telemetry is omitted from canonical evidence artifacts.

### 10.6 Result Cryptographic Hash (`matrixResultSha256`)
$$\text{matrixResultSha256} = \text{SHA-256}\left(\text{CanonicalJson}(\text{MatrixResultSummaryPayload})\right)$$

The summary payload covers only canonical terminal research evidence:
1. `matrixPlanId`: The frozen 64-hex plan identity.
2. `status`: The final `MatrixPlanStatus` (`'COMPLETED'`, `'PARTIAL'`, or `'FAILED'`).
3. `totalCells`, `completedCells`, `failedCells`: Exact non-negative integer counts.
4. `cellDigests`: Array of per-cell digest records sorted strictly by `cellSequence` ($1, 2, \dots, N$):
   - **For `COMPLETED` Cells:**
     ```json
     {
       "expectedRunId": "<64-hex>",
       "matrixCellId": "<64-hex>",
       "resultSha256": "<64-hex>",
       "runId": "<64-hex>",
       "status": "COMPLETED"
     }
     ```
   - **For `FAILED` Cells:**
     ```json
     {
       "expectedRunId": "<64-hex>",
       "failureCode": "CELL_EXECUTION_FAILED",
       "matrixCellId": "<64-hex>",
       "phase9ErrorCode": "DATASET_RANGE_INVALID",
       "runId": "<64-hex-or-null>",
       "status": "FAILED"
     }
     ```
     *(If the cell failed before engine execution, `phase9ErrorCode` is `null` and `runId` is `null`).*
5. Excludes all duration, execution time, and worker process metadata.
6. Bit-for-bit identical whether executed with 1 worker or $N$ parallel workers.

---

## 11. Concurrency Determinism & Cache Boundary

### 11.1 Concurrency Determinism
Phase 11 supports parallel worker execution (e.g., worker pools, cluster nodes):
- **Cell Isolation:** Each research cell is completely stateless and decoupled from all other cells. No shared mutable memory or inter-cell message passing exists during execution.
- **Completion Invariance:** Worker completion order (e.g. cell #8 completing before cell #1) has **zero impact** on the final result payload.
- Upon completion of all executions, results are sorted strictly by `cellSequence` before computing `matrixResultSha256`.
- Running a plan with 1 worker vs. 8 workers vs. 64 workers yields **bit-for-bit identical `matrixResultSha256` and identical JSON result output**.

### 11.2 Strict Resume & Cache Boundary
To accelerate research iteration across long backtest spans, Phase 11 may inspect existing cell result archives:
1. **Verification Before Reuse:** A cached cell result cannot be trusted based on `matrixCellId` or filename alone.
2. **Reusability Restriction (COMPLETED Only):** Phase 11 v1 cache reuse is permitted **ONLY** for genuine successful `BacktestRunResult` outcomes. A failed outcome (`status: 'FAILED'`, `outcome.terminalStatus === 'FAILED'`) is **NEVER** reusable as a cache hit and must re-evaluate on fresh execution.
3. **Mandatory Cache Integrity Validation Algorithm:**
   A cached cell result is accepted if and only if all of the following conditions hold:
   - `cachedResult.status === 'COMPLETED'`
   - `cachedResult.outcome !== null`
   - `cachedResult.outcome.terminalStatus === 'COMPLETED'`
   - `cachedResult.outcome.isValid === true`
   - `cachedResult.runId === cell.expectedRunId`
   - `cachedResult.outcome.runId === cell.expectedRunId`
   - `cachedResult.matrixCellId === cell.matrixCellId`
   - **Correct Phase 9 Result Hash Verification:**
     Because Phase 9 computes `resultSha256` over `BacktestResultHashPayload` *prior* to attaching the `resultSha256` field to `BacktestRunResult`, the cache validator must extract the hash payload and verify:
     ```typescript
     const { resultSha256, ...phase9HashPayload } = cachedResult.outcome;
     sha256CanonicalJson(phase9HashPayload) === resultSha256;
     ```
   - **Explicit Non-Algorithm:** Hashing the full `cachedResult.outcome` object including `resultSha256` is **EXPLICITLY NOT** the validation algorithm (as the self-referential hash would never match).
4. **Tamper Invalidation:** Mutating any field in `phase9HashPayload` (e.g. `finalEquity`, `netPnl`, `totalFills`, `eventLedgerSha256`) invalidates the cache check.
5. **Fail-Closed on Corruption:** Mismatched, corrupt, or unverified cache entries fail closed: the cache entry is rejected/invalidated, forcing fresh cell execution. If fresh execution subsequently fails, standard `FAILED` cell result semantics apply. A corrupt cache can never fabricate `COMPLETED` evidence.

---

## 12. Structured Error Hierarchy

All Phase 11 failures fail closed using structured, typed errors:

```typescript
export type MatrixErrorCode =
  | 'INVALID_PARAMETER_SPACE'
  | 'DUPLICATE_PARAMETER_CANDIDATE'
  | 'DATASET_PAIR_MISMATCH'
  | 'DATASET_COVERAGE_GAP'
  | 'DATASET_IDENTITY_MISMATCH'
  | 'TIMEFRAME_ALIGNMENT_FAILURE'
  | 'STRATEGY_REGISTRY_LOOKUP_FAILED'
  | 'STRATEGY_PARAM_VALIDATION_FAILED'
  | 'CELL_EXECUTION_FAILED'
  | 'RUN_ID_MISMATCH'
  | 'CONCURRENCY_INTEGRITY_VIOLATION'
  | 'CACHE_INTEGRITY_FAILURE'
  | 'MATRIX_SOURCE_STATE_UNAVAILABLE'
  | 'MATRIX_SOURCE_DIRTY'
  | 'MATRIX_SOURCE_COMMIT_MISMATCH'
  | 'MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY'
  | 'RESOURCE_IDENTITY_MISMATCH'
  | 'INVALID_BACKTEST_CONFIG'
  | 'FUNDING_SCHEDULE_INVALID';

export class StrategyCoinMatrixError extends Error {
  public constructor(
    public readonly code: MatrixErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'StrategyCoinMatrixError';
  }
}
```

---

## 13. Non-Production Matrix Example

Below is an illustrative, non-production matrix plan specification demonstrating Cartesian grid expansion across 2 pairs and the first 4 strategies.

> [!NOTE]
> **RESEARCH EXAMPLE ONLY:** The parameters and values listed below are chosen strictly for architectural illustration. They **DO NOT** represent optimized defaults, approved trading parameters, or profitable configurations.

### 13.1 Illustrative Specification
- **Window:** 2024-01-01 00:00:00 UTC to 2024-02-01 00:00:00 UTC (`1704067200000` to `1706745600000`).
- **Bootstrap Policy:** `P11_INDICATOR_BOOTSTRAP_V1`.
- **Pairs:** `BTC-INR` (`fixedResearchQuantity: "0.01"`), `ETH-INR` (`fixedResearchQuantity: "0.1"`).
- **Strategies & Grids:**
  1. `EMA_TREND` (v1.0.0):
     - `timeframeMinutes`: `[5, 15]`
     - `fastPeriod`: `[9, 12]`
     - `slowPeriod`: `[21, 26]`
     - `priceSource`: `['CLOSE']`
     - *Grid size: $2 \times 2 \times 2 \times 1 = 8$ candidates.*
  2. `ATR_BREAKOUT` (v1.0.0):
     - `timeframeMinutes`: `[5, 15]`
     - `atrPeriod`: `[14, 20]`
     - `breakoutMultiplier`: `["1.5", "2.0"]`
     - *Grid size: $2 \times 2 \times 2 = 8$ candidates.*
  3. `RSI_MOMENTUM` (v1.0.0):
     - `timeframeMinutes`: `[5, 15]`
     - `period`: `[14]`
     - `longThreshold`: `["65", "70"]`
     - `shortThreshold`: `["30", "35"]`
     - `priceSource`: `['CLOSE']`
     - *Grid size: $2 \times 1 \times 2 \times 2 \times 1 = 8$ candidates.*
  4. `MULTI_TIMEFRAME_TREND` (v1.0.0):
     - `timeframes`: `[[5, 15], [5, 15, 60]]`
     - `fastPeriod`: `[9]`
     - `slowPeriod`: `[21]`
     - `priceSource`: `['CLOSE']`
     - *Grid size: $2 \times 1 \times 1 \times 1 = 2$ candidates.*
- **Total Candidates per Pair:** $8 + 8 + 8 + 2 = 26$ candidates.
- **Total Matrix Cells:** $2 \text{ pairs} \times 26 \text{ candidates} = 52$ deterministic cells.

### 13.2 Cell Expansion Trace (First 3 Cells)
```
Cell 001: BTC-INR × ATR_BREAKOUT 1.0.0 × { atrPeriod: 14, breakoutMultiplier: "1.5", timeframeMinutes: 5 }
Cell 002: BTC-INR × ATR_BREAKOUT 1.0.0 × { atrPeriod: 14, breakoutMultiplier: "2", timeframeMinutes: 5 }
Cell 003: BTC-INR × ATR_BREAKOUT 1.0.0 × { atrPeriod: 20, breakoutMultiplier: "1.5", timeframeMinutes: 5 }
...
```

---

## 14. High-Risk Architectural Checklist

| ID | High-Risk Question | Specification Resolution | Status |
| :--- | :--- | :--- | :--- |
| **P11-H01** | Can dirty/uncommitted executable source execute while claiming a clean committed git hash? | **NO.** Source check requires `git status --porcelain=v1 --untracked-files=all` to be empty. Any change fails closed with `MATRIX_SOURCE_DIRTY`. | **CLOSED** |
| **P11-H02** | Can caller provide an arbitrary source hash that is trusted without runtime verification? | **NO.** Orchestrator independently verifies the current repository HEAD matches the full commit OID. | **CLOSED** |
| **P11-H03** | Can a serialized plan execute on a different HEAD from the one it binds? | **NO.** Independent pre-execution check requires `actual HEAD === plan.sourceIdentity.gitCommitHash`; mismatch fails closed with `MATRIX_SOURCE_COMMIT_MISMATCH`. | **CLOSED** |
| **P11-H04** | Can a currently unsupported Phase 10 indicator type receive an inferred/guessed warmup formula? | **NO.** `P11_INDICATOR_BOOTSTRAP_V1` supports only EMA, ATR, RSI. SMA/MACD/Bollinger/SuperTrend fail closed with `MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY`. | **CLOSED** |
| **P11-H05** | Can a new non-EMA/ATR/RSI strategy enter Phase 11 v1 without first extending the versioned bootstrap policy? | **NO.** Unregistered indicator requirements fail closed during plan normalization before execution. | **CLOSED** |
| **P11-H06** | Can Phase 11 compute expectedRunId using a parallel hash implementation instead of actual Phase 9 production identity code? | **NO.** Must invoke the real Phase 9 `normalizeBacktestInputs` and `sha256CanonicalJson`. Parallel serializers or formulas are barred. | **CLOSED** |
| **P11-H07** | Can mutating caller-owned plan/candidate inputs after construction change matrixPlanId or cell execution? | **NO.** All caller inputs are defensively deep-copied and deep-frozen upon ingestion before hashing or expansion. | **CLOSED** |
| **P11-H08** | Can raw candidates bypass Phase 10 validation? | **NO.** All raw candidates pass through Phase 10 `definition.normalizeParameters()`. Invalid candidates fail closed before execution. | **CLOSED** |
| **P11-H09** | Can numerical equivalents create duplicate matrix cells? | **NO.** Normalization canonicalizes strings (`"2.0"` $\to$ `"2"`). Duplicate normalized hashes are detected and rejected with `DUPLICATE_PARAMETER_CANDIDATE`. | **CLOSED** |
| **P11-H10** | Can worker concurrency change result sequence or hash? | **NO.** Cells are totally ordered in canonical sequence. Results are sorted by `cellSequence` before hashing. | **CLOSED** |
| **P11-H11** | Can Phase 11 use a faster mock backtest engine? | **NO.** Absolute environment parity requires executing the real Phase 9 `BacktestEngine` and Phase 10 `StrategyKernel`. | **CLOSED** |
| **P11-H12** | Can a failed cell silently drop to report success? | **NO.** All planned cells must be present in `cellResults`. Any failure changes matrix status to `PARTIAL` or `FAILED`. | **CLOSED** |
| **P11-H13** | Can future backtest results alter subsequent parameter candidates? | **NO.** The finite candidate grid is completely declared and frozen before execution begins. No lookahead or adaptive search is allowed. | **CLOSED** |
| **P11-H14** | Can a positive backtest PnL promote a strategy to paper/live? | **NO.** Phase 11 is research evidence only. Promotion requires Phase 12 validation, Phase 13 risk review, and Phase 15 ranking. | **CLOSED** |
| **P11-H15** | Can dataset binding silently resolve to "latest"? | **NO.** Exact `datasetId` and `contentSha256` must be explicitly declared in the plan. | **CLOSED** |
| **P11-H16** | Can altered `fixedResearchQuantity` retain the same Phase 9 runId? | **NO.** Adapter configuration binds `participant.parameterHash`, changing Phase 9 `runId` deterministically. | **CLOSED** |
| **P11-H17** | Can matrix results mutate production configurations? | **NO.** Matrix results are immutable read-only records. Production configurations remain unaffected. | **CLOSED** |
| **P11-H18** | Can `MatrixBacktestExecutionConfig` be omitted or left unstandardized? | **NO.** `MatrixBacktestExecutionConfig` is explicitly frozen with canonical decimal bounds (`initialEquity`, `costModel`, `intrabarAmbiguityPolicy: 'ADVERSE_FIRST'`, `maxOpenOrders`, `engineSemanticVersion`), bound in `StrategyCoinMatrixPlan` and hashed into `matrixPlanId`. Pair-specific funding schedules are cleanly segregated into pair catalog entries. | **CLOSED** |
| **P11-H19** | Can pair-specific funding schedules or concrete execution resources mismatch plan identities? | **NO.** `MatrixPairCatalogEntry` binds `fundingScheduleBinding` (`sourceId`, `contentSha256`, `fidelity`). `MatrixPairExecutionResources` are validated against plan bindings before cell finalization and execution; any mismatch fails closed (`RESOURCE_IDENTITY_MISMATCH`). | **CLOSED** |
| **P11-H20** | Can a cell failure fabricate a fake `BacktestRunOutcome` or can pre-engine failure use an invalid union variant? | **NO.** Discriminated union enforces `MatrixCellCompletedResult` (`outcome: BacktestRunResult`, `failure: null`) vs `MatrixCellFailedResult` (`failure: MatrixCellFailure`). Pre-engine failures record `outcome: null` and `runId: null`, strictly forbidding fabricated Phase 9 outcomes. | **CLOSED** |
| **P11-H21** | Can cache validation hash the full outcome including `resultSha256` or reuse failed backtests? | **NO.** Validation extracts `{ resultSha256, ...phase9HashPayload }` and verifies `sha256CanonicalJson(phase9HashPayload) === resultSha256`. Full-outcome self-hashing is prohibited. Failed outcomes are never reusable cache hits. | **CLOSED** |
| **P11-H22** | Can wall-clock duration or worker timing jitter affect canonical research evidence? | **NO.** All durations (`durationMs`), `Date.now()`, `performance.now()`, and process metadata are strictly removed from `StrategyCoinMatrixCellResult`, `StrategyCoinMatrixPlanResult`, and `matrixResultSha256`. | **CLOSED** |
| **P11-H23** | Can production entry points bypass real Git source verification using test seams? | **NO.** Public production entry points strictly require the real Git source verifier. Internal test seam is not exported from the public barrel. Tests run against isolated temporary Git repositories. | **CLOSED** |

---

## 15. Required Implementation Evidence Matrix

Implementation of Phase 11 must provide exhaustive test suites proving compliance across the following verified areas:

| Evidence ID | Requirement / Invariant | Verification Procedure |
| :--- | :--- | :--- |
| **P11-I01** | Deterministic candidate-space normalization | Define dimensions in reverse/shuffled order; assert normalized candidate space is bit-for-bit identical. |
| **P11-I02** | Phase 10 parameter validation authority | Pass invalid parameters (e.g. `fastPeriod >= slowPeriod`, inverted RSI bounds); assert execution fails closed via Phase 10 error without secondary validator. |
| **P11-I03** | Dataset, window & versioned bootstrap policy binding | Provide dataset missing required warmup or analysis window $\implies$ fails closed with `DATASET_COVERAGE_GAP`. Prove EMA, ATR, RSI are accepted by `P11_INDICATOR_BOOTSTRAP_V1` and yield deterministic bootstrap origins. |
| **P11-I04** | Deterministic `matrixPlanId` & verified Git source binding | Construct two identical plans with different key orders $\implies$ identical `matrixPlanId`. Prove full commit OID is auto-captured; dirty tracked file, staged file, or untracked non-ignored file fails closed (`MATRIX_SOURCE_DIRTY`); commit mismatch on prebuilt plan fails closed (`MATRIX_SOURCE_COMMIT_MISMATCH`); different clean commit OID produces different `matrixPlanId`. |
| **P11-I05** | Deterministic cell expansion & ordering | Generate cells from multi-coin multi-strategy grid; assert cells strictly follow canonical total ordering (`pair` $\to$ `strategyId` $\to$ `version` $\to$ `paramHash` $\to$ `strategyInstanceId` $\to$ `expectedRunId`). |
| **P11-I06** | Authoritative Phase 9 `runId` construction path & sensitivity | Bind exact `MatrixBacktestExecutionConfig` and real pair resource identities (`MatrixPairCatalogEntry`, `fundingScheduleBinding`). Derive `configuredTimeframes` from real Phase 10 kernel indicator requirements (distinct $TF > 1$, sorted ascending, 1 excluded). Invoke actual Phase 9 `normalizeBacktestInputs` and `sha256CanonicalJson` (zero parallel hash code); assert executed `cellResult.runId` exactly equals `cell.expectedRunId` and `cell.expectedRunId === sha256CanonicalJson(normalized.manifest)`. Prove sensitivity: independently varying dataset manifest, strategy participant identity, `fixedResearchQuantity`, `gitCommitHash`, pair funding schedule, or backtest execution config changes Phase 9 `runId`. |
| **P11-I07** | BTC + ETH × 4 strategies generic matrix | Execute a multi-cell test across BTC and ETH with all 4 Phase 10 strategies without any coin-specific code paths. |
| **P11-I08** | Invalid / duplicate candidate & unsupported bootstrap policy fail-closed | Provide duplicate candidates (e.g. `"2.0"` and `"2.00"`) $\implies$ throws `DUPLICATE_PARAMETER_CANDIDATE`. Pass strategy requiring SMA, MACD, Bollinger, or SuperTrend $\implies$ fails closed before plan finalization or execution with `MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY`. Prove policy version increment changes `matrixPlanId`. |
| **P11-I09** | Discriminated cell results, non-disappearing cells & partial/failure semantics | Final cell result is a strict discriminated union (`MatrixCellCompletedResult` vs `MatrixCellFailedResult`). For pre-engine failures (validation, coverage gap, resource mismatch), assert `status: 'FAILED'`, `outcome: null`, `runId: null` (or null outcome), and non-null `failure: MatrixCellFailure`, with zero fabricated `BacktestRunOutcome`. For Phase 9 engine failures, assert `outcome: BacktestFailedRunResult` preserves genuine `BacktestErrorCode`. Assert failed cells never disappear (`cellResults.length === plannedCells`). If at least 1 cell completes and 1 fails under valid source, matrix status is `PARTIAL`. If 0 cells complete, status is `FAILED`. If source changes mid-run, status is `FAILED` and pending cells become `FAILED` with `MATRIX_SOURCE_DIRTY` / `MATRIX_SOURCE_COMMIT_MISMATCH`. |
| **P11-I10** | Concurrency invariance & zero duration in canonical results | Execute identical 16-cell plan with 1 worker vs. 4 workers; assert `cellResults` sequence, `matrixResultSha256`, and canonical result JSON are bit-for-bit identical independent of worker completion timing. Assert zero wall-clock duration (`durationMs`), timestamps, or process metadata exist in canonical cell results, plan results, or `matrixResultSha256` payload. |
| **P11-I11** | No-lookahead / predeclared space | Assert candidate grid generation completes before any backtest execution begins; zero feedback loops from results to candidates. |
| **P11-I12** | Fixed research quantity propagation | Execute identical strategy parameters with two different `fixedResearchQuantity` values; assert pure strategy `parameterHash` is unchanged while Phase 9 `runId` and `matrixCellId` differ. |
| **P11-I13** | Genuine Phase 9 + Phase 10 execution, runtime resource validation & execution source integrity | Verify cell execution calls genuine `BacktestEngine` and `StrategyKernel` via `StrategyBacktestParticipantAdapter`. Assert runtime resource identity mismatch (`datasetManifest`, `instrumentSpec`, `fundingSchedule`) fails closed before execution. Verify clean source state is asserted before first cell, throughout execution, and before declaring `COMPLETED`. If source tree is dirtied mid-run, execution fails closed, all pending cells fail, and matrix status is `FAILED`. |
| **P11-I14** | Input-side defensive immutability & result immutability | Construct plan/cells using caller-owned mutable input objects/arrays; mutate caller inputs aggressively post-construction; assert frozen plan, `matrixPlanId`, cell list, `matrixCellIds`, parameter hashes, `strategyInstanceIds`, and `runIds` are completely unchanged. Assert emitted plan/cell/result objects are deeply frozen against external mutation. |
| **P11-I15** | Phase 9 completed-result cache integrity | Accept genuine completed `BacktestRunResult` from cache when `runId` matches `cell.expectedRunId`, `matrixCellId` matches `cell.matrixCellId`, and `sha256CanonicalJson(outcome without resultSha256) === outcome.resultSha256`. Assert modifying any hashed Phase 9 outcome field invalidates cache check and forces fresh execution. Assert that hashing full outcome including `resultSha256` is explicitly NOT the validation algorithm. Assert that failed outcomes (`status: 'FAILED'`) are never reusable as Phase 11 v1 cache hits. Corrupt cache entries fail closed and never produce `COMPLETED` evidence. |
