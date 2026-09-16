# Strategy Ranking — Phase 15 Architecture & Specification

## 1. Purpose & Scope Boundary

Phase 15 owns **deterministic Strategy × Coin ranking**. It answers exactly one question:

> **Among the candidates of a single trading pair that genuinely PASSED Phase 12 research validation, what is the deterministic ordinal quality ordering under one frozen, fully-disclosed policy?**

The ranking unit is the existing **Coin × Strategy validation subject** — `BTC × EMA_TREND`, `BTC × ATR_BREAKOUT`, `ETH × EMA_TREND`, `ETH × RSI_MOMENTUM`. Phase 15 creates no coin-specific strategy implementation and no new candidate identity: it reuses Phase 12's `validationSubjectId` verbatim (Invariant 17, Invariant 26).

Phase 15 output is **read-only analytical evidence**. It is structurally incapable of:

| Forbidden | How it is prevented |
| :--- | :--- |
| Placing an order | No CoinDCX integration module is transitively reachable from `src/ranking/**` |
| Mutating Phase 14 account state | No `src/execution/**` module is transitively reachable |
| Changing risk admission | No `src/risk/**` or `src/dispatch/**` module is transitively reachable |
| Promoting to `PAPER_APPROVED` / `SHADOW` / `LIVE_CANDIDATE` / `LIVE` | No coin-runtime lifecycle module is reachable; every result is permanently `promotionEligible: false` |
| Inventing funding economics | Phase 15 restates the frozen Phase 14 limitation and adds nothing to it |
| Re-running Phase 12 validation as a shortcut | The Phase 12 executor and planner are not imported anywhere in `src/ranking/**` |

`tests/architecture/phase15-ranking-boundary.test.ts` proves each row above against a true transitive TypeScript import graph (type-only imports counted as real edges), not a direct-import grep.

---

## 2. Input Authority

### 2.1 The single admission path

The only way a candidate enters a ranked universe is the **existing Phase 12 approval authority**:

```
rankStrategyCandidates({ planResult, candidates })
        │
        ▼
deriveAuthoritativeRankingEvidence(planResult, subject)     [src/ranking/evidence.ts]
        │
        ▼
issueResearchApprovalOrigin(planResult, subject)            [Phase 12, unchanged]
        │
        ├─ planResult not a genuine executor output (WeakSet miss)  → null
        ├─ recomputed validationSubjectId not found in the result   → null
        ├─ matching record's verdict is not exactly PASSED          → null
        └─ otherwise → ResearchApprovalOrigin
```

Phase 15 adds **no weaker parallel validation path**. It does not recompute a verdict, does not re-hash a record to "check" it, and does not accept a caller-created metric DTO. Metric values are read out of the *same genuine, deep-frozen* `StrategyValidationRecord` that the origin was issued from, so a coordinated "tampered metric + recomputed `validationSubjectResultSha256`" substitution has nothing to substitute into: the mutated clone is not the WeakSet-tracked object, so no origin is ever issued for it.

After the origin is issued, Phase 15 additionally re-checks that the record and the origin agree on `pair`, `strategyId`, `strategyVersion`, `parameterHash` and `validationSubjectResultSha256` before reading a single number.

### 2.2 Terminal status admission

| Phase 12 terminal status | Phase 15 |
| :--- | :--- |
| `PASSED` | Rankable candidate |
| `FAILED` | `NOT_ELIGIBLE` |
| `INSUFFICIENT_EVIDENCE` | `NOT_ELIGIBLE` |
| absent / forged / aborted | `NOT_ELIGIBLE` |

Phase 15 deliberately does **not** report *which* of those it was. Distinguishing `FAILED` from `INSUFFICIENT_EVIDENCE` from "forged" would require reading fields of an object whose genuineness has not been proven. Every rejection carries the single reason code `VALIDATION_SUBJECT_NOT_AUTHORITATIVE`.

A `NOT_ELIGIBLE` row carries only the **caller-declared** identity, is explicitly labelled as such (`declaredPair`, `declaredStrategyId`, …), carries no ranking evidence, and is **not part of any `rankingRunId`** — junk input therefore cannot perturb an authoritative run identity.

### 2.3 Bound identities

Every authoritative row binds the full existing lineage: `pair`, `strategyId`, `strategyVersion`, `parameterHash`, `validationSubjectId`, `validationPlanId`, `validationSubjectResultSha256`.

The **source Git identity** is bound transitively rather than duplicated. Phase 12 defines `validationPlanId = sha256CanonicalJson(plan)`, and the plan carries `sourceIdentity.gitCommitHash` (captured from a verified-clean tree). Binding `validationPlanId` therefore cryptographically binds the commit; Phase 15 mints no second, weaker Git identity of its own.

---

## 3. `P15_RANKING_V1`

One frozen policy object (`src/ranking/policy.ts`) holds every outcome-affecting decision. Weights are not scattered through the code, and `rankingPolicyId = sha256CanonicalJson(P15_RANKING_V1)`.

### 3.1 Components and weights

| Component | Weight | Direction | Phase 12 authoritative source |
| :--- | ---: | :--- | :--- |
| `SHARPE` | 25% | higher is better | `aggregateOosMetrics.sharpe` |
| `SORTINO` | 15% | higher is better | `aggregateOosMetrics.sortino` |
| `MAX_DRAWDOWN` | 20% | **lower is better** | `aggregateOosMetrics.maxDrawdownPercent` |
| `PROFIT_FACTOR` | 15% | higher is better | `aggregateOosMetrics.netDailyProfitFactor` |
| `EXPECTANCY` | 10% | higher is better | `aggregateOosMetrics.netDailyExpectancy` |
| `OOS_CONSISTENCY` | 10% | higher is better | `GATE-08 MIN_OOS_FOLD_PASS_RATIO.observedValue` |
| `PARAMETER_ROBUSTNESS` | 5% | higher is better | `parameterNeighborhoodSensitivity` |

Total = 100%, asserted at module load under exact Decimal arithmetic. A weight table that no longer sums to 1, a duplicated component, a tie-break level missing from the rule table, or a loosened economic limitation is a **load-time failure**, never a silently mis-scored ranking.

### 3.2 Disclosed adaptations to the real Phase 12 contract

Phase 15 invents **no** new derived market statistic. Where the generic metric names differ from what Phase 12 actually computes, the adaptation is:

1. **Profit factor / expectancy bind the NET DAILY variants.** Phase 12 computes both `grossTradeProfitFactor`/`grossTradeExpectancy` and `netDailyProfitFactor`/`netDailyExpectancy`. Only the net daily pair is the approval-gated authority (`GATE-06`/`GATE-07` against `minNetDailyProfitFactor`/`minNetDailyExpectancy`). Binding the gated variant keeps Phase 15 aligned with the exact numbers that produced the `PASSED` verdict it depends on.
2. **OOS consistency is a gate-observed value, not a `ValidationMetrics` field.** Phase 12 computes `passingOosFolds / totalFolds` in canonical Decimal and publishes it as `GATE-08.observedValue`. Phase 15 reads that published value and does **not** recompute a fold ratio of its own. A `GATE-08` whose status is `UNAVAILABLE`/`DISABLED`, whose name does not match, or whose `observedValue` is not a canonical decimal string makes the candidate fail closed.
3. **Max drawdown binds the percent form** (`maxDrawdownPercent`), the same form `GATE-05` gates, so the component is comparable across candidates with different capital bases.
4. **Parameter robustness binds Phase 12's neighbourhood sensitivity statistic** (mean neighbour OOS Sharpe ÷ target OOS Sharpe). Phase 15 applies the mandated `HIGHER_IS_BETTER` direction to the Phase 12 value **unchanged** and performs no transform of its own.

### 3.3 Required-metric guarantee and the one gap

`subjectVerdict` returns `PASSED` only when no gate is `FAIL` **and** no gate is `UNAVAILABLE`, and `metricGate` returns `UNAVAILABLE` for every non-`VALUE` metric. A `PASSED` subject therefore mathematically guarantees `sharpe`, `sortino`, `maxDrawdownPercent`, `netDailyProfitFactor` and `netDailyExpectancy` are `VALUE`. `GATE-08` is always `VALUE` because Phase 12 derives it from two integers.

**`parameterNeighborhoodSensitivity` is the exception.** Phase 12 produces it only when the validation plan declares a `parameterNeighborhoods` mapping for the subject's `parameterHash`, and it is never gated — so `PASSED` does not guarantee it. Per the fail-closed rule it is **not** coerced to zero and the remaining weights are **not** silently redistributed; the candidate becomes `INSUFFICIENT_RANKING_EVIDENCE`.

> **Operational consequence:** declaring `parameterNeighborhoods` in the Phase 12 validation plan is a precondition for a subject to be rankable under `P15_RANKING_V1`.

Phase 15 re-checks all seven components at runtime rather than relying on the proof above.

---

## 4. Normalization — no arbitrary financial units

`P15_CANDIDATE_SET_RELATIVE_DENSE_ORDINAL_V1`.

Phase 15 invents **no absolute ceiling** ("Sharpe 3 = perfect"). A component is normalized only against the other candidates of the same pair:

1. Collect the candidates' canonical component values.
2. Reduce to the **distinct** values and order them best → worst by exact Decimal comparison — descending for `HIGHER_IS_BETTER`, ascending for `LOWER_IS_BETTER`. For a lower-is-better metric the **ordering is inverted, never the numeric sign**.
3. Give each distinct value a dense ordinal position `d ∈ [0, D-1]`, so exactly equal metric values necessarily receive exactly equal component scores.
4. `componentScore = D === 1 ? 1 : (D - 1 - d) / (D - 1)`.

A universe with one distinct value — which includes every single-candidate universe — scores `1` for that component.

Nothing in the normalizer reads a clock, a worker id, a database insertion order, or an object key-iteration order. The only inputs are the candidate values.

### 4.1 Composite score

`compositeScore = Σ weightedScore_i`, where `weightedScore_i = weight_i × componentScore_i`, summed in **frozen policy order** rather than caller array order.

Each weighted term is quantized once and then summed, so the seven published `weightedScore` values **re-add to the published `compositeScore` with no residue** — a ranked row is self-auditable by hand.

### 4.2 Decimal semantics

| Property | Value |
| :--- | :--- |
| Calculation precision | 128 digits (the repository's existing isolated context) |
| Published scale | 18 decimal places, `DECIMAL(48,18)` contract |
| Rounding | `ROUND_HALF_UP` |
| Native JS floating point | **Forbidden** |

The only `number` values Phase 15 computes with are integer ordinal positions and candidate counts, and they are converted to Decimal before any division. Every authoritative input string is canonicalized on the way in, so `"1.50"`, `"1.5"` and `"+1.5"` produce one identical ranking identity, while a `1e-18` difference is preserved and separates candidates.

---

## 5. Pair-local ranking

Candidates are ranked **within each pair**. `rankStrategyCandidates` returns one independent `StrategyRankingRun` per pair, each with its own `rankingRunId`, sorted by pair ascending.

There is no cross-coin ordinal leaderboard in V1, so no cross-coin capital-allocation or regime-comparability assumption is made. Isolation is structural, not conventional: a BTC run's identity literally cannot contain an ETH candidate, and adding, removing or changing every ETH candidate leaves the BTC run bit-for-bit identical.

---

## 6. Ties

Composite ties are resolved by one frozen precedence list and nothing else:

1. lower `MAX_DRAWDOWN`
2. higher `SHARPE`
3. higher `SORTINO`
4. higher `PROFIT_FACTOR`
5. lexical `validationSubjectId` ascending

Level 5 makes the comparator a **total order** (candidate identities are unique within a run), so the output permutation is identical for every input permutation.

Explicitly **not** used, and structurally absent from the comparator's inputs: `createdAt`, database insertion id, worker index, execution duration, wall clock, randomness.

Each ranked row publishes `compositeTieGroupSize` and `tieBreakLevelApplied` — the first level that separated it from its immediate predecessor inside the same composite tie group (`null` when it leads its group or its group has one member).

---

## 7. Identity

| Identity | Binds |
| :--- | :--- |
| `rankingPolicyId` | policy version, schema version, metric set + sources, weights, directions, normalization algorithm, tie-break order, Decimal semantics, economic limitation semantics, `paperEconomicContribution` |
| `rankingRunId` | `rankingPolicyId`, the **pair**, `validationPlanId` (which transitively binds the verified-clean source commit), and the exact candidate universe |
| `rankingResultSha256` | the full content of one result row |
| `rankingRunSha256` | the full content of one completed pair-local run |
| `rankingRunSetSha256` | the full content of the multi-pair run set |

The candidate universe bound into `rankingRunId` contains **every authoritative candidate evaluated for that pair** — ranked and `INSUFFICIENT_RANKING_EVIDENCE` alike — each with its `validationSubjectId`, `validationSubjectResultSha256`, rankability, and the canonical value (or unavailability reason) of every policy component, sorted by `validationSubjectId`.

Binding the component values *directly*, not only the Phase 12 result hash, is what makes a `1e-18` outcome-affecting metric difference produce a different `rankingRunId`. A run identity therefore identifies a **complete evaluated universe**, not only its ranked subset.

Same semantic inputs ⇒ same `rankingRunId`, regardless of worker count, DB insertion order, or caller array order. Any outcome-affecting metric, policy or candidate change ⇒ different `rankingRunId`.

---

## 8. Result contract

```
StrategyRankingRunSet
 ├── rankingPolicyId, schemaVersion, economicStatus, promotionEligible, maxLifecycle, rankingRunSetSha256
 ├── runs[]                       (one per pair, sorted by pair)
 │    └── StrategyRankingRun
 │         ├── rankingRunId, pair, validationPlanId, candidateCount, rankedCount, rankingRunSha256
 │         └── results[]          (RANKED by rank asc, then INSUFFICIENT by subject id asc)
 └── nonAuthoritativeCandidates[] (NOT_ELIGIBLE; never part of any rankingRunId)
```

Discriminated result states:

| Status | Meaning | Ranked-only fields |
| :--- | :--- | :--- |
| `RANKED` | Authoritative and complete | `componentScores`, `compositeScore`, `rank`, `candidateCount`, `compositeTieGroupSize`, `tieBreakLevelApplied` |
| `INSUFFICIENT_RANKING_EVIDENCE` | Authoritative `PASSED` subject, but a required component is absent / `UNDEFINED` / `INSUFFICIENT_DATA` / non-canonical | absent entirely — never a fabricated zero |
| `NOT_ELIGIBLE` | Not provably a genuine Phase 12 `PASSED` subject | absent entirely |

Every row carries the frozen economic fields below, and every returned object graph is deeply frozen.

---

## 9. Funding exclusion & the Phase 14 paper boundary

### 9.1 The frozen economic fields

Every Phase 15 result — run set, run, and row — carries:

```
economicStatus     = FUNDING_EXCLUDED
promotionEligible  = false
maxLifecycle       = PAPER
```

plus the reason codes `FUNDING_EXCLUDED` and `PROMOTION_BLOCKED_FUNDING_EXCLUDED`. `P15_ECONOMIC_LIMITATION` restates Phase 14's frozen disclosure (`FUNDING_UNSUPPORTED`, `COINDCX_PROVIDER_EVIDENCE_INCOMPLETE`, `fundingApplied: false`, `PAPER_NOT_ECONOMICALLY_COMPLETE`, `FUNDING_EXCLUDED_PNL`) and **never widens it**. There is no enabled variant and no setter.

It is declared as Phase 15 literals rather than imported from `src/execution/funding-capability.ts` because the Phase 15 architecture gate forbids any `src/ranking/** → src/execution/**` edge, including a type-only one. `tests/unit/ranking/economic-limit.test.ts` asserts field-by-field equality against the genuine Phase 14 disclosure, so the two cannot drift.

### 9.2 Why paper PnL is not a ranking input

Because funding is excluded, paper PnL is not an economic performance signal. `P15_RANKING_V1.paperEconomicContribution = 'NONE'`, and that is enforced **structurally**, not by a zero weight or a test convention:

- `rankStrategyCandidates` has **no parameter** through which any paper value can be supplied;
- `RankingCandidateEvidence` carries only the seven policy components, none of which is a paper value;
- the ranking core computes and **deep-freezes** `compositeScore`, `rank`, `rankingRunId`, `rankingResultSha256`, `rankingRunSha256` and `rankingRunSetSha256` before any observation exists;
- `attachPaperObservations(ranking, observations)` only **wraps** that sealed evidence and re-emits it *by reference*.

Changing a paper PnL therefore cannot change a composite score, a rank, or a ranking identity — the value never reaches the code that computes them. `rankingRunId` is deliberately independent of every non-ranking paper observation.

### 9.3 The observation view

```ts
PaperObservationView =
  | { status: 'OBSERVED', economicStatus, fundingCapability, fundingCapabilityReason,
      fundingApplied: false, paperEconomicStatus, maxLifecycle, promotionEligible: false,
      lineage, mechanicalHealth, nonAuthoritativeFundingExcluded }
  | { status: 'NOT_OBSERVED'   | 'LINEAGE_UNPROVEN', economicStatus, maxLifecycle, promotionEligible: false, reason }
```

`mechanicalHealth` carries only non-economic durable facts: `reconciliationStatus`, `observationDurationMs`, `fillCount`, `closedTradeCount`, `runtimeFaultCount`.

Every economic number is wrapped in `FundingExcludedObservationalValue`, whose *type* carries `label: 'FUNDING_EXCLUDED_PNL'`, `authoritative: false` and `affectsCompositeScore: false` — there is no way to submit or display an unlabelled paper economic number.

`lineage` requires the durable Phase 14 identifiers (`accountId`, `accountRevision`, `executionPolicySnapshotId`, `instrumentEconomicsSnapshotId`) plus the full Coin × Strategy identity. `attachPaperObservations` re-checks that identity against the authoritative ranked row and downgrades a mismatch to `LINEAGE_UNPROVEN` rather than attaching a foreign observation.

> **V1 boundary, stated plainly.** Phase 15 ships the observation *contract* and the identity-binding check, but **no Phase 14 durable reader**: wiring one would create the `src/ranking/** → src/execution/**` edge the architecture gate forbids, and is outside Phase 15's analytical scope. A paper observation is therefore adapter-supplied observational metadata, never authority. That is acceptable precisely because it is provably incapable of affecting anything authoritative.

---

## 10. Promotion firewall

Mechanically:

- every result is `promotionEligible: false` while `economicStatus = FUNDING_EXCLUDED` and `maxLifecycle = PAPER`;
- all three values flow from one function (`rankingEconomicFields()`), which throws `RANKING_ECONOMIC_LIMIT_VIOLATION` if the frozen limitation is ever weakened — there is no branch that emits anything else;
- no `src/ranking/**` file transitively reaches `src/coin-runtime/registry.ts` or `src/coin-runtime/lifecycle.ts`, so `transitionLifecycle` is unreachable;
- no Phase 15 source file contains `PAPER_APPROVED`, `LIVE_CANDIDATE`, `RESEARCH_APPROVED` or a `SHADOW` string literal in executable code;
- the persistence layer refuses to write a run whose economic fields have been weakened.

A Phase 15 rank is a research-quality ordering. It is **not** a promotion, and it never becomes one.

---

## 11. Failure modes

| Condition | Behaviour |
| :--- | :--- |
| Empty declared candidate universe | throws `EMPTY_RANKING_UNIVERSE` — never a fake ranking |
| Two candidates with the same declared identity tuple | throws `DUPLICATE_RANKING_CANDIDATE` |
| Two candidates resolving to the same `validationSubjectId` | throws `DUPLICATE_RANKING_CANDIDATE` |
| One pair mixing candidates from different validation plans | throws `RANKING_EVIDENCE_CONFLICT` |
| Non-canonical / non-finite decimal anywhere | throws `RANKING_NUMERIC_FAILURE` |
| Weights, tie-break table or economic limitation inconsistent | throws `RANKING_POLICY_INVALID` / `RANKING_ECONOMIC_LIMIT_VIOLATION` at module load |
| Required metric absent / `UNDEFINED` / `INSUFFICIENT_DATA` / non-canonical | candidate → `INSUFFICIENT_RANKING_EVIDENCE` (fail closed) |
| Subject not provably a genuine Phase 12 `PASSED` subject | candidate → `NOT_ELIGIBLE` |
| Every candidate of a pair unrankable | explicit empty leaderboard (`rankedCount: 0`), never a fabricated order |
| Stored run disagrees with a recomputed run under the same id | throws `RANKING_EVIDENCE_CONFLICT` — never an overwrite |

---

## 12. Persistence & restart behaviour

Two additive, immutable tables — `ranking_run` and `ranking_result` — introduced by `prisma/migrations/20260916120000_phase15_strategy_ranking`. The migration creates only those two tables and the foreign key between them: **no existing table is altered, no column is dropped, and there is no backfill.** Historic runs are simply absent rather than invented, because a ranking run is a deterministic function of Phase 12 evidence and can always be recomputed rather than guessed.

- `ranking_run`'s primary key **is** the deterministic `rankingRunId`, so re-running the same semantic ranking is idempotent (`ALREADY_IDENTICAL`) rather than duplicative.
- `ranking_result`'s primary key **is** the row's own content hash (which itself binds `rankingRunId`).
- `UNIQUE(ranking_run_id, validation_subject_id)` allows exactly one row per candidate per run.
- `composite_score` is `DECIMAL(36,18)` and crosses the boundary as a canonical fixed-point string; no float is ever persisted.
- Ranked-only columns are `NULL` for an `INSUFFICIENT_RANKING_EVIDENCE` row — never a fabricated zero score or rank.
- `StrategyRankingRepository` exposes `persistRun` and `persistRunSet` only. There is **no update and no delete method**: completed ranking evidence cannot be rewritten. A same-id/different-content write fails closed.
- No Phase 12 result and no Phase 14 paper ledger row is read, written, or referenced by foreign key; no pre-Phase 15 model gains a relation into the ranking tables.

**Restart:** nothing needs replaying. Recomputing after a restart yields the same `rankingRunId` and the same content hash, and re-persisting is a no-op.

---

## 13. Module layout

```
src/ranking/
├── types.ts                       contracts (no logic)
├── policy.ts                      P15_RANKING_V1 + rankingPolicyId + self-validation
├── numeric.ts                     exact Decimal helpers
├── errors.ts                      RankingError / RankingErrorCode
├── evidence.ts                    authoritative Phase12 input adapter (the ONLY evidence producer)
├── normalize.ts                   ordinal normalizer
├── score.ts                       composite scorer
├── tie-break.ts                   frozen total ordering
├── identity.ts                    rankingRunId + content hashes
├── core.ts                        pure ranking core (normalize → score → tie-break → seal)
├── engine.ts                      rankStrategyCandidates — the public entry point
├── paper-observation.ts           non-authoritative Phase14 observation decorator
├── persistence/
│   ├── ranking-repository.ts      append-only repository over a narrow store port
│   └── prisma-ranking-store.ts    MySQL store (Prisma client always injected)
└── index.ts                       narrow public barrel
```

The barrel deliberately **does not** re-export `core.ts`, `normalize.ts`, `score.ts`, `tie-break.ts`, `identity.ts` or `evidence.ts`. The only public way to obtain an authoritative Phase 15 result is `rankStrategyCandidates`, which requires a genuine Phase 12 `ResearchValidationPlanResult`; a caller therefore cannot reach the scorer with a fabricated metric DTO. Those modules remain importable by concrete path for lower-level tests, matching the repository's existing internal-module convention (see the `PaperAdmissionBridge` note in `src/execution/persistence/index.ts`).

---

## 14. Future extension boundary

The following are **explicitly out of scope for V1** and must not be inferred from this document:

- **Cross-coin ranking.** A single leaderboard spanning BTC and ETH requires a capital-normalization and regime-comparability policy that does not exist. V1 ranks within a pair only.
- **Economic paper contribution.** Paper PnL, return, Sharpe, profit factor, expectancy and drawdown may become ranking inputs only after the CoinDCX funding provider gate reopens and Invariant 28's evidence bar is met. Until then `paperEconomicContribution` stays `NONE`.
- **Promotion.** Phase 15 ranks; it does not promote. `PAPER_APPROVED` remains gated by the Phase 14 economic limitation, and `SHADOW` remains a mandatory pre-live gate (Strategy Lifecycle §3.4).
- **A Phase 14 durable observation reader.** Requires a layering decision about whether ranking may read (never write) paper persistence.
- **Weight re-tuning.** Any change to a weight, direction, source, normalization algorithm or tie-break level is a **new policy version** with a new `rankingPolicyId`. `P15_RANKING_V1` is frozen.
