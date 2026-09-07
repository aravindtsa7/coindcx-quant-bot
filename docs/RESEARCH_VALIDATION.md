# Research Validation Lab — Phase 12 Architecture & Specification

## 1. Executive Summary & Scope Boundary

Phase 12 defines the **Research Validation Lab** for the **CoinDCX Quant Futures Bot**. It is the authoritative statistical validation subsystem responsible for determining whether quantitative hypothesis candidates explored by Phase 11 (Strategy × Coin Matrix) demonstrate genuine statistical robustness, resistance to overfitting, and temporal stability sufficient for research approval.

Phase 12 answers one fundamental question:
> **For a given frozen research candidate (pair $\times$ strategy $\times$ parameters) evaluated across chronological walk-forward folds, cost stress scenarios, and Monte Carlo permutations:**
> *Does the empirical evidence satisfy frozen statistical robustness gates, or is the observed performance an artifact of data mining, sample selection bias, execution cost fragility, or path luck?*

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│              PHASE 11: DETERMINISTIC STRATEGY × COIN MATRIX ENGINE              │
│                                                                                 │
│   - Predeclared finite parameter candidate grids (zero adaptive lookahead)      │
│   - Cartesian cell expansion & cryptographic cell identities (matrixCellId)     │
│   - Authoritative Phase 9 backtest execution via Phase 10 strategy kernels       │
│   - Raw research evidence ledger: BacktestRunResult per completed cell          │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Frozen Candidates & Real Execution Path
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                   PHASE 12: RESEARCH VALIDATION LAB ARCHITECTURE                │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │ 1. Canonical Validation Plan & Cross-Fold Subject Identity              │   │
│   │    - validationPlanId binds pairBindings, folds, holdout, gates         │   │
│   │    - validationSubjectId = SHA-256(pair, strategyId, version, paramHash)│   │
│   │    - holdoutExposureDeclaration: UNSEEN_BY_OPERATOR | PREVIOUSLY_OBSERVED│   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │                                        │
│   ┌────────────────────────────────────▼────────────────────────────────────┐   │
│   │ 2. Chronological Walk-Forward & Final Holdout Orchestration             │   │
│   │    - P12_WALK_FORWARD_V1: trainDays, testDays, stepDays === testDays    │   │
│   │    - Exact K complete folds (OOS_end(k) <= holdoutStartMs); unused tail │   │
│   │    - Non-overlapping OOS test windows; zero random row splitting        │   │
│   │    - Final holdout executed strictly after all WF development folds     │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ Execution Seam (eventSinkFactory)      │
│   ┌────────────────────────────────────▼────────────────────────────────────┐   │
│   │ 3. Streaming Event Evidence Collector (Bound to Phase 9 Execution)      │   │
│   │    - Structurally cache-free Phase 11 execution dependencies            │   │
│   │    - Independently hashes EVERY event via updateCanonicalEventHash      │   │
│   │    - Verifies observedEventLedgerSha256 === outcome.eventLedgerSha256   │   │
│   │    - Samples baselineEquity at analysisStartMs after same-timestamp flush│  │
│   │    - Metric interval: analysisStartMs < T <= analysisEndExclusiveMs     │   │
│   │    - Minute-close equity path + same-timestamp funding settlement       │   │
│   │    - N+1 UTC boundary equities generating N daily net returns           │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ Canonical Evidence Streams             │
│   ┌────────────────────────────────────▼────────────────────────────────────┐   │
│   │ 4. Deterministic Statistical & Robustness Engines                       │   │
│   │    - Isolated 128-digit Decimal financial metrics (Sharpe, Sortino, DD) │   │
│   │    - Multi-Scenario Real Phase 9 Cost Stress (Baseline/Moderate/Severe) │   │
│   │    - P12_MONTE_CARLO_PERMUTATION_V1 (HMAC-SHA256 PRNG, Fisher-Yates)    │   │
│   │    - P12_DEFLATED_SHARPE_Z_V1 (DSR Z-score on aggregate OOS returns)   │   │
│   │    - Generic parameter neighborhood sensitivity                         │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ Evaluated Gates                        │
│   ┌────────────────────────────────────▼────────────────────────────────────┐   │
│   │ 5. Approval Policy Gate Evaluator & Lineage Finalization                │   │
│   │    - Evaluates ResearchValidationPolicy gates (zero hidden defaults)    │   │
│   │    - Exact verdict precedence: FAILED > INSUFFICIENT_EVIDENCE > PASSED  │   │
│   │    - Canonical JSON digest: validationResultSha256                      │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Canonical Auditable Validation Evidence
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          DOWNSTREAM DISCIPLINES & BOUNDARIES                    │
│                                                                                 │
│   Phase 13: Risk & Leverage Engine (Position sizing, dynamic leverage brackets) │
│   Phase 14: Real-time Paper Trading Simulator                                   │
│   Phase 15: Strategy Ranking, Composite Scoring & Promotion (OWNS RANKING)      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Strict Separation of Concerns: Non-Goals & Anti-Scope
Phase 12 is strictly a **Statistical Robustness & Validation** layer. To preserve clean architecture and prevent conflating validation with selection or live trading:
- **Phase 12 Explicitly DOES NOT Own (Strict Anti-Scope):**
  - **No Candidate Ranking or Leaderboards:** Phase 12 does not sort candidates from best to worst, assign relative performance ranks, or compute composite scores across candidates. **Phase 15 owns strategy ranking.**
  - **No Winner Selection:** Phase 12 never designates a single "best candidate", "winning parameter", or "top strategy".
  - **No Parameter Auto-Tuning or Optimization Loops:** Phase 12 never adjusts parameters based on validation outcomes, runs hill-climbing algorithms, or performs adaptive parameter refinement.
  - **No Candidate Space Mutation:** Phase 12 never generates new candidate parameter sets or mutates the hypothesis space.
  - **No Dynamic Position Sizing or Leverage:** Phase 12 executes solely with fixed research quantities. Dynamic capital allocation, margin tiers, and leverage limits belong exclusively to **Phase 13 (Risk & Leverage Engine)**.
  - **No Paper or Live Trading Promotion:** Passing Phase 12 validation renders a candidate eligible for research consideration; it does not automatically deploy the candidate to paper trading (Phase 14) or live execution (Phase 17).
  - **No Modification of Strategy Signal Semantics:** Phase 12 evaluates pure Phase 10 strategy kernels as frozen black-box signal generators.
  - **No Production State Mutation:** Phase 12 outputs are immutable read-only records. Generating validation results never alters the Coin Registry, Strategy Registry, runtime supervisor state, or active bot configurations.

---

## 2. Phase 11 & Phase 9 Integration Contract: Bridging the Evidence Gap

### 2.1 The Evidence Gap in Completed Phase 11 Results
Phase 11's canonical terminal cell result (`MatrixCellCompletedResult`) stores the authoritative Phase 9 `BacktestRunResult`. While `BacktestRunResult` includes high-level scalar summaries:
- `financialSummary` (`initialEquity`, `finalEquity`, `netPnl`, `realizedGrossPnl`, `totalFees`, `fundingPnl`, etc.)
- `totalFills`, `totalClosedTrades`
- `terminalPosition`, `terminalOpenOrders`
- `eventLedgerSha256`, `resultSha256`

It **does not** retain the time-series equity trajectory, UTC daily return series, closed trade sequences, or drawdowns required for rigorous statistical validation (Sharpe ratio, Sortino ratio, minute-close drawdown path, daily net returns, Deflated Sharpe Ratio, and Monte Carlo path permutation).

### 2.2 Single Source of Truth: Absolute Prohibition of Secondary Simulators
To satisfy Invariant 17 (Uniform Strategy Implementation), Invariant 23 (Deterministic Backtesting), and Invariant 25 (Deterministic Matrix Research):
> **Core Architectural Law:** Phase 12 MUST NOT construct a secondary backtest simulator, implement vectorized Python/Pandas approximations, or reconstruct simulated equity paths from raw OHLCV candles independently.
> Every validation observation MUST originate from the **exact same Phase 9 `BacktestEngine` and Phase 10 `StrategyKernel` execution path** executed during Phase 11 matrix research.

### 2.3 The Narrow Phase 11 Integration Seam (`eventSinkFactory`)
To enable Phase 12 to stream granular event evidence without duplicating execution or altering Phase 11 identities, Phase 11 exposes an execution-only observer seam in `MatrixExecutionOptions`:
```typescript
export interface MatrixExecutionOptions {
  readonly workerCount?: number;
  readonly verificationPageMinutes?: number;
  /**
   * Optional execution-only event sink factory.
   * When supplied, executeCell passes the created sink to BacktestEngine.
   * Default: () => new InMemoryBacktestSink()
   */
  readonly eventSinkFactory?: (cell: StrategyCoinMatrixCell) => BacktestEventSink;
}
```

#### Invariance Guarantees of the Seam:
1. **Zero Impact on `matrixPlanId`:** The presence, absence, or configuration of `eventSinkFactory` is an execution option and is **NOT** part of `StrategyCoinMatrixPlan`. `matrixPlanId` remains bit-for-bit identical.
2. **Zero Impact on `matrixCellId`:** `matrixCellId` is computed over `StrategyCoinMatrixCellIdentityPayload`, which does not include the sink.
3. **Zero Impact on `expectedRunId`:** Phase 9 `normalizeBacktestInputs` computes `runId` from `BacktestRunManifest`, which does not bind the event sink.
4. **Zero Impact on `resultSha256`:** Phase 9 `BacktestRunResult.resultSha256` is computed over `BacktestResultHashPayload`, which is strictly identical regardless of sink destination.
5. **Zero Impact on `eventLedgerSha256`:** Phase 9 `BacktestEventLedger` computes `eventLedgerSha256` over the canonical event stream independently of whether the attached sink writes to memory, disk, or Phase 12's collector.
6. **Preservation of Fail-Closed Sink Semantics:** If Phase 12's streaming sink throws or rejects during `sink.write(event)`, Phase 9's `BacktestEventLedger` catches the exception and immediately throws `BacktestError('BACKTEST_RUN_FAILED', 'Backtest event sink failed')`. The cell fails closed immediately (`status: 'FAILED'`).
7. **No Unsafe Execution Bypass:** The seam does not expose internal simulator state for manipulation; it is strictly a read-only push listener.

### 2.4 Fresh Execution Cache Policy (PHASE12-SPEC-02, H1 Closed)
Because Phase 11's completed-result cache (`MatrixCompletedResultCache`) returns a cached `BacktestRunResult` that lacks granular time-series events, Phase 12 V1 structurally guarantees fresh Phase 9 execution:
1. **Dependency Boundary:** The public Phase 12 validation API **does not accept** a `MatrixCompletedResultCache`. It accepts only:
   ```typescript
   export interface ValidationExecutionDependencies {
     readonly registry: StrategyRegistry;
     readonly pairResources: readonly MatrixPairExecutionResources[];
   }
   ```
2. **Structural Cache Omission:** When Phase 12 invokes Phase 11 execution routines (`executeStrategyCoinMatrix`), it constructs a fresh `MatrixExecutionDependencies` object:
   ```typescript
   const matrixDependencies: MatrixExecutionDependencies = {
     registry: dependencies.registry,
     pairResources: dependencies.pairResources,
     // cache property is strictly omitted (undefined)
   };
   ```
   Because `cache` is omitted, Phase 11's internal check `dependencies.cache?.get(...)` evaluates to undefined and cannot produce a cache hit.
3. **Collector Verification Invariant:** For every planned cell that returns `status: 'COMPLETED'` during a Phase 12 validation run, Phase 12 **MUST** verify that an authoritative, finalized `ValidationEvidenceCollector` exists for that cell. If `cell.status === 'COMPLETED'` but verified event evidence is missing or unfinalized, the evaluation fails closed immediately with `EVIDENCE_INTEGRITY_FAILURE`. No subject may receive a verdict of `PASSED` without genuine event evidence.
4. **Future Persisted Evidence Cache:** Out of scope for V1. Any future evidence cache must be content-addressed and cryptographically bound to `runId`, `resultSha256`, and `eventLedgerSha256`.

### 2.5 Matrix Construction from Canonical Pair Bindings & Runtime Resource Cross-Check
To ensure bit-for-bit reproducible backtest execution and avoid missing parameter contracts, Phase 12 directly reuses Phase 11's production pair catalog structure:
```typescript
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
```

1. **Full Pair Execution Binding:** Phase 12 canonical plans store `readonly pairBindings: readonly MatrixPairCatalogEntry[]`. This binds dataset identity (`datasetId`, `datasetContentSha256`), nominal research quantity (`fixedResearchQuantity`), instrument specification snapshot (`instrumentSpecSnapshotId`), and funding schedule binding (`sourceId`, `contentSha256`, `fidelity`).
2. **Phase 11 Matrix Plan Construction:** For every generated Phase 11 matrix execution (IS fold, OOS fold, BASELINE, cost-stress scenarios, and final holdout), the matrix plan input `StrategyCoinMatrixPlanInput.pairs` is passed directly and immutably from `validationPlan.pairBindings`:
   - No reconstruction from caller-owned mutable data.
   - `fixedResearchQuantity` remains invariant across all folds and stress scenarios.
   - Instrument spec snapshot remains invariant across all folds and stress scenarios.
   - Funding schedule binding remains invariant across all folds and stress scenarios.
   - The only per-execution differences are `researchWindow` (temporal bounds for IS, OOS, or holdout), `costModel` (for explicit stress scenarios), matrix plan name, and execution-only options (`verificationPageMinutes`, `workerCount`).
3. **Runtime Resource Cross-Check (`assertPairResourceIdentity`):** Before executing any matrix cell, Phase 12 cross-checks each canonical `pairBinding` against `dependencies.pairResources` (`MatrixPairExecutionResources[]`):
   - For each pair in `pairBindings`, exactly one matching runtime resource must be present.
   - Phase 12 invokes Phase 11's authoritative `assertPairResourceIdentity(pairBinding, resource)`, asserting bit-for-bit equality of `datasetId`, `datasetContentSha256`, `instrumentSpecSnapshotId`, funding `sourceId`, `contentSha256`, and `fidelity`.
   - Missing, duplicate, foreign, or mismatched pair resources fail closed immediately with `RESOURCE_IDENTITY_MISMATCH` (or `VALIDATION_PLAN_INVALID` if detected at plan time).
   - `fixedResearchQuantity` is NOT extracted from runtime resources because `MatrixPairExecutionResources` does not own that field; the canonical `pairBinding` owns `fixedResearchQuantity`.
4. **Fixed Research Quantity Authority:** `fixedResearchQuantity` is validated exclusively via Phase 11 / Phase 10 adapter authority (`normalizeFixedResearchQuantity`). Phase 12 does NOT normalize it with a new formula, scale it per fold, risk-adjust it, equity-adjust it, or coin-normalize it. Phase 13 owns dynamic position sizing.
5. **Funding & Instrument Lineage:** Every fold/stress/holdout evidence record traces directly to the Phase 11 matrix cell whose `runId` already cryptographically binds the genuine Phase 9 manifest and resources. Phase 12 never creates a separate instrument or funding identity formula.

---

## 3. Deterministic Validation Plan & Plan Identity (`validationPlanId`)

### 3.1 Input-Side Immutability & Safe Plan Construction
All caller-provided configuration objects, candidate spaces, threshold sets, temporal boundaries, and operator attestations are defensively deep-copied and deep-frozen upon ingestion. Subsequent mutations to caller memory have zero effect on validation plan contents, execution, or identities.

#### Public Plan Input vs. Finalized Plan Split:
To prevent callers from injecting unverified Git identities or contradictory pair universes, Phase 12 enforces a strict construction split analogous to Phase 11:
- **`ResearchValidationPlanInput` (Public Caller Input):** Accepts caller-controlled research parameters, strategy candidate spaces, `pairBindings`, temporal windows, walk-forward config, holdout config, metric policies, and approval thresholds. It **DOES NOT** accept `schemaVersion`, `sourceIdentity`, `validationPlanId`, or derived `pairUniverse`.
- **`ResearchValidationPlan` (Finalized Canonical Plan):** Contains the immutable canonical plan, including `schemaVersion: 1`, authoritative `sourceIdentity.gitCommitHash`, derived `pairUniverse`, and full `pairBindings`.

#### Plan Construction Flow:
1. **Defensive Ingestion:** Deep-copies and freezes all caller inputs (`matrixDeepCopyFreeze`).
2. **Pair Binding Normalization & Validation:**
   - `pairBindings` must be non-empty.
   - Pair names must be unique and valid string identifiers.
   - `datasetBinding.pair === entry.pair`.
   - Valid SHA-256 for dataset, instrument, and funding schedule content.
   - Valid `fixedResearchQuantity` normalized via Phase 10 `normalizeFixedResearchQuantity`.
   - Lexicographically sorted by `pair` ascending (`ascii(left.pair, right.pair)`).
   - Any duplicate, format mismatch, or invalid identifier throws `VALIDATION_PLAN_INVALID`.
3. **Derived Pair Universe:**
   `pairUniverse` is canonically derived as the projection `pairBindings.map(b => b.pair)`. The public caller cannot supply an independent or conflicting `pairUniverse`.
4. **Authoritative Git Source Verification:**
   Captures clean Git commit hash ONCE using the existing Phase 11 `ProductionGitSourceVerifier` (`git rev-parse HEAD` and `git status --porcelain=v1 --untracked-files=all` must be empty). Public callers cannot inject fake or unverified `sourceIdentity`. (For testing, an internal verifier seam accepts `GitSourceVerifier`).
5. **Finalized Plan Assembly:**
   Constructs `ResearchValidationPlan` with `schemaVersion: 1`, verified `sourceIdentity.gitCommitHash`, derived `pairUniverse`, and normalized `pairBindings`.
6. **Canonical Plan ID Computation:**
   Computes `validationPlanId = sha256CanonicalJson(finalized canonical plan)`.

### 3.2 Canonical Validation Plan Schema (`ResearchValidationPlan`)
```typescript
export interface ValidationWalkForwardConfig {
  readonly policyId: 'P12_WALK_FORWARD_V1';
  readonly trainDays: number;     // Safe integer >= 1
  readonly testDays: number;      // Safe integer >= 1
  readonly stepDays: number;      // Safe integer >= 1 (strictly equal to testDays in V1)
  readonly embargoDays: number;   // Safe integer >= 0
}

export type HoldoutExposureDeclaration =
  | 'UNSEEN_BY_OPERATOR'
  | 'PREVIOUSLY_OBSERVED';

export interface ValidationHoldoutConfig {
  readonly holdoutStartMs: number;         // Safe integer, UTC day-aligned
  readonly holdoutEndExclusiveMs: number;  // Safe integer, UTC day-aligned
  readonly exposureDeclaration: HoldoutExposureDeclaration;
}

export interface ValidationMetricPolicyConfig {
  readonly policyId: 'P12_METRIC_POLICY_V1';
  readonly annualRiskFreeRate: string;     // Canonical decimal string, e.g. "0.00"
  readonly annualSortinoTargetRate: string;// Canonical decimal string, e.g. "0.00"
  readonly annualizationFactor: 365;       // Constant 365 for 24/7/365 crypto
  readonly minDailyObservations: number;   // Explicit safe integer threshold (e.g. 30)
  readonly minClosedTrades: number;        // Explicit safe integer threshold (e.g. 10)
  readonly sharpeDegradationDenominatorFloor: string; // Canonical decimal string > "0", e.g. "0.10"
}

export interface ValidationApprovalThresholds {
  readonly minOosClosedTrades: number;
  readonly minDailyObservations: number;
  readonly minOosSharpe: string;
  readonly minOosSortino: string;
  readonly maxOosDrawdownPercent: string;
  readonly minNetDailyProfitFactor: string;
  readonly minNetDailyExpectancy: string;
  readonly minOosFoldPassRatio: string;
  readonly maxIsToOosSharpeDegradation: string;
  readonly requireCostStressSurvival: boolean;
  readonly maxMonteCarloAdverseDrawdownPercent: string;
  readonly minDeflatedSharpeZ: string;     // Canonical decimal string, e.g. "1.645"
  readonly requireHoldoutPositiveReturn: boolean;
  readonly minHoldoutSharpe: string;
  readonly requireFreshHoldout: boolean;   // Requires exposureDeclaration === 'UNSEEN_BY_OPERATOR'
}

export interface ValidationCostStressConfig {
  readonly policyId: 'P12_COST_STRESS_V1';
  readonly scenarios: readonly {
    readonly scenarioId: string;           // Non-empty, unique stable identifier within the plan
    readonly costModel: {
      readonly makerFeeRate: string;
      readonly takerFeeRate: string;
      readonly halfSpreadBps: string;
      readonly marketSlippageBps: string;
      readonly stopSlippageBps: string;
    };
  }[];
}

export interface ValidationMonteCarloConfig {
  readonly policyId: 'P12_MONTE_CARLO_PERMUTATION_V1';
  readonly simulationCount: number;        // Safe integer >= 1, e.g. 1000
  readonly adversePercentile: number;      // Safe integer 1 <= adversePercentile <= 99, e.g. 95
  readonly seedDerivationPolicy: 'HMAC_SHA256_V1';
}

export interface ValidationOverfittingConfig {
  readonly policyId: 'P12_DEFLATED_SHARPE_Z_V1';
  readonly metric: 'DEFLATED_SHARPE_Z';
}

export interface ResearchValidationPlanInput {
  readonly planName: string;
  readonly validationPolicyVersion: 'P12_VALIDATION_POLICY_V1';
  readonly pairBindings: readonly MatrixPairCatalogEntry[];
  readonly strategies: readonly {
    readonly strategyId: string;
    readonly strategyVersion: string;
    readonly candidateSpace: StrategyParameterCandidateSpace;
  }[];
  readonly validationWindow: {
    readonly startMs: number;              // Safe integer, UTC day-aligned
    readonly endExclusiveMs: number;       // Safe integer, UTC day-aligned
  };
  readonly walkForward: ValidationWalkForwardConfig;
  readonly holdout: ValidationHoldoutConfig;
  readonly metricPolicy: ValidationMetricPolicyConfig;
  readonly thresholds: ValidationApprovalThresholds;
  readonly costStress: ValidationCostStressConfig;
  readonly monteCarlo: ValidationMonteCarloConfig;
  readonly overfitting: ValidationOverfittingConfig;
  readonly backtestBaseConfig: MatrixBacktestExecutionConfig;
  readonly parameterNeighborhoods?: readonly ParameterNeighborhoodMapping[];
}

export interface ResearchValidationPlan extends ResearchValidationPlanInput {
  readonly schemaVersion: 1;
  readonly sourceIdentity: {
    readonly gitCommitHash: string;        // Full 40-hex or 64-hex commit OID
  };
  readonly pairUniverse: readonly string[]; // Derived canonical projection: pairBindings.map(b => b.pair)
}
```

### 3.3 Deterministic Plan ID (`validationPlanId`)
$$\text{validationPlanId} = \text{SHA-256}\left(\text{CanonicalJson}(\text{ResearchValidationPlan})\right)$$

**Canonicalization Rules:**
1. Keys sorted lexicographically at all depths via `canonicalJson`.
2. Safe integer day-aligned timestamps.
3. Quantized canonical decimal strings for all financial thresholds and rates.
4. Includes `holdout.exposureDeclaration` and all explicit thresholds.
5. **Full Pair Execution Binding Coverage:** Binds the complete normalized `pairBindings` array. Changing ANY of:
   - `fixedResearchQuantity`
   - `instrumentSpecSnapshotId`
   - funding `sourceId`, `contentSha256`, or `fidelity`
   - `datasetId` or `datasetContentSha256`
   deterministically alters `validationPlanId`. No pair execution input required by Phase 11 may remain an unbound runtime-only choice.
6. **Strictly Excluded:** Wall-clock timestamps (`Date.now()`), execution durations, CPU architecture, hostnames, PIDs, temporary paths, and worker concurrency counts.
7. Any alteration to candidate spaces, pair bindings, date windows, walk-forward parameters, holdout boundaries, cost stress models, Monte Carlo settings, or approval thresholds generates a new, distinct `validationPlanId`.

---

## 4. Validation Subject Identity & Cross-Fold Lineage

### 4.1 The Cross-Fold Strategy Instance ID Problem
In Phase 10, a strategy instance identity (`strategyInstanceId`) is cryptographically bound to its `indicatorBootstrapIdentity`:
```typescript
export interface StrategyIndicatorBootstrapIdentityEntry {
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
}
```
In chronological walk-forward analysis, each fold $k$ evaluates over a different time window $[\text{analysisStartMs}_k, \text{analysisEndExclusiveMs}_k)$. Consequently, Phase 11 derives different indicator bootstrap origins for different folds.
> **Critical Architectural Law:** A fold-specific `strategyInstanceId` **MUST NOT** be used as the cross-fold candidate identity. Doing so would fragment the same logical candidate across folds, making cross-fold stability tracking impossible.

### 4.2 Research Validation Subject Identity (`validationSubjectId`)
Phase 12 defines an invariant, cross-fold research candidate identity:
```typescript
export interface ResearchValidationSubject {
  readonly validationSubjectId: string;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly normalizedParameters: Readonly<Record<string, unknown>>;
}
```

$$\text{validationSubjectId} = \text{SHA-256}\left(\text{CanonicalJson}(\{ \text{pair}, \text{strategyId}, \text{strategyVersion}, \text{parameterHash} \})\right)$$

### 4.3 Preserving Per-Fold Lineage
While `validationSubjectId` provides the invariant cross-fold subject identity, Phase 12 strictly retains full audit lineage for every fold execution under that subject:
- `validationFoldId`: unique fold identifier (e.g. `FOLD_00_IS`, `FOLD_00_OOS`, `HOLDOUT`).
- `strategyInstanceId`: genuine fold-specific Phase 10 instance ID.
- `matrixCellId`: genuine Phase 11 cell ID for that fold window.
- `expectedRunId` and Phase 9 `runId`.
- `resultSha256` and `eventLedgerSha256`.
- `validationEvidenceSha256`.

---

## 5. Temporal Validation: Walk-Forward V1 (`P12_WALK_FORWARD_V1`)

### 5.1 Chronological Validation Law (Zero Random Leakage)
> **Core Architectural Law:** Phase 12 V1 strictly enforces chronological time-series splitting. Random train/test row splitting, K-fold cross-validation with shuffled rows, and future-to-past evaluation are **strictly prohibited**. Financial time-series possess temporal autocorrelation and regime persistence; random splitting causes catastrophic lookahead leakage.

### 5.2 Exact Fold Generation Algebra & Tail Handling (PHASE12-SPEC-05, Q6 Closed)
In `P12_WALK_FORWARD_V1`:
- `stepDays === testDays` is strictly required, producing contiguous, non-overlapping Out-of-Sample (OOS) evaluation windows.
- No overlapping OOS windows, no partial folds.
- Let $DAY\_MS = 86\,400\,000$. For a zero-based fold index $k \ge 0$:
  $$\text{IS\_start}(k) = \text{validationWindow.startMs} + k \times \text{stepDays} \times DAY\_MS$$
  $$\text{IS\_end}(k) = \text{IS\_start}(k) + \text{trainDays} \times DAY\_MS$$
  $$\text{OOS\_start}(k) = \text{IS\_end}(k) + \text{embargoDays} \times DAY\_MS$$
  $$\text{OOS\_end}(k) = \text{OOS\_start}(k) + \text{testDays} \times DAY\_MS$$

#### Exact Calculation of Total Folds $K$:
Total fold count $K$ is the maximum non-negative integer such that the entire OOS window completes at or before `holdoutStartMs`:
$$K = \max \left\{ j \in \mathbb{Z}_{\ge 0} \mid \text{validationWindow.startMs} + (j - 1) \times \text{stepDays} \times DAY\_MS + (\text{trainDays} + \text{embargoDays} + \text{testDays}) \times DAY\_MS \le \text{holdout.holdoutStartMs} \right\}$$

- **Validation Requirement:** $K \ge 1$. If $K < 1$, plan finalization fails closed immediately with `VALIDATION_PLAN_INVALID` ("Walk-forward window cannot accommodate at least one complete fold before holdout").
- **Generated Fold Indices:** $k = 0, 1, \dots, K - 1$.
- **Tail Handling:**
  $$\text{unusedTailMs} = \text{holdout.holdoutStartMs} - \text{OOS\_end}(K - 1)$$
  Constraint: $0 \le \text{unusedTailMs} < \text{stepDays} \times DAY\_MS$.
  This trailing time gap is permitted, canonically disclosed in plan inspection and result metadata, strictly unused for walk-forward metrics, never converted into an incomplete/partial fold, and never annexed into the holdout.

```
Time Axis (UTC) ──────────────────────────────────────────────────────────────────────────────────────────►
Fold 0:  [  IS Window 0 (trainDays)  ] [Embargo] [ OOS 0 (testDays) ]
Fold 1:         [  IS Window 1 (trainDays)  ] [Embargo] [ OOS 1 (testDays) ]
...
Fold K-1:              [  IS Window K-1  ] [Embargo] [ OOS K-1 ]
                                                               [unusedTail] [ FINAL HOLDOUT WINDOW ]
```

### 5.3 Frozen Subject Evaluation across Folds
"TRAIN"/IS windows evaluate the **exact same frozen subjects** as OOS windows. Phase 12 **never selects** a fold-specific "winning candidate" from training data to test in OOS. All candidates are evaluated across all folds for cross-sectional and temporal stability.

### 5.4 Warmup Metric Segregation
For each fold, Phase 11 derives `bootstrapFromInclusiveMs <= evaluationFromInclusiveMs`:
- Warmup candles strictly feed Phase 8 indicator kernels.
- Pure strategy callbacks do not evaluate during warmup.
- **Zero Warmup Contamination:** Fills, mark-to-market observations, and account states prior to `evaluationFromInclusiveMs` are strictly quarantined and **never enter validation metrics or return series**.

---

## 6. Final Holdout Window Architecture & Freshness Attestation

### 6.1 Purpose & Temporal Isolation
The final holdout window is placed chronologically strictly **AFTER** all walk-forward folds:
$$\text{holdoutStartMs} \ge \text{OOS\_end}(K - 1)$$
$$\text{holdoutEndExclusiveMs} > \text{holdoutStartMs}$$

### 6.2 Operator Attestation vs. Methodological Freshness (PHASE12-SPEC-04, H5, Q7 Closed)
- **What Cryptographic Plan Identity Proves:** Hashing the holdout configuration into `validationPlanId` cryptographically guarantees that the holdout boundaries, dataset hashes, candidate spaces, and approval thresholds are immutable within that plan. Evidence from one plan cannot be silently relabeled as evidence for another.
- **What It Does NOT Prove:** Hashing does **not** prove that a human researcher has never previously inspected or tested the historical data in that holdout window under an earlier plan or ad-hoc experiment. Phase 12 V1 has no persistent global registry of human eyes; claiming a "cryptographic anti-reuse guarantee" for human non-exposure is methodologically false.
- **Explicit Plan-Bound Exposure Declaration:**
  Every validation plan must explicitly declare:
  ```typescript
  holdoutExposureDeclaration: 'UNSEEN_BY_OPERATOR' | 'PREVIOUSLY_OBSERVED'
  ```
- **Holdout Approval Gate Composition (GATE-13):**
  GATE-13 evaluates final holdout performance across three explicit subgates:
  1. **Holdout Sharpe Subgate (Always Active):**
     $$\text{holdoutSharpe} \ge \text{thresholds.minHoldoutSharpe}$$
  2. **Holdout Positive Return Subgate (Conditional):**
     - If `thresholds.requireHoldoutPositiveReturn === true`: Requires $\text{holdoutTotalNetReturn} > 0$.
     - If `thresholds.requireHoldoutPositiveReturn === false`: The positive-return requirement is `DISABLED` and does not affect the gate.
  3. **Holdout Freshness Subgate (Conditional):**
     - If `thresholds.requireFreshHoldout === true`: Requires `holdout.exposureDeclaration === 'UNSEEN_BY_OPERATOR'`. If `holdout.exposureDeclaration === 'PREVIOUSLY_OBSERVED'`, the freshness requirement is `UNAVAILABLE`, making GATE-13 `UNAVAILABLE` and contributing `INSUFFICIENT_EVIDENCE` to the subject verdict (unless another measurable gate definitively fails).
     - If `thresholds.requireFreshHoldout === false`: Declaring `PREVIOUSLY_OBSERVED` does NOT prevent GATE-13 from passing, but the canonical validation result explicitly discloses the attestation (`freshnessBasis: 'OPERATOR_ATTESTATION_V1'`).
- **Holdout Execution Sequencing:** All walk-forward IS/OOS executions and cost stress runs must complete before final holdout execution begins. No intermediate feedback loop may mutate candidate definitions before holdout evaluation.

---

## 7. Streaming Event Evidence Collector & Independent Ledger Proof

### 7.1 Architecture & Memory Policy
Phase 12 does not retain millions of raw `BacktestEvent` objects in memory. The collector processes streaming events in real time, updating running metrics and hashing the full stream.

### 7.2 Independent Observed Event Ledger Proof (PHASE12-SPEC-03, H2, Q2 Closed)
To prevent blindly trusting or copying Phase 9's reported `eventLedgerSha256`, the `ValidationEvidenceCollector` independently proves the authenticity of the event stream:
1. **Fresh Hash Instance:** The collector instantiates its own SHA-256 hash instance (`#observedHash`) upon construction.
2. **Exact Phase 9 Algorithm Reuse:** It imports and executes the actual Phase 9 production event hasher:
   ```typescript
   import { updateCanonicalEventHash } from '../../backtest/canonical-json';
   ```
3. **Strict Ingest Rules on Every Event:**
   - `event.runId === cell.expectedRunId`
   - Monotonic sequence verification: First event must have `sequence === 1`; each subsequent event must have `sequence === previous.sequence + 1` (zero gaps, zero duplicates, zero reordering).
   - Ingests event into hash: `updateCanonicalEventHash(this.#observedHash, event)`.
4. **Full Stream vs. Metric Subset Distinction:**
   - **Full Event Stream:** ALL events (`DATASET_VERIFIED`, `REPLAY_STARTED`, `CANDLE_CLOSED`, `INDICATOR_UPDATED`, `ORDER_*`, `ACCOUNT_MARKED`, `FUNDING_APPLIED`, `RUN_COMPLETED`) are hashed into `observedEventLedgerSha256`.
   - **Metric Subset:** Only post-settlement equity, funding, and trade events occurring within the analysis window feed financial metrics.
5. **Finalization Timing (Post-Execution):**
   The collector **MUST NOT** finalize its hash inside `RUN_COMPLETED.write()`, because Phase 9's `BacktestEventLedger` updates its hash *after* the sink write resolves. The collector finalizes its hash only AFTER `BacktestEngine.run()` has returned:
   ```typescript
   const observedLedgerSha256 = collector.finalizeObservedHash();
   if (observedLedgerSha256 !== outcome.eventLedgerSha256) {
     throw new ResearchValidationError('EVIDENCE_INTEGRITY_FAILURE', 'Observed event ledger hash does not match Phase 9 outcome');
   }
   ```
   Requires: `RUN_COMPLETED` was observed exactly once and was the final event. Mismatch fails closed immediately.

### 7.3 Analysis Window Boundary Semantics (PHASE12-SPEC-01, H3, H4, Q3 Closed)
Phase 9 evaluation executes within $[\text{evaluationFromInclusiveMs}, \text{evaluationToExclusiveMs})$, but the final replayed candle closes at $\text{replayToExclusiveMs} === \text{analysisEndExclusiveMs}$.
Phase 12 defines exact causal metric boundaries:

```
Replay Timeline (ms) ────────────────────────────────────────────────────────────────────────►
Bootstrap / Warmup     │                     Active Analysis Window                    │
[...indicators warm...]│                                                               │
                       ▲                                                               ▲
                       │                                                               │
               analysisStartMs                                              analysisEndExclusiveMs
               (Baseline Equity E_0)                                        (Terminal Analysis Equity E_N)
```

1. **Metric Baseline ($T = \text{analysisStartMs}$):**
   - Collect the post-settlement account equity after ALL equity-changing events at $T$ have settled.
   - Flushed as `baselineEquity` ($E_0$).
   - It is the anchor for returns and is **NOT** counted as an analysis-period return.
2. **Metric Observation Interval:**
   $$\text{analysisStartMs} < \text{eventTimeMs} \le \text{analysisEndExclusiveMs}$$
   - The final `ACCOUNT_MARKED` generated by the last replayed candle at $T = \text{analysisEndExclusiveMs}$ **IS INCLUDED**.
   - Any same-timestamp funding settlement at $\text{analysisEndExclusiveMs}$ **IS INCLUDED**.
   - `RUN_COMPLETED` at $\text{analysisEndExclusiveMs}$ is observed for lineage and ledger closure.
3. **Warmup Quarantined:** No event with $\text{eventTimeMs} < \text{analysisStartMs}$ enters validation metrics.

### 7.4 Same-Timestamp Equity Accumulator (Funding Edge Resolution)
In Phase 9 `processBar`, at timestamp $T = \text{candle.closeTimeExclusiveMs}$:
1. Engine marks position PnL and emits `ACCOUNT_MARKED` at $T$.
2. If funding is scheduled, engine settles funding and emits `FUNDING_APPLIED` at the same timestamp $T$.
3. Strategy evaluation occurs.

#### Deterministic Timestamp-Group State Machine:
```typescript
// On each event at timestamp T:
if (event.type === 'ACCOUNT_MARKED') {
  currentTimestampEquity = event.payload.equity; // BacktestDecimal string
} else if (event.type === 'FUNDING_APPLIED') {
  currentTimestampEquity = event.payload.accountEquity.equity; // Post-funding equity!
}
// When eventTimeMs advances to T_next, OR upon RUN_COMPLETED:
// Commit currentTimestampEquity as the terminal equity for timestamp T.
```
- For $T = \text{analysisStartMs}$: Committed as `baselineEquity` ($E_0$).
- For each UTC midnight ($T \pmod{86\,400\,000} === 0$): Committed as that day's terminal equity $E_d$.
- For $T = \text{analysisEndExclusiveMs}$: Committed as `terminalAnalysisEquity` ($E_N$).
- Guarantees pre-funding equity is never mistakenly sampled.

### 7.5 UTC Daily Equity & Return Series
For an analysis window with $N = \frac{\text{analysisEndExclusiveMs} - \text{analysisStartMs}}{DAY\_MS}$ days:
- Exactly $N + 1$ boundary equity observations are collected: $E_0, E_1, \dots, E_N$.
- Produces exactly $N$ daily net returns:
  $$R_d = \frac{E_d - E_{d-1}}{E_{d-1}} \quad \text{for } d \in \{1, \dots, N\}$$
- If any expected UTC midnight boundary equity is missing: fails closed with `EVIDENCE_INTEGRITY_FAILURE` (zero silent interpolation).
- If $E_{d-1} \le 0$: return metric terminates as `UNDEFINED` with reason `'NON_POSITIVE_PRIOR_EQUITY'`.

### 7.6 Minute-Close Drawdown Path (Granularity Clarification)
Drawdown is evaluated across the **minute-close cost-inclusive equity path plus same-timestamp funding settlement**:
- Path: $[E_0, E_{t_1}, E_{t_2}, \dots, E_{\text{terminal}}]$ where each $E_t$ is the post-settlement equity at candle close for $\text{analysisStartMs} < t \le \text{analysisEndExclusiveMs}$.
- Running high-water mark: $HWM_t = \max_{0 \le s \le t} E_s$.
- Drawdown percentage: $DD\%_t = \frac{HWM_t - E_t}{HWM_t}$.
- Maximum drawdown: $\text{MaxDD}\% = \max_t DD\%_t$.
- Prohibits claiming "intrabar continuous" pricing; accurately reflects 1m OHLCV bar-close resolution.

### 7.7 Canonical Evidence Bundle & Hash (`validationEvidenceSha256`)
```typescript
export interface CanonicalValidationEvidence {
  readonly schemaVersion: 1;
  readonly validationPlanId: string;
  readonly validationSubjectId: string;
  readonly validationFoldId: string;
  readonly scenarioId: string;
  readonly matrixPlanId: string;
  readonly matrixCellId: string;
  readonly expectedRunId: string;
  readonly runId: string;
  readonly resultSha256: string;
  readonly observedEventLedgerSha256: string;
  readonly phase9EventLedgerSha256: string;
  readonly observedEventCount: number;
  readonly baselineEquity: string;
  readonly terminalAnalysisEquity: string;
  readonly totalNetReturn: string;
  readonly maxDrawdownAmount: string;
  readonly maxDrawdownPercent: string;
  readonly totalFills: number;
  readonly totalClosedTrades: number;
  readonly totalFees: string;
  readonly fundingPnl: string;
  readonly dailyEquities: readonly CanonicalDailyTerminalEquity[];
  readonly dailyReturns: readonly string[]; // Canonical decimal strings
  readonly closedTradeGrossPnls: readonly string[];
  readonly validationEvidenceSha256: string;
}
```

$$\text{validationEvidenceSha256} = \text{SHA-256}\left(\text{CanonicalJson}(\text{CanonicalValidationEvidence without validationEvidenceSha256})\right)$$

Lineage assertion: `runId === expectedRunId`, `resultSha256 === outcome.resultSha256`, `observedEventLedgerSha256 === phase9EventLedgerSha256 === outcome.eventLedgerSha256`. Any discrepancy fails closed (`EVIDENCE_INTEGRITY_FAILURE`).

---

## 8. Numeric Policy & Metric Validity Representation

### 8.1 Numeric Architecture
- **Financial & Statistical Calculations:** Evaluated exclusively via `decimal.js` within an isolated calculation context (minimum 128-digit precision, `ROUND_HALF_UP`).
- **Prohibitions:** Native JavaScript `Number` floating-point arithmetic is strictly barred for prices, equities, returns, standard deviations, and ratios. `Math.random` and `parseFloat` are strictly forbidden.
- **Safe Integers Only:** Permitted strictly for timestamps, bar counts, day indexes, and sample counts validated with `Number.isSafeInteger()`.

### 8.2 Discriminated Metric State Model (No NaN / No Infinity)
```typescript
export type MetricValidityStatus = 'VALUE' | 'UNDEFINED' | 'INSUFFICIENT_DATA';

export type MetricUndefinedReason =
  | 'ZERO_SAMPLE_VARIANCE'
  | 'ZERO_DOWNSIDE_DEVIATION'
  | 'ZERO_LOSSES'
  | 'ZERO_DENOMINATOR'
  | 'ZERO_BASELINE_EQUITY'
  | 'NON_POSITIVE_BASELINE_EQUITY'
  | 'NON_POSITIVE_PRIOR_EQUITY'
  | 'NON_POSITIVE_SIMULATED_EQUITY'
  | 'DSR_ESTIMATOR_VARIANCE_INVALID'
  | 'ZERO_DSR_ESTIMATOR_DEVIATION';

export interface MetricValueResult<T = string> {
  readonly status: 'VALUE';
  readonly value: T;
}

export interface MetricUndefinedResult {
  readonly status: 'UNDEFINED';
  readonly reason: MetricUndefinedReason;
  readonly value: null;
}

export interface MetricInsufficientDataResult {
  readonly status: 'INSUFFICIENT_DATA';
  readonly reason: string;
  readonly count: number;
  readonly required: number;
  readonly value: null;
}

export type ValidationMetric<T = string> =
  | MetricValueResult<T>
  | MetricUndefinedResult
  | MetricInsufficientDataResult;
```

---

## 9. Core Validation Metrics Specification

### 9.1 Total Net Return (Annualized Removed in V1)
- **Canonical V1 Definition:**
  $$\text{totalNetReturn} = \frac{\text{terminalAnalysisEquity} - \text{baselineEquity}}{\text{baselineEquity}}$$
  If $\text{baselineEquity} \le 0$: returns `UNDEFINED` (`NON_POSITIVE_BASELINE_EQUITY`).
- **Removal of Compound Annualized Return:** Compound annualized return $(1 + R)^{365/N} - 1$ is removed from Phase 12 V1 canonical evidence because it is not used in approval gating and introduces fractional-power domain fragility for negative returns.

### 9.2 Annualized Sharpe Ratio
Given daily returns $R_1, \dots, R_N$:
1. **Daily Risk-Free Rate ($r_{f,\text{daily}}$):**
   $$r_{f,\text{daily}} = (1 + r_f)^{\frac{1}{365}} - 1$$
   Where $r_f$ is plan-bound `metricPolicy.annualRiskFreeRate`.
2. **Excess Returns:** $Z_d = R_d - r_{f,\text{daily}}$; Mean: $\bar{Z} = \frac{1}{N} \sum_{d=1}^N Z_d$.
3. **Sample Variance ($N-1$ Bessel's Correction):**
   $$s^2 = \frac{1}{N - 1} \sum_{d=1}^N (Z_d - \bar{Z})^2 \quad (s = \sqrt{s^2})$$
4. **Annualized Sharpe Ratio:**
   $$\text{Sharpe} = \sqrt{365} \times \frac{\bar{Z}}{s}$$
5. **Deterministic Failure Semantics:**
   - If $N < \text{metricPolicy.minDailyObservations}$: returns `INSUFFICIENT_DATA` with `{ count: N, required: minDailyObservations }`.
   - If $s^2 === 0$: returns `UNDEFINED` with reason `'ZERO_SAMPLE_VARIANCE'`.
   - Never outputs `Infinity` or `NaN`.

### 9.3 Annualized Sortino Ratio
1. **Daily Target Rate ($R_{\text{target}}$):**
   $$R_{\text{target}} = (1 + r_{\text{sortino}})^{\frac{1}{365}} - 1$$
   Where $r_{\text{sortino}}$ is plan-bound `metricPolicy.annualSortinoTargetRate` (not silently equated to risk-free rate).
2. **Downside Deviation Term:** $\delta_d = \min(R_d - R_{\text{target}}, 0)$.
3. **Downside Semi-Variance ($N-1$ Convention):**
   $$s_d^2 = \frac{1}{N - 1} \sum_{d=1}^N (\delta_d)^2 \quad (s_d = \sqrt{s_d^2})$$
4. **Annualized Sortino Ratio:**
   $$\text{Sortino} = \sqrt{365} \times \frac{\bar{R} - R_{\text{target}}}{s_d}$$
5. **Deterministic Failure Semantics:**
   - If $N < \text{metricPolicy.minDailyObservations}$: returns `INSUFFICIENT_DATA`.
   - If $s_d^2 === 0$: returns `UNDEFINED` with reason `'ZERO_DOWNSIDE_DEVIATION'`.

### 9.4 Profit Factor & Expectancy (Gross vs. Net Disambiguation)
- **Gross Trade Metrics (from `TRADE_CLOSED.realizedGrossPnl`):**
  - `grossTradeProfitFactor`: $\frac{\sum \max(\text{Pnl}, 0)}{|\sum \min(\text{Pnl}, 0)|}$. If losses sum to zero: `UNDEFINED` (`'ZERO_LOSSES'`).
  - `grossTradeExpectancy`: $\frac{\sum \text{Pnl}_t}{N_{\text{trades}}}$. If $N_{\text{trades}} === 0$: `INSUFFICIENT_DATA`.
- **Net Daily Metrics (Cost-Inclusive, from Daily Net Equity Changes $\Delta E_d$):**
  - `netDailyProfitFactor`: $\frac{\sum \max(\Delta E_d, 0)}{|\sum \min(\Delta E_d, 0)|}$.
  - `netDailyExpectancy`: $\frac{\sum \Delta E_d}{N} = \frac{\text{terminalAnalysisEquity} - \text{baselineEquity}}{N}$.
  - Never labeled as trade-level metrics.

---

## 10. Walk-Forward Stability Analysis

For every frozen validation subject across all $K$ walk-forward folds:
1. **Per-Fold Metrics:** Compute IS and OOS metrics independently per fold.
2. **Aggregate OOS Return Series:** Formed by concatenating non-overlapping OOS daily net returns in chronological order. Because windows are non-overlapping, no date is duplicated.
3. **OOS Fold Pass Ratio (`P12_OOS_FOLD_LOCAL_GATES_V1`):**
   Freeze exactly which gates are FOLD-LOCAL.
   For each OOS fold $k \in \{0, \dots, K-1\}$, evaluate strictly the seven fold-local gates:
   - `MIN_OOS_TRADES` (fold-local form of GATE-01)
   - `MIN_DAILY_OBSERVATIONS` (fold-local form of GATE-02)
   - `MIN_OOS_SHARPE` (fold-local form of GATE-03)
   - `MIN_OOS_SORTINO` (fold-local form of GATE-04)
   - `MAX_OOS_DRAWDOWN` (fold-local form of GATE-05)
   - `MIN_PROFIT_FACTOR` (fold-local form of GATE-06)
   - `MIN_EXPECTANCY` (fold-local form of GATE-07)
   A fold is marked `PASS` if and only if all seven fold-local gates are assessable and satisfied (`status === 'PASS'`).
   If any required fold-local gate is unavailable (`status === 'UNAVAILABLE'`), the fold verdict is `INSUFFICIENT_EVIDENCE` and it is NOT counted as a passing fold.
   Cross-fold and plan-level gates are strictly excluded from fold pass definition:
   - GATE-08 (`MIN_OOS_FOLD_PASS_RATIO` itself)
   - GATE-09 (`MAX_IS_TO_OOS_DEGRADATION`)
   - GATE-10 (`COST_STRESS_SURVIVAL`)
   - GATE-11 (`MONTE_CARLO_ADVERSE_DRAWDOWN`)
   - GATE-12 (`DEFLATED_SHARPE_Z`)
   - GATE-13 (`FINAL_HOLDOUT_GATE`)
   Then:
   $$\text{oosFoldPassRatio} = \frac{\text{numberOfPassingOosFolds}}{K}$$
   evaluated using deterministic 128-digit Decimal arithmetic.
4. **IS $\to$ OOS Sharpe Degradation:**
   Degradation is computed strictly per fold without concatenating overlapping IS periods:
   $$\text{degradation}_k = \frac{\text{Sharpe}_{\text{IS},k} - \text{Sharpe}_{\text{OOS},k}}{\max(|\text{Sharpe}_{\text{IS},k}|, \text{metricPolicy.sharpeDegradationDenominatorFloor})}$$
   where $\text{metricPolicy.sharpeDegradationDenominatorFloor}$ is an explicit plan-bound canonical decimal string strictly $> 0$ (no hidden source-code epsilon).
   For GATE-09, the canonical subject statistic is:
   $$\text{maxIsToOosSharpeDegradationObserved} = \max_{k=0\dots K-1} (\text{degradation}_k)$$
   GATE-09 passes iff:
   $$\text{maxIsToOosSharpeDegradationObserved} \le \text{thresholds.maxIsToOosSharpeDegradation}$$
   If any required IS or OOS fold Sharpe is `UNDEFINED` or `INSUFFICIENT_DATA`, GATE-09 is `UNAVAILABLE` and contributes `INSUFFICIENT_EVIDENCE` (unless another measurable gate definitively fails). No aggregate overlapping-IS return concatenation is permitted.
5. **OOS Metric Dispersion:** Sample standard deviation of OOS Sharpe across folds.

---

## 11. Real Phase 9 Cost Stress Testing (`P12_COST_STRESS_V1`)

- **Prohibition of Synthetic Deductions:** Subtracting hypothetical fees from baseline PnL in memory is barred.
- **Genuine Phase 9 Reruns:** Each configured cost scenario binds its exact cost model into a genuine `MatrixBacktestExecutionConfig`. Scenario IDs must be non-empty stable identifiers unique within the plan (e.g. `MODERATE_STRESS`, `SEVERE_STRESS`). Scenario identity always binds the exact `costModel`, not name alone.
- **Unique Run Lineage:** Phase 9 `normalizeBacktestInputs` derives a distinct `expectedRunId` for each scenario. Execution yields authentic fills, genuine fee assessments, distinct `resultSha256`, and distinct `eventLedgerSha256`.
- **Gate Evaluation Semantics (GATE-10):**
  - If `thresholds.requireCostStressSurvival === false`: GATE-10 is `DISABLED` and has no effect on subject verdict.
  - If `thresholds.requireCostStressSurvival === true`: The plan **MUST** contain exactly one scenario with `scenarioId = 'MODERATE_STRESS'`; otherwise the plan fails validation with `VALIDATION_PLAN_INVALID`. GATE-10 evaluates that exact genuine Phase 9 rerun:
    $$\text{totalNetReturn}_{\text{MODERATE\_STRESS}} > 0$$
  - Additional configured scenarios (such as `SEVERE_STRESS`) may be executed and retained in canonical evidence bundles for audit and research inspection, but they do not form V1 approval gates unless a future version explicitly adds a threshold. Stress returns are evaluated in isolation and **never contaminate** baseline OOS return series or DSR trial families.

---

## 12. Deterministic Monte Carlo Permutation Testing (`P12_MONTE_CARLO_PERMUTATION_V1`)

- **Objective:** Path-risk evaluation (sequence luck), NOT profit forecasting.
- **Input:** Cost-inclusive daily net returns array $[R_1, \dots, R_N]$ from aggregate OOS.
- **Canonical Seed Derivation:**
  $$\text{seed}_0 = \text{HMAC-SHA256}\left(\text{key}=\text{UTF8}(\text{validationPlanId}), \text{message}=\text{UTF8}(\text{canonicalJson}(\{ \text{validationSubjectId}, \text{validationFoldId}: \text{'AGGREGATE\_OOS'}, \text{scenarioId}: \text{'BASELINE'}, \text{policyId}: \text{'P12\_MONTE\_CARLO\_PERMUTATION\_V1'} \}))\right)$$
  The raw 32-byte HMAC digest is used as `seed0`.
- **Deterministic Counter PRNG Stream:**
  $$\text{block}(\text{counter}) = \text{SHA-256}(\text{seed}_0 \mathbin{\Vert} \text{UINT64\_BE}(\text{counter}))$$
  `counter` starts at 0 and increments by 1 per generated 32-byte block. Each block is consumed as eight unsigned 32-bit big-endian words in byte order. Zero runtime RNG and zero `Math.random`.
- **Unbiased Rejection-Sampled Fisher-Yates Shuffle:**
  One continuous deterministic PRNG stream is consumed per subject across all simulations executed in ascending order: $\text{simulationIndex} = 0 \dots \text{simulationCount} - 1$. Each simulation begins from a fresh copy of the original aggregate OOS return array. For $i = N - 1$ down to 1:
  $$\text{range} = i + 1, \quad \text{limit} = \lfloor 2^{32} / \text{range} \rfloor \times \text{range}$$
  Draw $\text{uint32 } x$ from the stream until $x < \text{limit}$, then set $j = x \pmod{\text{range}}$ and swap $\text{array}[i]$ with $\text{array}[j]$. (Safe integer arithmetic is permitted for index/random-word logic).
- **Simulated Equity Path Construction:**
  For each permutation:
  $$\text{simulatedEquity}_0 = 1$$
  $$\text{simulatedEquity}_d = \text{simulatedEquity}_{d-1} \times (1 + \text{permutedReturn}_d)$$
  evaluated using deterministic 128-digit Decimal arithmetic.
  If any $1 + \text{permutedReturn}_d \le 0$, the Monte Carlo metric for that subject terminates as `UNDEFINED` with reason `NON_POSITIVE_SIMULATED_EQUITY` (zero `NaN`, zero `Infinity`).
  Max drawdown percent is computed from the simulated equity path using peak high-water-mark tracking:
  $$\text{peak}_d = \max(\text{peak}_{d-1}, \text{simulatedEquity}_d), \quad \text{drawdown}_d = \frac{\text{peak}_d - \text{simulatedEquity}_d}{\text{peak}_d}, \quad \text{maxDrawdownPercent} = \max_d(\text{drawdown}_d) \times 100$$
- **Configured Adverse Percentile Selection (GATE-11):**
  After collecting `simulationCount` max-drawdown percentages, the array is sorted ascending numerically using Decimal comparison. For configured percentile $p = \text{plan.monteCarlo.adversePercentile}$ ($1 \le p \le 99$):
  $$\text{nearestRank} = \left\lceil \frac{p \times \text{simulationCount}}{100} \right\rceil = \left\lfloor \frac{p \times \text{simulationCount} + 99}{100} \right\rfloor, \quad \text{selectedIndex} = \text{nearestRank} - 1$$
  Calculated using exact integer arithmetic without floating point.
  $$\text{monteCarloAdverseDrawdownPercent} = \text{sortedDrawdowns}[\text{selectedIndex}]$$
  GATE-11 passes iff $\text{monteCarloAdverseDrawdownPercent} \le \text{thresholds.maxMonteCarloAdverseDrawdownPercent}$. No hardcoded 95th percentile in production policy.

---

## 13. Statistical Overfitting Control (`P12_DEFLATED_SHARPE_Z_V1`)

### 13.1 Multiple-Testing Trial Family Definition (PHASE12-SPEC-06, H7 Closed)
The multiple-testing family is strictly defined as:
> **All distinct frozen `parameterHash` candidates belonging to the same $(\text{pair}, \text{strategyId}, \text{strategyVersion})$ within one `validationPlanId`.**
- $M$: Number of distinct candidate subjects in that exact family ($M \ge 1$).
- $M$ **does NOT include** walk-forward folds, cost stress reruns, Monte Carlo permutations, holdout executions, or worker counts.
- **Input Series:** The aggregate OOS daily excess-return series $x_1, \dots, x_N$ ($x_d = R_d - r_{f,\text{daily}}$) across the $K$ non-overlapping OOS folds. Does not include holdout or stress runs.

### 13.2 Per-Observation Daily Sharpe Unit Convention
The Sharpe ratio entering deflated Sharpe mathematics is strictly in **daily-observation units**:
$$\widehat{SR} = \frac{\bar{x}}{s_x} \quad \text{where } \bar{x} = \frac{1}{N}\sum_{d=1}^N x_d, \quad s_x = \sqrt{\frac{1}{N-1}\sum_{d=1}^N (x_d - \bar{x})^2}$$
(Annualized Sharpe $\sqrt{365} \cdot \widehat{SR}$ is used for reporting; DSR equations evaluate in per-day units).

### 13.3 Raw Return Moments
Let $\mu = \frac{1}{N} \sum_{d=1}^N x_d$:
$$m_2 = \frac{1}{N} \sum_{d=1}^N (x_d - \mu)^2, \quad m_3 = \frac{1}{N} \sum_{d=1}^N (x_d - \mu)^3, \quad m_4 = \frac{1}{N} \sum_{d=1}^N (x_d - \mu)^4$$
$$\text{skewness} = \frac{m_3}{m_2^{3/2}}, \quad \text{kurtosis} = \frac{m_4}{m_2^2} \quad (\text{Pearson kurtosis; normal distribution } = 3)$$
If $m_2 === 0$: metric terminates as `UNDEFINED`.

### 13.4 Candidate Dispersion & The $M = 1$ Branch
Let $\{\widehat{SR}_m\}_{m=1}^M$ be the daily Sharpe estimates across the $M$ candidates in the family. Let $\sigma_{\{SR\}}$ be their sample standard deviation:
- **Single-Trial Branch ($M === 1$):**
  $$SR_0 = 0$$
  Evaluated strictly outside logarithmic terms (zero evaluation of $\ln(M)$ or $\ln(\ln(M))$).
- **Multiple-Trial Branch ($M > 1$):**
  If $\sigma_{\{SR\}} === 0$: $SR_0 = 0$.
  Otherwise:
  $$SR_0 = \sqrt{2 \ln M} \times \sigma_{\{SR\}} \left( 1 - \frac{\gamma + \ln(\ln M)}{2 \ln M} \right)$$
  Where $\gamma \approx 0.5772156649$ (Euler-Mascheroni constant).
  *Methodological Disclosure:* This is a versioned asymptotic approximation under trial independence; cross-candidate correlation is not modeled in V1.

### 13.5 Estimator Variance & Canonical Z-Statistic
$$\sigma_{\widehat{SR}}^2 = \frac{1 - \text{skewness} \cdot \widehat{SR} + \frac{\text{kurtosis} - 1}{4} \widehat{SR}^2}{N - 1}$$
Requires: $N \ge \text{metricPolicy.minDailyObservations}$ and $N \ge 2$.
- If numerator $\le 0$: returns `UNDEFINED` (`'DSR_ESTIMATOR_VARIANCE_INVALID'`).
- If $\sigma_{\widehat{SR}} === 0$: returns `UNDEFINED` (`'ZERO_DSR_ESTIMATOR_DEVIATION'`).
- **Canonical V1 Statistic (`deflatedSharpeZ`):**
  $$\text{deflatedSharpeZ} = \frac{\widehat{SR} - SR_0}{\sigma_{\widehat{SR}}}$$
  Evaluating as a canonical Z-score avoids runtime-dependent normal CDF approximations in V1. Gate requires $\text{deflatedSharpeZ} \ge \text{thresholds.minDeflatedSharpeZ}$ (e.g. $\ge 1.645$).

---

## 14. Generic Parameter Neighborhood Sensitivity

- Generic topology mapping `targetParameterHash` to `adjacentNeighborParameterHashes` supplied in plan.
- Zero hardcoded indicator parameter logic (EMA/ATR/RSI) in Phase 12 core.
- Plateau stability ratio: $\frac{\text{Mean}(\text{Neighbor Sharpes})}{\text{Target Sharpe}}$. Flags isolated spikes surrounded by failing neighbors.

---

## 15. Research Validation Policy & Approval Gates

### 15.1 Deterministic Policy Schema & Gate Status Model
All approval criteria are declared explicitly in `ResearchValidationPolicy`:

```typescript
export type ValidationGateStatus =
  | 'PASS'
  | 'FAIL'
  | 'UNAVAILABLE'
  | 'DISABLED';

export interface ValidationGateEvaluation {
  readonly gateId: string;
  readonly gateName: string;
  readonly status: ValidationGateStatus;
  readonly observedValue: string | number | null;
  readonly thresholdValue: string | number | boolean | null;
  readonly reason?: string;
}
```

#### Gate Status Semantics:
- **`PASS`:** Metric/condition is assessable and satisfies the threshold.
- **`FAIL`:** Metric/condition is assessable and violates the threshold.
- **`UNAVAILABLE`:** Metric/condition cannot be evaluated due to `INSUFFICIENT_DATA`, `UNDEFINED` metric value, unverified holdout, missing event evidence, or execution failure.
- **`DISABLED`:** Gate is explicitly deactivated by plan configuration (e.g., `requireCostStressSurvival === false`, `requireHoldoutPositiveReturn === false`, or `requireFreshHoldout === false`).
- **Verdict Effect:** `DISABLED` gates have no effect on subject verdict. `UNAVAILABLE` gates contribute `INSUFFICIENT_EVIDENCE` unless another required gate `FAIL`s. `FAIL` takes precedence over all other outcomes.

| Gate ID | Approval Gate Name | Required Condition | Failure Classification |
| :--- | :--- | :--- | :--- |
| **GATE-01** | `MIN_OOS_TRADES` | $N_{\text{trades, OOS}} \ge \text{thresholds.minOosClosedTrades}$ | Sample insufficiency |
| **GATE-02** | `MIN_DAILY_OBSERVATIONS` | $N_{\text{days, OOS}} \ge \text{thresholds.minDailyObservations}$ | Sample insufficiency |
| **GATE-03** | `MIN_OOS_SHARPE` | $\text{Sharpe}_{\text{OOS}} \ge \text{thresholds.minOosSharpe}$ | Statistical failure |
| **GATE-04** | `MIN_OOS_SORTINO` | $\text{Sortino}_{\text{OOS}} \ge \text{thresholds.minOosSortino}$ | Statistical failure |
| **GATE-05** | `MAX_OOS_DRAWDOWN` | $\text{MaxDD}\%_{\text{OOS}} \le \text{thresholds.maxOosDrawdownPercent}$ | Risk threshold breach |
| **GATE-06** | `MIN_PROFIT_FACTOR` | $\text{PF}_{\text{net,daily}} \ge \text{thresholds.minNetDailyProfitFactor}$ | Profitability failure |
| **GATE-07** | `MIN_EXPECTANCY` | $\text{Expectancy}_{\text{net,daily}} \ge \text{thresholds.minNetDailyExpectancy}$ | Profitability failure |
| **GATE-08** | `MIN_OOS_FOLD_PASS_RATIO` | $\text{oosFoldPassRatio} \ge \text{thresholds.minOosFoldPassRatio}$ | Temporal instability |
| **GATE-09** | `MAX_IS_TO_OOS_DEGRADATION` | $\text{maxIsToOosSharpeDegradationObserved} \le \text{thresholds.maxIsToOosSharpeDegradation}$ | Overfitting failure |
| **GATE-10** | `COST_STRESS_SURVIVAL` | If $\text{requireCostStressSurvival} === \text{true}$: $\text{totalNetReturn}_{\text{MODERATE\_STRESS}} > 0$; else `DISABLED` | Execution cost fragility |
| **GATE-11** | `MONTE_CARLO_ADVERSE_DRAWDOWN` | $\text{monteCarloAdverseDrawdownPercent} \le \text{thresholds.maxMonteCarloAdverseDrawdownPercent}$ (at configured `adversePercentile`) | Path-risk vulnerability |
| **GATE-12** | `DEFLATED_SHARPE_Z` | $\text{deflatedSharpeZ} \ge \text{thresholds.minDeflatedSharpeZ}$ | Multiple-testing data mining |
| **GATE-13** | `FINAL_HOLDOUT_GATE` | $\text{holdoutSharpe} \ge \text{thresholds.minHoldoutSharpe} \land (\neg \text{requireHoldoutPositiveReturn} \lor \text{holdoutTotalNetReturn} > 0) \land (\neg \text{requireFreshHoldout} \lor \text{exposureDeclaration} === \text{'UNSEEN\_BY\_OPERATOR'})$ | Final temporal verification |

### 15.2 Exact Verdict Precedence Architecture
For every successfully orchestrated subject:
1. **Precedence 1 (Definitive Policy Failure):** If ANY required policy gate evaluates to `FAIL` (assessable and definitively violates its threshold), verdict is:
   $$\text{verdict} = \mathbf{FAILED}$$
2. **Precedence 2 (Evidence / Procedural Insufficiency):** Else, if ANY required policy gate evaluates to `UNAVAILABLE` (due to `INSUFFICIENT_DATA`, `UNDEFINED` metric, missing fresh holdout when `requireFreshHoldout === true`, per-fold backtest execution failure, or missing verified event evidence):
   $$\text{verdict} = \mathbf{INSUFFICIENT\_EVIDENCE}$$
3. **Precedence 3 (Unanimous Approval):** If and only if EVERY required policy gate evaluates to `PASS` (or is `DISABLED`):
   $$\text{verdict} = \mathbf{PASSED}$$

*Principle:* Definitive statistical failure takes precedence over missing data; operational failure must never be masked as strategy failure.

---

## 16. Canonical Validation Result & Result ID (`validationResultSha256`)

```typescript
export type ValidationPlanStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface StrategyValidationRecord {
  readonly validationSubjectId: string;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly verdict: 'PASSED' | 'FAILED' | 'INSUFFICIENT_EVIDENCE';
  readonly foldResults: readonly ValidationFoldResult[];
  readonly aggregateOosMetrics: Record<string, ValidationMetric>;
  readonly gateEvaluations: readonly ValidationGateEvaluation[];
  readonly costStressEvaluations?: readonly ValidationCostStressEvaluation[];
  readonly monteCarloResult?: ValidationMonteCarloResult;
  readonly holdoutEvaluation?: ValidationHoldoutEvaluation;
}

export interface ResearchValidationPlanResult {
  readonly validationPlanId: string;
  readonly planName: string;
  readonly status: ValidationPlanStatus;
  readonly totalSubjects: number;
  readonly passedSubjects: number;
  readonly failedSubjects: number;
  readonly insufficientEvidenceSubjects: number;
  readonly totalFolds: number;
  readonly unusedTailMs: number;
  readonly freshnessBasis: 'OPERATOR_ATTESTATION_V1';
  readonly subjectResults: readonly StrategyValidationRecord[];
  readonly validationResultSha256: string;
}
```

### 16.1 Deterministic Plan-Level Status Rules
- **`COMPLETED`**:
  - Source identity remained valid for the entire validation orchestration.
  - Every authoritative validation subject in the plan has exactly one terminal `StrategyValidationRecord`.
  - Each subject record has one research verdict: `PASSED`, `FAILED`, or `INSUFFICIENT_EVIDENCE`.
  - A subject receiving verdict `FAILED` or `INSUFFICIENT_EVIDENCE` does **NOT** make plan status `FAILED`; `COMPLETED` indicates the research plan executed fully and produced complete evidence.
- **`PARTIAL`**:
  - Source identity remains valid.
  - At least one authoritative validation subject has a terminal `StrategyValidationRecord`.
  - One or more subjects cannot produce a complete canonical terminal validation record due to a bounded non-source orchestration failure (e.g. per-subject dataset read error or unexpected worker fault).
  - No subject may silently disappear; missing or aborted subjects are explicitly disclosed in the evidence ledger.
- **`FAILED`**:
  - Source identity / clean Git invariant becomes invalid mid-orchestration (untracked files, modified working tree, or commit mismatch).
  OR
  - Matrix-wide evidence, concurrency, or cryptographic integrity invariant fails (`EVIDENCE_INTEGRITY_FAILURE`, hash mismatch).
  OR
  - Zero subjects obtain valid terminal records after execution begins.
- **Pre-Execution Plan Validation Failure:**
  - If a plan is invalid prior to execution (e.g. invalid candidate space, dataset coverage gap, or `requireCostStressSurvival === true` without exactly one `MODERATE_STRESS` scenario):
    The engine throws `VALIDATION_PLAN_INVALID` and does **NOT** fabricate a `ResearchValidationPlanResult`.

### 16.2 Validation-Wide Source TOCTOU Semantics
- `validationPlan.sourceIdentity.gitCommitHash` is captured once at plan construction.
- Every fold, stress, and holdout Phase 11 matrix execution must bind and verify the **identical** expected commit.
- Before dispatching each new matrix execution and after the final execution:
  The engine verifies clean repository state (`git status --porcelain=v1 --untracked-files=all` must be empty) and exact expected commit (`git rev-parse HEAD`).
- Existing Phase 11 Git verification authority (`ProductionGitSourceVerifier` / `GitSourceVerifier`) is reused; no separate unsafe shell-based verifier is created.
- If source becomes dirty or HEAD changes during execution:
  - No subsequent validation execution starts.
  - The validation plan terminates `status: 'FAILED'`.
  - No result may be emitted as `COMPLETED` or `PARTIAL`.

$$\text{validationResultSha256} = \text{SHA-256}\left(\text{CanonicalJson}(\text{ValidationResultSummaryPayload})\right)$$

Sorted strictly by `validationSubjectId` ascending. Bit-for-bit identical independent of worker concurrency. Durations, timestamps, hostnames, and PIDs are excluded.

---

## 17. Structured Error Hierarchy & Fail-Closed Semantics

```typescript
export type ValidationErrorCode =
  | 'VALIDATION_PLAN_INVALID'
  | 'VALIDATION_SOURCE_DIRTY'
  | 'VALIDATION_SOURCE_COMMIT_MISMATCH'
  | 'VALIDATION_SOURCE_UNAVAILABLE'
  | 'RESOURCE_IDENTITY_MISMATCH'
  | 'DATASET_COVERAGE_GAP'
  | 'BACKTEST_EXECUTION_FAILED'
  | 'EVIDENCE_INTEGRITY_FAILURE'
  | 'METRIC_NUMERIC_FAILURE'
  | 'MONTE_CARLO_FAILURE'
  | 'OVERFITTING_POLICY_FAILURE'
  | 'CONCURRENCY_INTEGRITY_VIOLATION';
```

---

## 18. Coin Runtime & Production State Boundary

- Phase 12 produces immutable, read-only research records.
- Zero direct mutation of Coin Runtime state machines, active coin configurations, or strategy registries.
- Qualification for paper trading occurs explicitly in Phase 15.

---

## 19. Required Phase 12 Invariants

| Invariant ID | Name | Formal Specification |
| :--- | :--- | :--- |
| **P12-I01** | **Deterministic Validation Plan Identity** | `validationPlanId` derives via `sha256CanonicalJson(ResearchValidationPlan)` canonically binding full `pairBindings` (pair, datasetBinding, fixedResearchQuantity, instrumentSpecSnapshotId, and fundingScheduleBinding { sourceId, contentSha256, fidelity }), derived `pairUniverse`, windows, candidate spaces, walk-forward parameters, holdout boundaries, operator attestation, cost models, Monte Carlo policies, and approval thresholds. Environment and timing metadata are excluded. |
| **P12-I02** | **Exact Phase 11 / Phase 9 Lineage** | Every validation evaluation executes through the genuine Phase 11 `executeCell` $\to$ Phase 9 `BacktestEngine` path using matrix plans constructed directly from `validationPlan.pairBindings` without mutating fixedResearchQuantity, instrument specs, or funding schedules across folds, stress runs, or holdout runs. Research mocks or synthetic candle simulators are strictly prohibited. Every subject retains genuine cell, run, outcome, and ledger IDs. |
| **P12-I03** | **Independent Observed Event Ledger Hash** | The evidence collector must independently hash the complete observed event stream using `updateCanonicalEventHash`. The finalized `observedEventLedgerSha256` must strictly equal Phase 9's `outcome.eventLedgerSha256`; mismatch fails closed with `EVIDENCE_INTEGRITY_FAILURE`. |
| **P12-I04** | **Zero Warmup Metric Contamination** | Observations prior to `evaluationFromInclusiveMs` are strictly quarantined and never enter daily return series, trade counts, PnL calculations, or validation metrics. |
| **P12-I05** | **Deterministic UTC Daily Equity & Return Series** | At `analysisStartMs`, baseline equity $E_0$ is captured after same-timestamp flush; metrics observe $\text{analysisStartMs} < T \le \text{analysisEndExclusiveMs}$, including final candle close and funding. $N+1$ UTC boundaries produce exactly $N$ daily returns $R_d = \frac{E_d - E_{d-1}}{E_{d-1}}$. Missing boundaries fail closed. |
| **P12-I06** | **Minute-Close Drawdown & Exact Risk Semantics** | Max drawdown evaluates across the minute-close cost-inclusive equity path plus same-timestamp funding settlement. Sharpe uses daily excess returns with $N-1$ variance and $\sqrt{365}$ annualization. Sortino uses plan-bound `annualSortinoTargetRate`. All financial math uses 128-digit Decimal. |
| **P12-I07** | **Zero-Denominator & Insufficient-Data Semantics** | No metric calculation may emit `NaN`, `Infinity`, or silent fallback numbers. A metric must terminate in a discriminated union (`VALUE`, `UNDEFINED`, or `INSUFFICIENT_DATA`) with explicit reason codes (including `NON_POSITIVE_SIMULATED_EQUITY`). |
| **P12-I08** | **Chronological Walk-Forward & Tail Disclosure** | Walk-forward steps chronologically forward with $\text{stepDays} === \text{testDays}$ producing $K$ complete non-overlapping folds. Any trailing span before holdout is disclosed as `unusedTailMs` and excluded from folds; partial folds are barred. |
| **P12-I09** | **Holdout Plan Binding & Operator Attestation** | Plan identity binds holdout boundaries preventing cross-plan relabeling, but does not prove human non-exposure. Freshness is governed by plan-bound `holdoutExposureDeclaration` (`UNSEEN_BY_OPERATOR` vs `PREVIOUSLY_OBSERVED`); `PREVIOUSLY_OBSERVED` cannot satisfy fresh holdout requirements. |
| **P12-I10** | **Real Cost-Stress Reruns (No Synthetic Adjustments)** | Cost stress scenarios must re-execute the genuine Phase 9 engine under identity-bound stressed cost models producing real Phase 9 run IDs and fills. If `requireCostStressSurvival === true`, exactly one `MODERATE_STRESS` scenario is required. Post-processing baseline PnL via synthetic fee subtraction is barred. |
| **P12-I11** | **Deterministic Monte Carlo Permutations** | Daily return permutation uses an unbiased Fisher-Yates shuffle driven by counter-mode CSPRNG seeded via HMAC-SHA256 from plan, subject, fold, and policy IDs. Evaluates simulated equity path $E_d = E_{d-1}(1+R_d)$; non-positive simulated equity terminates `UNDEFINED` (`NON_POSITIVE_SIMULATED_EQUITY`). Evaluates configured `adversePercentile` via exact integer rank. `Math.random` is prohibited. Path-risk evaluation only. |
| **P12-I12** | **Explicit Overfitting Control (Deflated Sharpe Z)** | The engine must compute `deflatedSharpeZ` over aggregate OOS daily returns for the trial family of size $M$, evaluating $SR_0 = 0$ for $M === 1$ outside logarithms, and penalizing return skewness and kurtosis. Positive PnL alone is insufficient. |
| **P12-I13** | **Concurrency & Worker-Count Invariance** | Validation results must be sorted strictly by canonical `validationSubjectId` ascending before hashing. Executing with 1 worker vs $N$ parallel workers yields bit-for-bit identical `validationResultSha256` and output JSON. Subject `FAILED` does not make plan status `FAILED`. |
| **P12-I14** | **Deep Input & Result Immutability** | All plan inputs, threshold structures, evidence arrays, and output records must be defensively deep-copied and deep-frozen upon creation. |
| **P12-I15** | **Strict Prohibition of Ranking & Winner Selection** | Phase 12 must never compute candidate rankings, leaderboards, composite sorting scores, or designate a "winning" strategy. Phase 15 owns ranking. Phase 12 emits only binary gate verdicts (`PASSED`, `FAILED`, `INSUFFICIENT_EVIDENCE`). |
| **P12-I16** | **Structural Fresh Execution & Fail-Closed Evidence** | Phase 12 dependencies strictly omit completed-result cache. For every cell reporting `COMPLETED`, genuine independently verified event evidence must be present; missing evidence fails closed with `EVIDENCE_INTEGRITY_FAILURE`. |

---

## 20. High-Risk Architectural Closure Matrix

| ID | High-Risk Topic | Specification Resolution | Status |
| :--- | :--- | :--- | :--- |
| **H1** | **Cache Bypass** | Public Phase 12 API omits cache dependency; constructs fresh `MatrixExecutionDependencies` without cache. Completed cell without collector evidence fails closed. | **CLOSED** |
| **H2** | **Observed Ledger Rehash** | Collector independently hashes full event stream via Phase 9 `updateCanonicalEventHash` and asserts `observedEventLedgerSha256 === outcome.eventLedgerSha256` post-run. | **CLOSED** |
| **H3** | **Analysis-End Equity** | Baseline captured at `analysisStartMs`; metric interval is $\text{analysisStartMs} < T \le \text{analysisEndExclusiveMs}$, including final candle close and same-timestamp funding. | **CLOSED** |
| **H4** | **Funding Ordering** | Timestamp-group state machine updates equity sequentially (`FUNDING_APPLIED` replaces `ACCOUNT_MARKED` at same $T$); flushes post-funding terminal equity. | **CLOSED** |
| **H5** | **Holdout Freshness** | Plan binds holdout boundaries; operator attests `exposureDeclaration` (`UNSEEN_BY_OPERATOR` vs `PREVIOUSLY_OBSERVED`). No false cryptographic human-freshness claims. | **CLOSED** |
| **H6** | **DSR Domain** | Evaluated on aggregate OOS daily returns in per-day Sharpe units. Raw Pearson kurtosis ($= 3$ for normal). $M=1$ branch sets $SR_0 = 0$ outside logarithms. | **CLOSED** |
| **H7** | **Trial Family $M$** | $M$ is the count of distinct `parameterHash` candidates in the $(\text{pair}, \text{strategyId}, \text{strategyVersion})$ family within the plan. Excludes folds, stress runs, and MC. | **CLOSED** |
| **H8** | **Monte Carlo Reproducibility** | HMAC-SHA256 seed + SHA-256 counter PRNG + rejection-sampled Fisher-Yates shuffle. 100% deterministic, zero `Math.random`. Exact integer percentile rank over configured `adversePercentile`. | **CLOSED** |
| **H9** | **Threshold Identity** | All thresholds (`minDailyObservations`, `minOosClosedTrades`, `minDeflatedSharpeZ`, etc.) are explicit plan-bound fields hashed into `validationPlanId`. | **CLOSED** |
| **H10** | **Ranking Boundary** | Results sorted strictly by `validationSubjectId` ascending. Zero rank fields, composite scores, or leaderboards. Phase 15 owns ranking. | **CLOSED** |

---

## 21. Architecture Questions & Closed Resolutions

### Q1: How exactly does Phase 12 obtain event/equity evidence without duplicating Phase 9 or Phase 11 execution?
**Resolution:** Phase 11 exposes an execution-only `eventSinkFactory` seam in `MatrixExecutionOptions`. Matrix plans are constructed directly from `validationPlan.pairBindings` (preserving canonical dataset, fixed research quantity, instrument spec, and funding schedule identity). When invoked by Phase 12, `executeCell` instantiates Phase 12's `ValidationEvidenceCollector` and passes it directly to `new BacktestEngine(config, sink)`. Phase 9 emits events directly into this sink during execution, achieving single-source execution without duplicating simulators or reconstructing candle PnL.

### Q2: How is an event evidence bundle cryptographically bound to `matrixCellId`, `runId`, `resultSha256`, and `eventLedgerSha256`?
**Resolution:** The collector independently hashes every event in sequence using Phase 9's `updateCanonicalEventHash`. After `BacktestEngine.run()` returns, Phase 12 asserts that `observedEventLedgerSha256 === outcome.eventLedgerSha256`, that `outcome.runId === cell.expectedRunId`, and that `resultSha256 === sha256CanonicalJson(outcome without resultSha256)`. The collector packages `CanonicalValidationEvidence` containing all lineage and time-series data, computing `validationEvidenceSha256`. Any mismatch fails closed immediately.

### Q3: How are daily terminal equity observations selected when `ACCOUNT_MARKED` and `FUNDING_APPLIED` share a timestamp?
**Resolution:** Baseline equity is captured at $T = \text{analysisStartMs}$ after same-timestamp event settlement. During $\text{analysisStartMs} < T \le \text{analysisEndExclusiveMs}$, a timestamp-group accumulator processes all events at $T$ in sequence order: `ACCOUNT_MARKED` sets marked equity, and `FUNDING_APPLIED` at the same $T$ updates it with post-funding `accountEquity.equity`. Terminal equity for day $D$ is flushed only after all events at $T$ settle, guaranteeing funding cash flows are incorporated.

### Q4: What exact return series feeds Sharpe and Sortino?
**Resolution:** Cost-inclusive UTC daily net returns $R_d = \frac{E_d - E_{d-1}}{E_{d-1}}$ evaluated in 128-digit Decimal arithmetic, reflecting realized PnL, unrealized mark adjustments, maker/taker fees, spread attribution, slippage attribution, and funding debits/credits across the $N$ days.

### Q5: What are the exact zero-denominator and insufficient-sample semantics?
**Resolution:** Modeled as a discriminated union: `VALUE`, `UNDEFINED`, or `INSUFFICIENT_DATA`. Insufficient daily observations ($N < \text{metricPolicy.minDailyObservations}$) or trades emit `INSUFFICIENT_DATA` with `{ count, required }`. Zero sample variance, zero downside deviation, zero losing trades, non-positive baseline equity, or non-positive simulated equity emit `UNDEFINED` with typed reason codes. `NaN` and `Infinity` are strictly barred.

### Q6: What exact chronology prevents train/OOS/holdout leakage?
**Resolution:** Safe-integer UTC midnight boundaries ($t \pmod{86\,400\,000} === 0$). Walk-forward steps forward with $\text{stepDays} === \text{testDays}$ producing $K$ complete, non-overlapping OOS windows ($K = \max\{j \mid \text{OOS\_end}(j-1) \le \text{holdoutStartMs}\}$). Any trailing gap is disclosed as `unusedTailMs`. Final holdout is strictly in the future ($\text{holdoutStartMs} \ge \text{OOS\_end}(K-1)$). Indicator warmup is quarantined before the evaluation window.

### Q7: How does Phase 12 prevent a changed candidate set from claiming reuse of an old holdout?
**Resolution:** The entire candidate parameter space is hashed directly into `validationPlanId`. Adding, removing, or modifying even a single candidate produces a new `validationPlanId`. Furthermore, human freshness is governed by plan-bound `holdoutExposureDeclaration`: declaring `PREVIOUSLY_OBSERVED` prevents satisfying fresh holdout gates.

### Q8: How are stress runs proven to be genuine new Phase 9 runs?
**Resolution:** Phase 9 `costModel` is part of `BacktestRunManifest`. Stress matrix plans reuse `validationPlan.pairBindings` without altering execution quantities or market resources, updating only the `costModel`. Updating the cost model alters the manifest canonical JSON, generating a brand-new Phase 9 `runId` ($\text{runId} = \text{sha256CanonicalJson}(\text{manifest})$). Executing the engine produces real fills, different accounting balances, a new `resultSha256`, and a new `eventLedgerSha256`. Synthetic cost deduction cannot produce these cryptographic proofs.

### Q9: What deterministic algorithm and seed produce Monte Carlo permutations?
**Resolution:** Seed derived via HMAC-SHA256 over plan, subject, fold, scenario, and policy IDs. Generates pseudorandom 32-bit words via SHA-256 counter mode. Employs unbiased rejection sampling to eliminate modulo bias, driving a Fisher-Yates shuffle of daily net returns to calculate permuted path drawdown distributions without `Math.random`. Path simulated equity is evaluated with high-water-mark tracking, and adverse drawdown is selected at configured `plan.monteCarlo.adversePercentile` via exact integer rank.

### Q10: What exact V1 overfitting method is used, with mathematical definition?
**Resolution:** Deflated Sharpe Z-Score (`P12_DEFLATED_SHARPE_Z_V1`). Evaluated on aggregate OOS daily returns in per-day units: $\text{deflatedSharpeZ} = \frac{\widehat{SR} - SR_0}{\sigma_{\widehat{SR}}}$. For candidate family size $M === 1$, $SR_0 = 0$ outside logarithms. For $M > 1$, $SR_0 = \sqrt{2 \ln M} \times \sigma_{\{SR\}} \left( 1 - \frac{\gamma + \ln(\ln M)}{2 \ln M} \right)$. Estimator variance $\sigma_{\widehat{SR}}^2 = \frac{1 - \text{skewness} \cdot \widehat{SR} + \frac{\text{kurtosis} - 1}{4} \widehat{SR}^2}{N - 1}$ incorporates sample skewness and Pearson kurtosis. Gated against plan-bound `minDeflatedSharpeZ`.

### Q11: How does the architecture prevent Phase 12 from becoming Phase 15 ranking?
**Resolution:** Phase 12 results contain no rank fields, no composite scores, no winner flags, and no capital allocation weights. Results are sorted strictly by `validationSubjectId` ascending. Each subject receives an independent binary gate evaluation (`PASSED`, `FAILED`, `INSUFFICIENT_EVIDENCE`). Phase 15 is explicitly designated as the sole ranking authority.

### Q12: How can the same candidate be identified across folds when fold-specific `strategyInstanceId` changes?
**Resolution:** Defined as `ResearchValidationSubject` with $\text{validationSubjectId} = \text{sha256CanonicalJson}(\{ \text{pair}, \text{strategyId}, \text{strategyVersion}, \text{parameterHash} \})$, which is invariant across folds. Variations in pair execution bindings (such as datasets, quantities, or funding schedules) change `validationPlanId` and run lineage rather than the cross-fold subject identity. Fold-specific `strategyInstanceId`, `matrixCellId`, and `runId` values are recorded as execution lineage under that invariant subject.

### Q13: What is canonical and hashed versus telemetry-only?
**Resolution:** Canonical (hashed in `validationPlanId` and `validationResultSha256`): `validationPlanId` (which binds `pairBindings`, derived `pairUniverse`, windows, candidate spaces, walk-forward, holdout, cost models, and thresholds), overall status, summary counts, `totalFolds`, `unusedTailMs`, `freshnessBasis`, and per-subject digests sorted by `validationSubjectId` ascending. Telemetry-only (excluded): start/end timestamps, wall-clock duration (`durationMs`), worker concurrency count, process ID, hostname, memory usage, and console output.

### Q14: What happens if Phase 11 cache has a completed result but Phase 12 lacks event evidence?
**Resolution:** Phase 12 dependencies structurally omit the cache property, preventing Phase 11 from returning cached results. In addition, Phase 12 asserts that every cell reporting `COMPLETED` has an authentic finalized collector; missing evidence fails closed with `EVIDENCE_INTEGRITY_FAILURE`.

### Q15: What is the minimal Phase 11 integration extension and why does it not change Phase 11 identities?
**Resolution:** Passing an optional `eventSinkFactory` to `MatrixExecutionOptions` which forwards to `new BacktestEngine(config, sink)`. This has zero impact on `BacktestRunManifest`, Phase 9 `runId`, `matrixPlanId`, `matrixCellId`, or `resultSha256`. The execution path remains authoritative and single-source.
