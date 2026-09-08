# Risk / Leverage Engine — Phase 13 Architecture & Specification (Corrected, Round 7)

> **Round 7 note — implementation-blocking corrections:** Phase 13 implementation correctly stopped before touching production code because four spec contradictions made the frozen document unimplementable. All four are closed here, tagged `[P13-SPEC-00n]`: **001** — "field-for-field identical" between `PositionSizingDecision.sizing` and `AcceptedOpenRiskDecision.approved` is retracted (the shapes are deliberately different) and replaced by an exact seven-field canonical projection table (§7.5.1). **002** — well-formed valuation mismatches no longer throw `RISK_SOURCE_INVALID` (Group C), contradicting §13.2; they are Group B rejections using existing granular codes plus two new codes, `VALUATION_METHOD_MISMATCH` and `VALUATION_NUMERIC_CONTEXT_EXCEEDED` (§2.8.1 step 2, §17, one entry each in `REJECTION_PRECEDENCE_V1`). **003** — a future-dated settlement rate is `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION`, never `SETTLEMENT_RATE_STALE`, which is now exclusively an age-limit breach on causally valid evidence (§15.3). **004** — `RiskFreshnessPolicy` gains `riskFreshnessPolicyId`, bound into `riskPolicyId` (§8.3, §11.4), so no decision-affecting freshness threshold can change without changing every downstream identity. No Phase 13 architecture was redesigned and no previously closed finding was reopened.

> **Round 6 note:** Round 6 closes the last open item of `P13-B03`: **signed-quantity semantics**. CoinDCX's authoritative `activePositionQuantity` is signed; `PairPositionState` normalized it to a magnitude, but nothing forbade a *negative instance* quantity, so a mixed-sign instance set (`+2`, `-1`) could reconcile by cancellation against an aggregate magnitude of `1`. Round 6 freezes the single signed-to-magnitude normalization boundary (§3.1.2, with `side`/`quantity` renamed to `positionDirection`/`quantityMagnitude` so the names cannot invite a signed reading), requires every instance quantity to be a strictly-positive magnitude with zero shares represented by omission, and makes direction inheritable only from the `OPEN` parent — never encodable in an instance quantity's sign (§2.8.2). Mixed-sign sets are now structurally impossible in `RECONCILED` state. Round-6 edits are tagged `[P13-B03 R6]`; **no new rejection code was added**, and no previously-closed section was reopened.

> **Round 5 note:** Round 5 closes the last open item of `P13-B03`: current-**notional** reconciliation was previously delegated to unspecified adapter rules, and `PairRiskSnapshot` carried no authoritative aggregate current INR notional. Round 5 freezes the complete valuation contract — `CanonicalPositionValuation` on `PairPositionState.OPEN` (§3.1.1), the `RiskValuationPolicy` that versions it (§10.5, bound into `riskPolicyId`), the exact two-step derivation with a single quantization point, the engine-side recomputation, and exact tolerance-free canonical-Decimal equality for aggregate reconciliation (§2.8.1). Round-5 edits are tagged `[P13-B03 R5]`; **no new rejection code was added**, and no Round-1/2/3/4-closed section was reopened. Everything below this note is unchanged from Round 4 except where tagged R5.

> **Revision note:** This document has been corrected four times. Round 1 closed a consolidated review (4 blockers, 9 major findings, 1 minor finding, 3 evidence gaps) tagged `[P13-xxx]` at first mention. Round 2 closed 9 remaining findings tagged `[P13-xxx R2]`. Round 3 closed 4 findings tagged `[P13-xxx R3]`. Round 4 (this revision) closes the single remaining blocker from an ultra-narrow targeted re-review: `P13-B03` — `InstanceOwnershipRecord`/`InstancePendingReservation` now bind the complete four-field strategy identity (`strategyInstanceId` + `strategyId` + `strategyVersion` + `parameterHash`), never `strategyInstanceId` alone, and `PositionOwnershipState`'s single `RECONCILED` shape (which forced a required-but-fabricated `positionId` on a `FLAT` pair) is replaced by a proper `ReconciledFlatOwnership | ReconciledOpenOwnership` discriminated union. Round-4 edits are tagged `[P13-xxx R4]`. Everything not tagged R4 is unchanged Round-1/2/3-closed architecture. No production code exists for Phase 13; this document remains architecture-only.

## 1. Executive Summary & Scope Boundary

Phase 13 defines the **Risk / Leverage Engine** for the **CoinDCX Quant Futures Bot**: the single, non-bypassable, deterministic arbiter between a genuine Phase 10 `StrategyDecision` and any future execution intent. It answers one question, and only one:

> **Given a strategy's actual target-exposure decision, a separately-provenanced entry/stop reference, the selected risk mode, and the exact current state of the account, the pair, the portfolio, and CoinDCX's dynamic leverage tiers — is a specific quantity, at a specific leverage, at a specific estimated risk, safe to take, and if so, exactly how much?**

```
┌───────────────────────────────────────────────────────────────────────────┐
│           PHASE 10: STRATEGY FRAMEWORK (Upstream, real contract)          │
│  BaseStrategyKernel.evaluate() emits the genuine StrategyDecision:        │
│  { decisionId, decisionSequence, strategyInstanceId, strategyId,          │
│    strategyVersion, parameterHash, pair, evaluationTimeMs,                │
│    triggerTimeframeMinutes, status: WARMING|READY,                        │
│    targetExposure: LONG|SHORT|FLAT|null, reasonCodes }                    │
│  — carries NO price, NO leverage, NO quantity (Invariant 9/24).           │
└──────────────────────────────────────┬────────────────────────────────────┘
                                       │ status === 'READY' only (§4.2)
                                       ▼
┌───────────────────────────────────────────────────────────────────────────┐
│     BRIDGE: StrategyRiskCandidate + separately-provenanced proposals      │
│  (already-selected pair/instrument; entry/stop/leverage proposals are     │
│   distinct, versioned, provenance-bound inputs — §4.2–§4.4)               │
└──────────────────────────────────────┬────────────────────────────────────┘
                                       ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    PHASE 13: RISK / LEVERAGE ENGINE                      │
│                                                                           │
│  1. Identity & action derivation (OPEN / CLOSE / NO_CHANGE / REVERSAL_DEFERRED) │
│  2. Snapshot provenance & freshness gating (policy-owned max age)        │
│  3. Instrument tradeability & price/reference validation                 │
│  4. Position Sizing (risk-budget ceiling, §6)                            │
│  5. Finite Leverage-Tier Enumeration → PositionSizingDecision (§7)       │
│  6. Exposure, Loss & Drawdown Gates (gross notional, §9–§10)             │
│  7. Deterministic RiskDecision: AcceptedOpenRiskDecision | AcceptedCloseRiskDecision | RejectedRiskDecision │
└──────────────────────────────────────┬────────────────────────────────────┘
                                       │ Immutable, replayable, SCOPE-LIMITED
                                       ▼                (§16 — not valid forever)
┌───────────────────────────────────────────────────────────────────────────┐
│           FUTURE PHASES (Explicitly Out of Scope for Phase 13)           │
│   Phase 14: Paper Trading (turns ACCEPTED into ExecutionIntent)          │
│   Phase 15: Strategy Ranking & Promotion                                 │
│   Phase 17/18: Live Execution + Revalidation before mutation (§16)       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Strict Anti-Scope

Unchanged from the original freeze — Phase 13 does **NOT**: place live orders or call any CoinDCX private order/leverage-mutation endpoint (Invariant 20); construct or persist `ExecutionIntent`; implement paper/shadow execution (Phase 14); rank/score/promote strategies (Phase 15); fabricate CoinDCX leverage, margin, or conversion data; compute fills or own position truth (Invariant 13); perform adaptive/ML risk adjustment, cross-exchange logic, or news-based modulation (Phase 24); or compute a liquidation price (§8.3 — explicitly deferred, not fabricated).

### 1.2 Core Flow (corrected lineage) `[P13-M01]`

$$\text{StrategyDecision (status=READY)} \longrightarrow \text{StrategyRiskCandidate} \longrightarrow \text{PositionSizingDecision} \longrightarrow \text{RiskDecision} \longrightarrow \{\text{ACCEPTED}, \text{REJECTED}\}$$

The project's frozen future lineage is:
$$\text{StrategyDecision} \to \text{InstrumentSelectionDecision} \to \text{PositionSizingDecision} \to \text{RiskDecision} \to \text{ExecutionIntent}$$

**`InstrumentSelectionDecision` does not exist yet.** Phase 13 does not implement it and does not pretend an already-selected instrument identity comes from it. Phase 13 V1 requires the caller (a future bridge) to supply an already-resolved `pair` and `instrumentSpecSnapshotId` as part of `StrategyRiskCandidate`/`PairRiskSnapshot`; Phase 13 treats instrument selection as a precondition it consumes, not a decision it makes.

**`PositionSizingDecision` is frozen as a first-class canonical output** (Option A of the two models under consideration — chosen because it is named explicitly in the roadmap lineage above and in the original Phase 13 kickoff brief). `RiskDecision` wraps a `PositionSizingDecision` with exposure/loss/drawdown gates and the final ACCEPT/REJECT envelope (§7, §11). Phase 13 does not yet build `ExecutionIntent`.

Phase 13 is a **pure function** of its inputs: `evaluateRisk(context: RiskEvaluationContext): RiskDecision`. It performs no I/O, no persistence, and reads no wall clock — `RiskEvaluationContext.evaluationTimeMs` is the only time reference used anywhere inside the pure engine (§8.4).

---

## 2. Real StrategyDecision Lineage `[P13-B01]`

### 2.1 The Actual Phase 10 Contract

Phase 13 binds to the genuine `StrategyDecision` (`src/strategies/core/types.ts`), not an imagined superset:
```typescript
// VERBATIM Phase 10 contract — Phase 13 adds nothing to this type.
export type StrategyDecisionStatus = 'WARMING' | 'READY';
export type StrategyTargetExposure = 'LONG' | 'SHORT' | 'FLAT';

export interface StrategyDecision {
  readonly decisionId: string;
  readonly decisionSequence: number;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly pair: string;
  readonly evaluationTimeMs: number;
  readonly triggerTimeframeMinutes: number;
  readonly status: StrategyDecisionStatus;
  readonly targetExposure: StrategyTargetExposure | null;
  readonly reasonCodes: readonly string[];
}
```
It carries **no** entry price, stop price, requested leverage, quantity, side, or "candidate intent" field. Any earlier claim that Phase 13 reads these directly off `StrategyDecision` is retracted.

### 2.2 Decision Identity Is Independently Verifiable

The genuine `BaseStrategyKernel.evaluate()` (`src/strategies/core/kernel.ts:140-153`) computes:
```typescript
decisionId = strategySha256CanonicalJson({
  strategyInstanceId, decisionSequence, evaluationTimeMs,
  triggerTimeframeMinutes, status, targetExposure, reasonCodes,
});
```
Every field this hash depends on is present verbatim on the public `StrategyDecision` object. Phase 13's bridge therefore consumes the **entire, unmodified `StrategyDecision` object** (a lossless projection is unnecessary — nothing needs to be dropped) and **independently recomputes** `decisionId` via the identical canonical-JSON algorithm before constructing a `StrategyRiskCandidate`. A recomputation mismatch fails closed with `DECISION_IDENTITY_MISMATCH` (§13, Group B) — Phase 13 never trusts a caller-asserted `decisionId` it has not itself re-derived.

### 2.3 WARMING Is Non-Actionable — Structurally, Not by Convention

`BaseStrategyKernel.validateOutcome` already enforces `status === 'WARMING' ⇒ targetExposure === null` at the kernel level. Phase 13 freezes the consuming side of this: **a `StrategyDecision` with `status !== 'READY'` never reaches the sizing/leverage pipeline.** The bridge that constructs `StrategyRiskCandidate` from a `StrategyDecision`:
- for `status === 'WARMING'`: produces **no** `StrategyRiskCandidate` and **no** `RiskDecision` at all — this is a structural no-op, not a rejection (there is nothing to accept or reject; the strategy has not signaled).
- for `status === 'READY'`: proceeds only if `targetExposure !== null` (guaranteed by the kernel's own invariant); if a caller-supplied bridge somehow presents `status === 'READY'` with `targetExposure === null`, this is a Group C construction fault (`RISK_SOURCE_INVALID`) — it means the bridge fabricated an inconsistent object, since a genuine Phase 10 kernel can never emit that combination.

### 2.4 Entry/Stop/Leverage Are Separate, Versioned, Provenance-Bound Proposals

Because `StrategyDecision` carries no price or leverage information, and Invariant 9/24 forbid a strategy kernel from ever computing or leaking one, Phase 13 defines three genuinely distinct upstream input types — none of which is fabricated by Phase 13 itself, and none of which is part of `StrategyDecision`:

```typescript
export interface EntryStopProposal {
  readonly proposalId: string;
  readonly proposalPolicyId: string;         // e.g. 'CURRENT_MARK_PRICE_ENTRY_V1' — versioned, external to Phase 13
  readonly sourceStrategyDecisionId: string;  // binds to StrategyDecision.decisionId
  readonly pair: string;
  readonly entryPriceUsdt: string;
  readonly stopPriceUsdt: string;
  readonly provenance: EvidenceProvenance;    // §8 — sourceTimeMs/observedAtMs/contentSha256
}

export interface LeverageProposal {
  readonly proposalId: string;
  readonly proposalPolicyId: string;          // e.g. 'STRATEGY_FIXED_LEVERAGE_V1' or 'NONE_USE_MODE_DEFAULT_V1'
  readonly sourceStrategyDecisionId: string;
  readonly requestedLeverage: string | null;  // null = defer entirely to RiskModeConfig (§10 layer "strategy proposal")
}
```
Phase 13 does not define or implement the logic that *produces* `EntryStopProposal`/`LeverageProposal` (that belongs to whatever future bridge computes an entry reference and a stop distance from live/backtest market truth — e.g. current mark price and an ATR-derived stop). Phase 13 defines only the **contract shape** these proposals must satisfy to be consumed, and validates their content (§6.1) and provenance (§8) exactly like every other evidentiary input.

### 2.5 Side/Action Derivation — Exact, Frozen Table

`side` and `action` are never carried as an input field; they are **derived deterministically** from `StrategyDecision.targetExposure` and the authoritative `PairRiskSnapshot.position` state (§3.1; Invariant 13 — position truth is fill-derived, never assumed). The table below uses `currentPositionSide` as shorthand for `position.state === 'FLAT' ? 'FLAT' : position.positionDirection` — a *derived* three-valued shorthand, never a stored field (§3.1.2):

| `currentPositionSide` | `targetExposure` | `action` | Sizing invoked? |
|---|---|---|---|
| FLAT | LONG | `OPEN` (side = LONG) | Yes — full pipeline |
| FLAT | SHORT | `OPEN` (side = SHORT) | Yes — full pipeline |
| FLAT | FLAT | `NO_CHANGE` | No |
| LONG | LONG | `NO_CHANGE` | No |
| SHORT | SHORT | `NO_CHANGE` | No |
| LONG | FLAT | `CLOSE` (full closure only) | No — see §2.6 |
| SHORT | FLAT | `CLOSE` (full closure only) | No — see §2.6 |
| LONG | SHORT | `REVERSAL_DEFERRED` | No — see §2.7 |
| SHORT | LONG | `REVERSAL_DEFERRED` | No — see §2.7 |

`targetExposure === null` never reaches this table (§2.3). **No other action category exists.** `INCREASE`, `PARTIAL_REDUCE`, and any pyramiding semantics are explicitly **not defined in Phase 13 V1**, because the real `StrategyDecision` contract carries no target quantity, no partial-exposure fraction, and no "add to position" signal — it is a binary end-state target (`LONG`/`SHORT`/`FLAT`), not an incremental order. Referencing a "requested reduction quantity" without such an input existing was the exact defect this correction removes.

### 2.6 `CLOSE` Semantics — Full Closure of the Owned Share Only `[P13-B03 R2]`

There is no partial-close input contract anywhere upstream, so `CLOSE` never accepts a caller-specified partial amount. But `CLOSE` also does **not** unconditionally mean "close the entire physical exchange position" — CoinDCX INR futures aggregate one physical position per pair (`activePositionQuantity`, one-way, isolated margin — Invariant 2), and when more than one `strategyInstanceId` targets the same pair, the physical position is shared. **Frozen rule:** `CLOSE` means closing the entirety of the **requesting instance's proven owned quantity** — the `currentQuantity` of the matching entry in `ownership.instanceOwnership` (§2.8) — never the full physical position when ownership cannot attribute that full quantity to this instance. In the common single-instance-per-pair case, the instance's owned quantity equals `position.quantityMagnitude` (§3.1), so full-instance-closure and full-position-closure coincide; they are not required to coincide in general.

`CLOSE` does not invoke risk-budget sizing (there is no budget to size against) and does not invoke leverage resolution (leverage is inherited from the existing position, already fixed at open). It is exempt from the instrument-tradeability gate (§3.3), the exposure gates (§9), and the loss/drawdown gates (§10) — de-risking is never blocked. It is **not** exempt from ownership verification (§2.8) or from provenance/freshness/identity checks (§8) — Invariant 13 requires that an unknown or unattributed position quantity can never be closed as if it were known and owned.

### 2.7 `REVERSAL_DEFERRED` — No Atomic Reversal in V1

A reversal (`LONG→SHORT` or `SHORT→LONG`) would require Phase 13 to size a new opposite-side `OPEN` against an account state that reflects margin freed by closing the existing position — a state that does not yet exist (Phase 13 performs no execution) and which Phase 13 must not fabricate by projecting a hypothetical post-close snapshot. **Frozen rule:** Phase 13 V1 does not support atomic reversal sizing. A `REVERSAL_DEFERRED` action always terminates as `RejectedRiskDecision` with `primaryReasonCode: 'REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION'` (Group A, §13) — the outer adapter must submit the `CLOSE` leg first (itself subject to the same ownership verification as any other `CLOSE`, §2.6/§2.8), obtain a fresh, genuine post-close `AccountRiskSnapshot`, and then submit a new `OPEN` candidate for independent evaluation. This is a deliberate V1 scope limitation, not an oversight.

### 2.8 Strategy-Instance Ownership `[P13-B03 R4 — complete instance identity; FLAT/OPEN no longer share one shape]`

**The defects being corrected (Round 3 residue, two of them):**
1. `InstanceOwnershipRecord` bound `strategyInstanceId` plus quantity/notional, but not `strategyId`/`strategyVersion`/`parameterHash`. A `strategyInstanceId` is only a safe ownership key if it is validated *together with* the strategy configuration it claims to belong to — a record whose `strategyInstanceId` happens to match but whose `strategyId`/`strategyVersion`/`parameterHash` do not is evidence of either adapter-side ledger corruption or a stale/wrong candidate, and Phase 13 must not authorize anything against it as if it were trustworthy.
2. The single `RECONCILED` shape required a `positionId` unconditionally, while the surrounding prose correctly said no authoritative `positionId` exists for a `FLAT` pair — forcing either a fabricated placeholder or an inconsistent "required-but-irrelevant" field. This is retracted in favor of a proper discriminated union with no shared shape between `FLAT` and `OPEN`.

**Frozen ownership model — full four-field instance identity, and `FLAT`/`OPEN` as genuinely distinct reconciled shapes:**
```typescript
export interface InstanceOwnershipRecord {
  readonly strategyInstanceId: string;   // concrete runtime ownership identity
  readonly strategyId: string;           // together with strategyVersion + parameterHash: the strategy configuration identity
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly currentQuantity: string;      // canonical Decimal magnitude, STRICTLY POSITIVE (> 0) — never signed, never "0" (§2.8.2)
  readonly currentNotionalInr: string;   // magnitude, INR — MUST equal currentQuantity × position.valuation.unitValuationInrPerQty exactly (§3.1.1); recomputed by the engine, never trusted as reported
}

export type PositionOwnershipState =
  | ReconciledFlatOwnership
  | ReconciledOpenOwnership
  | { readonly status: 'UNRECONCILED' };

export interface ReconciledFlatOwnership {
  readonly status: 'RECONCILED';
  readonly positionState: 'FLAT';
  readonly accountId: string;             // must equal AccountRiskSnapshot.accountId (§8.4 cross-check)
  readonly pair: string;                  // must equal PairRiskSnapshot.pair (§8.4 cross-check)
  readonly positionId: null;              // no exchange position exists — never a fabricated placeholder string
  readonly instanceOwnership: readonly [];  // always empty; a nonempty array here is malformed evidence (§14-style structural check), not a business condition
}

export interface ReconciledOpenOwnership {
  readonly status: 'RECONCILED';
  readonly positionState: 'OPEN';
  readonly accountId: string;
  readonly pair: string;
  readonly positionId: string;            // required, authoritative CoinDCX position identity — must equal position.positionId (§3.1, M05)
  readonly instanceOwnership: readonly InstanceOwnershipRecord[]; // exactly one entry per strategyInstanceId holding a strictly-positive share (zero-share instances are OMITTED, never listed as "0" — §2.8.2); sum of currentQuantity === position.quantityMagnitude AND sum of currentNotionalInr === position.valuation.aggregateCurrentNotionalInr, both exactly (§2.8.1, §3.1.1)
}
```
`positionState` — not the shared `status` field — is the discriminant between the two `RECONCILED` shapes; `status` remains `'RECONCILED'` on both, matching `PairPositionState`'s own `FLAT`/`OPEN` discriminant (§3.1) so the two line up structurally. `RECONCILED` (either shape) asserts that the adapter has proven, per `strategyInstanceId`, exactly how much quantity **and current notional** of the aggregated physical position that instance opened (e.g. via client-order-ID-tagged fill reconciliation — a future execution-phase concern; Phase 13 only consumes the result). `UNRECONCILED` is the honest default whenever the adapter cannot make this proof — Phase 13 never assumes single ownership merely because only one instance is currently visible to it, and never infers `ReconciledFlatOwnership` merely because it hasn't seen a position — a genuinely flat pair must be explicitly reported as such.

**Reservations are never represented here:** `instanceOwnership`/`ReconciledFlatOwnership.instanceOwnership` describes *current, filled* position ownership only. Pending/reserved exposure — including per-instance reservations — is tracked exclusively by `PendingExposureState` (§4), a wholly separate mechanism; `PositionOwnershipState` never grows a third "reservation-only" variant to hold it.

#### 2.8.1 Identity & Reconciliation Validation (`[P13-B03 R4]`)

Every `InstanceOwnershipRecord` inside a `ReconciledOpenOwnership.instanceOwnership` array is validated as a complete four-field tuple, never `strategyInstanceId` alone:
- The tuple (`strategyInstanceId`, `strategyId`, `strategyVersion`, `parameterHash`) must match the canonical strategy-instance binding supplied by the authoritative ownership adapter (the same binding the candidate's own `StrategyDecision`-derived identity is checked against, §2.2).
- **A record whose `strategyInstanceId` matches the candidate's but whose `strategyId`, `strategyVersion`, or `parameterHash` does not** fails closed with `DECISION_IDENTITY_MISMATCH` (Group B) — the already-frozen generic candidate-identity-inconsistency code (§8.4, §17) is reused rather than adding an overlapping new one; `strategyInstanceId` alone is never sufficient to authorize ownership.
- **Aggregate quantity reconciliation:** `sum(instanceOwnership[].currentQuantity)` must equal `position.quantityMagnitude` exactly — a sum of strictly-positive magnitudes compared against an already-unsigned aggregate, with no `abs()` applied at reconciliation time (§2.8.2, §3.1.2).
- **Aggregate notional reconciliation (`[P13-B03 R5]` — now fully deterministic):** the prior revision delegated this to "the adapter's own reconciliation rules," which froze nothing. Replaced by an exact, engine-side recomputation against the canonical valuation basis (§3.1.1), in this fixed order:
  1. **Valuation must exist.** `position.state === 'OPEN'` with `position.valuation === null` (nullable `markPriceUsdt`, §3.1.1) ⇒ no `ReconciledOpenOwnership` claim is admissible ⇒ `UNRECONCILED`.
  2. **Valuation inputs must be bound, not asserted (`[P13-SPEC-002]` — every mismatch is a Group B *rejection*, never a Group C throw).** `valuation.contractMultiplier` must equal `PairRiskSnapshot.contractMultiplier`, `valuation.conversionRateInrPerUsdt` must equal `SettlementConversionSnapshot.rateInrPerUsdt`, and `valuation.valuationMethodVersion` must equal `RiskValuationPolicy.valuationMethodVersion` (§10.5) — each exactly, on canonical normalized decimals/strings. **The defect being corrected:** these mismatches previously mapped to `RISK_SOURCE_INVALID` (Group C, a thrown error), contradicting §13.2's frozen rule that a well-formed object whose *values* merely disagree always terminates as a `RejectedRiskDecision`. A valuation object that passed exact-shape, type, and canonical Decimal ingestion is well-formed; disagreement between its bound values and the surrounding evidence is a per-evaluation evidence failure, not a construction fault. Corrected mapping, using existing granular codes wherever one genuinely fits:

  | Mismatch | Code (all Group B → `RejectedRiskDecision`) |
  |---|---|
  | `valuationMethodVersion` ≠ `RiskValuationPolicy.valuationMethodVersion` (valuation method/policy identity) | `VALUATION_METHOD_MISMATCH` — the method-specific canonical code (§17, §13.4) |
  | `contractMultiplier` ≠ `PairRiskSnapshot.contractMultiplier` (instrument multiplier) | `PAIR_STATE_UNAVAILABLE` — the pair snapshot contradicts itself, exactly the malformed-instrument condition this code already covers (§3.2) |
  | `conversionRateInrPerUsdt` ≠ `SettlementConversionSnapshot.rateInrPerUsdt`, or `conversionMarket` ≠ the settlement snapshot's market identity (conversion binding) | `SETTLEMENT_RATE_UNAVAILABLE` — the conversion evidence does not describe the conversion actually used (§8.4, §15.3) |
  | recomputed `unitValuationInrPerQty` / `aggregateCurrentNotionalInr` / any `currentNotionalInr` ≠ reported (valuation content) | `POSITION_OWNERSHIP_UNRECONCILED` — steps 3–5 below |
  | `valuationPriceSourceId` / `conversionSourceId` ≠ policy-bound expected source | `SOURCE_ID_MISMATCH` (§8.6, unchanged rule) |

  Two — and only two — new codes are introduced across this correction: `VALUATION_METHOD_MISMATCH` (above) and `VALUATION_NUMERIC_CONTEXT_EXCEEDED` (§3.1.1), because no existing code expresses either "this evidence was produced under a different valuation method than the policy in force" or "the frozen arithmetic context cannot represent this otherwise-valid calculation" without overloading an unrelated meaning. Each appears exactly once in the taxonomy and exactly once in `REJECTION_PRECEDENCE_V1`.

  **Frozen valuation-failure taxonomy (`[P13-SPEC-002]`)** — these meanings do not overlap, and no condition maps to two codes:

  | # | Condition | Code | Group |
  |---|---|---|---|
  | A | Malformed evidence — required field missing, invalid type, unparseable or non-finite Decimal, prohibited non-canonical Decimal form (§11.1), or impossible exact-shape ingestion; **canonical identity cannot be established at all** | `RISK_SOURCE_INVALID` | C (thrown) |
  | B | Well-formed, identity established, values individually valid — but the frozen `RiskCalcDecimal` / valuation arithmetic context cannot safely represent or complete the required calculation | `VALUATION_NUMERIC_CONTEXT_EXCEEDED` | B (rejection) |
  | C | Valuation **method identity** mismatch — `valuationMethodVersion` ≠ `RiskValuationPolicy.valuationMethodVersion` | `VALUATION_METHOD_MISMATCH` | B |
  | D | Authoritative instrument/multiplier state mismatch — `valuation.contractMultiplier` ≠ `PairRiskSnapshot.contractMultiplier` | `PAIR_STATE_UNAVAILABLE` | B |
  | E | Settlement/conversion binding mismatch — rate or market disagrees with `SettlementConversionSnapshot` | `SETTLEMENT_RATE_UNAVAILABLE` | B |
  | F | Canonical valuation **recomputation produces a value** inconsistent with the supplied ownership valuation (unit factor, aggregate, or any per-instance notional) | `POSITION_OWNERSHIP_UNRECONCILED` | B |
  | G | Recomputed **identity/hash** does not match a declared decision/evidence identity | `DECISION_IDENTITY_MISMATCH` (or the already-frozen identity-specific code, §13.2) | B |
  | H | Actual `sourceId` disagrees with the policy-owned expected source ID | `SOURCE_ID_MISMATCH` | B |

  **The F/G boundary is now explicit and narrow.** `DECISION_IDENTITY_MISMATCH` covers **identity and hash** recomputation only — a `decisionId`, a `contentSha256`, a cross-field identity binding. It does **not** cover numeric content or value reconciliation: a recomputed *amount* disagreeing with a supplied *amount* is row F, never row G. `RISK_SOURCE_INVALID` (row A) remains reserved for its frozen purpose and is unreachable once canonical identity has been established — rows B through H are all deterministic rejections. Each code describes its own failed check; independent failures may coexist and are ordered by §13.4. When a binding or numeric-context failure prevents value recomputation, that dependent reconciliation check is `SKIPPED`; no value mismatch is inferred from an unavailable result.
  3. **The engine recomputes, it does not trust.** `unitValuationInrPerQty` and `aggregateCurrentNotionalInr` are both recomputed from the bound inputs per §3.1.1 and must equal the reported values exactly. This is what makes an adapter- or caller-supplied `aggregateCurrentNotionalInr` structurally unable to bypass reconciliation: a fabricated figure fails the recomputation regardless of how plausible it looks.
  4. **Per-instance exactness.** For every record, `currentNotionalInr` must equal `currentQuantity × unitValuationInrPerQty` exactly — this is what forces every instance onto the identical valuation basis (same price, same multiplier, same rate) as the aggregate. No `abs()` appears in this formula: `currentQuantity` has already been validated strictly positive by §2.8.2, which runs first, so the product is a positive magnitude by construction rather than by defensive coercion. A `SHORT` parent changes nothing here — direction lives on `position.positionDirection`, never in these operands (§3.1.2), so `LONG` and `SHORT` positions of equal magnitude value identically.
  5. **Aggregate equality.** `sum(instanceOwnership[].currentNotionalInr)` must equal `aggregateCurrentNotionalInr` under **exact canonical Decimal equality** (§11.1) — no tolerance, no epsilon, no configurable band. §3.1.1's single-quantization-point derivation makes this an exact identity whenever step 4 and the quantity reconciliation both hold, so any inequality here is genuine evidence corruption rather than accumulated rounding. It is still checked explicitly rather than assumed.

  After successful canonical ingestion and valuation binding, a completed quantity or notional reconciliation that disagrees with the reported canonical values means the ownership claim is `UNRECONCILED` (`POSITION_OWNERSHIP_UNRECONCILED`, Group B). Malformed input, source/identity/method/binding failures, and numeric-context exhaustion retain their own codes from the table above; this ownership rule does not relabel them. A reconciliation that cannot run because its precondition failed is `SKIPPED` (§13.3).
- **`FLAT` semantics.** `ReconciledFlatOwnership` implies aggregate quantity magnitude `"0"`, aggregate current notional `"0"`, and `instanceOwnership: []` definitionally. No valuation price, conversion rate, or multiplier is required to prove zero exposure — `PairPositionState.FLAT` carries no `valuation`, no `positionDirection`, and no `quantityMagnitude` at all, and none is fabricated to satisfy this section (§3.1.1, §3.1.2). Signed-quantity semantics never apply to a `FLAT` pair.

#### 2.8.2 Instance Quantity Is Strictly a Positive Magnitude `[P13-B03 R6]`

The signed-to-magnitude boundary (§3.1.2) normalizes the *aggregate*. This section freezes the matching rule for every *instance* record, closing the mixed-sign cancellation hole:

- **Strictly positive.** `InstanceOwnershipRecord.currentQuantity` is a canonical Decimal **magnitude**, required `> 0` for every record inside a `ReconciledOpenOwnership`. A negative value is invalid ownership evidence, full stop — not a short allocation, not a reduction, not a correction entry.
- **Zero allocations are omitted, never listed (one frozen behavior).** An instance holding no share of the position is **absent** from `instanceOwnership`; a record present with `currentQuantity === "0"` is invalid evidence. Freezing omission rather than tolerating `"0"` is what prevents a zero record from being used as a fake ownership allocation — an entry's mere presence is the ownership claim, so there is no such thing as a present-but-empty claim. (This also means the `CLOSE`-side "instance owns nothing" case, §2.8 below, is reached by *no matching entry*, which is the only representable form it now has.)
- **Direction is inherited, never encoded in a sign.** Every instance record inherits `position.positionDirection` from the authoritative `OPEN` parent. `InstanceOwnershipRecord` carries no direction field of its own and no signed quantity, so an instance **cannot** represent the opposite direction inside the same reconciled aggregate position. CoinDCX INR futures hold one physical one-way position per pair (Invariant 2); two instances claiming opposite directions within it is a contradiction, not a state.
- **Mixed-sign sets are therefore structurally impossible in `RECONCILED` state** — this is the point of the rule. The `+2` / `-1` set that would previously have summed to an aggregate magnitude of `1` is now rejected at the `> 0` check, before any summation happens. Cancellation between positive and negative contributions cannot occur when every contribution is required positive.

**Canonical ingestion precedes ownership checks (`[P13-SPEC-002]`).** A missing/unknown field (including a per-instance direction field), wrong type, unparseable or non-finite Decimal, or prohibited non-canonical Decimal representation (§11.1) prevents canonical identity from being established and throws `RISK_SOURCE_INVALID`. This applies to every required ownership Decimal, including `currentQuantity` and `currentNotionalInr`.

Once canonical identity is established, a valid canonical `currentQuantity <= 0` makes the ownership state `UNRECONCILED` (`POSITION_OWNERSHIP_UNRECONCILED`, Group B). Thus `"0"` and `"-1"` are parseable canonical numbers whose values violate the positive-magnitude contract; they are rejected at the sign check before summation. A set of valid positive quantities or notionals that fails exact aggregate reconciliation also yields `POSITION_OWNERSHIP_UNRECONCILED`. The order is canonical ingestion, per-record sign checks, then applicable value reconciliation. Arithmetic that cannot safely complete uses `VALUATION_NUMERIC_CONTEXT_EXCEEDED`; it is never treated as a completed but unequal sum.

**Ownership-sensitive actions are `OPEN`, `CLOSE`, and the (already-terminal) `REVERSAL_DEFERRED` — `NO_CHANGE` remains non-actionable and is never ownership-checked (§2.5).**

- `ownership.status === 'UNRECONCILED'` (including a self-inconsistent `RECONCILED` claim downgraded per §2.8.1) → **for every one of `OPEN`, `CLOSE`, `REVERSAL_DEFERRED`** → fails closed with `POSITION_OWNERSHIP_UNRECONCILED` (Group B). This is unconditional: `OPEN`/`INCREASE`-shaped exposure can never be authorized against a pair whose existing aggregated exposure cannot be attributed, because it may already belong to another strategy instance and Phase 13 cannot safely reason about the resulting total.
- For `CLOSE` specifically, `positionState === 'FLAT'` (nothing to close — a different, action-derivation-level rejection applies, §2.5) or `positionState === 'OPEN'` with no `instanceOwnership` entry matching the candidate's full four-field identity tuple → fails closed with `POSITION_OWNERSHIP_MISMATCH` (Group B). Since a zero share is represented by **omission** rather than a `"0"` record (§2.8.2), "this instance owns nothing" and "this instance has no entry" are the same condition, with one rejection — this specific instance owns nothing to close, regardless of what its `strategyId` peers own.
- A four-field identity tuple mismatch on an otherwise-matching `strategyInstanceId` → `DECISION_IDENTITY_MISMATCH` (Group B, §2.8.1) — checked before the ownership-quantity check above, since an unverifiable identity makes the quantity claim moot.
- `ownership.positionId !== position.positionId` (when `positionState === 'OPEN'`), `ownership.pair !== PairRiskSnapshot.pair`, or `ownership.accountId !== AccountRiskSnapshot.accountId` → fails closed with `POSITION_IDENTITY_MISMATCH` / `DECISION_IDENTITY_MISMATCH` / `ACCOUNT_IDENTITY_MISMATCH` respectively (Group B, §8.4) — stale or misattributed ownership data is never silently reused.
- Otherwise: `OPEN` proceeds to full sizing (§6–§7); `CLOSE` is authorized for exactly the matching record's `currentQuantity` (§2.6).

**Why `OPEN` is now gated but exposure *limits* still use `strategyId` (unchanged, §9.1):** ownership answers *"can this specific instance safely act on this pair's existing position at all"* — a yes/no gate that must hold before any sizing math runs. Exposure limits answer a completely different question — *"how much aggregate notional is this strategy *definition* allowed across every instance and pair"* — which is deliberately courser-grained and remains `strategyId`-keyed (§9.1's existing disclaimer stands unchanged). `PendingExposureState` (§4) remains the correct mechanism for reservation-level headroom; ownership (this section) is the correct mechanism for "does this instance have standing to act on this pair's existing position," and the two are checked independently in the pipeline (§13.3, step 10 now covers both).

**Audit binding:** `strategyInstanceId` is bound onto `RiskDecisionBase` (§5.1) and `PositionSizingDecision` (§7.5) alongside `strategyId`/`strategyVersion`/`parameterHash`, so every decision and every sizing computation is traceable to the concrete allocation that produced it, not merely to the strategy definition it runs.

This retires `MULTI_STRATEGY_PAIR_OWNERSHIP_UNRESOLVED` (§17) — the `POSITION_OWNERSHIP_UNRECONCILED`/`POSITION_OWNERSHIP_MISMATCH` pair is strictly more precise, keyed on the correct identity, and applied uniformly to every ownership-sensitive action rather than `CLOSE` alone.

---

## 3. Complete Instrument Constraints `[P13-B02]`

### 3.1 Binding to the Real Phase 2 Model

`PairRiskSnapshot` binds every entry-relevant field actually present on Phase 2's `InrFuturesInstrument` (`src/integration/coindcx/models.ts`) — no invented fields, no dropped ones. Position identity and ownership (`[P13-M05 R2]`, `[P13-B03 R2]`) replace the old ambiguous scalar `currentPositionQuantity`/`currentPositionSide` pair with explicit discriminated states bound to the genuine Phase 2 `InrFuturesPosition.id`:
```typescript
export type PairPositionState =
  | { readonly state: 'FLAT' }                            // carries no direction and no quantity field at all (§3.1.2)
  | {
      readonly state: 'OPEN';
      readonly positionId: string;          // InrFuturesPosition.id, verbatim — never fabricated
      readonly positionDirection: 'LONG' | 'SHORT';       // the ONLY carrier of direction (§3.1.2) — never the sign of a quantity
      readonly quantityMagnitude: string;    // canonical strictly-positive Decimal magnitude (§3.1.2) — never signed
      readonly valuation: CanonicalPositionValuation | null;  // §3.1.1 — null iff markPriceUsdt is null (P13-B03 R5)
    };

export interface PairRiskSnapshot {
  readonly pair: string;
  readonly instrumentSpecSnapshotId: string;
  readonly status: string;                    // InrFuturesInstrument.status, verbatim
  readonly exitOnly: boolean;                  // InrFuturesInstrument.exitOnly, verbatim
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
  readonly minPrice: string;
  readonly maxPrice: string;
  readonly minQuantity: string;
  readonly maxQuantity: string;
  readonly minTradeSize: string;
  readonly minNotional: string;                // USDT
  readonly maxNotional: string | null;          // USDT — InrFuturesInstrument.maxNotional is nullable
  readonly contractMultiplier: string;          // InrFuturesInstrument.unitContractValue
  readonly position: PairPositionState;
  readonly ownership: PositionOwnershipState;   // §2.8 — RECONCILED / UNRECONCILED
  readonly provenance: EvidenceProvenance;      // §8
}
```
`maxMarketOrderQuantity` (also present on `InrFuturesInstrument`, nullable) is **deferred to execution**: it constrains a specific order *type* (market orders), and Phase 13 V1 does not fix an order type — that is an execution-phase (Phase 17) concern. Phase 13 never applies `maxMarketOrderQuantity` as a sizing ceiling; doing so would silently assume a market order is what eventually gets placed.

`position.state === 'FLAT'` never carries a fake/null `positionId`, direction, or quantity — the discriminant makes "no position" and "a position with unknown quantity" structurally distinct states, and only the latter is even representable if `ownership`/provenance data forces it (it does not; a flat pair is simply `FLAT`).

#### 3.1.1 Canonical Current-Notional Valuation `[P13-B03 R5]`

**The defect being corrected:** `InstanceOwnershipRecord.currentNotionalInr` (§2.8) existed, and §2.8.1 required it to reconcile — but reconciliation was delegated to "the adapter's own reconciliation rules," and `PairRiskSnapshot` carried no authoritative aggregate current INR notional at all. Quantity reconciliation was deterministic; **notional reconciliation was not**, because no aggregate field, valuation price, formula, conversion source, rounding rule, or equality rule was frozen. This section freezes all six.

**What CoinDCX actually provides (verified against the real Phase 2 model, `src/integration/coindcx/models.ts`):** `InrFuturesPosition` exposes **no** position-notional field. It exposes `activePositionQuantity` (signed), `avgPriceUsdt`, `markPriceUsdt` (**nullable**), `liquidationPriceUsdt`, margin fields, and `settlementCurrencyAvgPriceInrPerUsdt` (**nullable**). There is therefore **no authoritative direct notional to normalize** — it must be derived, and the derivation must be frozen rather than left to an adapter. Two negative rules follow directly from the real model and are frozen:
- **`avgPriceUsdt` is never a valuation price.** It is the position's historical average entry price. Valuing current exposure at entry price is not a current notional, and mixing it with a mark-priced aggregate is exactly the basis-mismatch this correction forbids.
- **`settlementCurrencyAvgPriceInrPerUsdt` is never the conversion rate.** It is a per-position *average* conversion price bound to that position's history, not a current INR/USDT rate. The only conversion authority is `SettlementConversionSnapshot.rateInrPerUsdt` (§8.5, §15.3), which is already provenance-, freshness-, and source-authority-gated (§8.3, §8.4, §8.6).

**Frozen valuation contract** — one method, one version, every decision-affecting input bound:
```typescript
export interface CanonicalPositionValuation {
  readonly valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1';  // must equal RiskValuationPolicy.valuationMethodVersion (§10.5)
  readonly valuationPriceField: 'markPriceUsdt';        // frozen literal — the field the price was read from, never avgPriceUsdt
  readonly valuationPriceUsdt: string;                   // InrFuturesPosition.markPriceUsdt, verbatim; > 0, finite
  readonly valuationPriceSourceId: string;               // must equal RiskSourceAuthorityPolicy.pairRiskSourceId (§8.6)
  readonly valuationPriceSourceTimeMs: number | null;    // exchange-reported time, when available
  readonly valuationPriceObservedAtMs: number;           // adapter observation time
  readonly contractMultiplier: string;                   // must equal PairRiskSnapshot.contractMultiplier (InrFuturesInstrument.unitContractValue)
  readonly conversionMarket: string;                     // must equal SettlementConversionSnapshot's market identity (§8.4)
  readonly conversionRateInrPerUsdt: string;             // must equal SettlementConversionSnapshot.rateInrPerUsdt exactly
  readonly conversionSourceId: string;                   // must equal RiskSourceAuthorityPolicy.conversionSourceId (§8.6)
  readonly unitValuationInrPerQty: string;               // the single quantization point — see below
  readonly aggregateCurrentNotionalInr: string;          // position.quantityMagnitude × unitValuationInrPerQty, exact (already unsigned — §3.1.2)
}
```

**Frozen derivation (two steps, exactly one rounding point):**

$$\text{unitValuationInrPerQty} = \text{quantize}_{S}\big(\text{valuationPriceUsdt} \times \text{contractMultiplier} \times \text{conversionRateInrPerUsdt}\big)$$

$$\text{aggregateCurrentNotionalInr} = \text{position.quantityMagnitude} \times \text{unitValuationInrPerQty}$$

where $\text{quantize}_S$ is `RiskCalcDecimal` rounding to exactly `RiskValuationPolicy.valuationUnitScale` decimal places using `RiskValuationPolicy.valuationUnitRounding` (§10.5, both frozen and identity-bound). All arithmetic uses the isolated 128-digit `RiskCalcDecimal` context (§3 numeric policy); no native float, no `parseFloat`, no `Date.now()`.

**Why exactly one rounding point matters (this is what makes §2.8.1's equality check exact rather than tolerance-based):** after `unitValuationInrPerQty` is quantized to a fixed finite scale $S$, every subsequent multiplication is a finite-scale decimal × finite-scale decimal. Quantities are themselves finite-scale (aligned to `quantityIncrement`, §3.2), so each product has scale ≤ `scale(qty) + S` — bounded far below the 128-digit context and therefore **computed exactly, with no rounding at all**. Exact decimal multiplication distributes exactly over exact decimal addition, so $\sum_i (q_i \times U) = (\sum_i q_i) \times U$ holds **identically**, not approximately. This is why §2.8.1 can demand exact canonical-Decimal equality and needs no tolerance: a tolerance would be covering for a rounding error the frozen derivation does not produce. If any product's required scale would exceed the `RiskCalcDecimal` context (a pathological instrument/policy combination), that is a **Group B deterministic rejection** — `VALUATION_NUMERIC_CONTEXT_EXCEEDED` (§17) — never a silently-rounded result, and never a thrown Group C fault (`[P13-SPEC-002]`). **The defect being corrected:** this condition previously mapped to `RISK_SOURCE_INVALID`, but it arises from evidence that is fully well-formed — every field present, correctly typed, canonically parseable, with source and evidence identity already established. Nothing about it is malformed; the frozen arithmetic context simply cannot represent the required product. That is an evaluation outcome, not a construction fault, so it terminates as a `RejectedRiskDecision` and participates in normal reason precedence like any other Group B code.

**Per-instance derivation uses the identical basis** — the same `unitValuationInrPerQty` object, not a re-derived one:

$$\text{instanceCurrentNotionalInr}_i = \text{instanceCurrentQuantity}_i \times \text{unitValuationInrPerQty}$$

No instance may be valued at entry price while the aggregate is valued at mark, and no instance may carry a different conversion rate or multiplier, because there is exactly one shared factor and the engine recomputes every record against it (§2.8.1).

**Nullable mark price — fail closed, never substitute:** `markPriceUsdt` is nullable on the real model, so `PairPositionState.OPEN.valuation` is nullable. `valuation === null` means the position genuinely cannot be valued at mark; Phase 13 does **not** fall back to `avgPriceUsdt` and does not fabricate a price. An `OPEN` position with `valuation === null` can never support a `ReconciledOpenOwnership` claim — the ownership state is treated as `UNRECONCILED` (§2.8.1), which fails closed for `OPEN`, `CLOSE`, and `REVERSAL_DEFERRED` alike (§2.8).

**Temporal and authority gating:** `valuationPriceSourceTimeMs ≤ valuationPriceObservedAtMs ≤ evaluationTimeMs` is enforced by the same zero-tolerance rule as every other timestamp (§8.4, first inequality only when non-null); `valuationPriceObservedAtMs` is additionally subject to `RiskFreshnessPolicy.maxPairSnapshotAgeMs` (§8.3), and `valuationPriceSourceId`/`conversionSourceId` to §8.6. There is no valuation-specific freshness or skew knob.

**Scope guard (this section reopens nothing):** this valuation basis governs the **current notional of an already-existing position** only. It does **not** change §6/§7's candidate sizing, which values *prospective* new exposure at the separately-provenanced `entryPriceUsdt` from `EntryStopProposal` — a different quantity answering a different question. It does not change §9's exposure aggregates, which come from `PortfolioExposureSnapshot`. And it deliberately does **not** apply to `PendingExposureState` (§4): a pending reservation is prospective, not filled, and is valued at its own proposal's entry price; conflating the two bases would misstate reserved exposure.

#### 3.1.2 Signed-to-Magnitude Normalization Boundary `[P13-B03 R6]`

**The defect being corrected:** CoinDCX's authoritative quantity, `InrFuturesPosition.activePositionQuantity`, is **signed** (negative for short, positive for long, zero for flat — `src/integration/coindcx/models.ts:73`). `PairPositionState` normalized it to an unsigned magnitude, but the spec never explicitly forbade a *negative instance* quantity, and the reconciliation rule was written as a plain sum. A mixed-sign instance set could therefore reconcile by cancellation — e.g. instance records of `+2` and `-1` summing to the aggregate magnitude `1` — producing a `RECONCILED` state over evidence that is self-contradictory (two instances of the same physical one-way position claiming opposite directions). Direction was implicitly representable in two places at once (the parent's field and an instance quantity's sign), and the two could disagree.

**Frozen normalization — one boundary, applied exactly once, by the adapter, before any Phase 13 contract is constructed.** For the authoritative raw signed quantity `q = InrFuturesPosition.activePositionQuantity`:

| Raw `q` | Resulting `PairPositionState` |
|---|---|
| `q > 0` | `state: 'OPEN'`, `positionDirection: 'LONG'`, `quantityMagnitude = q` |
| `q < 0` | `state: 'OPEN'`, `positionDirection: 'SHORT'`, `quantityMagnitude = abs(q)` |
| `q === 0` | `state: 'FLAT'` — no `positionDirection`, no `quantityMagnitude`, no `positionId`, no `valuation` |

**After this boundary, Phase 13 ownership reconciliation never sees or uses a signed quantity again.** This is the single, frozen point at which sign is converted into a direction label; downstream, `quantityMagnitude` is a canonical, strictly-positive Decimal and `positionDirection` is the *only* carrier of direction. The renaming from `side`/`quantity` to `positionDirection`/`quantityMagnitude` is deliberate: the old names invited a signed reading, and the `position.quantityMagnitude` absolute-value notation that previously appeared in the reconciliation rules is retired everywhere — taking `abs()` at reconciliation time is exactly what would have let a mixed-sign set cancel into a plausible-looking total.

**`FLAT` carries direction structurally absent, not as a `'FLAT'` direction value** (one frozen model, chosen for consistency with §3.1's existing discriminated-union rule that a flat pair carries no fabricated fields). Code needing a three-valued shorthand derives it — see §2.5, which computes `position.state === 'FLAT' ? 'FLAT' : position.positionDirection` rather than reading a stored field.

**Ingestion validation (§11.2, `[P13-SPEC-002]`):** first validate the exact shape, field types, and canonical Decimal ingestion (§11.1). A `quantityMagnitude` that is unparseable, non-finite, or in a prohibited non-canonical form throws `RISK_SOURCE_INVALID` because canonical source identity cannot be established. After canonical identity is established, a valid canonical negative or zero `quantityMagnitude` violates the `OPEN` positive-magnitude state contract and returns `PAIR_STATE_UNAVAILABLE` (Group B). These value failures are distinct from malformed Decimal evidence; no new rejection code is introduced.

### 3.2 Rounding & Ceiling Rules
- Quantity is **only ever rounded down** (unchanged from the original freeze, §6).
- **New:** the final approved quantity can never exceed `maxQuantity` — `maxQuantity` participates as one more intersected ceiling in the finite tier enumeration (§7.3, step 4).
- Entry/stop/reference prices must satisfy `minPrice ≤ price ≤ maxPrice` in addition to `> 0` and tick-increment alignment (§6.1 table, extended).
- If `minQuantity > maxQuantity` for a snapshot (a malformed instrument), this is evidence corruption, not a business outcome — fails closed with `PAIR_STATE_UNAVAILABLE` (Group B) before any sizing math runs.

### 3.3 Tradeability Gate

| `status` / `exitOnly` | `action = OPEN` | `action = CLOSE` |
|---|---|---|
| `status` not tradeable (adapter-defined non-active state) | Reject: `INSTRUMENT_NOT_TRADEABLE_FOR_NEW_EXPOSURE` (Group A) | Allowed — exempt |
| `exitOnly === true` | Reject: `INSTRUMENT_NOT_TRADEABLE_FOR_NEW_EXPOSURE` (Group A) | Allowed — exempt |
| Otherwise | Proceeds | Allowed |

`REVERSAL_DEFERRED` is already terminal before this gate matters (§2.7). This is a deterministic, currently-trusted exchange fact — classified Group A (business rejection), not Group B, because it is not a trust/staleness question but a definitive tradeability rule, exactly analogous to an exposure limit.

---

## 4. Discriminated Pending / Reserved Exposure `[P13-B03]`

### 4.1 Replacing "0 If Not Tracked"

The original "`concurrentPendingRiskDecisions: number`, default 0 if untracked" language silently conflated *genuinely zero* with *we don't know*. Frozen replacement — a discriminated union, with pending reservations bound to the **same full four-field strategy-instance identity** as current ownership (`[P13-B03 R4]` — Round 2/3 left this `strategyInstanceId`-only, which under-identified reservations exactly the way `InstanceOwnershipRecord` under-identified current ownership before this revision; both are now consistent), alongside the pre-existing `strategyId`-keyed aggregate used for `STRATEGY_EXPOSURE_LIMIT` (see §2.8 for why these two keys must not be conflated):
```typescript
export interface InstancePendingReservation {
  readonly strategyInstanceId: string;   // concrete runtime ownership identity — same identity concept as InstanceOwnershipRecord (§2.8)
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly pendingNotionalInr: string;
  readonly pendingReservationCount: number;
}

export type PendingExposureState =
  | {
      readonly status: 'KNOWN';
      readonly globalPendingNotionalInr: string;
      readonly pairPendingNotionalInr: Readonly<Record<string, string>>;
      readonly strategyPendingNotionalInr: Readonly<Record<string, string>>;   // keyed by strategyId — aggregate, for STRATEGY_EXPOSURE_LIMIT (§9.1)
      readonly instancePendingReservations: readonly InstancePendingReservation[]; // one entry per strategyInstanceId with a nonzero reservation — authoritative for reservation isolation
      readonly pendingReservationCount: number;
      readonly pendingDirectionalNotionalInr: { readonly longInr: string; readonly shortInr: string };
    }
  | { readonly status: 'UNKNOWN' };
```
`PortfolioExposureSnapshot.pending: PendingExposureState` replaces the old scalar field. `strategyPendingNotionalInr` (by `strategyId` alone, a deliberately coarser aggregate for `STRATEGY_EXPOSURE_LIMIT`) and `instancePendingReservations` (by the full four-field identity tuple) are **not** required to be derivable from one another in general (two instances of the same `strategyId` sum into the former; only the latter can isolate one specific instance's reservation for a same-`strategyId`-different-`strategyInstanceId` isolation check) — both are supplied explicitly by the adapter, never one computed by Phase 13 from the other. A reservation entry whose `strategyInstanceId` matches a candidate's but whose `strategyId`/`strategyVersion`/`parameterHash` does not is the identical identity-inconsistency case as §2.8.1 and is rejected identically (`DECISION_IDENTITY_MISMATCH`, Group B) — pending and current ownership are never allowed to diverge on how strictly they check identity.

### 4.2 Fail-Closed Rule

`pending.status === 'UNKNOWN'` fails closed with `PENDING_EXPOSURE_UNKNOWN` (Group B) for **any** action that increases exposure (`OPEN`; `REVERSAL_DEFERRED`'s eventual `OPEN` leg once resubmitted per §2.7). `CLOSE` is exempt (§2.6) — an unknown reservation count never blocks de-risking.

### 4.3 What "KNOWN" Must Support

An outer adapter reporting `status: 'KNOWN'` must supply genuine gross accounting for: global pending notional (sum of every `ACCEPTED`-but-not-yet-executed `RiskDecision`'s approved notional, across all pairs/strategies), per-pair and per-strategy pending notional (keyed maps, not a single scalar — matching the existing `perPairOpenNotionalInr`/`perStrategyOpenNotionalInr` shape), **per-strategy-instance pending notional and reservation count as full `InstancePendingReservation` entries** (`[P13-B03 R4]` — each entry bound to the complete four-field identity tuple, not `strategyInstanceId` alone, matching the same standard `InstanceOwnershipRecord` is held to, §2.8 — the authoritative granularity for isolating one instance's reservations from a same-`strategyId` sibling instance's), a global reservation count (for `MAX_CONCURRENT_POSITIONS`, §9.1), and directional (long/short) pending notional where a mode config declares a directional limit. Phase 13 does not implement this adapter; it only defines the shape a genuine one must satisfy — consistent with §15 (adapter boundaries are interface-only in Phase 13).

### 4.4 Netting

Unchanged: gross only, never netted against opposite-direction positions on other pairs (§9.1's frozen rule stands and is now reinforced by `pendingDirectionalNotionalInr` being tracked separately for disclosure, not for netting).

---

## 5. `RiskDecision` As a Discriminated Union `[P13-B04 R2 — resolves the OPEN/CLOSE shape contradiction]`

### 5.1 The Defect Being Corrected

The prior revision declared a single `AcceptedRiskDecision` requiring OPEN-style fields (`approvedLeverage`, `estimatedInitialMargin*`), then separately claimed in prose that `CLOSE` uses "its own dedicated `AcceptedRiskDecision` shape" with a smaller, incompatible `approved` block — two different shapes under one type name is a genuine contradiction, not just loose wording. This is corrected by splitting into three sibling variants, action-discriminated, with no shared "one true `AcceptedRiskDecision`" type left standing.

### 5.2 The Corrected Type

```typescript
export type RiskDecisionAction = 'OPEN' | 'CLOSE' | 'NO_CHANGE' | 'REVERSAL_DEFERRED';

export interface CapValue {
  readonly status: 'RESOLVED' | 'NOT_APPLICABLE' | 'UNRESOLVED';
  readonly value: string | null;   // non-null iff status === 'RESOLVED'
}

interface RiskDecisionBase {
  readonly schemaVersion: 1;
  readonly riskDecisionId: string;
  readonly riskPolicyId: string;
  readonly sourceStrategyDecisionId: string;         // StrategyDecision.decisionId, re-verified (§2.2)
  readonly sourcePositionSizingDecisionId: string;    // ALWAYS non-null — a PositionSizingDecision is constructed for every action, §5.4/§7.5
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;                // [P13-B03 R2] — ownership/allocation identity, distinct from strategyId
  readonly pair: string;
  readonly riskMode: RiskMode;
  readonly evaluationTimeMs: number;
  readonly capsApplied: RiskCapsApplied;               // §10.2 — every field a CapValue, never a bare string
  readonly auditTrail: readonly RiskAuditStep[];        // §13.2 — complete, including SKIPPED steps
  readonly inputContentHashes: RiskInputContentHashes;
}

export interface AcceptedOpenRiskDecision extends RiskDecisionBase {
  readonly status: 'ACCEPTED';
  readonly action: 'OPEN';
  readonly approved: {
    readonly approvedQuantity: string;
    readonly approvedLeverage: string;
    readonly approvedNotionalUsdt: string;
    readonly approvedNotionalInr: string;
    readonly estimatedInitialMarginUsdt: string;   // §8 — initial margin only (never maintenance/liquidation)
    readonly estimatedInitialMarginInr: string;
    readonly estimatedStopLossRiskInr: string;
  };
  readonly reasonCodes: readonly string[];           // informational only; may be empty
}

export interface AcceptedCloseRiskDecision extends RiskDecisionBase {
  readonly status: 'ACCEPTED';
  readonly action: 'CLOSE';
  readonly approved: {
    readonly approvedQuantity: string;    // = the matching instanceOwnership[].currentQuantity for the full 4-field strategy-instance identity tuple (§2.6/§2.8.1) — never the full physical position unless they coincide
    readonly approvedNotionalUsdt: string;
    readonly approvedNotionalInr: string;
  };
  readonly reasonCodes: readonly string[];
}

export interface RejectedRiskDecision extends RiskDecisionBase {
  readonly status: 'REJECTED';
  readonly action: RiskDecisionAction;                    // any of the four — a rejection can occur for OPEN, CLOSE, NO_CHANGE, or REVERSAL_DEFERRED
  readonly approved: null;
  readonly primaryReasonCode: string;                     // [P13-M08 R2] — first failing check by canonical pipeline precedence, §13.2/§13.3
  readonly secondaryReasonCodes: readonly string[];       // every other failing check, in canonical pipeline order; may be empty
}

export type RiskDecision = AcceptedOpenRiskDecision | AcceptedCloseRiskDecision | RejectedRiskDecision;
```

### 5.3 Frozen Guarantees
- `approved` is `null` on every `RejectedRiskDecision` — **structurally**, via the discriminated union, not by convention. There is no code path that can attach financial values to a rejection.
- `AcceptedOpenRiskDecision.approved` and `AcceptedCloseRiskDecision.approved` are each always the **complete** object for their own shape — never partially populated, and never borrowing a field (`approvedLeverage`, `estimatedInitialMargin*`) that the other action doesn't compute. There is no third "generic accepted" shape that could accidentally mix them.
- `capsApplied` uses `CapValue` (§10.2), never a bare `string | null`. **No field is ever a fabricated `"0"` standing in for "not computed."**
- Because `AcceptedOpenRiskDecision.action` is the literal type `'OPEN'` and `AcceptedCloseRiskDecision.action` is the literal type `'CLOSE'`, it is **structurally impossible** — not merely a convention — to construct an `ACCEPTED` decision with `action: 'NO_CHANGE'` or `action: 'REVERSAL_DEFERRED'`. Only `RejectedRiskDecision` can carry those two actions. This is the frozen answer to "`NO_CHANGE` should not accidentally create an ACCEPTED tradable approval" and "`REVERSAL_DEFERRED` must remain non-executable": the type system itself, not a runtime check alone, forecloses it.
- `RejectedRiskDecision.primaryReasonCode`/`secondaryReasonCodes` replace the earlier flat `reasonCodes` array on rejections specifically (§13.3) — `AcceptedOpenRiskDecision`/`AcceptedCloseRiskDecision` retain a plain `reasonCodes` array since "primary/secondary" is a rejection-precedence concept, not an acceptance-audit concept.

### 5.4 Exact Relationship: `PositionSizingDecision` × `RiskDecision.action` × `RiskDecision.approved` `[P13-B04 R2, P13-M01 cross-reference]`

A `PositionSizingDecision` (§7.5) is constructed for **every** action — never conditionally omitted — so `RiskDecisionBase.sourcePositionSizingDecisionId` is never `null`. What varies is its `outcome`:

| `action` | `PositionSizingDecision.outcome` | `RiskDecision` variant(s) possible | `RiskDecision.approved` |
|---|---|---|---|
| `OPEN` | `'SIZED'` (a feasible tier candidate was found, §7.4) or `'NOT_SIZED'` (sizing was attempted but failed — no feasible tier, invalid price, etc.) | `AcceptedOpenRiskDecision` (iff `SIZED` **and** every downstream gate in §13.2 passes) or `RejectedRiskDecision` | non-null (Accepted) or `null` (Rejected) |
| `CLOSE` | `'NOT_APPLICABLE'` (risk-budget sizing never applies to closing an existing position, §2.6) | `AcceptedCloseRiskDecision` (iff ownership verification, §2.8, and identity/provenance checks pass) or `RejectedRiskDecision` | non-null CLOSE-shaped object (Accepted) or `null` (Rejected) |
| `NO_CHANGE` | `'NOT_APPLICABLE'` | `RejectedRiskDecision` **only** | always `null` |
| `REVERSAL_DEFERRED` | `'NOT_APPLICABLE'` | `RejectedRiskDecision` **only** | always `null` |

This is the single frozen source of truth for how sizing, action, and the accepted/rejected envelope relate — `NOT_APPLICABLE` (§7.2/§7.5) replaces what was previously an inconsistent implicit null/non-null relationship for `CLOSE`/`NO_CHANGE`/`REVERSAL_DEFERRED`. For `OPEN`, the exact field-by-field derivation of `approved` from `PositionSizingDecision.sizing` is the canonical projection frozen in §7.5.1 (`[P13-SPEC-001]`) — the two shapes are deliberately **not** structurally identical.

---

## 6. Position Sizing `[unchanged core math, corrected inputs §2/§3]`

### 6.1 Validation (fail closed before any arithmetic) — extended
| Condition | Rejection |
|---|---|
| Canonically ingested `entryPriceUsdt ≤ 0`, `< minPrice`, `> maxPrice`, or not tick-aligned | `INVALID_ENTRY_PRICE` |
| `stopPriceUsdt` same checks | `INVALID_STOP_PRICE` |
| `side = LONG` and `stopPriceUsdt ≥ entryPriceUsdt` | `INVALID_STOP_DISTANCE` |
| `side = SHORT` and `stopPriceUsdt ≤ entryPriceUsdt` | `INVALID_STOP_DISTANCE` |
| resulting `stopDistanceUsdt ≤ 0` | `INVALID_STOP_DISTANCE` |
| effective `riskPerTradePercent ≤ 0` or `currentEquityInr ≤ 0` | `RISK_BUDGET_NON_POSITIVE` |

Malformed entry/stop Decimal evidence, including non-finite values, fails canonical ingestion first with `RISK_SOURCE_INVALID` (§11.1/§13.2); the price codes above apply only to valid canonical values. This step only executes for `action = 'OPEN'` (§2.5–§2.7 exempt every other action).

### 6.2 Deterministic Sizing Formula (unit table frozen in §8.1)
$$\text{riskBudgetInr} = \text{currentEquityInr} \times \frac{\text{riskPerTradePercent}}{100}$$
$$\text{stopDistanceUsdt} = |\text{entryPriceUsdt} - \text{stopPriceUsdt}|$$
$$\text{perUnitLossInr} = \text{stopDistanceUsdt} \times \text{contractMultiplier} \times \text{rateInrPerUsdt}$$
$$\text{riskCappedQuantity} = \left\lfloor \frac{\text{riskBudgetInr} / \text{perUnitLossInr}}{\text{quantityIncrement}} \right\rfloor \times \text{quantityIncrement}$$

`riskCappedQuantity` is a **fixed ceiling** — it is computed once, independent of leverage, and is never exceeded by the final answer (§7.3, step 4 intersects it as one of several ceilings).

---

## 7. Finite Leverage-Tier Enumeration `[P13-M04 R2 — now applies every notional cap; P13-E02 R2 — now consumes adapter-verified tier intervals]`

### 7.1 Why the Original Loop Was Wrong

The original bounded fixed-point loop (`candidateQuantity` monotonically shrinking across iterations, "return at the first non-decreasing iteration") can converge to a **locally stable but not globally greatest** quantity: because margin capacity at a *lower* leverage tier can sometimes support a *larger* quantity than the loop reaches by always evaluating the tier implied by the *current* (shrinking) quantity, the loop had no guarantee of finding the true maximum feasible quantity across all tiers — only a fixed point of one specific descent path. This is retracted.

### 7.2 Frozen Replacement: Exhaustive Finite Tier Enumeration Over Adapter-Verified Intervals

Instead of iterating a shrinking quantity and re-deriving its tier, Phase 13 enumerates **every tier exactly once** (a single finite pass, bounded by `tiers.length`, with zero recursion and zero convergence dependency) and computes the best feasible quantity **achievable at that tier's leverage**, then takes the global maximum across all tiers.

**Precondition (corrected, §14.1):** tier intervals are no longer *derived* by Phase 13 from adjacent tiers' `maxPositionSizeUsdt` — that derivation assumed an inclusive-upper-bound convention CoinDCX has never documented. Phase 13 now consumes `VerifiedLeverageTier[]` (§14.1), each carrying **explicit, adapter-verified** `lowerNotionalUsdt`/`upperNotionalUsdt`/`lowerInclusive`/`upperInclusive`/`maxLeverage`. The adapter — not the risk engine — is responsible for proving these intervals are ordered, non-overlapping, and gap-free (§14.1); Phase 13 only re-validates that proof defensively at ingestion. `tiers` non-empty and `semanticsStatus === 'VERIFIED'` are both required before any `OPEN` sizing runs; violated ⇒ `LEVERAGE_TIERS_UNAVAILABLE` / `LEVERAGE_TIER_SEMANTICS_UNVERIFIED` respectively (§14.1).

### 7.3 The Algorithm (single finite pass, `i = 0 .. n-1` over `VerifiedLeverageTier[]`)

**Canonical notional-to-quantity conversion**, used for every cap below (`[P13-M04 R2]`):
$$\text{qtyFromUsdtCap}(C_{\text{usdt}}) = \left\lfloor \frac{C_{\text{usdt}} / (\text{entryPriceUsdt} \times \text{contractMultiplier})}{\text{quantityIncrement}} \right\rfloor \times \text{quantityIncrement}$$
$$\text{qtyFromInrCap}(C_{\text{inr}}) = \text{qtyFromUsdtCap}(C_{\text{inr}} / \text{rateInrPerUsdt})$$
A cap whose authority-matrix status is `NOT_APPLICABLE` (§10.1 — e.g. `PairRiskSnapshot.maxNotional === null`) contributes **nothing** to any `min()` below; it is never treated as `Infinity` and never silently dropped either — its absence is recorded as `NOT_APPLICABLE` in `capsApplied` (§10.2), not omitted from the audit trail.

For each tier `i`:
1. **Tier leverage cap:** `tierLeverage := tiers[i].maxLeverage`.
2. **Final leverage candidate for this tier:** `finalLeverage_i := min(tierLeverage, requestedLeverage ?? modeRecommendedLeverage, modeRecommendedLeverage, accountMaxLeverage, pairMaxLeverage, globalMaxLeverage)` (§10 authority matrix; `exchangeMaxLeverage` is never separately needed here since `tierLeverage ≤ exchangeMaxLeverage` by construction — `exchangeMaxLeverage = max(tiers[].maxLeverage)`).
3. **Margin-limited quantity at this tier's leverage:**
   $$\text{marginQty}_i = \text{qtyFromInrCap}\big(\text{availableMarginInr} \times \text{finalLeverage}_i\big)$$
4. **Tier interval bound as a quantity ceiling**, respecting inclusivity exactly (`[P13-E02 R2]`) — let `boundaryQty(usdt, inclusive)` be `qtyFromUsdtCap(usdt)`, adjusted down by one `quantityIncrement` if `!inclusive` and that floored quantity's implied notional lands exactly on `usdt` (the excluded boundary point):
   $$\text{tierUpperQty}_i = \text{tiers}[i].\text{upperNotionalUsdt} = \text{null} \ ?\ +\infty_{\text{qty}} : \text{boundaryQty}(\text{tiers}[i].\text{upperNotionalUsdt},\ \text{tiers}[i].\text{upperInclusive})$$
   (`+∞_qty` here is a **sizing-internal placeholder for "this tier's own interval imposes no ceiling"**, used only inside this per-tier computation — it is never written into `capsApplied`, never crosses into §10's authority matrix, and is immediately superseded by every other ceiling in step 5's `min()`; only the topmost tier may have `upperNotionalUsdt === null`, §14.1.)
5. **Intersect EVERY applicable ceiling** into one candidate quantity for this tier — the complete list, corrected to include what was previously missing:
   $$\text{candidate}_i = \min\Big(\text{riskCappedQuantity},\ \text{maxQuantity},\ \text{marginQty}_i,\ \text{tierUpperQty}_i,\ \text{qtyFromInrCap}(\text{maxNotionalPerTradeInrResolved}),\ \text{qtyFromUsdtCap}(\text{pairMaxNotionalUsdt}),\ \text{qtyFromInrCap}(\text{globalExposureHeadroomInr}),\ \text{qtyFromInrCap}(\text{pairExposureHeadroomInr}),\ \text{qtyFromInrCap}(\text{strategyExposureHeadroomInr})\Big)$$
   where: `maxNotionalPerTradeInrResolved = min(RiskModeConfig.maxNotionalPerTradeInr, override if tighter)` (§10.1); `pairMaxNotionalUsdt = PairRiskSnapshot.maxNotional` (omitted from the `min()` — `NOT_APPLICABLE` — when `null`); `*ExposureHeadroomInr` are the remaining global/pair/strategy exposure capacity (§9.1) before this candidate's notional is added. **`modeQuantityCap` — an undefined term used in the retracted revision — no longer appears anywhere; every notional-derived ceiling above is spelled out by name and by formula.** A strategy-**instance**-level per-trade notional cap does not exist as a configuration concept in Phase 13 V1 (only the aggregate `maxStrategyExposureInr` exposure limit exists, already captured via `strategyExposureHeadroomInr`) — this is stated explicitly rather than left implicit, so no future reader mistakes its absence for an oversight.
6. **Quantize down** to `quantityIncrement` (every term above is already increment-aligned or floored at the point of computation; `candidate_i` is re-floored defensively).
7. **Verify tier membership and every floor — and REVALIDATE every cap from step 5, not just tier/margin/risk-budget** (`[P13-M04 R2]`, defense-in-depth against a future implementation bug silently emitting an over-cap quantity): `candidate_i` must satisfy tier membership (`lowerInclusive`/`upperInclusive`-aware, symmetric to step 4), `candidate_i ≥ minQuantity`, `candidate_i ≥ minTradeSize`, `candidate_i × entryPriceUsdt × contractMultiplier ≥ minNotional`, `candidate_i × entryPriceUsdt × contractMultiplier ≤ pairMaxNotionalUsdt` (if applicable), `candidate_i × entryPriceUsdt × contractMultiplier × rateInrPerUsdt ≤ maxNotionalPerTradeInrResolved`, and each exposure headroom bound. If any fail, tier `i` yields **no feasible candidate** (discarded, not an error — by construction from step 5 this should never actually fail, but the revalidation is required rather than assumed).
8. **Collect** `(tier i, candidate_i)` into the feasible set if step 7 passed.

### 7.4 Selection

$$\text{finalQuantity} = \max\{\, \text{candidate}_i \mid i \in \text{feasible set} \,\}$$

The chosen `i` fixes `finalLeverage = finalLeverage_i`. **This is the true global maximum satisfying every applicable quantity, notional, tier, margin, and exposure constraint** — every tier is evaluated independently against the *complete* constraint intersection (§7.3 step 5, now including `maxNotional` and every resolved notional cap), so no achievable `(leverage, quantity)` pair is skipped, and the result does not depend on enumeration order, unlike the retracted loop.

If the feasible set is empty:
- if every tier failed **specifically** because `marginQty_i` was the binding (smallest) constraint and it fell below `minQuantity`/`minTradeSize`/`minNotional` ⇒ reject `INSUFFICIENT_MARGIN`.
- else if every tier failed specifically because a resolved notional cap (`maxNotionalPerTradeInrResolved`, `pairMaxNotionalUsdt`, or an exposure headroom) — not margin — was the binding constraint and forced `candidate_i` below the floors ⇒ reject `MIN_QUANTITY_NOT_MET` or `MIN_NOTIONAL_NOT_MET` as applicable.
- else (mixed causes, or structurally no tier could ever apply — e.g. `entryPriceUsdt × contractMultiplier` alone exceeds every tier's interval) ⇒ reject `NO_VALID_LEVERAGE_TIER`.

No cycles. No "last iteration wins." No rounding above `riskCappedQuantity`. `maxIterations` no longer exists as a concept — the pass length is exactly `tiers.length`, a property of the input, not a derived safety bound.

### 7.5 `PositionSizingDecision` (first-class output, §1.2) `[P13-M01, P13-B04 R2 — 3-way outcome]`

```typescript
export interface PositionSizingDecision {
  readonly schemaVersion: 1;
  readonly positionSizingDecisionId: string;      // sha256CanonicalJson, §11
  readonly sourceStrategyDecisionId: string;
  readonly strategyInstanceId: string;             // [P13-B03 R2]
  readonly pair: string;
  readonly instrumentSpecSnapshotId: string;
  readonly positionSizingPolicyId: string;        // binds §6/§7 policy versions, §11.3
  readonly action: RiskDecisionAction;
  readonly outcome: 'SIZED' | 'NOT_SIZED' | 'NOT_APPLICABLE';  // [P13-B04 R2] — NOT_APPLICABLE: CLOSE/NO_CHANGE/REVERSAL_DEFERRED never invoke risk-budget sizing at all; NOT_SIZED: OPEN was attempted but no feasible tier candidate was found (§7.4)
  readonly sizing: {
    readonly riskBudgetInr: string;
    readonly riskCappedQuantity: string;
    readonly finalQuantity: string;
    readonly finalLeverage: string;
    readonly finalNotionalUsdt: string;
    readonly finalNotionalInr: string;
    readonly estimatedInitialMarginUsdt: string;
    readonly estimatedInitialMarginInr: string;
    readonly estimatedStopLossRiskInr: string;
  } | null;                                        // non-null iff outcome === 'SIZED'
  readonly sizingReasonCodes: readonly string[];
  readonly auditTrail: readonly RiskAuditStep[];
}
```
#### 7.5.1 `sizing` → `approved` Canonical Projection `[P13-SPEC-001]`

**The defect being corrected:** this section previously required `RiskDecision.approved` to be **field-for-field identical** to `PositionSizingDecision.sizing` for `action = 'OPEN'`. The two objects do not and should not have identical field sets: `sizing` is the authoritative *calculation* record (it carries `riskBudgetInr` and `riskCappedQuantity`, which are intermediate derivations no executor needs), while `approved` is the execution-facing *approval* envelope using `approved*` names. Taken literally, the old wording demanded either renaming one shape into the other or duplicating calculation fields into the approval — neither of which is intended, and the contradiction blocked implementation. "Field-for-field identical" is retracted and replaced by an exact one-to-one **projection**.

**Frozen rule:** `PositionSizingDecision.sizing` is the single authoritative sizing calculation. `AcceptedOpenRiskDecision.approved` is a **pure, deterministic projection** of it — a rename-only copy of a strict subset. Every value is carried across **verbatim** (already-canonical decimal strings, §11.1); the engine performs **no recomputation, no re-rounding, no re-derivation, and no adjustment** when building `approved`.

| `AcceptedOpenRiskDecision.approved` field | ← source (`PositionSizingDecision.sizing`) |
|---|---|
| `approvedQuantity` | `finalQuantity` |
| `approvedLeverage` | `finalLeverage` |
| `approvedNotionalUsdt` | `finalNotionalUsdt` |
| `approvedNotionalInr` | `finalNotionalInr` |
| `estimatedInitialMarginUsdt` | `estimatedInitialMarginUsdt` (same name) |
| `estimatedInitialMarginInr` | `estimatedInitialMarginInr` (same name) |
| `estimatedStopLossRiskInr` | `estimatedStopLossRiskInr` (same name) |

`riskBudgetInr` and `riskCappedQuantity` are deliberately **not** projected — they are inputs to the calculation, not approvals, and remain available for audit on the canonical `PositionSizingDecision`. This is the complete mapping: `approved` has exactly seven fields, each sourced from exactly one `sizing` field, and no `approved` field has any other origin.

**Frozen guarantees:**
- **No modification.** `AcceptedOpenRiskDecision` cannot alter a projected value. If a projected field were ever unequal to its source, that is a Phase 13 implementation defect, not a business outcome — it is asserted, not tolerated.
- **No duplicated recalculation.** There is exactly one code path that computes each of these numbers (§6–§7), and `RiskDecision` construction reads its output. `RiskDecision` adds only the gates layered on top (§9–§10) and the decision envelope.
- **Identity binding.** `RiskDecisionBase.sourcePositionSizingDecisionId` is always non-null (§5.4), and `positionSizingDecisionId` is bound into `riskDecisionId` (§11.5) — so the approval is cryptographically tied to the exact sizing record it projects, and a changed sizing calculation necessarily changes the risk decision identity.
- **Projection exists only for `OPEN`.** For `action = 'CLOSE'`, `PositionSizingDecision.outcome` is always `'NOT_APPLICABLE'`, `sizing` is `null`, and `AcceptedCloseRiskDecision.approved` (§5.2) is computed directly from `PairRiskSnapshot.ownership` (§2.8) — no projection applies. See §5.4 for the complete action-by-action relationship table.

---

## 8. Evidence Provenance, Freshness & Currency `[P13-M05, P13-M03]`

### 8.1 Financial Unit Table `[P13-M03]`

| Field | Unit |
|---|---|
| `riskBudgetInr`, `estimatedStopLossRiskInr` | INR |
| `entryPriceUsdt`, `stopPriceUsdt`, `stopDistanceUsdt` | USDT |
| `quantity` (all forms) | contracts (unitless instrument quantity) |
| `contractMultiplier` | USDT notional per contract per unit price (dimensionless multiplier) |
| `notionalUsdt` | USDT |
| `rateInrPerUsdt` | INR per USDT |
| `notionalInr` | INR |
| `estimatedInitialMarginUsdt` | USDT |
| `estimatedInitialMarginInr` | INR |
| maintenance margin | **Not computed in V1** — see §8.3 |

`estimatedInitialMarginUsdt = notionalUsdt / finalLeverage`; `estimatedInitialMarginInr = estimatedInitialMarginUsdt × rateInrPerUsdt`. The generic name `estimatedMargin` from the original freeze is retired everywhere in favor of these two explicit fields.

### 8.2 Maintenance Margin — Explicitly Deferred `[P13-M03, Option B]`

**Phase 13 does NOT compute progressive maintenance margin or a liquidation price in V1.** `estimatedInitialMarginInr` (`notionalInr / finalLeverage`) is the **initial margin lock estimate only** — it is not a maintenance-margin figure, not a liquidation buffer, and not a liquidation-price estimate, and no part of this document should be read as implying otherwise.

`CoinDcxLeverageTierSnapshot.safetyMarginTiers` (projected from `InrFuturesInstrument.dynamicSafetyMarginTiers`) is retained purely as **disclosed adapter evidence** for audit/future use — Phase 13 reads it into the snapshot for lineage completeness but does not use `maintenanceMarginPercent` in any accept/reject computation. Computing a progressive tranche maintenance-margin formula or a liquidation distance requires authoritative confirmation of CoinDCX's exact blended-vs-marginal-rate semantics and tier-boundary inclusivity, which is not yet established (§14.2) — fabricating that formula without exchange confirmation is prohibited (zero data fabrication). A future phase may pick this back up once semantics are verified.

### 8.3 Snapshot Provenance Model `[P13-M05]`

Every evidentiary snapshot embeds one common provenance shape instead of ad hoc `asOfMs`/`fetchedAtMs`/`maxAgeMs` fields:
```typescript
export interface EvidenceProvenance {
  readonly sourceId: string;
  readonly sourceTimeMs: number | null;   // server/exchange-declared truth time; null when the source exposes none — disclosed, not fabricated
  readonly observedAtMs: number;          // adapter fetch/observation time — always required
  readonly contentSha256: string;         // canonical hash of the normalized snapshot payload, computed by Phase 13 at ingestion (§11)
}
```
**Maximum age is a policy property, never a snapshot property** — the earlier design (`AccountRiskSnapshot.maxAgeMs`, etc.) let evidence define its own trust window, which a compromised or buggy adapter could abuse. Corrected: `RiskFreshnessPolicy` lives entirely inside the risk-mode-independent, load-time-frozen policy layer:
```typescript
export interface RiskFreshnessPolicy {
  readonly riskFreshnessPolicyId: string;          // [P13-SPEC-004] sha256CanonicalJson(self minus this field)
  readonly maxAccountSnapshotAgeMs: number;
  readonly maxPairSnapshotAgeMs: number;
  readonly maxExposureSnapshotAgeMs: number;
  readonly maxLeverageTierSnapshotAgeMs: number;
  readonly maxSettlementRateSnapshotAgeMs: number;
}
```

**`riskFreshnessPolicyId` — canonical identity (`[P13-SPEC-004]`).** **The defect being corrected:** every field above is decision-affecting (a different max-age can flip an evaluation between `ACCEPTED` and `*_STATE_STALE`), yet the frozen `riskPolicyId` payload (§11.4) omitted the freshness policy entirely — so an operator could tighten or loosen a staleness threshold, change real outcomes, and produce an unchanged `riskPolicyId` and unchanged `riskDecisionId`s. Two evaluations with identical identities could then have been decided under different freshness rules, defeating replay.

$$\text{riskFreshnessPolicyId} = \text{SHA-256}\Big(\text{CanonicalJson}\big(\text{RiskFreshnessPolicy} \setminus \{\text{riskFreshnessPolicyId}\}\big)\Big)$$

The canonical payload is the **exact** five-field shape above — all five max-age limits, nothing else — validated by the same exact-shape rule as every other canonical contract (§11.2), so no unknown field can silently enter or escape the hash. Each value is a non-negative safe integer count of milliseconds, normalized per the repository's identity rules (§11.1): a non-integer, negative, non-finite, or non-safe-integer value is a load-time `RISK_CONFIG_INVALID` (Group C, §10.3), never a per-trade condition. Computed once at config load alongside every other policy identity (§11.3), and recomputed/verified by the engine rather than accepted from configuration.

**Snapshot timestamps are not duplicated here.** `observedAtMs`/`sourceTimeMs` and every snapshot's `contentSha256` already enter decision identity through `riskDecisionId` (§11.5); this policy ID binds only the *thresholds* those timestamps are judged against. The two are complementary — evidence identity versus policy identity — and neither restates the other.
`maxClockSkewAheadMs` — present in the prior revision — is **removed** (`[P13-M05 R2]`, see §8.4): it weakened strict causal ordering into a tolerance band, which is unacceptable for a pure, deterministic engine consuming evidence it cannot itself timestamp.

### 8.4 Strict Temporal Causality & Position Identity `[P13-M05 R2]`

**The defect being corrected:** the prior revision tolerated `sourceTimeMs`/`observedAtMs` up to `maxClockSkewAheadMs` *ahead* of `evaluationTimeMs`, meaning the pure engine could accept evidence that, on its face, describes a moment in the future relative to the causal instant being evaluated. This is retracted without replacement inside the pure engine.

**Frozen production invariant — zero tolerance, enforced by `evaluateRisk()` itself:**
$$\text{provenance.sourceTimeMs} \le \text{provenance.observedAtMs} \le \text{evaluationTimeMs}$$
(the first inequality applies only when `sourceTimeMs !== null`). There is no skew allowance, no grace window, and no configuration knob that can widen this — it is not a policy value, it is a structural precondition on every snapshot the pure engine accepts. `RiskEvaluationContext.evaluationTimeMs` is the only time reference used anywhere in this check; the pure engine never calls `Date.now()`.

**Where operational clock skew tolerance actually belongs:** if a real deployment needs to tolerate minor clock drift between CoinDCX, the adapter host, and the risk-evaluation host, that tolerance is applied — attested, normalized, or the evidence is rejected outright — by the **adapter**, strictly *before* it constructs the canonical snapshot handed to `RiskEvaluationContext`. By the time a snapshot reaches the pure engine, it must already satisfy strict causal ordering; the engine performs no leniency of its own. This is a boundary the engine cannot police (it cannot know what tolerance an adapter applied), so it does not try — it simply refuses anything that fails the strict inequality above, which correctly rejects *both* a genuinely-skewed clock and a fabricated future timestamp identically.

**Position identity (`positionId`), bound to the real Phase 2 model:** `PairPositionState.positionId` (§3.1) is `InrFuturesPosition.id` verbatim. `PositionOwnershipState.RECONCILED.positionId` (§2.8) must equal it whenever `position.state === 'OPEN'`. Violations fail closed:

| Condition | Rejection |
|---|---|
| `evaluationTimeMs - observedAtMs > policy.maxXSnapshotAgeMs`, **and** causal ordering already holds | `*_STATE_STALE` / `LEVERAGE_TIERS_STALE` / `SETTLEMENT_RATE_STALE` (per snapshot) — age-limit breach only (`[P13-SPEC-003]`) |
| `observedAtMs > evaluationTimeMs` (any amount, no tolerance) | `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION` (Group B) — future observed timestamp |
| `sourceTimeMs !== null` and `sourceTimeMs > observedAtMs` (any amount, no tolerance) | `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION` (Group B) — future source timestamp |
| account identity on `AccountRiskSnapshot` ≠ configured account identity | `ACCOUNT_IDENTITY_MISMATCH` (Group B) |
| pair identity mismatch across candidate / sizing proposal / pair config / any pair-scoped snapshot | `DECISION_IDENTITY_MISMATCH` (Group B, §2.2) |
| `ownership.positionId` (when `ReconciledOpenOwnership`) ≠ `position.positionId` (when `OPEN`) | `POSITION_IDENTITY_MISMATCH` (Group B, §2.8) — stale ownership from a prior, since-closed position |
| `valuation.valuationPriceSourceTimeMs > valuation.valuationPriceObservedAtMs`, or `valuation.valuationPriceObservedAtMs > evaluationTimeMs` (any amount, no tolerance) | `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION` (Group B, §3.1.1) |
| `valuation.valuationMethodVersion` ≠ `RiskValuationPolicy.valuationMethodVersion` | `VALUATION_METHOD_MISMATCH` (Group B, §2.8.1 step 2) — evidence produced under a different valuation method than the policy in force |
| `valuation.contractMultiplier` ≠ `PairRiskSnapshot.contractMultiplier` | `PAIR_STATE_UNAVAILABLE` (Group B, §2.8.1 step 2) — the pair snapshot contradicts itself |
| `valuation.conversionRateInrPerUsdt` ≠ `SettlementConversionSnapshot.rateInrPerUsdt` | `SETTLEMENT_RATE_UNAVAILABLE` (Group B, §2.8.1 step 2) — the valuation's conversion binding is not the conversion evidence supplied |
| reported `unitValuationInrPerQty` / `aggregateCurrentNotionalInr` / any `currentNotionalInr` ≠ the engine's recomputation (§3.1.1) | `POSITION_OWNERSHIP_UNRECONCILED` (Group B, §2.8.1 steps 3–5) — a supplied notional can never bypass recomputation |
| `CoinDcxLeverageTierSnapshot.pair` / `SettlementConversionSnapshot` market identity mismatch | `LEVERAGE_TIERS_UNAVAILABLE` / `SETTLEMENT_RATE_UNAVAILABLE` respectively (evidence does not describe the evaluated instrument/market, §14, §15.3) |
| any snapshot's `provenance.sourceId` ≠ its policy-bound expected source ID (§8.6) | `SOURCE_ID_MISMATCH` (Group B) — source authority only |
| declared `provenance.contentSha256` ≠ the engine’s canonical content-hash recomputation | `DECISION_IDENTITY_MISMATCH` (Group B) — independently checked from source authority |

Caller-supplied evidence can never override or widen `RiskFreshnessPolicy`, and no snapshot has a field capable of asserting its own trust window or its own clock-skew allowance.

### 8.5 Currency Boundary (unchanged principle, corrected adapter ownership — see §15.3)

`SettlementConversionSnapshot` is retained exactly as in the original freeze (CoinDCX INR futures quote price/notional in USDT while margin/equity are INR — Invariant 2), but its adapter is now explicitly a **separate, not-yet-implemented** boundary (§15.3) rather than an assumed extension of the Phase 2 wallet/instrument models.

### 8.6 Expected Source Authority `[P13-M05 R3]`

**The defect being corrected:** every snapshot carries `provenance.sourceId` (§8.3), but nothing previously defined what that value was *supposed to be* — a snapshot could self-report any `sourceId` string and Phase 13 had no independent basis to judge it correct. A `sourceId` is only meaningful evidence of provenance if it is checked against an authority the evidence itself cannot influence.

**Frozen policy-owned expected-source contract**, immutable, canonical, and constructed independently of any evidence being validated:
```typescript
export interface RiskSourceAuthorityPolicy {
  readonly riskSourceAuthorityPolicyId: string;   // sha256CanonicalJson(self minus this field)
  readonly accountRiskSourceId: string;            // expected AccountRiskSnapshot.provenance.sourceId
  readonly pairRiskSourceId: string;               // expected PairRiskSnapshot.provenance.sourceId (covers both instrument constraints and position/ownership — Phase 13 assembles both into one adapter-produced snapshot with one provenance, §3.1; a future phase splitting them into distinct snapshot types would add a second field here, not overload this one)
  readonly exposureSourceId: string;               // expected PortfolioExposureSnapshot.provenance.sourceId
  readonly leverageTierSourceId: string;           // expected CoinDcxLeverageTierSnapshot.provenance.sourceId
  readonly conversionSourceId: string;             // expected SettlementConversionSnapshot.provenance.sourceId
}
```
`RiskSourceAuthorityPolicy` is constructed once, at the same load time as `GlobalRiskConfig`/`PairRiskConfig`/`RiskModeConfig` (§10.3), from operator/deployment configuration — **never** derived from, or defaulted to, any value observed on an incoming snapshot. `riskSourceAuthorityPolicyId` is bound into `riskPolicyId` (§11.4), so a policy-level change to any expected source ID changes `riskPolicyId` and therefore every subsequent `riskDecisionId`.

**The check (runs for every snapshot, every evaluation):** `snapshot.provenance.sourceId === policy.<correspondingField>`. A mismatch fails closed with `SOURCE_ID_MISMATCH` (Group B) — the specific snapshot type responsible is disclosed by the `auditTrail` step name (§13.3 step 6), not by a family of per-snapshot codes; one canonical code, disambiguated by audit context, exactly as `DECISION_IDENTITY_MISMATCH` already covers multiple distinct identity sub-cases (§8.4). A snapshot can never satisfy this check by asserting a `sourceId` that happens to match itself — the comparison target is exclusively the frozen policy value.

---

## 9. Exposure Limits (gross-notional convention unchanged)

Unchanged core rule from the original freeze: all exposure checks are **gross** absolute notional sums, never netted across pairs (isolated per-pair margin accounting). `CLOSE` is exempt (§2.6). The checks themselves (`GLOBAL_EXPOSURE_LIMIT`, `PAIR_EXPOSURE_LIMIT`, `STRATEGY_EXPOSURE_LIMIT`, `MAX_CONCURRENT_POSITIONS`) now additionally intersect `PendingExposureState` (§4) rather than a scalar "0 if untracked" figure, and use the corrected provenance/freshness model (§8) instead of a snapshot-owned `maxAgeMs`.

### 9.1 Deterministic Checks (unchanged formulas, corrected pending-exposure input)
| Check | Formula | Rejection |
|---|---|---|
| Global notional | `globalOpenNotionalInr + pending.globalPendingNotionalInr (if KNOWN) + candidateNotionalInr ≤ min(GlobalRiskConfig.globalMaxOpenNotionalInr, RiskModeConfig.maxConcurrentExposureInr)` | `GLOBAL_EXPOSURE_LIMIT` |
| Pair notional | analogous, keyed by pair | `PAIR_EXPOSURE_LIMIT` |
| Strategy notional | analogous, keyed by strategyId | `STRATEGY_EXPOSURE_LIMIT` |
| Concurrent positions | `concurrentOpenPositions + (pending.pendingReservationCount if KNOWN else reject, §4.2) + 1 ≤ min(GlobalRiskConfig.globalMaxConcurrentPositions, PairRiskConfig.pairMaxConcurrentPositions ?? skip, RiskModeConfig.maxConcurrentPositions)` | `MAX_CONCURRENT_POSITIONS` |

`PairRiskConfig.pairMaxConcurrentPositions ?? skip` means: `null` contributes nothing to the `min()` (§10.3 — never `Infinity`).

**`strategyId` here is deliberate, not a repeat of the B03 defect** (`[P13-B03 R2 cross-reference]`): `STRATEGY_EXPOSURE_LIMIT` is an aggregate ceiling on a *strategy definition's* total footprint across every instance and pair, and `RiskModeConfig.maxStrategyExposureInr` is defined at that granularity — this is a legitimate, deliberate use of `strategyId` as the key. It is never used to decide **ownership** of a specific position or reservation for `CLOSE`/`REVERSAL_DEFERRED` purposes; that decision is exclusively `strategyInstanceId`-keyed (§2.8).

---

## 10. Field-by-Field Authority Matrix `[P13-M02 — replaces the vague "pointwise min" claim]`

### 10.1 The Matrix

For each decision-affecting field, every layer is exactly one of `PROPOSE` (advisory, freely overridden downward), `TIGHTEN` (must validate `≤` its parent hard cap at load time), `HARD_CAP` (root or evidentiary authority for this field), or `NOT_APPLICABLE` (this layer genuinely contributes nothing — never `Infinity`).

| Field | Global config | Pair config | Strategy proposal | Risk mode | Override | Exchange/tier | Account/exposure (gate) | Engine arbiter |
|---|---|---|---|---|---|---|---|---|
| Risk per trade % / budget | N/A | N/A | N/A | HARD_CAP | TIGHTEN (≤mode) | N/A | N/A | value = min(mode, override) |
| Max leverage | HARD_CAP | TIGHTEN (≤global) | PROPOSE | TIGHTEN (≤pair) | TIGHTEN (≤mode) | HARD_CAP (evidentiary, per-tier) | TIGHTEN (`accountMaxLeverage`, optional) | `min()` of all resolved |
| Max quantity (instrument) | N/A | N/A | N/A | N/A | N/A | HARD_CAP (`maxQuantity`) | N/A | intersected in §7.3 step 4 |
| Max notional per trade | N/A | N/A | N/A | HARD_CAP | TIGHTEN (≤mode) | N/A | N/A | `min(mode, override)` |
| Global exposure | HARD_CAP | N/A | N/A | TIGHTEN (≤global) | N/A (V1 overrides do not touch aggregate exposure) | N/A | HARD_CAP (gate: current usage) | `min(global, mode)` vs gate |
| Pair exposure | N/A | HARD_CAP | N/A | TIGHTEN (≤pair) | N/A | N/A | HARD_CAP (gate) | `min(pair, mode)` vs gate |
| Strategy exposure | N/A | N/A | N/A | HARD_CAP (no parent layer exists in V1) | N/A | N/A | HARD_CAP (gate) | mode value vs gate |
| Max concurrent positions | HARD_CAP | TIGHTEN (optional, ≤global) | N/A | TIGHTEN (≤global) | N/A | N/A | HARD_CAP (gate) | `min()` vs gate |
| Daily loss (primary, INR) | HARD_CAP (`globalMaxDailyLossInr`, required `> 0`) | N/A | N/A | TIGHTEN (`maxDailyLossInr` ≤ global, required `> 0`) | N/A | N/A | HARD_CAP (gate: `dailyLossMagnitudeInr`) | `min(global, mode)` vs gate, §12.1.1 |
| Daily loss (optional secondary, %) | HARD_CAP (`globalDailyLossLimitPercent`, nullable) | N/A | N/A | TIGHTEN (`dailyLossLimitPercent` ≤ global, nullable) | N/A | N/A | HARD_CAP (gate: `dailyLossMagnitudePercent`) | `min(global, mode)` vs gate, evaluated only if configured, §12.1.1 |
| Drawdown | HARD_CAP | N/A | N/A | TIGHTEN (≤global) | N/A | N/A | HARD_CAP (gate) | `min(global, mode)` vs gate |

**Legend note:** the "Account/exposure" column is always a **gate** (compares current usage against the resolved cap) — it never proposes or widens the cap's ceiling value itself.

### 10.2 `RiskCapsApplied` Uses `CapValue`, Never a Bare String or `Infinity`

```typescript
export interface RiskCapsApplied {
  readonly riskPerTradePercentApplied: CapValue;
  readonly maxNotionalPerTradeInrApplied: CapValue;
  readonly requestedLeverage: CapValue;
  readonly modeRecommendedLeverage: CapValue;
  readonly exchangeMaxLeverage: CapValue;
  readonly tierMaxLeverage: CapValue;           // RESOLVED only for the tier ultimately selected (§7.4)
  readonly accountMaxLeverage: CapValue;         // NOT_APPLICABLE if account.accountMaxLeverage is null
  readonly pairMaxLeverage: CapValue;
  readonly globalMaxLeverage: CapValue;
  readonly finalLeverage: CapValue;
}
```
`status: 'NOT_APPLICABLE'` (a layer genuinely has no cap for this field, per §10.1) is now structurally distinct from `'UNRESOLVED'` (evaluation stopped, by an earlier failing step, before this cap was ever computed) and from `'RESOLVED'` (a real value). **No optional cap is ever coerced to `Infinity`.**

### 10.3 Load-Time Enforcement

Every `TIGHTEN` relationship in §10.1 is validated **once**, when `GlobalRiskConfig`/`PairRiskConfig`/`RiskModeConfig`/`RiskOverride` are constructed — never per-trade. A violation (a pair cap exceeding its global parent, a `HIGH` mode's `leverageRecommendation` exceeding `PairRiskConfig.pairMaxLeverage`, an override widening past its mode) throws `RiskConfigError` (`RISK_CONFIG_INVALID` or `RISK_OVERRIDE_INVALID`, Group C, §13) and constructs no decision of any kind. **`HIGH` and `CUSTOM` cannot widen any hard cap** — this is now enforced structurally by the same load-time check that governs every other mode, not asserted separately.

If a required field has **no** applicable layer at all after normalization (every column is `NOT_APPLICABLE`), config load fails closed with `RISK_CONFIG_INVALID` — a field with zero resolvable authority is a configuration error, never silently unlimited.

### 10.4 Canonical Config Type Declarations

The types §9–§13 reference by field (`GlobalRiskConfig.globalMaxOpenNotionalInr`, `RiskModeConfig.dailyLossLimitPercent`, etc.) are declared here in full — completing the referenced contracts, including the `maxDailyLossInr`/`globalMaxDailyLossInr` fields required by §12.1.1 (`[P13-M07 R3]`):
```typescript
export type RiskMode = 'SAFE' | 'NORMAL' | 'HIGH' | 'CUSTOM';

export interface GlobalRiskConfig {
  readonly globalRiskConfigId: string;              // sha256CanonicalJson(self minus this field)
  readonly globalMaxLeverage: string;
  readonly globalMaxOpenNotionalInr: string;
  readonly globalMaxConcurrentPositions: number;
  readonly globalMaxDailyLossInr: string;            // [P13-M07 R3] primary hard gate — required, > 0
  readonly globalDailyLossLimitPercent: string | null; // [P13-M07 R3] optional secondary gate — null disables it
  readonly globalMaxDrawdownPercent: string;
}

export interface PairRiskConfig {
  readonly pair: string;
  readonly pairRiskConfigId: string;
  readonly pairMaxLeverage: string;                  // TIGHTEN ≤ globalMaxLeverage
  readonly pairMaxExposureInr: string;               // TIGHTEN ≤ globalMaxOpenNotionalInr
  readonly pairMaxConcurrentPositions: number | null; // null = NOT_APPLICABLE, never Infinity (§10.1)
}

export interface RiskModeConfig {
  readonly mode: RiskMode;
  readonly riskModeConfigId: string;
  readonly riskPerTradePercent: string;
  readonly maxNotionalPerTradeInr: string;
  readonly leverageRecommendation: string;
  readonly maxConcurrentExposureInr: string;         // TIGHTEN ≤ globalMaxOpenNotionalInr
  readonly maxCoinExposureInr: string;                // TIGHTEN ≤ pairMaxExposureInr
  readonly maxStrategyExposureInr: string;            // HARD_CAP — no parent layer exists in V1 (§10.1)
  readonly maxConcurrentPositions: number;
  readonly maxDailyLossInr: string;                   // [P13-M07 R3] primary hard gate — required, > 0, TIGHTEN ≤ globalMaxDailyLossInr
  readonly dailyLossLimitPercent: string | null;       // [P13-M07 R3] optional secondary gate, TIGHTEN ≤ global when both non-null
  readonly maxDrawdownPercent: string;
  readonly consecutiveLossLimit: number | null;
  readonly cooldownMs: number | null;
}

export interface RiskOverride {
  readonly overrideId: string;
  readonly overrideRiskPerTradePercent: string | null;  // TIGHTEN ≤ mode's riskPerTradePercent
  readonly overrideMaxLeverage: string | null;           // TIGHTEN ≤ mode's leverageRecommendation
  readonly overrideMaxNotionalInr: string | null;        // TIGHTEN ≤ mode's maxNotionalPerTradeInr
}
```
Load-time validation (§10.3) rejects `globalMaxDailyLossInr ≤ 0`, `maxDailyLossInr ≤ 0`, or `maxDailyLossInr > globalMaxDailyLossInr` with `RISK_CONFIG_INVALID` — a zero, negative, or non-widening-violating primary daily-loss cap is a configuration error, never a per-trade decision (§13.2).

### 10.5 `RiskValuationPolicy` `[P13-B03 R5]`

The current-notional valuation method (§3.1.1) is a **policy**, not a snapshot property and not an adapter choice — otherwise the meaning of `currentNotionalInr` could drift between evaluations without changing any identity:
```typescript
export interface RiskValuationPolicy {
  readonly riskValuationPolicyId: string;          // sha256CanonicalJson(self minus this field)
  readonly valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1';
  readonly valuationPriceField: 'markPriceUsdt';   // frozen: never avgPriceUsdt
  readonly valuationUnitScale: number;             // decimal places for unitValuationInrPerQty — the single quantization point (§3.1.1)
  readonly valuationUnitRounding: 'ROUND_HALF_UP'; // matches the RiskCalcDecimal context default (§3 numeric policy)
}
```
Constructed once at the same load time as every other policy layer (§10.3), from operator/deployment configuration — never derived from, defaulted to, or widened by any observed snapshot value. Load-time validation rejects a non-integer, negative, or context-exceeding `valuationUnitScale` with `RISK_CONFIG_INVALID`. `CanonicalPositionValuation.valuationMethodVersion` must equal this policy's value on every evaluation (§2.8.1, step 2), so evidence produced under a different valuation method can never be silently consumed under this one.

---

## 11. Complete Canonical Identities `[P13-M06]`

### 11.1 Canonical Decimal Normalization

Before any decimal-bearing value enters canonical JSON or a content hash, it is passed through `canonicalDecimalString(value)`: parse via `RiskCalcDecimal`, re-emit as a fixed-point string with no scientific notation, no leading zeros (except a single `0` before the decimal point), no trailing fractional zeros, and `"-0"` normalized to `"0"`. `"1"`, `"1.0"`, and `"1.000"` all canonicalize to `"1"` — this mirrors Phase 10's existing parameter-hash canonicalization (Invariant 24) rather than inventing a new rule.

**Canonical ingestion boundary (`[P13-SPEC-002]`).** Decimal normalization precedes hashing and all value checks. The permitted decimal spellings already illustrated above (including leading zeros, trailing fractional zeros, and signed zero) normalize into the frozen fixed-point form; normalization does not change their economic value. `"100.00"` therefore becomes canonical `"100"`, and `"101.00"` becomes `"101"`. A supplied amount of `"100.00"` that normalizes successfully but disagrees with a recomputed `"101.00"` is a value-reconciliation failure: `POSITION_OWNERSHIP_UNRECONCILED`.

A required Decimal that cannot be parsed as a finite decimal value, or cannot be normalized under that format, fails with `RISK_SOURCE_INVALID` before canonical identity is established. Examples include `"abc"`, `"NaN"`, `"Infinity"`, and a prohibited formatted amount such as `"1,000"`. A prohibited non-canonical form is distinct from a permitted spelling explicitly normalized by §11.1; no prohibited representation reaches the canonical hash. Once canonical ingestion succeeds, `RISK_SOURCE_INVALID` is unreachable for that evaluation's evidence: unsafe derived valuation arithmetic returns `VALUATION_NUMERIC_CONTEXT_EXCEEDED`, a completed but unequal valuation returns `POSITION_OWNERSHIP_UNRECONCILED`, a declared content hash differing from canonical recomputation returns `DECISION_IDENTITY_MISMATCH`, and a policy-source mismatch returns `SOURCE_ID_MISMATCH`. Those checks retain separate meanings and normal reason precedence.

### 11.2 Exact-Shape Ingestion

Every canonical contract type (every snapshot, every config, every proposal) is validated at ingestion for field types, Decimal normalization (§11.1), and its **exact** expected key set — `Object.keys(value).length === expectedKeys.length` and every expected key present — mirroring the existing pattern in `src/strategies/core/identity.ts:29-32`. Unknown or extra fields are rejected at ingestion (typed Group C failures: `RISK_CONFIG_INVALID` / `RISK_OVERRIDE_INVALID` for static configuration, and `RISK_SOURCE_INVALID` for malformed per-evaluation evidence whose canonical identity cannot be established) — they can neither silently enter nor silently escape the canonical identity.

### 11.3 All Identities, Recomputed and Verified

| Identity | Computed over | Recomputed/verified by |
|---|---|---|
| `globalRiskConfigId` | `GlobalRiskConfig` minus this field | Engine, at config load |
| `pairRiskConfigId` | `PairRiskConfig` minus this field | Engine, at config load |
| `riskModeConfigId` | `RiskModeConfig` minus this field | Engine, at config load |
| `riskSourceAuthorityPolicyId` | `RiskSourceAuthorityPolicy` minus this field (§8.6) | Engine, at config load |
| `riskValuationPolicyId` | `RiskValuationPolicy` minus this field (§10.5) | Engine, at config load |
| `riskFreshnessPolicyId` | `RiskFreshnessPolicy` minus this field (§8.3) | Engine, at config load |
| `positionSizingPolicyId` | `{ policyId: 'P13_POSITION_SIZING_V1', tierEnumerationPolicyId: 'P13_LEVERAGE_TIER_ENUMERATION_V1', roundingMode: 'FLOOR_CONSERVATIVE' }` | Engine, at construction |
| `positionSizingDecisionId` | `PositionSizingDecision` minus this field | Engine, per evaluation |
| `riskPolicyId` | see §11.4 | Engine, at construction |
| `riskDecisionId` | see §11.5 | Engine, per evaluation |

If `RiskEvaluationContext` optionally carries `expectedRiskPolicyId` (a caller's defensive replay assertion), the engine recomputes `riskPolicyId` independently and throws `RISK_POLICY_IDENTITY_MISMATCH` (Group C) on any mismatch — an expected-ID field is never trusted at face value.

### 11.4 `riskPolicyId` — Full Version Binding

$$\text{riskPolicyId} = \text{SHA-256}\Big(\text{CanonicalJson}\big(\{\, \text{globalRiskConfigId}, \text{pairRiskConfigId}, \text{riskModeConfigId}, \text{riskSourceAuthorityPolicyId}, \\ \text{riskValuationPolicyId}, \text{riskFreshnessPolicyId}, \text{sizingPolicyId: 'P13\_POSITION\_SIZING\_V1'}, \\ \text{tierEnumerationPolicyId: 'P13\_LEVERAGE\_TIER\_ENUMERATION\_V1'}, \\ \text{exposurePolicyId: 'P13\_EXPOSURE\_V1'}, \text{lossDrawdownPolicyId: 'P13\_LOSS\_DRAWDOWN\_V1'}, \\ \text{validationPrecedenceId: 'P13\_VALIDATION\_PRECEDENCE\_V1'}, \text{rejectionPrecedenceId: 'P13\_REJECTION\_PRECEDENCE\_V1'}, \\ \text{auditOrderingId: 'P13\_AUDIT\_ORDERING\_V1'} \,\}\big)\Big)$$

`riskSourceAuthorityPolicyId` (`[P13-M05 R3]`, §8.6) is included so that any operator change to an expected `sourceId` — tightening or otherwise — produces a new `riskPolicyId` and, transitively, new `riskDecisionId`s; expected source authority is exactly as immutable and identity-bound as every other policy layer here. `riskValuationPolicyId` (`[P13-B03 R5]`, §10.5) is included for the same reason: the current-notional valuation method and its single quantization scale are decision-affecting (they determine whether ownership reconciles at all), so changing either must change every downstream identity rather than silently altering what `currentNotionalInr` means. `riskFreshnessPolicyId` (`[P13-SPEC-004]`, §8.3) closes the last such gap: every max-age threshold can flip an evaluation between acceptance and a `*_STATE_STALE` rejection, so changing any one of them **must** change `riskPolicyId` and therefore every subsequent `riskDecisionId`. With this addition, every policy layer that can alter an outcome is bound into `riskPolicyId` — there is no remaining decision-affecting policy value outside it.

### 11.5 `riskDecisionId`

$$\text{riskDecisionId} = \text{SHA-256}\Big(\text{CanonicalJson}\big(\{\, \text{riskPolicyId}, \text{positionSizingDecisionId}, \text{sourceStrategyDecisionId}, \\ \text{candidate}, \text{entryStopProposal}, \text{leverageProposal}, \text{override}, \text{evaluationTimeMs}, \\ \text{accountSnapshotSha256}, \text{pairSnapshotSha256}, \text{exposureSnapshotSha256}, \text{leverageTierSnapshotSha256}, \text{settlementRateSnapshotSha256} \,\}\big)\Big)$$

Each `*SnapshotSha256` is `provenance.contentSha256`, computed by Phase 13 itself over the deep-frozen, canonically-normalized snapshot at ingestion — never trusted from a caller-supplied value (unchanged principle from the original freeze). Strictly excluded: `Date.now()`, execution duration, host/PID/worker identifiers, mutable object insertion order. `evaluationTimeMs` is included (a causal input, not a wall-clock read).

---

## 12. Daily Loss / Drawdown — Exact Definitions `[P13-M07]`

### 12.1 Net Daily PnL Formula

$$\text{netDailyPnlInr} = \text{realizedTradingPnlInr} + \text{fundingPnlInr} - \text{feesInr} + \text{otherAccountAdjustmentsInr}$$

each a **named component**, not a single opaque blob — `AccountRiskSnapshot` carries all four separately so the formula is auditable rather than assumed:
```typescript
export interface DailyPnlComponents {
  readonly realizedTradingPnlInr: string;
  readonly fundingPnlInr: string;
  readonly feesInr: string;
  readonly otherAccountAdjustmentsInr: string;
  readonly netDailyPnlInr: string;   // must equal the sum above — verified at ingestion, not trusted blindly
}
```
`netDailyPnlInr` is **realized-only** — it explicitly excludes unrealized mark-to-market movement of any open position. This is why the daily-loss check and the drawdown check (§12.4, which does include unrealized PnL via `currentEquityInr`) are two independent gates, not one merged concept: a losing open position can breach drawdown with zero realized daily loss.

### 12.1.1 Daily Loss Magnitude — Exact Gate Formula `[P13-M07 R3 — direct INR cap is now the primary, required gate]`

**The defect being corrected:** Round 2 froze `dailyLossMagnitudeInr` correctly but then gated it by *converting to a percentage of equity* before comparing against a percentage-based limit. That conversion is an unnecessary, error-prone detour for what the review specifies as the primary hard gate: an INR magnitude should be compared directly against an INR cap. The percentage-based formulation is retained, but strictly demoted to a separate, optional, independently-reasoned gate — never a substitute for the direct comparison.

$$\text{dailyLossMagnitudeInr} = \max(0,\ -\text{netDailyPnlInr})$$

**Sign convention (frozen, unambiguous):**
- Profit day: `netDailyPnlInr > 0` ⇒ `dailyLossMagnitudeInr = 0`.
- Flat day: `netDailyPnlInr = 0` ⇒ `dailyLossMagnitudeInr = 0`.
- Loss day: `netDailyPnlInr < 0` ⇒ `dailyLossMagnitudeInr > 0` (exactly `-netDailyPnlInr`).
- `dailyLossMagnitudeInr` is **always `≥ 0`** by construction — it is never compared against the signed `netDailyPnlInr` directly, and the signed value is never itself compared against a positive limit.

**Primary gate — direct INR comparison (required, always evaluated):**
$$\text{maxDailyLossInrResolved} = \min\big(\text{GlobalRiskConfig.globalMaxDailyLossInr},\ \text{RiskModeConfig.maxDailyLossInr}\big)$$
Reject with `DAILY_LOSS_LIMIT` iff $\text{dailyLossMagnitudeInr} \ge \text{maxDailyLossInrResolved}$ — a value **equal to** the cap rejects (fail-closed at the boundary, unchanged convention from §12.4). `globalMaxDailyLossInr` and `maxDailyLossInr` are each required and validated `> 0` at config load (§10.4) — there is no code path where this gate is skipped for lacking a configured cap.

**Secondary gate — percentage of equity (optional, independent, never a substitute):** evaluated **only if** both `GlobalRiskConfig.globalDailyLossLimitPercent` and/or `RiskModeConfig.dailyLossLimitPercent` are non-null (either may independently be `null` = not configured, §10.4):
$$\text{dailyLossMagnitudePercent} = \frac{\text{dailyLossMagnitudeInr}}{\text{currentEquityInr}} \times 100$$
Reject with its own distinct reason, `DAILY_LOSS_PERCENT_LIMIT`, iff configured and $\text{dailyLossMagnitudePercent} \ge \min(\text{configured percent values})$. **This gate firing is never reported as `DAILY_LOSS_LIMIT`, and the primary INR gate firing is never reported as `DAILY_LOSS_PERCENT_LIMIT`** — they are two independent checks with two independent reason codes; a rejected decision may carry either, both, or neither in its `secondaryReasonCodes` (§13.4) depending on which actually fired.

**Fees and funding are already sign-correct by construction** (§12.1's formula): `feesInr` is always subtracted (fees are a cost, never a credit), while `fundingPnlInr` may legitimately be positive or negative depending on funding direction — both flow through `netDailyPnlInr` before the `max(0, -…)` clamp, so a day that is profitable in trading PnL but loses money overall once fees/negative funding are included is correctly captured as a loss day by this formula, and a day with a trading loss fully offset by favorable funding is correctly captured as a non-loss (`dailyLossMagnitudeInr = 0`) day.

**Unrealized PnL is explicitly excluded from this gate** (reaffirming §12.1's closing sentence as a standalone frozen rule, not left to inference): `dailyLossMagnitudeInr` is derived solely from `DailyPnlComponents` (realized-only). Only the drawdown gate (§12.4) is sensitive to unrealized PnL, via `currentEquityInr`.

### 12.2 Interval

$$[\text{UTC day start} = \lfloor \text{evaluationTimeMs} / 86\,400\,000 \rfloor \times 86\,400\,000,\ \ \text{evaluationTimeMs}]$$
inclusive of both endpoints — consistent with the UTC-day convention already frozen for Phase 12 (`docs/RESEARCH_VALIDATION.md` §7.5). No alternative CoinDCX settlement-day boundary is documented that would override this.

### 12.3 Equity Composition

`currentEquityInr` **includes** unrealized PnL of any open position (the conventional definition of equity) — but per §15.1, Phase 2's `InrFuturesWallet` model does **not** compute this (its own documentation states "The read layer does NOT compute derived account equity"). `currentEquityInr` therefore arrives from the new `AccountRiskStateProvider` adapter (§15.1) as an opaque, already-reconciled figure with disclosed provenance; Phase 13 does not derive it from raw wallet fields itself.

### 12.4 Drawdown, Peak, and Threshold Boundary

$$\text{drawdownPercent} = \frac{\text{peakEquityInr} - \text{currentEquityInr}}{\text{peakEquityInr}} \times 100$$
`peakEquityInr` is a running high-water mark maintained by the adapter since account risk tracking inception; it never auto-resets — an operator-triggered reset (if ever introduced) must be an explicit, separately-auditable adapter-side event, never a silent engine-side decision. `peakEquityInr ≤ 0` is a state-integrity failure (`ACCOUNT_STATE_UNAVAILABLE`), never a fabricated `100%` drawdown.

**Threshold boundary semantics (frozen, resolving prior ambiguity):** both the daily-loss check and the drawdown check reject on `≥` (a value **equal to** the configured limit rejects; strictly below passes).

### 12.5 Consecutive Loss & Cooldown

- **Loss event:** a closed trade's realized PnL `< 0` increments `consecutiveLossCount` by 1.
- **Breakeven or profit:** realized PnL `≥ 0` **resets** `consecutiveLossCount` to `0` (breakeven does not count as a loss, and does not leave the streak untouched — it clears it).
- **Cooldown start:** the exact closing trade that causes `consecutiveLossCount` to first reach `consecutiveLossLimit` sets `cooldownActiveUntilMs = thatTradeCloseTimeMs + cooldownMs`.
- **Cooldown boundary:** trading is blocked strictly while `evaluationTimeMs < cooldownActiveUntilMs`; at `evaluationTimeMs === cooldownActiveUntilMs` the cooldown has elapsed (inclusive-end).
- Both `consecutiveLossCount` and `cooldownActiveUntilMs` are computed and maintained by the `AccountRiskStateProvider` adapter (§15.1) from real trade history — Phase 13 only compares the supplied values against configured thresholds; it never recomputes them from raw trades itself (consistent with `dailyNetPnlInr` being pre-aggregated, §12.1).

### 12.6 Disclosure

Phase 2's `InrFuturesWallet` does **not** provide `currentEquityInr`, `peakEquityInr`, `DailyPnlComponents`, `consecutiveLossCount`, or `cooldownActiveUntilMs` — this is explicit in `docs/COINDCX_READ_LAYER.md` §9.3 ("The read layer does NOT compute derived account equity"). All of these are the `AccountRiskStateProvider` adapter's responsibility (§15.1), which Phase 13 does not implement.

---

## 13. Total Validation & Rejection Precedence `[P13-M08 R2 — one taxonomy, one pipeline, no contradictions]`

### 13.1 The Defect Being Corrected

The prior revision used `DECISION_IDENTITY_MISMATCH` (Group B, a rejected decision) in §2.2 for a `decisionId` recomputation mismatch, but §13.1's own disambiguating rule simultaneously implied that "`sourceStrategyDecisionId` fails recomputation" should throw `RISK_SOURCE_INVALID` (Group C) — the identical condition, described twice, with two different behaviors. This is retracted and replaced with exactly one rule.

### 13.2 One Rule to Tell the Two Failure Universes Apart

- **Static/construction-time (Group C, throws, no decision constructed):** malformed `GlobalRiskConfig`/`PairRiskConfig`/`RiskModeConfig`/`RiskOverride` (hierarchy violation, widening override, non-finite config decimal, wrong exact shape), unsupported risk mode, `expectedRiskPolicyId` mismatch — and, per §11.2's exact-shape ingestion, an incoming `StrategyDecision`/proposal/snapshot object carrying an unknown or missing required field, or a field of the wrong type, an unparseable/non-finite/prohibited Decimal form (§11.1), or invalid source structure (non-safe-integer timestamp, non-string identity field, a `status`/`targetExposure` combination the genuine Phase 10 kernel could never produce, §2.3). These are evaluated **once**, before any decisionId recomputation is even attempted — canonical source identity itself cannot be established from malformed shape, so there is nothing to attach a `riskDecisionId` to.
- **Per-evaluation (Group A/B, always produces a `RejectedRiskDecision`):** everything else, **without exception**, once the incoming `StrategyDecision`/proposals/snapshots have passed exact-shape, type, and canonical Decimal ingestion validation above. This explicitly includes a `decisionId` **recomputation mismatch** — the object is well-formed enough to compute a candidate hash from, it simply does not match what was asserted, which is exactly the situation `DECISION_IDENTITY_MISMATCH` exists to describe.

**The exact, singular disambiguating rule (frozen, replacing the two-different-answers version):** `RISK_SOURCE_INVALID` is restricted to cases where canonical source identity **cannot be established at all** — a structurally malformed object, an unknown field, a field of the wrong type, an unparseable or non-finite Decimal, or a prohibited non-canonical Decimal form (§11.1). Once an object is well-formed enough that Phase 13 *can* compute a canonical hash or identity from it, **no failure arising from it is ever `RISK_SOURCE_INVALID` (Group C)** — per-evaluation failures produce deterministic Group A/B rejections. The Group B evidence code is decided by the failed check (`[P13-SPEC-002]`):

- **Identity or hash recomputation** — a recomputed `decisionId`, `contentSha256`, or cross-field identity binding disagrees with the declared one ⇒ `DECISION_IDENTITY_MISMATCH`, with account identity using its own `ACCOUNT_IDENTITY_MISMATCH` and position identity using `POSITION_IDENTITY_MISMATCH` (§8.4). Source authority uses `SOURCE_ID_MISMATCH`, valuation method identity uses `VALUATION_METHOD_MISMATCH`, and the instrument/conversion bindings retain the specific codes in §2.8.1. `DECISION_IDENTITY_MISMATCH` never covers numerical value reconciliation.
- **Source authority** — actual `sourceId` differs from the policy-owned expected source ⇒ `SOURCE_ID_MISMATCH`. A correct hash cannot establish source authority.
- **Numeric content or value reconciliation** — a recomputed *amount* disagrees with a supplied *amount* ⇒ the code owning that reconciliation, `POSITION_OWNERSHIP_UNRECONCILED` for ownership valuation (§2.8.1 row F). A value disagreement is **never** an identity mismatch: identity answers "is this the object it claims to be," value reconciliation answers "does this number check out," and conflating them would report a corrupted amount as a misidentified object.
- **Arithmetic context exhaustion** — valuation calculation on valid canonical inputs cannot be completed within the frozen `RiskCalcDecimal` context ⇒ `VALUATION_NUMERIC_CONTEXT_EXCEEDED` (§3.1.1).

There is exactly one behavior per condition, not two, and the full valuation-failure mapping is tabulated in §2.8.1.

### 13.3 Fixed Total Pipeline Order (frozen; bound into `riskPolicyId`, §11.4)

Every evaluation runs this exact 13-step sequence — steps never reorder, and a step whose precondition failed is marked `SKIPPED` in the audit trail (not fabricated as `PASS` or `FAIL`), never silently omitted. The pipeline **never short-circuits**: every applicable step runs and is recorded regardless of earlier failures, so `auditTrail` is always complete.

1. **Static policy/config integrity** — `GlobalRiskConfig`/`PairRiskConfig`/`RiskModeConfig`/`RiskOverride` hierarchy validation (§10.3). Evaluated once at load time, not per-evaluation; a violation throws (Group C) before step 2 ever runs for any candidate.
2. **Canonical source shape** — exact-shape, field-type, and canonical Decimal ingestion validation (§11.2) of the incoming `StrategyDecision`, `EntryStopProposal`, `LeverageProposal`, and every snapshot. A violation throws `RISK_SOURCE_INVALID` (Group C) — canonical identity cannot be established (§13.2).
3. **Source `StrategyDecision` identity recomputation** — recompute `decisionId` via the genuine kernel hash formula (§2.2) and compare to the received value. Mismatch ⇒ `DECISION_IDENTITY_MISMATCH` (Group B) — **never** Group C (§13.2).
4. **Pair/account/instrument identity** — cross-field checks: candidate pair === proposal pair === `PairRiskConfig.pair` === `PairRiskSnapshot.pair`; `AccountRiskSnapshot.accountId` === configured account identity; `PositionOwnershipState.RECONCILED.positionId` === `PairPositionState.positionId` when `OPEN` (§8.4). Mismatches ⇒ `DECISION_IDENTITY_MISMATCH` / `ACCOUNT_IDENTITY_MISMATCH` / `POSITION_IDENTITY_MISMATCH` (all Group B).
5. **Proposal identity/provenance** — `EntryStopProposal.sourceStrategyDecisionId`/`LeverageProposal.sourceStrategyDecisionId` must equal the verified `decisionId` from step 3; provenance shape validated (§8.3). Mismatch ⇒ `DECISION_IDENTITY_MISMATCH` (Group B).
6. **Snapshot identity/provenance** — independently recompute and check each snapshot’s `contentSha256` (§11.5): a declared content-hash mismatch ⇒ `DECISION_IDENTITY_MISMATCH` (Group B). Separately compare every snapshot’s `provenance.sourceId` against the policy-bound expected value (§8.6): a source-ID mismatch ⇒ `SOURCE_ID_MISMATCH` (Group B). Correct content with an incorrect hash and correctly hashed content from an unexpected source are separate failures; if both checks fail, both codes participate in §13.4 precedence. **Valuation binding (`[P13-SPEC-002]`)** is checked in this same step for an `OPEN` position carrying a `valuation` (§2.8.1 step 2): method-identity mismatch ⇒ `VALUATION_METHOD_MISMATCH`, multiplier mismatch ⇒ `PAIR_STATE_UNAVAILABLE`, conversion-binding mismatch ⇒ `SETTLEMENT_RATE_UNAVAILABLE`, and an arithmetic context that cannot complete the valuation ⇒ `VALUATION_NUMERIC_CONTEXT_EXCEEDED` (§3.1.1) — **all Group B rejections**, all participating in normal primary/secondary precedence (§13.4); none throws.
7. **Temporal/freshness** — strict causal ordering (§8.4, zero tolerance) and policy-owned max-age staleness (§8.3) for every snapshot required by the not-yet-derived action, including `SettlementConversionSnapshot` and the valuation price timestamps (§3.1.1). Violations ⇒ `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION` (any causal-ordering breach, including a future-dated settlement rate — `[P13-SPEC-003]`) / `*_STATE_STALE` family (age-only breaches, Group B).
8. **Action derivation** — §2.5 table. `NO_CHANGE` terminates here with `primaryReasonCode: 'NO_CHANGE_TARGET_ALREADY_HELD'` (Group A); `REVERSAL_DEFERRED` terminates here with `primaryReasonCode: 'REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION'` (Group A).
9. **Instrument constraints** — tradeability gate (§3.3) and entry/stop/reference price bounds (§6.1); **SKIPPED** for `CLOSE`.
10. **Pending/ownership state** — `PendingExposureState` `KNOWN`/`UNKNOWN` (§4.2) for `OPEN`, each `InstancePendingReservation` identity-validated as a full four-field tuple (§4.1); `PositionOwnershipState` `RECONCILED`/`UNRECONCILED` for **both** `OPEN` and `CLOSE` (§2.8), including the full four-field `InstanceOwnershipRecord` identity check, aggregate-**quantity** reconciliation, and — recomputed by the engine against the canonical valuation basis (§3.1.1), never trusted as reported — aggregate-**notional** reconciliation under exact canonical Decimal equality (§2.8.1) — a `RECONCILED` claim failing *either* reconciliation is treated as `UNRECONCILED`. `UNKNOWN` ⇒ `PENDING_EXPOSURE_UNKNOWN`; `UNRECONCILED` (either action, including downgraded self-inconsistent claims) ⇒ `POSITION_OWNERSHIP_UNRECONCILED`; a four-field identity tuple mismatch on a matching `strategyInstanceId` ⇒ `DECISION_IDENTITY_MISMATCH`; mismatched-instance quantity on `CLOSE` ⇒ `POSITION_OWNERSHIP_MISMATCH` (all Group B).
11. **Sizing / tier / margin** — §6 risk-budget ceiling and §7 finite tier enumeration (now intersecting every notional cap, §7.3); **SKIPPED** for `CLOSE`/`NO_CHANGE`/`REVERSAL_DEFERRED` (§7.5, `outcome = 'NOT_APPLICABLE'`).
12. **Exposure / loss / drawdown** — §9 gross exposure checks and §12 daily-loss-magnitude/drawdown/cooldown checks; **SKIPPED** for `CLOSE` (de-risking is never blocked by a circuit breaker).
13. **Final decision assembly** — construct `AcceptedOpenRiskDecision` / `AcceptedCloseRiskDecision` / `RejectedRiskDecision` per the §5.4 relationship table: `ACCEPTED` iff every non-`SKIPPED` step in 2–12 is `PASS`; otherwise `REJECTED` with `primaryReasonCode`/`secondaryReasonCodes` assembled per §13.4.

### 13.4 Total Reason Precedence — One Global Ordered Table `[P13-M08 R3]`

**The defect being corrected:** the 13 pipeline steps (§13.3) are themselves ordered, but nothing previously froze the order of *multiple simultaneously-true reason codes discovered within one step* — e.g. step 4 can find both `ACCOUNT_IDENTITY_MISMATCH` and `POSITION_IDENTITY_MISMATCH` true at once, or step 12 can find both `PAIR_EXPOSURE_LIMIT` and `STRATEGY_EXPOSURE_LIMIT` true at once. "Pipeline order" alone under-specifies this case, leaving `secondaryReasonCodes` ordering to whatever incidental order an implementation happened to check things in.

**Frozen correction:** every per-evaluation rejection code (every Group A and Group B code, §17) appears **exactly once** in one canonical, hand-authored, totally ordered array — constructed with pipeline-step order as its primary sort key (so the two orderings agree at the coarse level) and an explicit, documented sub-order within each step as the tie-breaker:
```typescript
export const REJECTION_PRECEDENCE_V1: readonly string[] = [
  // Steps 3-5: identity
  'DECISION_IDENTITY_MISMATCH',
  'ACCOUNT_IDENTITY_MISMATCH',
  'POSITION_IDENTITY_MISMATCH',
  // Step 6: snapshot identity/provenance/shape
  'SOURCE_ID_MISMATCH',
  'VALUATION_METHOD_MISMATCH',            // [P13-SPEC-002] — valuation evidence vs RiskValuationPolicy method identity
  'VALUATION_NUMERIC_CONTEXT_EXCEEDED',   // [P13-SPEC-002] — well-formed valuation arithmetic exceeds the frozen RiskCalcDecimal context (§3.1.1)
  'PAIR_STATE_UNAVAILABLE',
  // Step 7: temporal/freshness — causality first, then account -> exposure -> leverage-tier -> settlement layering
  'EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION',
  'ACCOUNT_STATE_UNAVAILABLE',
  'ACCOUNT_STATE_STALE',
  'EXPOSURE_STATE_UNAVAILABLE',
  'EXPOSURE_STATE_STALE',
  'LEVERAGE_TIERS_UNAVAILABLE',
  'LEVERAGE_TIERS_STALE',
  'LEVERAGE_TIER_SEMANTICS_UNVERIFIED',
  'SETTLEMENT_RATE_UNAVAILABLE',
  'SETTLEMENT_RATE_STALE',
  // Step 8: action derivation
  'NO_CHANGE_TARGET_ALREADY_HELD',
  'REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION',
  // Step 9: instrument constraints
  'INSTRUMENT_NOT_TRADEABLE_FOR_NEW_EXPOSURE',
  'INVALID_ENTRY_PRICE',
  'INVALID_STOP_PRICE',
  'INVALID_STOP_DISTANCE',
  // Step 10: pending/ownership state
  'PENDING_EXPOSURE_UNKNOWN',
  'POSITION_OWNERSHIP_UNRECONCILED',
  'POSITION_OWNERSHIP_MISMATCH',
  // Step 11: sizing/tier/margin
  'RISK_BUDGET_NON_POSITIVE',
  'NO_VALID_LEVERAGE_TIER',
  'INSUFFICIENT_MARGIN',
  'MIN_QUANTITY_NOT_MET',
  'MIN_NOTIONAL_NOT_MET',
  // Step 12: exposure / loss / drawdown
  'GLOBAL_EXPOSURE_LIMIT',
  'PAIR_EXPOSURE_LIMIT',
  'STRATEGY_EXPOSURE_LIMIT',
  'MAX_CONCURRENT_POSITIONS',
  'DAILY_LOSS_LIMIT',
  'DAILY_LOSS_PERCENT_LIMIT',
  'DRAWDOWN_LIMIT',
  'CONSECUTIVE_LOSS_COOLDOWN_ACTIVE',
] as const;
```
This is the **single** source of truth for reason ordering — the 13-step pipeline (§13.3) still governs *when* each check runs and *what gets marked `SKIPPED`*, but final reason ordering is decided exclusively by index into `REJECTION_PRECEDENCE_V1`, never by object key order, array insertion order, loop discovery order, `Map` iteration, or `Set` iteration.

**Assembly rule:** `RejectedRiskDecision.primaryReasonCode` is whichever applicable (non-`SKIPPED`) `FAIL` code appears **first** in `REJECTION_PRECEDENCE_V1`. `secondaryReasonCodes` is every other applicable `FAIL` code, in the same `REJECTION_PRECEDENCE_V1` order — regardless of which step each came from, and regardless of how many codes fired within a single step. `secondaryReasonCodes` may be empty; it never smuggles a "real" reason ahead of `primaryReasonCode` — array position has no meaning beyond this one frozen table.

**Self-consistency validation (static, at build/construction time — not a per-user config option):** `REJECTION_PRECEDENCE_V1` must contain every currently-frozen Group A and Group B code (§17) exactly once — no duplicates, no omissions. A duplicate entry or a known rejection code missing from the table is a static policy/config failure (`RISK_CONFIG_INVALID`, Group C), caught once, not per-evaluation; any future revision that adds, removes, or renames a rejection code must update this table in the same change, and this check is what enforces that they can never silently drift apart.

**Binding:** `rejectionPrecedenceId: 'P13_REJECTION_PRECEDENCE_V1'` (§11.4) now has concrete meaning — it identifies exactly this array. A future `P13_REJECTION_PRECEDENCE_V2` (different order, or extended for new codes) would bind a different `rejectionPrecedenceId` into `riskPolicyId`, changing every downstream `riskDecisionId` — reason-ordering policy is exactly as versioned and identity-bound as every other policy layer in this document.

---

## 14. CoinDCX Dynamic Tiers — Corrected Adapter Boundary `[P13-E02 R2 — explicit verified interval contract]`

### 14.1 Interval Semantics Require Verified Evidence, Not a Two-Field Proxy

**The defect being corrected:** the prior revision's `tiers: readonly { leverage, maxPositionSizeUsdt }[]` was insufficient to prove interval membership or boundary-equality semantics no matter what `semanticsStatus` claimed — two scalar fields per tier cannot express whether a boundary is inclusive or exclusive, so `semanticsStatus: 'VERIFIED'` had nothing concrete to be verified *of*. Corrected: the adapter must present a fully explicit, self-describing interval per tier before Phase 13 will treat it as usable evidence:
```typescript
export interface VerifiedLeverageTier {
  readonly tierId: string;
  readonly lowerNotionalUsdt: string;
  readonly upperNotionalUsdt: string | null;   // null permitted only on the single highest (last) tier — an unbounded top tier
  readonly lowerInclusive: boolean;
  readonly upperInclusive: boolean;
  readonly maxLeverage: string;
}

export interface CoinDcxLeverageTierSnapshot {
  readonly pair: string;
  readonly provenance: EvidenceProvenance;   // §8.3 — fetch-time-only freshness, §14.2
  readonly semanticsStatus: 'VERIFIED' | 'SEMANTICS_UNVERIFIED';
  readonly semanticsVersion: string | null;   // set only once VERIFIED
  readonly exchangeMaxLeverage: string;
  readonly tiers: readonly VerifiedLeverageTier[];
  readonly safetyMarginTiers: readonly { readonly positionSizeThresholdUsdt: string; readonly maintenanceMarginPercent: string }[]; // disclosed evidence only, §8.2
  readonly legacyMaxLeverageLongIgnored: string | null;
  readonly legacyMaxLeverageShortIgnored: string | null;
}
```
`sourceId`, `fetchedAtMs` (`= provenance.observedAtMs`), and the tier evidence's content hash (`= provenance.contentSha256`, §11.5 — Phase 13 does not introduce a second, separate hash concept for the same evidence) are already carried by the shared `EvidenceProvenance` shape (§8.3) rather than duplicated as bespoke fields on this type.

**Ingestion-time validation (frozen, applied before any tier is ever consulted by §7):**
- `tiers` non-empty.
- Sorted ascending by `lowerNotionalUsdt`.
- **No overlap:** for every consecutive pair, the intervals must be disjoint — it is invalid for both `tiers[i].upperInclusive` and `tiers[i+1].lowerInclusive` to be true at a shared boundary value (that value would belong to two tiers at once).
- **No gap, full coverage:** for every consecutive pair, `tiers[i].upperNotionalUsdt === tiers[i+1].lowerNotionalUsdt`, and **exactly one** of `tiers[i].upperInclusive` / `tiers[i+1].lowerInclusive` is `true` (the shared boundary value belongs to exactly one of the two tiers). CoinDCX's tier ladder is expected to fully partition `[0, ∞)` (or `[0, topmost bound]`) with no notional value left unattributed.
- `lowerNotionalUsdt < upperNotionalUsdt` wherever `upperNotionalUsdt !== null`; only `tiers[n-1]` (the last, ascending-sorted tier) may have `upperNotionalUsdt === null`.
- A snapshot failing any rule above is malformed evidence — fails closed with `LEVERAGE_TIERS_UNAVAILABLE` (Group B), regardless of its claimed `semanticsStatus`.

**Runtime tier lookup for a given notional `N`:** exactly one tier must satisfy `(lowerInclusive ? N ≥ lower : N > lower) ∧ (upperNotionalUsdt === null ∨ (upperInclusive ? N ≤ upper : N < upper))`.
- **Zero matches** within the covered range never occurs if ingestion validation passed (full coverage is guaranteed); `N` exceeding every tier's coverage (only possible if the topmost tier is bounded and `N` exceeds it) is a legitimate business outcome ⇒ `NO_VALID_LEVERAGE_TIER` (Group A, §7.4).
- **Multiple matches** at runtime despite passing ingestion validation indicates the evidence is untrustworthy even though it superficially passed — a defense-in-depth check, not expected to ever fire if ingestion validation is implemented correctly — fails closed with `LEVERAGE_TIERS_UNAVAILABLE` (Group B).

**Semantics disclosure, unchanged principle:** while `semanticsStatus === 'SEMANTICS_UNVERIFIED'` (the honest default, absent explicit exchange confirmation that the adapter's claimed inclusive/exclusive boundaries are correct), Phase 13 fails closed for `action = 'OPEN'` with `LEVERAGE_TIER_SEMANTICS_UNVERIFIED` (Group B) — **regardless of whether the tier array itself passes the structural validation above.** Structural validity (ordered, disjoint, gap-free) is a necessary but not sufficient condition; `VERIFIED` additionally asserts that a human or process has confirmed *this specific inclusive/exclusive encoding matches CoinDCX's actual behavior*, not merely that the numbers are internally consistent. Phase 13 never derives or guesses equality/boundary behavior from `maxPositionSizeUsdt` alone — that derivation is retracted; the adapter is exclusively responsible for presenting already-verified normalized intervals.

### 14.2 Freshness — Fetch-Time Only, Disclosed as Such

Unchanged rationale from the original freeze: CoinDCX's instrument metadata carries no server-side "last changed" timestamp, confirmed against the actual `InrFuturesInstrument` model. `provenance.sourceTimeMs` is therefore always `null` for this snapshot type, and freshness is governed exclusively by `provenance.observedAtMs` (adapter fetch time) against `RiskFreshnessPolicy.maxLeverageTierSnapshotAgeMs` (§8.3–§8.4) — the policy owns the age bound, not the snapshot.

### 14.3 No Fabrication on Absence

If a pair's tier data cannot be obtained at all, the adapter constructs no snapshot for that pair; the engine then fails closed with `LEVERAGE_TIERS_UNAVAILABLE`. Phase 13 defines this interface as the complete contract an adapter must satisfy — it neither implements the adapter nor guesses at exchange values in its absence.

---

## 15. Adapter Boundaries — Interface-Only, Not Implemented `[P13-E01, P13-E03]`

Phase 13 defines the **output contract** each of the following adapters must satisfy. None is implemented in Phase 13; each is a distinct, future implementation phase.

### 15.1 `AccountRiskStateProvider` `[P13-E01]`

The original freeze attributed `availableMarginInr`, `currentEquityInr`, and `peakEquityInr` directly to the existing CoinDCX wallet model. **Retracted** — `docs/COINDCX_READ_LAYER.md` §9.3 is explicit: *"The read layer does NOT compute derived account equity (`totalBalance`, `availableBalance`, or `equity`)."* Corrected boundary:
```typescript
export interface AccountRiskStateProvider {
  getAccountRiskSnapshot(evaluationTimeMs: number): Promise<AccountRiskSnapshot>;
}

export interface AccountRiskSnapshot {
  readonly accountId: string;                 // configured account identity, §8.4
  readonly provenance: EvidenceProvenance;
  readonly accountStateKnown: boolean;
  readonly availableMarginInr: string;
  readonly lockedMarginInr: string;
  readonly currentEquityInr: string;           // §12.3 — includes unrealized PnL
  readonly peakEquityInr: string;              // §12.4
  readonly dailyPnl: DailyPnlComponents;        // §12.1
  readonly consecutiveLossCount: number;
  readonly cooldownActiveUntilMs: number | null;
  readonly accountMaxLeverage: string | null;
  readonly reconciliationSourceIds: readonly string[];  // every upstream source this figure was reconciled from
}
```
Unknown or unreconciled state (`accountStateKnown: false`, or a reconciliation the adapter itself could not complete) fails closed with `ACCOUNT_STATE_UNAVAILABLE`. **Phase 13 does not implement `AccountRiskStateProvider`** — its internal reconciliation logic (which Phase 2 endpoints it polls, how wallet/position-transaction data combine into one equity figure) is out of scope here and deferred to that adapter's own implementation phase.

### 15.2 Tier-Semantics Adapter

Covered in §14 — the same adapter that produces `CoinDcxLeverageTierSnapshot` is responsible for setting `semanticsStatus`/`semanticsVersion` truthfully; Phase 13 does not implement it.

### 15.3 Settlement Conversion Adapter `[P13-E03 R2 — explicit market identity, not currencies alone]`

`docs/COINDCX_READ_LAYER.md` §9.2 states plainly: the currency-conversion endpoint is *"Left unimplemented in Phase 2."* Phase 13 therefore keeps `SettlementConversionSnapshot` (required by the current INR-margin accounting model, §8.5) but stops implying Phase 2 already supplies it.

**The defect being corrected:** the prior revision's snapshot carried only `{ baseCurrency: 'USDT', quoteCurrency: 'INR' }` — a currency *pair* is not a market *identity*. Two different authoritative endpoints (or a future multi-market conversion API) could both quote "USDT → INR" while referring to different underlying markets, index methodologies, or symbol conventions; currencies alone cannot prove which one supplied this evidence. Corrected:
```typescript
export interface SettlementConversionProvider {
  getSettlementConversionSnapshot(evaluationTimeMs: number): Promise<SettlementConversionSnapshot>;
}

export interface SettlementConversionSnapshot {
  readonly conversionMarketId: string;    // the authoritative endpoint's own symbol/market identifier, verbatim — e.g. whatever exact string that (future) endpoint uses; never invented or guessed by Phase 13
  readonly sourceCurrency: 'USDT';
  readonly targetCurrency: 'INR';
  readonly marginCurrency: 'INR';
  readonly rateInrPerUsdt: string;
  readonly provenance: EvidenceProvenance;    // sourceTimeMs (= "server last-updated", when disclosed), observedAtMs (= fetchedAtMs), sourceId, contentSha256 (= contentHash) — §8.3, no duplicate fields introduced
}
```

**Adapter-side verification (frozen, all required before a snapshot is accepted):**
- `conversionMarketId` is present, non-empty, and equals the **expected** authoritative identifier for the USDT→INR conversion path — the exact literal string is owned by whichever endpoint contract the future adapter implements against (Phase 13 does not hardcode a guessed literal for an endpoint that does not exist yet, §9.2 of the read-layer doc); the adapter is responsible for verifying its own fetched `conversionMarketId` against that contract before Phase 13 ever sees it.
- `sourceCurrency === 'USDT'` and `targetCurrency === 'INR'` exactly — reversed currencies (`INR`→`USDT`) or any other pair is rejected, not silently inverted.
- `rateInrPerUsdt > 0`, finite, and correctly parsed as a `RiskCalcDecimal` (§3 numeric policy).
- `provenance.sourceId` non-empty.
- Strict causal ordering (§8.4) and policy-owned freshness (§8.3) — a future-dated conversion is a causality violation and a causally-valid-but-too-old one is a staleness breach, each rejected under exactly the same rule and the same code as every other snapshot type (see the rejection table below, `[P13-SPEC-003]`).
- `provenance.contentSha256` recomputed and verified by Phase 13 itself at ingestion (§11.5), never trusted from the adapter's own claimed hash.

**Rejection (`[P13-SPEC-003]` — causality and staleness are now two distinct codes, not one overloaded code):** the prior wording assigned "any causal/freshness violation" to `SETTLEMENT_RATE_STALE`, while §8.4's universal temporal model simultaneously assigned every causal-ordering breach to `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION` — the identical condition with two different answers. Retracted in favor of the universal model, which settlement evidence has no reason to be exempt from:

| Settlement conversion condition | Code (all Group B) |
|---|---|
| Wrong `conversionMarketId`, wrong/reversed currencies, or non-positive rate — the evidence does not describe the required conversion at all | `SETTLEMENT_RATE_UNAVAILABLE` |
| **Causal-ordering violation** — `sourceTimeMs > observedAtMs`, or `observedAtMs > evaluationTimeMs` (i.e. future-dated evidence), any amount, no tolerance | `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION` (§8.4) |
| **Causally valid but too old** — `evaluationTimeMs - observedAtMs > RiskFreshnessPolicy.maxSettlementRateSnapshotAgeMs` | `SETTLEMENT_RATE_STALE` |

The two temporal codes are mutually exclusive and jointly exhaustive over temporal failures: `SETTLEMENT_RATE_STALE` is now **exclusively** an age-limit breach on evidence that already satisfies `sourceTimeMs ≤ observedAtMs ≤ evaluationTimeMs`, and a future-dated conversion rate is never reported as merely "stale" (which would understate a causality violation as an ordinary freshness lapse). This matches how account, exposure, and leverage-tier evidence are already treated — one universal causality rule, one per-snapshot age code — so no snapshot type is special-cased. **Currencies alone are never sufficient identity** — `conversionMarketId` must independently match before `sourceCurrency`/`targetCurrency` are even consulted. **No arbitrary positive Decimal may masquerade as exchange conversion truth** — a default, hardcoded, or "assumed 1:1" rate is prohibited; absent a real adapter, any Phase 13 evaluation requiring a conversion (i.e. any `OPEN`) fails closed with `SETTLEMENT_RATE_UNAVAILABLE`. Phase 13 does not implement this adapter.

---

## 16. Snapshot-Bound Validity — A Decision Is Not Valid Forever `[P13-N01]`

**Frozen invariant:** a Phase 13 `RiskDecision` is valid only for the immutable evidence snapshots and `evaluationTimeMs` bound into its `riskDecisionId` (§11.5). `ACCEPTED` is a statement about risk conditions **at that instant**, evaluated against **that evidence** — it is never a guarantee of future account safety, and it carries no expiry mechanism of its own (the pure engine has no concept of "later").

Before any future phase (Phase 17 live execution, Phase 18 reconciliation) allows an `ACCEPTED` decision to cause an external mutation, that phase's own policy must explicitly revalidate: decision age, current account state, current exposure, current instrument state, current leverage tiers, current conversion state, and any other decision-affecting authority listed in §10.1 — using freshly-fetched evidence, not the evidence embedded in the original decision. Phase 13 itself remains entirely side-effect free and defines no revalidation logic of its own; it only defines that such revalidation is mandatory downstream and that skipping it is an architecture violation of a later phase, not of Phase 13.

---

## 17. Rejection & Error Taxonomy (corrected, Round 3)

### Group A — Business Rejection (`RejectedRiskDecision`)
`INVALID_ENTRY_PRICE`, `INVALID_STOP_PRICE`, `INVALID_STOP_DISTANCE`, `RISK_BUDGET_NON_POSITIVE`, `MIN_QUANTITY_NOT_MET`, `MIN_NOTIONAL_NOT_MET`, `INSUFFICIENT_MARGIN`, `NO_VALID_LEVERAGE_TIER`, `INSTRUMENT_NOT_TRADEABLE_FOR_NEW_EXPOSURE`, `GLOBAL_EXPOSURE_LIMIT`, `PAIR_EXPOSURE_LIMIT`, `STRATEGY_EXPOSURE_LIMIT`, `MAX_CONCURRENT_POSITIONS`, `DAILY_LOSS_LIMIT`, `DAILY_LOSS_PERCENT_LIMIT`, `DRAWDOWN_LIMIT`, `CONSECUTIVE_LOSS_COOLDOWN_ACTIVE`, `NO_CHANGE_TARGET_ALREADY_HELD`, `REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION`.

`[P13-M07 R3]` `DAILY_LOSS_PERCENT_LIMIT` is new — the optional secondary percentage-based daily-loss gate (§12.1.1). It is never a substitute for `DAILY_LOSS_LIMIT` (the primary, required, direct-INR gate); the two are independent and either, both, or neither may appear on a given rejection.

### Group B — State/Evidence Integrity Rejection (`RejectedRiskDecision`)
`ACCOUNT_STATE_UNAVAILABLE`, `ACCOUNT_STATE_STALE`, `ACCOUNT_IDENTITY_MISMATCH`, `PAIR_STATE_UNAVAILABLE`, `EXPOSURE_STATE_UNAVAILABLE`, `EXPOSURE_STATE_STALE`, `PENDING_EXPOSURE_UNKNOWN`, `POSITION_OWNERSHIP_UNRECONCILED`, `POSITION_OWNERSHIP_MISMATCH`, `POSITION_IDENTITY_MISMATCH`, `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION`, `SOURCE_ID_MISMATCH`, `VALUATION_METHOD_MISMATCH`, `VALUATION_NUMERIC_CONTEXT_EXCEEDED`, `LEVERAGE_TIERS_UNAVAILABLE`, `LEVERAGE_TIERS_STALE`, `LEVERAGE_TIER_SEMANTICS_UNVERIFIED`, `SETTLEMENT_RATE_UNAVAILABLE`, `SETTLEMENT_RATE_STALE`, `DECISION_IDENTITY_MISMATCH`.

`[P13-B03 R2]` `POSITION_OWNERSHIP_UNRECONCILED`/`POSITION_OWNERSHIP_MISMATCH` retire and replace `MULTI_STRATEGY_PAIR_OWNERSHIP_UNRESOLVED` (§2.8) — the retired code was keyed on a `strategyId` count heuristic; its replacements are keyed on the correct `strategyInstanceId`-based ownership proof. `[P13-B03 R3]` `POSITION_OWNERSHIP_UNRECONCILED` now fires for `OPEN` as well as `CLOSE`/`REVERSAL_DEFERRED` (§2.8) — it is no longer a `CLOSE`-only code. `[P13-B03 R4]` `POSITION_OWNERSHIP_UNRECONCILED` additionally fires when a `RECONCILED` claim fails its own aggregate-quantity reconciliation (§2.8.1) — a self-inconsistent claim is never partially trusted. `[P13-B03 R4]` `DECISION_IDENTITY_MISMATCH` additionally covers a matching `strategyInstanceId` whose `strategyId`/`strategyVersion`/`parameterHash` does not match, on either `InstanceOwnershipRecord` (§2.8.1) or `InstancePendingReservation` (§4.1) — no new overlapping code was introduced for this case. `[P13-B03 R5]` `POSITION_OWNERSHIP_UNRECONCILED` additionally fires when the engine's recomputation of `unitValuationInrPerQty`, `aggregateCurrentNotionalInr`, or any record's `currentNotionalInr` disagrees with the reported value, or when the instance notionals fail exact aggregate equality (§2.8.1 steps 3–5), and when an `OPEN` position carries `valuation === null` (nullable `markPriceUsdt`, §3.1.1). Round 5 originally mapped valuation inputs bound to values the rest of the evidence contradicts (multiplier, conversion rate, method version) to `RISK_SOURCE_INVALID`; **that mapping is superseded by `[P13-SPEC-002]` below** and no longer holds. A conversion-market mismatch reuses `SETTLEMENT_RATE_UNAVAILABLE` and a valuation `sourceId` mismatch reuses `SOURCE_ID_MISMATCH` — unchanged. `[P13-SPEC-002]` `VALUATION_METHOD_MISMATCH` and `VALUATION_NUMERIC_CONTEXT_EXCEEDED` are **the only two new codes** in this correction (both Group B, both defined once here and entered exactly once in `REJECTION_PRECEDENCE_V1`, consecutively after `SOURCE_ID_MISMATCH`). `VALUATION_METHOD_MISMATCH` (§2.8.1): valuation evidence whose `valuationMethodVersion` disagrees with `RiskValuationPolicy` is well-formed evidence that simply describes a different valuation method, so it rejects deterministically rather than throwing. `VALUATION_NUMERIC_CONTEXT_EXCEEDED` (§3.1.1): valuation arithmetic whose required scale exceeds the frozen `RiskCalcDecimal` context, on evidence that is well-formed and whose identity is already established — the inputs are individually valid and only the calculation cannot be completed, which is an evaluation outcome, not malformed input. Neither overloads an existing code, and the full mapping (`RISK_SOURCE_INVALID` / `VALUATION_NUMERIC_CONTEXT_EXCEEDED` / `VALUATION_METHOD_MISMATCH` / `PAIR_STATE_UNAVAILABLE` / `SETTLEMENT_RATE_UNAVAILABLE` / `POSITION_OWNERSHIP_UNRECONCILED` / `DECISION_IDENTITY_MISMATCH` / `SOURCE_ID_MISMATCH`) is tabulated in §2.8.1. The remaining valuation mismatches were **re-mapped, not newly coded** — instrument-multiplier disagreement to `PAIR_STATE_UNAVAILABLE`, conversion-binding disagreement to `SETTLEMENT_RATE_UNAVAILABLE`, valuation-content recomputation disagreement to `POSITION_OWNERSHIP_UNRECONCILED` — all Group B, all already in the precedence table exactly once. None of these is `RISK_SOURCE_INVALID` any longer. `[P13-B03 R6, P13-SPEC-002]` After canonical ingestion, a valid non-positive (negative or zero) `InstanceOwnershipRecord.currentQuantity` returns `POSITION_OWNERSHIP_UNRECONCILED`; a valid non-positive `PairPositionState.OPEN.quantityMagnitude` returns `PAIR_STATE_UNAVAILABLE`. Malformed, unparseable, non-finite, or prohibited non-canonical Decimal evidence and extra per-instance direction fields instead fail ingestion with `RISK_SOURCE_INVALID` before identity exists (§2.8.2/§3.1.2). **Round 6 adds no new rejection code either.** `[P13-M05 R2]` `POSITION_IDENTITY_MISMATCH` and `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION` are new (§8.4). `[P13-M05 R3]` `SOURCE_ID_MISMATCH` is new (§8.6) — a snapshot's `provenance.sourceId` failed to match its policy-bound expected value.

### Group C — Programming/Configuration Failure (thrown `RiskConfigError`/`RiskEngineError`, no decision constructed)
`RISK_SOURCE_INVALID`, `RISK_CONFIG_INVALID`, `RISK_OVERRIDE_INVALID`, `UNSUPPORTED_RISK_MODE`, `RISK_POLICY_IDENTITY_MISMATCH`.

`[P13-SPEC-002]` `RISK_SOURCE_INVALID` is restricted to malformed per-evaluation evidence that prevents canonical identity from being established: missing/unknown fields, invalid types, or unparseable, non-finite, or prohibited non-canonical Decimals (§11.1/§13.2). Once exact-shape, type, and Decimal ingestion establish canonical identity, this code is unreachable. Identity/hash recomputation disagreement uses `DECISION_IDENTITY_MISMATCH` (or an already-frozen identity-specific code); unexpected source authority uses `SOURCE_ID_MISMATCH`; completed valuation-value disagreement uses `POSITION_OWNERSHIP_UNRECONCILED`; valuation arithmetic context exhaustion uses `VALUATION_NUMERIC_CONTEXT_EXCEEDED`. All are Group B rejections and none throws a Group C failure. Static policy/configuration failures retain their typed codes, including `RISK_CONFIG_INVALID` for a malformed precedence table or invalid daily-loss caps.

**Total reason ordering** for every Group A/B code above is frozen in `REJECTION_PRECEDENCE_V1` (§13.4) — that table, not this list's presentation order, is the canonical ordering authority.

Precedence and classification rules are frozen in §13.

---

## 18. Idempotency & Replay (unchanged principle)

Pure function, zero side effects, zero internal persistence. Identical canonical input (§11) ⇒ bit-for-bit identical `RiskDecision`. Re-evaluating the same `sourceStrategyDecisionId` against different snapshots legitimately produces a different `riskDecisionId` and potentially a different outcome — expected, not a violation (§16 reinforces why: evidence legitimately ages and changes).

---

## 19. Phase Boundary — Explicit Exclusions (unchanged, reaffirmed)

Deferred to later phases: live order placement / any CoinDCX private order or leverage-mutation API call; `ExecutionIntent` construction or persistence; fill reconciliation; TP/SL placement; paper broker; strategy ranking, composite scoring, capital allocation optimization; adaptive/ML risk adjustment; cross-exchange logic; news-based risk adjustment; liquidation-price / maintenance-margin computation (§8.2, unless and until authoritative semantics are confirmed); `InstrumentSelectionDecision` implementation (§1.2); atomic reversal sizing (§2.7); partial-close/partial-reduce sizing (no input contract exists, §2.5).

---

## 20. Module Plan (updated to reflect corrected contracts)

```
src/risk/
  types.ts             — StrategyRiskCandidate, EntryStopProposal, LeverageProposal, PositionSizingRequest,
                          AccountRiskSnapshot, DailyPnlComponents, PairRiskSnapshot, PairPositionState,
                          CanonicalPositionValuation, PositionOwnershipState, ReconciledFlatOwnership,
                          ReconciledOpenOwnership,
                          InstanceOwnershipRecord, PortfolioExposureSnapshot, PendingExposureState,
                          InstancePendingReservation, VerifiedLeverageTier, CoinDcxLeverageTierSnapshot,
                          SettlementConversionSnapshot, EvidenceProvenance, RiskFreshnessPolicy,
                          RiskSourceAuthorityPolicy, RiskValuationPolicy, RiskMode, RiskModeConfig, RiskOverride,
                          GlobalRiskConfig, PairRiskConfig, CapValue, RiskCapsApplied,
                          PositionSizingDecision, AcceptedOpenRiskDecision, AcceptedCloseRiskDecision,
                          RejectedRiskDecision, RiskDecision, RiskAuditStep
  errors.ts            — RiskConfigError / RiskEngineError + Group C taxonomy (§17)
  reason-codes.ts      — Group A / Group B taxonomy (§17) and the frozen REJECTION_PRECEDENCE_V1 array (§13.4),
                          including its self-consistency validator (every known code exactly once)
  decimal.ts           — isolated RiskCalcDecimal context + canonicalDecimalString (§11.1)
  immutable.ts         — riskDeepCopyFreeze / freezeRiskRuntime / exact-shape validators (§11.2)
  provenance.ts        — EvidenceProvenance validation, strict zero-tolerance temporal causality (§8.4),
                          expected-source-authority comparison against RiskSourceAuthorityPolicy (§8.6)
  valuation.ts         — §3.1.1 canonical current-notional valuation: unitValuationInrPerQty (single
                          quantization point) and aggregateCurrentNotionalInr recomputation, exactness
                          assertions, null-markPrice fail-closed
  config.ts            — Global/Pair/RiskMode/Override/RiskSourceAuthorityPolicy/RiskValuationPolicy normalization (§10.4–§10.5),
                          §10 authority-matrix load-time validation, globalRiskConfigId / pairRiskConfigId /
                          riskModeConfigId / riskSourceAuthorityPolicyId / riskValuationPolicyId /
                          riskFreshnessPolicyId / riskPolicyId (§8.3, §11.3–§11.4)
  action.ts            — action derivation table (§2.5), WARMING/NO_CHANGE/REVERSAL_DEFERRED short-circuits
  ownership.ts         — §2.8/§2.8.1 strategy-instance ownership verification (RECONCILED/UNRECONCILED,
                          FLAT/OPEN discriminated), applied to both OPEN and CLOSE; full four-field identity
                          tuple validation plus aggregate-quantity AND aggregate-notional reconciliation
                          (exact canonical Decimal equality, via valuation.ts) for every instance record;
                          §2.8.2 strictly-positive instance-magnitude enforcement (no signed or zero
                          instance quantities, direction inherited from the OPEN parent) run BEFORE any sum
  position-sizing.ts   — §6 risk-budget ceiling
  leverage-tiers.ts    — §7 finite tier enumeration, §14 semantics/freshness gating
  exposure.ts          — §9 gross exposure + pending-exposure checks
  loss-drawdown.ts      — §12 daily PnL, direct-INR primary daily-loss gate + optional percent secondary gate,
                          drawdown/cooldown checks
  identity.ts          — positionSizingDecisionId / riskDecisionId (§11.5)
  engine.ts            — evaluateRisk(): §13.3 fixed pipeline, §13.4 REJECTION_PRECEDENCE_V1-ordered reason
                          assembly, producing PositionSizingDecision then RiskDecision
  index.ts             — public barrel exports
```
Adapter interfaces (`AccountRiskStateProvider`, the tier-semantics adapter, `SettlementConversionProvider`) are declared in `types.ts` as interfaces only — no implementation lives under `src/risk/`. Reuses `sha256CanonicalJson` (`src/backtest/canonical-json.ts`) — no duplicate hasher.

---

## 21. Expanded Test Plan `[P13-M09 R4 — complete]`

In addition to the original categories (determinism, mode matrix, hard-cap non-bypass, conservative rounding, min quantity/notional, insufficient margin, tier boundaries, stale rejection, exposure, loss/drawdown, taxonomy, identity, mutation protection, huge/invalid decimals, no native float):

1. **`StrategyDecision` lineage:** `status = 'WARMING'` produces no candidate and no decision at all; `decisionId` recomputation matches genuine kernel output; a structurally malformed `StrategyDecision` (missing field, wrong type) throws `RISK_SOURCE_INVALID`, while a well-formed one whose `decisionId` simply doesn't match rejects with `DECISION_IDENTITY_MISMATCH` — proving these are never conflated (§13.2); `triggerTimeframeMinutes` is bound through to `RiskDecision` audit context unmodified.
2. **Action derivation:** every row of the §2.5 table, including a deliberately inconsistent `currentPositionSide`/`targetExposure` pair fed through the real derivation function to confirm it always lands on exactly one of the four defined actions.
3. **`CLOSE` full-closure-of-owned-share-only:** confirm no partial-close path exists even when a caller attempts to smuggle a partial quantity into an `EntryStopProposal`-shaped object for a `CLOSE` action (must be structurally ignored/rejected, not silently honored); confirm `CLOSE` closes exactly the matching `instanceOwnership` entry's `currentQuantity` for the full four-field identity tuple, not the full physical position, when ownership is `RECONCILED` with multiple instances.
4. **`REVERSAL_DEFERRED`:** always rejects with `REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION`, never sizes anything, and can never appear as an `ACCEPTED` decision (compile-time discriminated-union check plus a runtime assertion).
5. **`PositionSizingDecision` identity and outcome discrimination:** `positionSizingDecisionId` changes iff any field of `PositionSizingDecision` changes; `outcome` is `'NOT_APPLICABLE'` for every `CLOSE`/`NO_CHANGE`/`REVERSAL_DEFERRED` candidate (never `'NOT_SIZED'`, which is reserved for a failed `OPEN`); `sourcePositionSizingDecisionId` is never `null` on any `RiskDecision`, including rejections.
   - **`sizing` → `approved` projection is exact and value-preserving (`[P13-SPEC-001]`, §7.5.1):** one test per mapped field asserts `approved.approvedQuantity === sizing.finalQuantity`, `approved.approvedLeverage === sizing.finalLeverage`, `approved.approvedNotionalUsdt === sizing.finalNotionalUsdt`, `approved.approvedNotionalInr === sizing.finalNotionalInr`, and byte-identical carry-through of `estimatedInitialMarginUsdt`, `estimatedInitialMarginInr`, `estimatedStopLossRiskInr` — compared as exact canonical strings, not numerically. Additionally: `approved` has exactly those seven keys (exact-shape, §11.2); `riskBudgetInr`/`riskCappedQuantity` never appear on `approved`; changing any `sizing` value changes the projected `approved` value identically and changes both `positionSizingDecisionId` and `riskDecisionId`; and no sizing arithmetic executes a second time during `RiskDecision` construction (asserted by spying on the sizing entry point — it is called exactly once per evaluation).
6. **Instrument bounds:** `maxQuantity` ceiling enforced even when risk budget and margin would otherwise allow more; `minPrice`/`maxPrice` boundary and one-increment-outside cases; inactive-status and `exitOnly` reject `OPEN` but allow `CLOSE`.
7. **Finite tier enumeration with all notional caps:** a constructed tier table where the naive shrinking-loop would have stopped short of the true maximum, verifying the enumeration finds the greater feasible quantity at a *different* tier; a case where `PairRiskSnapshot.maxNotional` (not margin, not the risk cap) is the binding constraint, confirming it is actually applied (the retracted revision omitted it entirely); a case where `maxNotionalPerTradeInrResolved` is the binding constraint; a case where the binding constraint shifts between a tier boundary and a notional cap depending on which mode is selected; exact tier-interval boundary (`N` exactly at `upperNotionalUsdt`, respecting `upperInclusive`/`lowerInclusive` — one increment above/below on both sides of the boundary); `semanticsStatus = 'SEMANTICS_UNVERIFIED'` fails closed for `OPEN` even when the tier array is structurally valid; a structurally invalid tier array (overlap, gap, unsorted) fails closed with `LEVERAGE_TIERS_UNAVAILABLE` regardless of `semanticsStatus`; no feasible tier at all rejects with the correct one of `INSUFFICIENT_MARGIN` / `MIN_QUANTITY_NOT_MET` / `MIN_NOTIONAL_NOT_MET` / `NO_VALID_LEVERAGE_TIER` per §7.4's precedence; the step-7 revalidation never actually fires a false rejection on a correctly-computed candidate (regression guard).
8. **Strategy-instance ownership (`[P13-B03 R4]` — complete four-field identity, `FLAT`/`OPEN` discriminated):**
   - **`OPEN` with `UNRECONCILED` ownership rejects** with `POSITION_OWNERSHIP_UNRECONCILED`, even against a pair whose ownership would otherwise be `ReconciledFlatOwnership` (the unconditional rule, §2.8) — `OPEN` is never exempt.
   - **`OPEN` with `RECONCILED` ownership evaluates normally** — full sizing/leverage/exposure pipeline runs unaffected by the presence of a well-formed `instanceOwnership` array (including the always-empty array on `ReconciledFlatOwnership`).
   - **Same `strategyId`, different `strategyInstanceId`, both on the same pair — isolated ownership:** a `CLOSE` from instance A cannot claim instance B's `instanceOwnership` entry; each instance's reservation/pending notional is isolated (§4); an `OPEN` from instance A is independently gated by instance A's own `PendingExposureState`/exposure limits, never by instance B's.
   - **Same `strategyInstanceId`, mismatched `strategyId`** on the matching `instanceOwnership`/`instancePendingReservations` entry → rejects with `DECISION_IDENTITY_MISMATCH`, both for current ownership (§2.8.1) and for a pending reservation (§4.1) — never silently trusted on `strategyInstanceId` alone.
   - **Same `strategyInstanceId`, mismatched `strategyVersion`** → identical rejection, `DECISION_IDENTITY_MISMATCH`, both current-ownership and pending-reservation paths.
   - **Same `strategyInstanceId`, mismatched `parameterHash`** → identical rejection, `DECISION_IDENTITY_MISMATCH`, both current-ownership and pending-reservation paths.
   - **`FLAT` reconciled state:** a `ReconciledFlatOwnership` object is accepted as valid canonical evidence with `positionId: null` (never a fabricated non-null placeholder — a compile-time shape check plus a runtime assertion that no string ever appears there), `instanceOwnership: []`, and implied zero current quantity/notional; an adapter attempting to report a nonempty `instanceOwnership` alongside `positionState: 'FLAT'` is rejected as malformed evidence.
   - **`OPEN` reconciled state requires `positionId`:** a `ReconciledOpenOwnership` object without a non-empty string `positionId` fails ingestion (`RISK_SOURCE_INVALID` — the shape itself is malformed, §11.2) — there is no code path that constructs a valid `ReconciledOpenOwnership` with a missing or empty `positionId`.
   - **Current quantity + current notional attribution:** each `InstanceOwnershipRecord.currentQuantity`/`currentNotionalInr` is independently verifiable, and the sum of `currentQuantity` across all records equals `position.quantityMagnitude` exactly.
   - **Instance quantities fail aggregate reconciliation → `UNRECONCILED`:** a `ReconciledOpenOwnership` whose `instanceOwnership` quantities sum to something other than `position.quantityMagnitude` is treated by Phase 13 exactly as `UNRECONCILED` (`POSITION_OWNERSHIP_UNRECONCILED`) for every gating purpose — never as a partially-trusted `RECONCILED` claim — for both `OPEN` and `CLOSE`.
   - **Aggregated exchange position with unresolved instance ownership:** a position with nonzero `position.quantityMagnitude` but `ownership.status === 'UNRECONCILED'` rejects both a `CLOSE` attempt and a fresh `OPEN` attempt from any instance on that pair, with `POSITION_OWNERSHIP_UNRECONCILED` in both cases.
   - **Present zero-quantity instance record → `UNRECONCILED`:** a matching `InstanceOwnershipRecord` present in `instanceOwnership` with `currentQuantity === "0"` is invalid evidence per §2.8.2 (every present record must be `> 0`); the ownership state is `UNRECONCILED` and both `OPEN` and `CLOSE` fail closed with `POSITION_OWNERSHIP_UNRECONCILED` — never `POSITION_OWNERSHIP_MISMATCH`, since a `"0"` record is not a valid `RECONCILED` claim to begin with.
   - **Omitted matching instance record on `CLOSE` → `POSITION_OWNERSHIP_MISMATCH`:** an otherwise-valid `ReconciledOpenOwnership` (all present records `> 0`, aggregate quantity and notional both reconciling exactly, §2.8.1) that simply contains no entry for the requesting instance's identity tuple — the correct representation of a zero share, §2.8.2 — fails closed on `CLOSE` with `POSITION_OWNERSHIP_MISMATCH`: the ownership state itself is genuinely `RECONCILED`, but this specific instance owns nothing to close.
   - `RECONCILED` ownership computed for a prior, since-closed-and-reopened position (mismatched `positionId`, or mismatched `pair`/`accountId`) fails closed with `POSITION_IDENTITY_MISMATCH` / `DECISION_IDENTITY_MISMATCH` / `ACCOUNT_IDENTITY_MISMATCH` respectively, not silently reapplied.
   - **Pending reservation uses the same full identity tuple:** an `InstancePendingReservation` is validated identically to `InstanceOwnershipRecord` — a same-`strategyId`-different-`strategyInstanceId` pair produces two isolated reservation entries, never merged or cross-attributed.

8b. **Canonical current-notional valuation & aggregate-notional reconciliation (`[P13-B03 R5]`, §3.1.1/§2.8.1):**
   - **Matching notional → `RECONCILED`:** instance quantities sum to `position.quantityMagnitude` **and** instance `currentNotionalInr` values sum to `aggregateCurrentNotionalInr`; the state is `RECONCILED` and an ownership-sensitive action proceeds to its normal gates.
   - **Notional mismatch → `UNRECONCILED`:** quantities reconcile exactly but one record's `currentNotionalInr` is perturbed by the smallest representable amount; the state is `POSITION_OWNERSHIP_UNRECONCILED` for both `OPEN` and `CLOSE`. Quantity reconciliation passing is proven **not** sufficient on its own.
   - **Exact-boundary equality, no tolerance:** the reconciliation accepts only exact canonical-Decimal equality — a value differing by one unit in the last place of `valuationUnitScale` rejects, and `"1200"` / `"1200.0"` / `"1200.000"` all canonicalize identically (§11.1) and all pass. No epsilon, band, or configurable tolerance exists anywhere in the code path.
   - **Shared valuation basis across instances and aggregate:** every `InstanceOwnershipRecord.currentNotionalInr` is proven to equal `currentQuantity × unitValuationInrPerQty` using the **same** `unitValuationInrPerQty` as the aggregate; a record valued at `avgPriceUsdt` instead of `markPriceUsdt` (numerically plausible, wrong basis) rejects with `POSITION_OWNERSHIP_UNRECONCILED`.
   - **Conversion identity must match the settlement snapshot:** `valuation.conversionRateInrPerUsdt` ≠ `SettlementConversionSnapshot.rateInrPerUsdt` rejects with `SETTLEMENT_RATE_UNAVAILABLE` (`[P13-SPEC-002]` — a Group B rejection, superseding the Round-5 mapping to `RISK_SOURCE_INVALID`); a `conversionMarket` naming a different market rejects identically with `SETTLEMENT_RATE_UNAVAILABLE`; a `conversionSourceId`/`valuationPriceSourceId` outside `RiskSourceAuthorityPolicy` rejects with `SOURCE_ID_MISMATCH`. A valuation built from `settlementCurrencyAvgPriceInrPerUsdt` (the position's historical average, §3.1.1) can never satisfy this check.
   - **Price sensitivity is deterministic:** changing only `markPriceUsdt` changes `unitValuationInrPerQty` and `aggregateCurrentNotionalInr` by exactly the frozen formula, and re-running with the identical price reproduces a bit-identical result; the same instance quantities then reconcile against the new aggregate without any tolerance drift.
   - **Conversion sensitivity is deterministic:** changing only `rateInrPerUsdt` likewise changes the canonical aggregate by exactly the frozen formula, deterministically and reproducibly.
   - **`FLAT`:** aggregate quantity `"0"`, aggregate current notional `"0"`, `instanceOwnership: []`, and **no** valuation object is required or constructed — `PairPositionState.FLAT` carries no `valuation`, and no price/rate/multiplier is fabricated merely to prove zero exposure.
   - **Null mark price fails closed:** an `OPEN` position whose `markPriceUsdt` is `null` yields `valuation === null`; any `ReconciledOpenOwnership` claim over it is treated as `UNRECONCILED` (`POSITION_OWNERSHIP_UNRECONCILED`) for `OPEN`, `CLOSE`, and `REVERSAL_DEFERRED`. There is no fallback to `avgPriceUsdt` and no fabricated price anywhere in the path.
   - **Huge Decimal values, no native float:** quantities/prices near the `RiskCalcDecimal` limits (e.g. 30+ significant digits) reconcile exactly, with no `Number`/`parseFloat` conversion anywhere in the valuation or reconciliation path (asserted by the same no-native-float test harness used for §6/§7); a scale demand exceeding the context surfaces as `VALUATION_NUMERIC_CONTEXT_EXCEEDED` (`[P13-SPEC-002]`, a Group B `RejectedRiskDecision` — superseding the earlier mapping to `RISK_SOURCE_INVALID`), never as a silently rounded value and never as a thrown error.
   - **Caller-supplied aggregate cannot bypass reconciliation:** a snapshot reporting an arbitrary `aggregateCurrentNotionalInr` (or `unitValuationInrPerQty`) that its own bound inputs do not produce is rejected by the engine's recomputation with `POSITION_OWNERSHIP_UNRECONCILED` — including the adversarial case where the fabricated aggregate exactly equals the sum of equally-fabricated instance notionals, proving self-consistency among reported values is not accepted as proof.

8c. **Signed-quantity normalization & magnitude-only ownership (`[P13-B03 R6]`, §3.1.2/§2.8.2):**
   - **Raw positive quantity → `LONG` + positive magnitude:** a raw `activePositionQuantity` of `+3.5` normalizes to `state: 'OPEN'`, `positionDirection: 'LONG'`, `quantityMagnitude: "3.5"`.
   - **Raw negative quantity → `SHORT` + absolute magnitude:** a raw `activePositionQuantity` of `-3.5` normalizes to `state: 'OPEN'`, `positionDirection: 'SHORT'`, `quantityMagnitude: "3.5"` — the two cases produce an identical magnitude and differ only in the direction label.
   - **Raw zero quantity → `FLAT`:** a raw `activePositionQuantity` of `0` normalizes to `state: 'FLAT'` with no `positionDirection`, no `quantityMagnitude`, no `positionId`, and no `valuation` field present at all (asserted structurally, not merely as null/zero values).
   - **Positive magnitudes summing exactly → `RECONCILED`:** instance magnitudes `"2"` + `"1.5"` against `quantityMagnitude: "3.5"` reconcile, and the corresponding notionals reconcile against the aggregate.
   - **Negative instance quantity → invalid evidence:** any `InstanceOwnershipRecord` with `currentQuantity < 0` yields `UNRECONCILED` (`POSITION_OWNERSHIP_UNRECONCILED`) for `OPEN`, `CLOSE`, and `REVERSAL_DEFERRED` — rejected at the per-record sign check, before any summation runs.
   - **Zero instance allocation → invalid evidence (frozen behavior: omission):** a record present with `currentQuantity === "0"` yields `UNRECONCILED`; the correct representation of a zero share is **absence** from `instanceOwnership`, and an instance absent from the array attempting `CLOSE` gets `POSITION_OWNERSHIP_MISMATCH`. Both halves of this pairing are asserted, so a zero record can never serve as a fake allocation.
   - **Mixed-sign set must not reconcile:** instance magnitudes `"2"` and `"-1"` against `quantityMagnitude: "1"` — a set that *would* sum to the correct aggregate by cancellation — is rejected with `POSITION_OWNERSHIP_UNRECONCILED`. This is the specific regression this section exists to prevent, and it is asserted to fail at the sign check rather than at the sum.
   - **Correct quantity sum, wrong notional sum → `UNRECONCILED`:** all magnitudes strictly positive and summing exactly to `quantityMagnitude`, but one `currentNotionalInr` perturbed, still rejects (§2.8.1 step 5) — quantity-only agreement is never sufficient.
   - **`SHORT` aggregate uses positive ownership magnitudes:** a `SHORT` position with `quantityMagnitude: "3.5"` reconciles against strictly-positive instance magnitudes exactly as the `LONG` case does; no instance carries a negative quantity to signify the short direction, and none carries a direction field of its own.
   - **Identical valuation basis for `LONG` and `SHORT`:** two positions of equal `quantityMagnitude` and identical valuation inputs, differing only in `positionDirection`, produce bit-identical `unitValuationInrPerQty` and `aggregateCurrentNotionalInr` — direction never enters the valuation arithmetic (§3.1.1, §2.8.1 step 4).
9. **Pending exposure — `KNOWN`-zero vs `UNKNOWN` produce different behavior:** `KNOWN` with all pending fields exactly `"0"`/`0` behaves identically to no pending reservations at all (headroom fully available) and is *accepted* where applicable; `UNKNOWN` fails closed for `OPEN` with `PENDING_EXPOSURE_UNKNOWN` under otherwise-identical inputs — the two must diverge, proving they are not conflated.
10. **Expected source authority (`[P13-M05 R3]`, §8.6) and identity mismatches:** correct `provenance.sourceId` on each of account/pair/exposure/leverage-tier/settlement snapshots accepts; a wrong `sourceId` on **each one independently** (account, leverage-tier, conversion, exposure, pair) rejects with `SOURCE_ID_MISMATCH` — one test per snapshot type, confirming the check is applied uniformly and not skipped for any single evidentiary channel; a self-asserted `sourceId` that happens to equal what the snapshot itself claims is correct is still checked against the **policy's** value, never trusted at face value; changing `RiskSourceAuthorityPolicy`'s expected value for any one field changes `riskSourceAuthorityPolicyId` and therefore `riskPolicyId` (computed-ID sensitivity, cross-referenced in item 14). Separately: `accountId` mismatch (`ACCOUNT_IDENTITY_MISMATCH`), pair mismatch across every pair-scoped input (`DECISION_IDENTITY_MISMATCH`), `positionId` mismatch between `ownership.positionId` and `position.positionId` (`POSITION_IDENTITY_MISMATCH`) — each produces its own distinct code, never a shared generic one.
11. **Strict temporal causality (`[P13-M05]`, zero tolerance):** `sourceTimeMs > observedAtMs` by exactly 1ms rejects with `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION`; `observedAtMs > evaluationTimeMs` by exactly 1ms rejects identically; `sourceTimeMs === observedAtMs === evaluationTimeMs` (exact equality, the boundary case) passes; there is no configuration value anywhere that widens this — a test asserting `RiskFreshnessPolicy` has no clock-skew field at all; each snapshot's own staleness boundary (exactly at policy max age passes, one ms past it fails).
12. **Flat-position representation:** `position.state === 'FLAT'` carries no `positionId`/`quantity`/`side` fields at all (compile-time shape check), never a null-populated "position" object.
13. **Override / mode bypass attempts:** an override that widens any field fails at config load, never at evaluation; `HIGH` and `CUSTOM` each independently attempted to exceed pair/global/tier/account caps, confirming the resolved value still wins per the §10.1 authority matrix.
14. **Computed-ID decision-affecting sensitivity — one test per ID:** for each of `riskModeConfigId`, `globalRiskConfigId`, `pairRiskConfigId`, `positionSizingPolicyId`, `riskSourceAuthorityPolicyId`, `riskValuationPolicyId`, `riskFreshnessPolicyId`, `riskPolicyId`, `riskDecisionId`, `positionSizingDecisionId` — change exactly one decision-affecting canonical field feeding that ID and prove the ID changes; leaving everything else byte-identical reproduces the identical ID.
15. **Noncanonical metadata invariance:** for every field explicitly excluded from canonical identity (wall-clock reads, host/PID/worker identifiers, object key insertion order, the presence/absence of optional audit-only prose fields not part of the canonical payload) — prove changing it does **not** change any computed ID or `RiskDecision` content.
16. **Rejected/accepted union shape coverage:** `AcceptedOpenRiskDecision` has every OPEN-specific field populated; `AcceptedCloseRiskDecision` has exactly its own (smaller) field set and never an OPEN-only field; every `RejectedRiskDecision` (from `NO_CHANGE`, `REVERSAL_DEFERRED`, and both `OPEN`/`CLOSE` rejection paths) has `approved: null`, a non-empty `primaryReasonCode`, and a `secondaryReasonCodes` array consistent with the fixed pipeline order (§13.3–§13.4); a compile-time check that no code path can construct `{ action: 'NO_CHANGE', status: 'ACCEPTED' }` or `{ action: 'REVERSAL_DEFERRED', status: 'ACCEPTED' }`.
17. **Daily loss magnitude — direct INR cap (`[P13-M07 R3]`) — exact boundary cases:** profit day (`netDailyPnlInr > 0` ⇒ `dailyLossMagnitudeInr = 0`, gate never fires); zero/flat day (`netDailyPnlInr = 0` ⇒ same); an INR loss strictly below `maxDailyLossInrResolved` (passes); a loss **exactly at** `maxDailyLossInrResolved` (`≥` rejects, `DAILY_LOSS_LIMIT` — confirms the direct INR comparison, not a percentage conversion, is what fires); a loss beyond the cap (rejects); a day with positive trading PnL fully erased by fees (net loss correctly detected via the fee term, still compared directly in INR); a day with a trading loss fully offset by positive funding (correctly *not* a loss day); a day with negative funding compounding a trading loss (correctly a larger loss magnitude, still an exact INR comparison); `maxDailyLossInr`/`globalMaxDailyLossInr` policy-identity sensitivity — changing either value changes `riskModeConfigId`/`globalRiskConfigId` and therefore `riskPolicyId`; a config load with `maxDailyLossInr ≤ 0` or `globalMaxDailyLossInr ≤ 0` throws `RISK_CONFIG_INVALID`, never silently accepted. **Secondary percentage gate, independently:** with `dailyLossLimitPercent`/`globalDailyLossLimitPercent` both `null`, the percentage gate never fires regardless of loss size; with one or both configured, a boundary case where the INR gate passes but the percentage gate fires (`DAILY_LOSS_PERCENT_LIMIT`, not `DAILY_LOSS_LIMIT`) and the converse (percentage gate would pass, INR gate fires `DAILY_LOSS_LIMIT`) — confirming the two gates are genuinely independent, never merged into one reason code.
18. **Settlement conversion market identity (`[P13-E03]`):** correct `conversionMarketId` + correct currencies accepts; correct currencies but wrong `conversionMarketId` rejects (`SETTLEMENT_RATE_UNAVAILABLE`) even though currencies alone "look right"; reversed currencies (`INR`→`USDT`) rejects; zero/negative rate rejects; a tampered `contentSha256` that doesn't match Phase 13's own recomputation rejects with `DECISION_IDENTITY_MISMATCH`; a correct conversion changes `notionalInr`/`estimatedInitialMarginInr` predictably.
   - **Causality vs staleness are disjoint (`[P13-SPEC-003]`):** a conversion snapshot that is causally valid (`sourceTimeMs ≤ observedAtMs ≤ evaluationTimeMs`) but older than `maxSettlementRateSnapshotAgeMs` rejects with **`SETTLEMENT_RATE_STALE`** and never `EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION`; a conversion snapshot with `observedAtMs > evaluationTimeMs` by exactly 1ms — or `sourceTimeMs > observedAtMs` by exactly 1ms — rejects with **`EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION`** and never `SETTLEMENT_RATE_STALE`, *including* when it is also outside the age window (causality is checked first and wins outright, per `REJECTION_PRECEDENCE_V1`). Boundary: exactly at `maxSettlementRateSnapshotAgeMs` passes; one ms past fails as stale. Settlement evidence is asserted to follow the identical rule as account/exposure/leverage-tier evidence, with no special-casing.

18b. **Valuation failure taxonomy — one code per condition, no overlap (`[P13-SPEC-002]`, §2.8.1's taxonomy table):** one test per row, each asserting both the returned code **and** whether anything was thrown.
   - **Malformed valuation shape → `RISK_SOURCE_INVALID` (thrown, Group C):** separate cases for a missing field, unknown field, wrong-typed field, unparseable `"abc"`, non-finite `"NaN"`/`"Infinity"`, and a prohibited non-canonical representation such as `"1,000"` (§11.1). Exercise required pair, valuation, and instance-ownership Decimals. Each throws the typed `RISK_SOURCE_INVALID` before identity construction, never `PAIR_STATE_UNAVAILABLE` or `POSITION_OWNERSHIP_UNRECONCILED`.
   - **Valid canonical inputs but numeric context exceeded → `VALUATION_NUMERIC_CONTEXT_EXCEEDED`:** every field present, correctly typed, canonically parseable, identity established, each value individually valid — but the required product's scale exceeds the frozen `RiskCalcDecimal` context (§3.1.1). Returns a `RejectedRiskDecision`.
   - **Valuation method identity mismatch → `VALUATION_METHOD_MISMATCH`:** `valuationMethodVersion` ≠ `RiskValuationPolicy.valuationMethodVersion`.
   - **Valuation value/content recomputation mismatch → `POSITION_OWNERSHIP_UNRECONCILED`:** a recomputed `unitValuationInrPerQty`, `aggregateCurrentNotionalInr`, or per-instance `currentNotionalInr` disagrees with the supplied amount. Use matching recomputed content hashes to isolate the value check. Include `"100.00"` versus recomputed `"101.00"`: normalize to `"100"` and `"101"` per §11.1, then return `POSITION_OWNERSHIP_UNRECONCILED`. Assert neither `RISK_SOURCE_INVALID` nor `DECISION_IDENTITY_MISMATCH` is produced. Equivalent `"100"`/`"100.00"` amounts still agree after normalization.
   - **Declared identity/hash recomputation mismatch → `DECISION_IDENTITY_MISMATCH`:** a recomputed `decisionId` or `contentSha256` disagrees with the declared value. Keep all numerical amounts reconciled to isolate the hash check. Asserted **not** to produce `POSITION_OWNERSHIP_UNRECONCILED`, proving the F/G boundary in both directions.
   - **Source-ID versus content-hash isolation:** correct numerical content with an incorrect declared `contentSha256` returns `DECISION_IDENTITY_MISMATCH`, never `SOURCE_ID_MISMATCH`; correct content with a correctly recomputed hash but an unexpected `sourceId` returns `SOURCE_ID_MISMATCH`, never `DECISION_IDENTITY_MISMATCH`. Run one case per snapshot and valuation source field as applicable. When both independent checks fail, return both codes in canonical precedence order.
   - **Numeric-context failure is a rejection, not a throw:** the `VALUATION_NUMERIC_CONTEXT_EXCEEDED` case returns a `RejectedRiskDecision` with that `primaryReasonCode`, `approved: null`, and a complete `auditTrail`; the test asserts no exception escapes `evaluateRisk()`.
   - **Taxonomy/precedence uniqueness:** `VALUATION_NUMERIC_CONTEXT_EXCEEDED` appears exactly once in the §17 Group B list and exactly once in `REJECTION_PRECEDENCE_V1`; likewise `VALUATION_METHOD_MISMATCH`. Asserted by the table's own self-consistency validator (§13.4), which additionally proves every taxonomy code appears in the precedence array exactly once, with no missing and no extra entries.
   - **`RISK_SOURCE_INVALID` is unreachable post-identity:** for every valuation failure whose canonical identity has already been established (every applicable Group B row, including source, method, multiplier, conversion, content, hash, and numeric-context failures), the test asserts the returned code is **never** `RISK_SOURCE_INVALID` and that nothing is thrown.
   - **Precedence participation:** a valuation failure fired simultaneously with a later-precedence failure asserts the valuation code is `primaryReasonCode` and the other appears in `secondaryReasonCodes`, in `REJECTION_PRECEDENCE_V1` order.

18c. **`riskFreshnessPolicyId` identity (`[P13-SPEC-004]`):** two structurally identical `RiskFreshnessPolicy` objects produce an identical `riskFreshnessPolicyId`, and key-order permutation does not change it; changing exactly one max-age field (any of the five, one test each) changes `riskFreshnessPolicyId`; a changed `riskFreshnessPolicyId` changes `riskPolicyId` and therefore every subsequent `riskDecisionId`; an unknown/non-canonical extra field is rejected at exact-shape validation rather than silently altering either ID; and a non-integer, negative, or non-safe-integer max-age fails load-time validation with `RISK_CONFIG_INVALID` rather than producing an ID at all. Snapshot `observedAtMs` values are asserted **not** to feed `riskFreshnessPolicyId` (they belong to `riskDecisionId`, §11.5) — changing an observation timestamp leaves the policy ID untouched.
19. **Canonical identity mechanics:** `"1"`/`"1.0"`/`"1.000"` canonicalize identically and do not change any hash; an unknown extra field on canonical per-evaluation evidence throws `RISK_SOURCE_INVALID` at ingestion (static configuration retains its typed config/override error); object key-order permutation never changes a hash.
20. **Execution-time revalidation boundary (§16):** a test asserting that `RiskDecision` carries no expiry/validity field implying perpetual validity, and that two evaluations of the same candidate against snapshots one policy-max-age apart produce independent, non-reused decisions.
21. **Total reason precedence — multiple simultaneous failures within one pipeline step (`[P13-M08 R3]`, §13.4):**
    - A candidate constructed to simultaneously trigger **pair mismatch + account mismatch + position mismatch** (all step 4) — `primaryReasonCode`/`secondaryReasonCodes` must equal `REJECTION_PRECEDENCE_V1`'s fixed sub-order (`DECISION_IDENTITY_MISMATCH`, then `ACCOUNT_IDENTITY_MISMATCH`, then `POSITION_IDENTITY_MISMATCH`) regardless of the order the underlying checks execute in the implementation.
    - **Multiple snapshot source/hash failures at once** (wrong `sourceId` ⇒ `SOURCE_ID_MISMATCH`; wrong declared `contentSha256` ⇒ `DECISION_IDENTITY_MISMATCH`, step 6) — test each independently and together; ordering matches `REJECTION_PRECEDENCE_V1`, not discovery order.
    - **Stale account + stale exposure simultaneously** (step 7) — `ACCOUNT_STATE_STALE` precedes `EXPOSURE_STATE_STALE` per the frozen table, verified against a deliberately reversed internal check order (e.g. an implementation that happens to evaluate exposure staleness before account staleness must still produce the frozen order in its output).
    - **Reason-order invariance:** the same simultaneous-failure fixture evaluated against two implementations (or two internal iteration orders simulated via a shuffled input `Map`/object) produces byte-identical `primaryReasonCode`/`secondaryReasonCodes` — proving the order is a property of `REJECTION_PRECEDENCE_V1`, never of object key order, array insertion order, loop discovery order, `Map` iteration, or `Set` iteration.
    - **`REJECTION_PRECEDENCE_V1` self-consistency:** a deliberately duplicated entry, or a deliberately omitted known Group A/B code, throws `RISK_CONFIG_INVALID` at construction — never silently accepted, never discovered only per-evaluation.

---

## Verdict

**PHASE13_IMPLEMENTATION_BLOCKING_SPEC_CORRECTION_READY_FOR_VERIFY**
