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
│   - Source check: Verify clean HEAD prior to declaring matrix COMPLETED         │
│   - Fail-closed matrix completion: Failed cells NEVER silently vanish           │
│   - Discrete execution status: PLANNED, RUNNING, COMPLETED, PARTIAL, FAILED     │
│   - Read-only research evidence ledger: Zero production state mutation          │
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

### 6.2 Authoritative Phase 9 Manifest & RunId Construction Path (P11-SPEC-02)
Phase 11 **MUST NOT** implement a duplicate canonical JSON serializer, a parallel manifest serializer, or a custom `runId` hashing function.
- Phase 11 directly imports and invokes the actual Phase 9 production manifest builder:
  ```typescript
  import { normalizeBacktestInputs } from '../backtest/manifest';
  import { sha256CanonicalJson } from '../backtest/canonical-json';
  ```
- For every cell, the expected Phase 9 execution parameters are passed to `normalizeBacktestInputs(...)`, which returns:
  $$\{ \text{manifest}: \text{BacktestRunManifest}, \text{runId}: \text{string}, \dots \}$$
- The returned `runId` is the **authoritative `expectedRunId`** assigned to `cell.expectedRunId`.
- When the cell executes via `BacktestEngine.run()`, the resulting `cellResult.runId` must strictly equal `cell.expectedRunId`. A mismatch fails closed immediately (`RUN_ID_MISMATCH`).

### 6.3 RunId Sensitivity & Identity Propagation
Phase 9 `runId` is sensitive to every behavior-altering backtest input. Altering any of the following parameters must deterministically produce a different `expectedRunId` and `matrixCellId`:
1. `datasetId` or `datasetContentSha256`
2. `bootstrapFromInclusiveMs`, `evaluationFromInclusiveMs`, `evaluationToExclusiveMs`, `replayToExclusiveMs`
3. `configuredTimeframes`
4. `instrumentSpecSnapshotId`
5. `costModel` (maker fee, taker fee, spread bps, slippage bps)
6. `fundingSchedule` (sourceId, contentSha256, fidelity)
7. `intrabarAmbiguityPolicy` (`ADVERSE_FIRST`)
8. `maxOpenOrders`
9. `engineSemanticVersion`
10. `initialEquity`
11. `participant.parameterHash` (which binds `strategyInstanceId` and `fixedResearchQuantity`)
12. `participant.gitCommitHash` (which binds the verified clean source commit)

Phase 11 enforces that all sensitivity changes propagate directly through the Phase 9 production code path.

### 6.4 Fixed Research Quantity Binding
Phase 10 adapter requires `fixedResearchQuantity`.
In Phase 11:
- `fixedResearchQuantity` must be explicitly declared per pair in the matrix plan (e.g., `0.01` for `BTC-INR`, `0.1` for `ETH-INR`).
- Default values or implicit fallbacks are barred.
- As proven in Phase 10 (P10-SPEC-06), altering `fixedResearchQuantity`:
  - **Does NOT** alter the pure strategy's `parameterHash` or `strategyInstanceId`.
  - **DOES** alter Phase 9's `participant.parameterHash` and Phase 9 `runId`.
- Phase 11 matrix cell identity cryptographically binds Phase 9 `runId`, ensuring complete lineage transparency.

### 6.5 Cross-Coin Comparison Safety Warning
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

### 8.3 Deterministic Matrix Plan ID (`matrixPlanId`)
$$\text{matrixPlanId} = \text{SHA-256}\left(\text{CanonicalJson}(\text{StrategyCoinMatrixPlan})\right)$$

**Canonicalization Rules:**
1. UTF-8 encoding without BOM.
2. Object keys sorted lexicographically (ASCII byte order) recursively at all depths.
3. `pairs` array sorted strictly ascending by `pair` name.
4. `strategies` array sorted strictly ascending by `strategyId`, then `strategyVersion`.
5. Candidate dimensions within each strategy sorted lexicographically by dimension key, and dimension values sorted per Section 3.3.
6. Decimals serialized as canonical normalized strings (`"0.01"`, `"1.5"`).
7. Zero wall-clock timestamps (`Date.now()`), zero runtime durations, zero hostnames, and zero process IDs in the hash payload.

Any change to the pair catalog, dataset hash, analysis window, strategy candidate spaces, execution parameters, bootstrap policy ID, or repository git commit alters `matrixPlanId`.

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

### 10.1 Cell Execution Lifecycle
Each research cell progresses through explicit, deterministic lifecycle states:

```
[ PLANNED ] ──► [ RUNNING ] ──► [ COMPLETED ] (Valid Phase 9 BacktestRunResult)
                     │
                     └──► [ FAILED ] (Structured Error, Coverage Gap, or Engine Failure)
```

```typescript
export type MatrixCellStatus = 'PLANNED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface StrategyCoinMatrixCellResult {
  readonly matrixCellId: string;
  readonly cellSequence: number;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly datasetId: string;
  readonly runId: string;
  readonly status: MatrixCellStatus;
  readonly outcome: BacktestRunOutcome;
  readonly executionMetrics?: {
    readonly durationMs: number;
  };
}
```

### 10.2 Overall Matrix Plan Status
```typescript
export type MatrixPlanStatus = 'PLANNED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

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

### 10.3 The Fail-Closed Non-Disappearing Cell Invariant (Critical Audit Law)
> **Core Architectural Law:** A failed, rejected, or missing cell MUST NEVER silently disappear from the matrix result. If any cell fails, the overall matrix status MUST NOT report `COMPLETED` (it must report `PARTIAL` or `FAILED`).

- If $N$ cells were planned, `cellResults.length` **MUST ALWAYS equal $N$**.
- If cell #4 encounters a dataset gap or backtest engine failure:
  - Its status is recorded as `FAILED`.
  - Its structured error code and diagnostic trace are recorded in `outcome`.
  - The matrix overall status becomes `PARTIAL` (if some completed) or `FAILED` (if zero completed).
- Dropping failed cells to report a false 100% completion rate is strictly barred.

### 10.4 Result Cryptographic Hash (`matrixResultSha256`)
$$\text{matrixResultSha256} = \text{SHA-256}\left(\text{CanonicalJson}(\text{MatrixResultSummaryPayload})\right)$$

The payload covers:
- `matrixPlanId`
- `status`
- `totalCells`, `completedCells`, `failedCells`
- Array of canonical cell result digests: `[ { matrixCellId, runId, status, resultSha256: outcome.resultSha256 ?? null } ]` sorted strictly by `cellSequence`.
- Excludes execution duration, timestamps, and host information.

---

## 11. Concurrency Determinism & Cache Boundary

### 11.1 Concurrency Determinism
Phase 11 supports parallel worker execution (e.g., worker pools, cluster nodes):
- **Cell Isolation:** Each research cell is completely stateless and decoupled from all other cells. No shared mutable memory or inter-cell message passing exists during execution.
- **Completion Invariance:** Worker completion order (e.g. cell #8 completing before cell #1) has **zero impact** on the final result payload.
- Upon completion of all executions, results are sorted strictly by `cellSequence` before computing `matrixResultSha256`.
- Running a plan with 1 worker vs. 8 workers vs. 64 workers yields **bit-for-bit identical `matrixResultSha256` and identical JSON result output**.

### 11.2 Strict Resume & Cache Boundary
To accelerate research iteration, Phase 11 may inspect existing cell result archives:
1. **Verification Before Reuse:** A cached cell result cannot be trusted based on `matrixCellId` alone.
2. **Mandatory Integrity Validation:** The cache layer must verify:
   $$\text{cachedResult.runId} === \text{cell.expectedRunId}$$
   $$\text{SHA-256}(\text{CanonicalJson}(\text{cachedResult.outcome})) === \text{cachedResult.outcome.resultSha256}$$
3. If any checksum, git commit, or parameter mismatch occurs, the cache is invalidated and the cell re-executes.
4. Mismatched or corrupted cache entries fail closed.

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
  | 'MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY';

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
| **P11-I06** | Authoritative Phase 9 `runId` construction path & sensitivity | Expected `runId` is computed by calling actual Phase 9 `normalizeBacktestInputs` and `sha256CanonicalJson` (zero parallel hash code); assert executed `cellResult.runId` exactly equals `cell.expectedRunId`. Prove sensitivity: independently varying dataset manifest, strategy participant identity, `fixedResearchQuantity`, `gitCommitHash`, or backtest execution config changes Phase 9 `runId`. |
| **P11-I07** | BTC + ETH × 4 strategies generic matrix | Execute a multi-cell test across BTC and ETH with all 4 Phase 10 strategies without any coin-specific code paths. |
| **P11-I08** | Invalid / duplicate candidate & unsupported bootstrap policy fail-closed | Provide duplicate candidates (e.g. `"2.0"` and `"2.00"`) $\implies$ throws `DUPLICATE_PARAMETER_CANDIDATE`. Pass strategy requiring SMA, MACD, Bollinger, or SuperTrend $\implies$ fails closed before plan finalization or execution with `MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY`. Prove policy version increment changes `matrixPlanId`. |
| **P11-I09** | Failed cell cannot disappear / partial semantics | Simulate one cell failing during backtest; assert matrix contains all planned cells, status is `PARTIAL`, and `isValid` is handled accurately without cell loss. |
| **P11-I10** | Concurrency invariance | Execute identical 16-cell plan with 1 worker vs. 4 workers; assert `cellResults` sequence and `matrixResultSha256` are identical. |
| **P11-I11** | No-lookahead / predeclared space | Assert candidate grid generation completes before any backtest execution begins; zero feedback loops from results to candidates. |
| **P11-I12** | Fixed research quantity propagation | Execute identical strategy parameters with two different `fixedResearchQuantity` values; assert pure strategy `parameterHash` is unchanged while Phase 9 `runId` and `matrixCellId` differ. |
| **P11-I13** | Genuine Phase 9 + Phase 10 execution & execution source integrity | Verify cell execution calls genuine `BacktestEngine` and `StrategyKernel`. Verify clean source state is asserted before first cell and before declaring `COMPLETED`. If source tree is dirtied mid-run, execution fails closed and never reports `COMPLETED`. |
| **P11-I14** | Input-side defensive immutability & result immutability | Construct plan/cells using caller-owned mutable input objects/arrays; mutate caller inputs aggressively post-construction; assert frozen plan, `matrixPlanId`, cell list, `matrixCellIds`, parameter hashes, `strategyInstanceIds`, and `runIds` are completely unchanged. Assert emitted plan/cell/result objects are deeply frozen against external mutation. |
