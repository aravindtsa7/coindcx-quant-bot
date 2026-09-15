# Phase 14 Proof Matrix

**Status legend:** `PROVEN` (implemented + tested, no known gap) · `PROVEN WITH LIMITATION` (implemented + tested, with an explicit, intentional scope boundary) · `INTENTIONALLY UNSUPPORTED` (deliberately not implemented, by frozen decision) · `NOT APPLICABLE` (out of Phase 14's scope entirely).

This document records what Phase 14 (the PAPER trading subsystem) actually
proves, as built, against what is actually tested — not what was originally
aspired to. It does not claim CoinDCX economic parity, and it does not claim
production-promotion eligibility. See §11 for the funding limitation, §13 for
the Wave1 final-gate correction record, and §14 for the final status conclusion.

Commit hashes are recorded because they are canonical anchors for each
slice's frozen baseline; individual test line numbers are deliberately never
cited (they drift) — every row instead references a stable test **file**.

| Slice | Canonical commit |
|---|---|
| P14-A | `3e9e0d9` |
| P14-B | `3cffc50` |
| P14-C | `9855ad3` |
| P14-D | `f608eb0` |
| P14-E | `8ce971b` |
| P14-F | `a228740` |
| P14-G | `14b14a3` |
| P14-H | `352e2a9` |
| P14-I | `ed69bb7` |
| P14-J | *(this slice, uncommitted at authoring time)* |

---

## 1. P14-A — Paper Execution Contracts / Authority

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| `PaperOpenExecutionAuthority`/`PaperCloseExecutionAuthority` are non-forgeable (symbol-gated constructor, private `#record`, `.read()` brand check) | `src/execution/open-authority.ts`, `src/execution/close-authority.ts` | `tests/unit/execution/open-authority.test.ts`, `tests/unit/execution/close-authority.test.ts` | Genuineness of the returned authority is only as strong as the `coordinator`/evidence the caller supplies — P14-A does not itself own account-level locking (P14-D/I do) | PROVEN |
| OPEN requires genuine Phase12 PASSED research + genuine Phase10 strategy origin + RiskEngine `ADMITTED`, in that exact order, inside one function | `src/execution/open-authority.ts:mintPaperOpenExecutionAuthority` | `tests/unit/execution/open-authority.test.ts` | — | PROVEN |
| CLOSE is research-exempt by frozen rule (de-risking never gated by research approval); still requires genuine kernel origin + RiskEngine `ACCEPTED_NO_CAPACITY_OWNERSHIP` + reconciled ownership of the exact position (full 4-tuple, never instance id alone) | `src/execution/close-authority.ts:mintPaperCloseExecutionAuthority` | `tests/unit/execution/close-authority.test.ts` | — | PROVEN |
| Mint functions are deliberately absent from the public `src/execution` barrel — reserved for the one real runtime composition (P14-I) | `src/execution/index.ts` (no export of either mint function) | `tests/unit/execution/barrel.test.ts`; statically re-verified in P14-J, see §10 | — | PROVEN |
| Pure decimal/identity/accounting/policy contracts (Q18 exactness, no floating point) | `src/execution/decimal.ts`, `identity.ts`, `accounting.ts`, `policy.ts` | `tests/unit/execution/decimal.test.ts`, `identity.test.ts`, `accounting.test.ts`, `policy.test.ts` | — | PROVEN |

---

## 2. P14-B — Trusted Market Evidence

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| `TrustedPaperExecutionEvidence` is an opaque, non-forgeable capability (WeakMap-backed registry, no public data surface) | `src/execution/trusted-evidence.ts` | `tests/unit/execution/trusted-evidence.test.ts` | — | PROVEN |
| Evidence requires WS-actionable orderbook (never REST-bootstrap), current-generation binding, freshness, and quote/depth/conversion causal-binding cross-checks | `src/integration/coindcx/paper-evidence.ts`, `src/integration/coindcx/execution-evidence-adapter.ts` | `tests/unit/coindcx/paper-evidence.test.ts` | REST evidence is retained only as non-actionable bootstrap/recovery evidence — cannot satisfy an execution read | PROVEN |
| No fallback to candle close, ticker LTP, private-position mark, or stale cached evidence | `src/integration/coindcx/paper-evidence.ts#getLatestExecutionQuote/getLatestOrderbookEvidence/getLatestConversion` | `tests/unit/coindcx/paper-evidence.test.ts` | — | PROVEN |
| Evidence acquisition happens outside any economic DB transaction | `src/integration/coindcx/paper-production-runtime.ts` calls `getTrustedPaperExecutionEvidence` before `session.executeOpen`/`executeClose` | `tests/integration/execution/paper-production-runtime.test.ts`; statically reinforced in P14-J (execution/persistence has no transitive dependency on CoinDCX networking modules, see §10) | — | PROVEN |

---

## 3. P14-C — Persistence Schema

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| Exactly the frozen 10 Phase14 models exist, unchanged since P14-C | `prisma/schema.prisma`: `PaperAccount`, `PaperExecutionPolicySnapshot`, `PaperReservation`, `PaperExecutionIntent`, `PaperOrder`, `PaperFill`, `PaperPosition`, `PaperPositionOwnershipHistory`, `PaperLedgerEntry`, `PaperReconciliationFault` | `tests/unit/prisma/phase14-schema.test.ts` | 3 unrelated pre-Phase14 models also exist (`SystemState`, `Candle1m`, `HistoricalDataset`) — not part of this count | PROVEN |
| P14-J made zero schema/migration changes | n/a (proof-only phase) | `npx prisma validate` (see §15 validation), `git diff prisma/` empty | — | PROVEN |

---

## 4. P14-D — Durable Admission / Fencing

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| Monotonic `ownerFence`; unconditional acquisition; every mutation re-verifies fence under `SELECT ... FOR UPDATE` in the same transaction | `src/execution/persistence/account-repository.ts#acquireOwnership/loadCoherentSnapshot` | `tests/integration/execution/paper-account-persistence.test.ts` | Liveness (deciding a prior owner's process is dead) is explicitly out of scope — fencing, not leasing | PROVEN |
| Stale-fence mutation rejected; restart acquires a strictly higher fence | same as above | `tests/integration/execution/paper-account-persistence.test.ts`, `tests/integration/execution/paper-account-kernel.test.ts` | — | PROVEN |
| `PaperReservation` generation-sensitive identity (`@@unique([accountId, riskDecisionId, generation])`) | `prisma/schema.prisma` | `tests/unit/prisma/phase14-schema.test.ts` | — | PROVEN |
| Durable admission restore: `ADMITTED` restored as pending; `RELEASED`/`CONSUMED` never restored as pending; sequence watermark computed from every historical row regardless of status | `src/dispatch/admission.ts#restore/restoreAuthoritative`, `src/execution/persistence/restore.ts` | `tests/unit/dispatch/admission-restore.test.ts`, `tests/integration/execution/paper-account-persistence.test.ts` | — | PROVEN |
| Post-C3-restore structural failure faults the coordinator (not silently left "restored but untracked") | `src/execution/persistence/paper-account-kernel.ts` (P14-G-MAJ-01 correction) | `tests/integration/execution/paper-account-kernel.test.ts` (`P14-G-MAJ-01 correction` describe block) | — | PROVEN |

---

## 5. P14-E — Integrated Paper Execution

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| OPEN/CLOSE are the only paths that create `PaperExecutionIntent`/`PaperOrder`/`PaperFill`/`PaperLedgerEntry` or mutate `PaperPosition`/`PaperAccount` economics | `src/execution/persistence/execution-engine.ts` | `tests/integration/execution/paper-execution-engine.test.ts` | — | PROVEN |
| Terminal source-execution dedup: `UNIQUE(accountId, sourceStrategyDecisionId)` on `PaperFill` — generation-independent, survives restart | `prisma/schema.prisma` (`paper_fill_account_source_decision_terminal_unique`) | `tests/integration/execution/paper-execution-engine.test.ts`, `tests/integration/execution/paper-account-kernel.test.ts`, `tests/integration/execution/paper-production-runtime.test.ts` (OPEN retry) | — | PROVEN |
| Exact fee/PnL/slippage/tick-rounding formulas, Decimal-only arithmetic | `src/execution/accounting.ts`, `decimal.ts` | `tests/integration/execution/paper-execution-engine.test.ts` (exact accounting matrix) | — | PROVEN |
| Ambiguous durable-write outcomes (post-admit/post-release failure) fault the session/account rather than silently rolling back memory | `src/execution/persistence/paper-account-session.ts`, `admission-bridge.ts` | `tests/unit/execution/persistence/session-fault-recovery.test.ts` | — | PROVEN |

---

## 6. P14-F — Funding Fail-Closed

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| `fundingCapability = FUNDING_UNSUPPORTED`, reason `COINDCX_PROVIDER_EVIDENCE_INCOMPLETE`, `fundingApplied = false` | `src/execution/funding-capability.ts` | `tests/unit/execution/funding-capability.test.ts` | See §11 — this is a permanent, intentional limitation, not a bug | INTENTIONALLY UNSUPPORTED (by design) |
| A session can never become READY while any funding fact (account/position cumulative funding, or any `FUNDING` ledger row) is non-zero/present | `src/execution/persistence/account-repository.ts#loadCoherentSnapshot` | `tests/integration/execution/paper-account-persistence.test.ts` (`P14-F live-DB` block) | — | PROVEN |
| `PAPER -> PAPER_APPROVED`/`SHADOW`/`LIVE_CANDIDATE`/`LIVE` all blocked while funding is unsupported | `src/coin-runtime/lifecycle.ts#assertProductionLifecycleTransitionAuthorized` | `tests/unit/coin-runtime/lifecycle.test.ts`, `tests/unit/coin-runtime/registry.test.ts`, re-verified live in `tests/integration/execution/paper-production-runtime.test.ts` (promotion-block test) | — | PROVEN |

---

## 7. P14-G — Restart / Rehydration

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| A process restart rehydrates EMPTY/PENDING/OPEN slots from durable facts only — no process-local capability is ever restored | `src/execution/persistence/paper-account-kernel.ts` | `tests/integration/execution/paper-account-kernel.test.ts` | — | PROVEN |
| No OPEN execution authority is ever minted from a durable row alone (a reservation/PENDING row is not authority) | same | `tests/integration/execution/paper-account-kernel.test.ts` (PENDING restart test) | — | PROVEN |
| Fresh CLOSE authority always obtainable for a genuine rehydrated OPEN position, bound to current `positionInstanceId`/`revision` | same | `tests/integration/execution/paper-account-kernel.test.ts` (OPEN restart test) | — | PROVEN |
| Repeated `startPaperAccountRuntime` for an already-READY account is idempotent — no fence bump, no re-reconciliation, same cached runtime | `PaperAccountKernel`'s `#readyRuntimes` cache | `tests/integration/execution/paper-account-kernel.test.ts` (P14-G-MAJ-02 correction block) | — | PROVEN |
| Structural impossibility (e.g. OPEN slot with no terminal opening fill) fails closed at startup (`RECONCILIATION_REQUIRED`), never repaired | same | `tests/integration/execution/paper-account-kernel.test.ts` (partial/impossible structural state block) | — | PROVEN |

---

## 8. P14-H — Reconciliation / Health

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| Read-only durable fact/projection verification; never mutates any economic table | `src/execution/persistence/paper-account-reconciler.ts` | `tests/integration/execution/paper-account-reconciler.test.ts` | — | PROVEN |
| Detected mismatches persist as `PaperReconciliationFault` rows, idempotently (content-addressed `faultId`) — no duplicate spam on repeated identical detection | same | `tests/integration/execution/paper-account-reconciler.test.ts` (repeated fault / idempotency block) | — | PROVEN |
| No economic auto-repair, ever | same | every "mismatch" test in `paper-account-reconciler.test.ts` asserts the tampered value is unchanged afterward | — | PROVEN |
| Health is account-scoped — one account's fault never affects another | same | `tests/integration/execution/paper-account-reconciler.test.ts` (multi-account isolation block) | — | PROVEN |
| `HEALTHY` means internally-consistent supported PAPER accounting only — never funding-complete or promotion-eligible | `PaperAccountReconciliationResult.fundingDisclosure` always attached | `tests/integration/execution/paper-account-reconciler.test.ts` | See §11 | PROVEN WITH LIMITATION (funding scope) |

---

## 9. P14-I — Production Composition

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| Startup order: P14-G READY → fresh P14-H reconciliation → verify `ownerFence`/`revision` correspond → HEALTHY required → only then a production facade is returned | `src/integration/coindcx/paper-production-runtime.ts#PaperAccountProductionComposer.start` | `tests/integration/execution/paper-production-runtime.test.ts` (clean/unhealthy startup blocks) | — | PROVEN |
| Genuine OPEN chain: Phase12 PASSED → `ResearchApprovalOrigin` → `authorizeStrategyDispatch` → genuine Phase10 origin → RiskEngine → durable P14-D admission → fresh P14-B evidence → P14-E OPEN | same, `#executeOpenLocked` | `tests/integration/execution/paper-production-runtime.test.ts` (OPEN end-to-end, forged-input, provider-failure, retry blocks) | — | PROVEN |
| Genuine CLOSE chain: fresh current durable OPEN position (read fresh each call, never cached) → research-exempt trusted CLOSE authority → fresh evidence → P14-E CLOSE | same, `#executeCloseLocked` | `tests/integration/execution/paper-production-runtime.test.ts` (CLOSE end-to-end, provider-failure, replay-safety blocks) | — | PROVEN |
| **P14-I-A1 (authoritative):** `UNHEALTHY` blocks ALL economic mutation — OPEN **and** CLOSE — no reduce-only exception in PAPER mode; historical faults do not permanently block once current state is corrected and reconciliation is fresh-HEALTHY | same, `#assertFreshlyHealthy` called before every mutation | `tests/integration/execution/paper-production-runtime.test.ts` (mandatory tests A–E: UNHEALTHY blocks OPEN, UNHEALTHY blocks CLOSE, recovery, historical-fault-preservation, no-bypass) | This is a PAPER-mode-only policy decision; it must not be inferred as future LIVE emergency-liquidation policy | PROVEN |
| Per-account mutation serialization; multi-account independence; cross-runtime stale-fence rejection; stale-health detection before mutation | `SerialQueue` per runtime; fresh reconciliation + fence comparison per call | `tests/integration/execution/paper-production-runtime.test.ts` (concurrency, stale-owner, stale-health blocks) | — | PROVEN |
| Every OPEN/CLOSE result still discloses `FUNDING_UNSUPPORTED`/`FUNDING_EXCLUDED`/`PAPER_NOT_ECONOMICALLY_COMPLETE`/`FUNDING_EXCLUDED_PNL` | `disclosePaperFundingExcluded` reused verbatim, never reimplemented | `tests/integration/execution/paper-production-runtime.test.ts` (funding disclosure regression) | See §11 | PROVEN WITH LIMITATION (funding scope) |
| Composition root lives at `src/integration/coindcx/paper-production-runtime.ts`, not re-exported from `src/integration/coindcx/index.ts` (direct concrete-path import is the established convention for this class of composition-reserved module, mirroring `open-authority.ts`/`close-authority.ts`) | `src/integration/coindcx/index.ts` (unchanged) | P14-J barrel audit, §10 | Not re-exported — this is a deliberate choice preserved by P14-J (§52: "do not modify barrel merely for style"); no caller today requires it, and its concrete-path importability is already sufficient (proven by `paper-production-runtime.test.ts` itself importing it that way) | PROVEN |

---

## 10. P14-J — Architecture Graph Gate (this slice)

| Guarantee | Implementation | Test evidence | Limitation | Status |
|---|---|---|---|---|
| True transitive (not direct-only) local TypeScript import graph, built from the TypeScript compiler API already in the project (no new dependency) | `tests/architecture/support/import-graph.ts` | `tests/architecture/phase14-import-graph.test.ts` (synthetic + fixture blocks) | — | PROVEN |
| Deterministic: sorted file discovery, sorted edge lists, BFS with sorted neighbor expansion — same graph always yields the same violation path | same | `tests/architecture/phase14-import-graph.test.ts` ("deterministic" synthetic test, 5 repeated runs) | — | PROVEN |
| Cycle-safe: visited-set-gated traversal never infinite-loops on an import cycle | same | `tests/architecture/phase14-import-graph.test.ts` (cycle fixture + synthetic self-loop test) | — | PROVEN |
| Handles real repo import forms: extensionless imports, `/index.ts`, `export * from`, named re-exports, type-only local imports | `resolveLocalSpecifier`, `extractImportSpecifiers` | `tests/architecture/phase14-import-graph.test.ts` (path-resolution fixture) | No tsconfig path aliases exist in this repo (`tsconfig.json` has no `paths`/`baseUrl`) — alias resolution was therefore not implemented, since there is nothing to resolve | NOT APPLICABLE (no aliases exist) |
| The checker is proven capable of detecting an INDIRECT violation (not just a direct one) via a synthetic fixture, and of accepting the one intentional reverse direction | fixtures under `tests/architecture/fixtures/{transitive-violation,allowed-direction}/` | `tests/architecture/phase14-import-graph.test.ts` | — | PROVEN |
| **Real-repository finding:** no module under `src/execution/**` (nor `dispatch/risk/research/strategies`) transitively reaches **any** `src/integration/**` file — strict zero, no exceptions | `tests/architecture/phase14-import-graph.test.ts` (real-repository-graph block) | same | See "Architecture correction" box below for the layering fix that closed this to strict zero | PROVEN |
| The P14-I composition root (`paper-production-runtime.ts`) is confirmed to (and is allowed to) transitively reach `src/execution/**` | same | same | — | PROVEN |
| `src/integration/coindcx/paper-production-runtime.ts` never transitively reaches any live order-mutation sink | `findMutatingOrderSymbols` scan (evidence-based: exported/declared function or method names matching a mutating-order verb pattern) across all of `src/` except `src/backtest/**` | `tests/architecture/phase14-import-graph.test.ts` (live-mutation-sink block) | `src/backtest/**` (Phase 9 historical simulation) is excluded from the scan on evidence, not convenience — its one matching hit (`BacktestEngine#cancelOrder`) is `private`, mutates only an in-memory simulated order `Map`, and has zero exchange interaction | PROVEN |
| **Repository-wide finding: LIVE_EXECUTION = NOT_IMPLEMENTED.** Zero create/place/cancel/modify/submit/amend/delete/new-Order symbols exist anywhere outside backtest simulation | `src/integration/coindcx/client.ts`/`transport.ts` expose only `executeRead`/`listXxx`/`getXxx` methods — no HTTP mutation verb is ever issued | same | If a live execution adapter is ever added, this test will immediately begin reporting a non-empty sink set and must then be re-verified, not silently updated | PROVEN (absence) |
| `paper-production-runtime.ts` never transitively reaches `src/integration/coindcx/client.ts` (the sole file exposing private wallet/position/order/trade **read** methods: `getUserInfoSafe`, `getFuturesWallets`, `getInrFuturesWallet`, `listFuturesWalletTransactions`, `listInrFuturesPositions`, `listInrFuturesOrders`, `listInrFuturesPositionTransactions`, `listInrFuturesTrades`) | same | `tests/architecture/phase14-import-graph.test.ts` (private-economic-source block) | — | PROVEN |
| No private CoinDCX funding-transaction record is ever mapped into `PaperLedgerEntry(FUNDING)`/`PaperAccount.cumulativeFundingInr`/`PaperPosition.cumulativeFundingInr` | Combines this slice's static proof (`client.ts` unreachable from the paper root and from `execution/persistence/**`) with P14-F/P14-H's existing runtime proof (zero `FUNDING` ledger rows, zero cumulative funding, in every live-DB test) | `tests/integration/execution/paper-account-persistence.test.ts` (P14-F funding block), `tests/integration/execution/paper-account-reconciler.test.ts` (funding invariant block), `tests/architecture/phase14-import-graph.test.ts` | — | PROVEN |
| No module-private issuer/capability symbol (`*_ISSUER`, `SESSION_PROOF`, `ACCOUNT_FAULT_RECOVERY_CAPABILITY`, `PRODUCTION_ISSUER`, …) is exported from any public barrel | `collectPublicExportNames` (recursive `export *`-following closure) against every public barrel | `tests/architecture/phase14-import-graph.test.ts` (capability export safety block) | — | PROVEN |

### Architecture correction: strict zero, no exceptions (P14-J-MAJ-01/MAJ-02)

An earlier revision of this checker found two (later three) transitive
execution/core -> integration edges — found *only* because this is a
transitive (not direct-only) checker; a plain ESLint `no-restricted-imports`
rule on `src/execution/**` would never have surfaced any of them, since none
was a direct import from an execution-tree file. That revision **allowlisted**
them as "known inert exceptions." A subsequent targeted review correctly
rejected that allowlist as unauthorized: an exception list is a policy
decision, not architecture proof. All three edges have since been closed by
behavior-neutral layering corrections, and the checker now asserts **strict
zero** transitive execution/dispatch/risk/research/strategies ->
`src/integration/**` edges with no exception mechanism of any kind.

The three edges and their corrections:

1. **`src/market-data/historical/index.ts` (and `canonical-engine.ts`,
   `pair-state.ts`, `rest-candle-reader.ts`) -> `src/integration/coindcx/clock.ts`**
   (value import). The `Clock`/`SystemClock`/`FakeClock` abstraction is
   exchange-neutral (`SystemClock.nowMs()` wraps `Date.now()`; `FakeClock` is
   a deterministic test double) — it was only *located* under the CoinDCX
   integration tree. **Fix:** moved verbatim (same interface, same class
   names, same method names, same millisecond semantics) to
   `src/core/time/clock.ts`. All four market-data importers now import the
   neutral module directly. `src/integration/coindcx/clock.ts` is now a thin
   `export type { Clock } from '../../core/time/clock'; export { SystemClock, FakeClock } from '../../core/time/clock';`
   compatibility re-export, kept only so CoinDCX-integration-side files
   (`client.ts`, `paper-evidence.ts`, `websocket/{public,private}-stream.ts`)
   and existing tests that deep-import `src/integration/coindcx/clock` keep
   working unchanged. No core/execution file imports that compatibility file
   any more.
2. **`src/risk/ownership.ts` -> `src/integration/coindcx/models.ts`**
   (`import type { InrFuturesPosition }`, type-only). Risk ownership logic
   only ever reads two fields off a CoinDCX position (`id`,
   `activePositionQuantity`). **Fix:** extracted the exact structural subset
   actually used into `RiskPositionExposureInput` in `src/risk/types.ts`;
   `ownership.ts` now imports that instead. CoinDCX's `InrFuturesPosition`
   remains naturally structurally assignable to it (TypeScript structural
   typing, zero runtime mapping, zero behavior change) — proven by the
   existing `valuation-ownership.test.ts` suite passing unmodified.
3. **`src/research/**`/`src/dispatch/**` -> `src/backtest/engine.ts` ->
   `src/backtest/instrument.ts` -> `src/coin-runtime/types.ts` ->
   `src/integration/coindcx/models.ts`** (value import of
   `DynamicLeverageTier`/`DynamicSafetyMarginTier`, discovered independently
   while closing #2 — the same target file was reachable through a second,
   unrelated path that a per-symbol review would have missed but the
   transitive graph checker caught immediately). Both tier interfaces are
   fully generic Decimal-pair shapes (a leverage/notional-cap pair, a
   threshold/margin-percent pair) with no CoinDCX-specific shape. **Fix:**
   moved verbatim to `src/core/types/index.ts`; `src/coin-runtime/types.ts`
   now imports them from core instead of from
   `../integration/coindcx/models`, and `src/integration/coindcx/models.ts`
   re-exports the same two names from core (`export type { DynamicLeverageTier, DynamicSafetyMarginTier } from '../../core/types'`)
   so its own `InrFuturesInstrument` and existing external importers
   (`src/integration/coindcx/normalizers.ts`) are unaffected.

All three corrections are pure type/module-location refactors: zero risk
economics change, zero clock semantics change, zero schema/migration change.
The full regression suite (Phase13 risk/ownership, market-data/historical/
canonical-engine/pair-state, P14-E/F/G/H/I) passed unmodified after the
correction, and `npm run build`'s emitted JS confirms `market-data/historical/index.js`
now requires `../../core/time/clock` (not `../../integration/coindcx/clock`)
and `risk/ownership.js` emits no CoinDCX-models `require` at all (the import
was always type-only and fully erases).

---

## 11. Funding Limitation (explicit, permanent unless re-scoped by a future phase)

```
fundingCapability     = FUNDING_UNSUPPORTED
reason                = COINDCX_PROVIDER_EVIDENCE_INCOMPLETE
fundingApplied        = false
economicCompleteness  = FUNDING_EXCLUDED
paperEconomicStatus   = PAPER_NOT_ECONOMICALLY_COMPLETE
pnlLabel              = FUNDING_EXCLUDED_PNL
maximum lifecycle     = PAPER
```

CoinDCX does not currently expose enough provider truth to reproduce
perpetual-funding economics for a synthetic paper position (`src/execution/funding-capability.ts`).
**Every** P14-E/P14-H/P14-I economic result carries this disclosure, always.
`HEALTHY` (P14-H) and production-`READY` (P14-I) both mean *"internally
consistent with currently supported paper accounting"* — **never** "funding
parity with a real CoinDCX position," and never "promotion-eligible."
`PAPER -> PAPER_APPROVED`/`SHADOW`/`LIVE_CANDIDATE`/`LIVE` remain
unconditionally blocked (§6) for exactly this reason. Phase 14 must **not**
be described as `PAPER_APPROVED`, `SHADOW`-ready, or `LIVE`-ready anywhere.

---

## 12. P14-I-A1 (frozen policy, restated for completeness)

```
P14-H UNHEALTHY  ->  blocks OPEN
P14-H UNHEALTHY  ->  blocks CLOSE
P14-H UNHEALTHY  ->  no reduce-only bypass, in PAPER mode
```

Rationale (unchanged from its authorization): an `UNHEALTHY` result means a
durable fact/projection mismatch exists; current position/revision/
reservation/fill/ledger/account state cannot be treated as trustworthy
enough for *any* further economic mutation. There is no real exchange
exposure in PAPER mode requiring emergency liquidation, so there is no
countervailing safety reason to carve out a CLOSE exception. **This is a
PAPER-mode-only decision — it must not be read as a statement about future
LIVE behavior.** A historical `PaperReconciliationFault` row never
permanently disables an account: only the *current*, freshly-run
reconciliation controls current health (proven in §9's mandatory-test row).

---

## 13. Phase14 Final-Gate Correction Wave 1 (F14-04/05/06/07)

An Astra final-milestone-gate pass found four durable-state/reconciliation/
version/recovery defects beyond the P14-A..J proofs above. All four were
corrected in this wave; **F14-01/F14-02/F14-03 (risk-evidence authority,
market-evidence public ingestion, ExecutionPolicy validation/multiplier
binding) remain open and are explicitly out of this wave's scope** — the
overall Phase14 final milestone gate is therefore **not yet** claimed PASS
(see §13.5 below).

| Finding | Defect | Correction | Test evidence | Status |
|---|---|---|---|---|
| F14-04 | A RELEASED reservation's generation was forgotten across a restart (`RiskAdmissionCoordinator.restore()` only ever restored currently-`ADMITTED` rows) — a post-restart retry of the same unfilled source decision reused generation 1, upserting into the existing RELEASED row instead of allocating a fresh one | `RiskAdmissionCoordinator` now tracks `#latestGeneration` (accountId → sourceStrategyDecisionId → highest generation ever durably used), restored independently of live pending exposure from a new `AdmissionGenerationWatermark[]` computed in `restore.ts` from **every** historical reservation row regardless of status | `tests/integration/execution/paper-account-kernel.test.ts` ("F14-04 correction") — release gen 1, restart, retry, assert gen 2, gen-1 row still RELEASED, exactly one eventual fill, terminal-retry-after-fill blocked | CORRECTED |
| F14-05 | P14-H reconciliation only walked forward from existing rows (slot → reservation, history → fill) — an ADMITTED reservation next to an EMPTY/wrongly-claimed slot, a CONSUMED reservation with neither an OPEN slot nor completed history, or a completed CLOSE missing its history row, all read HEALTHY; OPEN leverage/initial-margin were never cross-checked | Added `#reconcileReservationsReverse` (ADMITTED/CONSUMED reservation → required slot/history) and `#reconcileCompletedClosesReverse` (completed CLOSE → required history), plus exact leverage (direct fact equality) and initial-margin (re-derived from committed fill/policy-snapshot facts, same `quantizePaperPosting` boundary as P14-E) checks in `#reconcilePosition` | `tests/integration/execution/paper-account-reconciler.test.ts` ("F14-05 correction" — 5 new tests) | CORRECTED |
| F14-06 | `PaperAccount.revision` was observed by P14-H but never enforced at mutation time — admission/release never advanced it at all, and OPEN/CLOSE checked only `ownerFence`, so durable state could change between a HEALTHY observation and the mutation it authorized, even under the same fence | `admitAndPersist`/`releaseAndPersist`/`executeOpen`/`executeClose` all accept an optional `expectedRevision` and re-verify it under the same `SELECT ... FOR UPDATE` account lock as the mutation itself (never a separate preflight read); admission and release now atomically advance `PaperAccount.revision`; P14-I's production runtime binds every OPEN to its own fresh `#assertFreshlyHealthy()` revision, and CLOSE/the post-admission OPEN fill bind to the exact new revision admission produced | `tests/integration/execution/paper-account-persistence.test.ts` ("F14-06 correction" — revision transitions, multi-account isolation, stale-OPEN-revision rejection) + `tests/integration/execution/paper-account-kernel.test.ts` ("F14-06 correction" — stale-CLOSE-revision rejection) | CORRECTED |
| F14-07 | `PaperAccountProductionComposer.start()` trusted `PaperAccountKernel.getState()` (a diagnostic map set once at successful startup) to decide whether a cached READY facade was still valid — that map never reflects a `PaperAccountSession` faulting after startup (e.g. an outcome-ambiguous admission failure), so a stale READY facade over a FAULTED session could be returned indefinitely | `start()` now always re-verifies through `PaperAccountKernel.startPaperAccountRuntime` itself (the kernel's own recovery authority) before trusting a cached facade — a genuinely-still-READY session returns the identical cached `PaperAccountRuntime` instance with no re-reconciliation (§7's original idempotent fast path preserved); any other outcome (kernel had to recover, or recovery itself failed) discards the stale facade and requires a full fresh startup — fresh reconciliation included — before any new READY facade is produced | `tests/unit/execution/persistence/session-fault-recovery.test.ts` ("F14-07 correction" — 2 new tests: successful kernel-mediated recovery with no duplicate economics, and a failed recovery leaving the account NOT_READY) | CORRECTED |

### 13.5 Conservative final-gate status (as of Wave 1)

F14-01/F14-02/F14-03 were untouched by Wave 1. Phase14's overall final
milestone gate was **NOT** claimed PASS there — only
`PHASE14_WAVE1_COMPLETE`. (F14-01/F14-02 are corrected in Wave 2, §13B below;
F14-03 remains open.)

---

## 13B. Phase14 Final-Gate Correction Wave 2 (F14-01/F14-02)

Two authority/provenance defects from the same Astra pass. Both are corrected
here. **F14-03 (ExecutionPolicy content/hash validation, negative fee/slippage
domains, zero multiplier, authoritative instrument-multiplier binding) is
deliberately untouched and remains OPEN** — no policy economics,
`contractMultiplier` semantics, or fee/slippage validation were modified by
this wave. No schema, migration, funding, or live-execution change was made.

| Finding | Defect | Correction | Test evidence | Status |
|---|---|---|---|---|
| F14-01 | Production OPEN admission accepted caller-supplied `accountSnapshot`/`exposureSnapshot` risk evidence that was never bound to the current durable `PaperAccount`; the first correction then derived `currentEquityInr` as realized-only cash, contradicting Phase13 §12.3 and allowing an OPEN position's unrealized loss to be omitted from drawdown and risk-budget sizing | `src/execution/persistence/authoritative-risk-input.ts` now separates (A) one fence-verified, revision-bound durable transaction from (B) production-acquired mark/conversion evidence and (C/D) pure Decimal MTM derivation. The durable base contains every OPEN position's side, quantity, INR entry price, and its own opening execution-policy multiplier lineage. P14-I acquires a fresh current-generation CoinDCX mark for every distinct OPEN pair plus a locally-fresh conversion, then computes every position's frozen LONG/SHORT unrealized PnL and `equity = cashBalance + ΣU`; one missing, stale, or caller-supplied constituent fails the whole OPEN before admission. Positive U remains non-spendable through `min(cashBalance, equity)`, while negative U reduces both available margin and Phase13's equity-based risk budget. Caller account/exposure fields remain removed and durable-dependent pair facts remain strictly checked. Health/base revision disagreement is `HEALTH_STALE`; any later mutation is rejected atomically by admission's `expectedRevision` as `STALE_ACCOUNT_REVISION`. CLOSE deliberately performs no MTM risk gate because every equity-sensitive Phase13 gate is OPEN-only and de-risking must not be blocked by a new valuation prerequisite | `tests/unit/execution/persistence/authoritative-mtm-equity.test.ts` (19 tests: LONG/SHORT, conversion, precision, all positions, no fallback, margin, insolvency, daily-PnL isolation, CLOSE boundary, drawdown and risk-budget adversaries); `tests/unit/execution/trusted-evidence.test.ts` (5 valuation-provenance/freshness tests); `tests/integration/execution/paper-production-runtime.test.ts` (15 F14-01 live-DB tests: durable authority, smuggling/mismatch rejection, revision races, second-pair MTM sizing, unrealized-only drawdown rejection, and all-OPEN-pair valuation) | CORRECTED |
| F14-02 | Trusted evidence was non-forgeable as an *object* but not in its *provenance*: a caller could publicly construct a `CoinDcxPaperEvidence`, hand it a fake socket factory, feed fabricated `depth-snapshot`/conversion payloads through the public `ingest*` methods, and the trusted adapter minted an AVAILABLE, production-usable `TrustedPaperExecutionEvidence` — it only proved "an adapter wrapped a provider object" | New module-private `PRODUCTION_ACQUISITION_CAPABILITY` (`src/integration/coindcx/acquisition-capability.ts`, absent from the public barrel, mirroring `SESSION_PROOF`/`ACCOUNT_FAULT_RECOVERY_CAPABILITY`). Every stored P14-B datum now carries `PRODUCTION_ACQUISITION` vs `CALLER_SUPPLIED` provenance; only the provider's own approved acquisition paths (`startOrderbookWebSocket`/`startMarkWebSocket` callbacks, `readOrderbookBootstrap`/`readConversion`) supply the capability, and only on a provider whose acquisition seams are the genuine defaults (no injected socket factory, REST transport, or clock) or which holds the capability itself. The adapter now reads through `readProductionAcquiredPaperExecutionEvidence`, which requires (a) an instance registered by the real constructor's own `new.target` identity (subclasses excluded), (b) invocation of the PROTOTYPE reader over private twins of the public getters (own-property shadows excluded), and (c) production provenance on the quote, depth **and** conversion. `FakeCoinDcxSocket`/`FakeCoinDcxSocketFactory` were removed from the public CoinDCX barrel | `tests/unit/execution/trusted-evidence.test.ts` — "F14-02" (10 new tests): Astra's fabrication reproducer yields `EVIDENCE_NOT_PRODUCTION_ACQUIRED`; fake-socket laundering through the internal callback rejected; subclass rejected; own-property shadow cannot substitute the reader or any getter it uses; structural look-alike rejected; one caller-supplied constituent poisons the bundle; string brand / `isProduction: true` insufficient; generation/staleness/clock-regression/REST-never-blesses gates all still fire; barrel exposes neither the capability nor the fakes. Plus `tests/integration/execution/paper-production-runtime.test.ts` — "F14-02 live-DB": fabricated evidence cannot fill an OPEN and cannot close a genuinely OPEN position | CORRECTED |

### 13B.1 F14-01 final MTM correction boundary

V2 §12 defines `equity = cashBalance + U` (U = unrealized mark-to-market).
The durable base is loaded and unlocked before any provider read; P14-I then
obtains production-acquired mark/conversion valuation evidence and performs a
pure Decimal derivation over **every** durable OPEN position. This preserves
the no-network-inside-account-transaction boundary while making §12.4
drawdown and §11 risk-budget sizing fully unrealized-sensitive. A revision
change after the base read remains fail-closed at admission under the original
account lock. There is no entry-price, candle, LTP, partial-account, or
assume-zero fallback. Zero OPEN positions require no valuation provider work.

CLOSE retains the realized-only snapshot construction solely because Phase13
does not consult equity, drawdown, exposure, or sizing gates for CLOSE; adding
a mark prerequisite there would newly block de-risking. Execution's existing
fresh trusted quote/depth/conversion gate is unchanged.

`AccountRiskSnapshot.accountMaxLeverage` remains an explicit caller/config
input (`ProductionOpenParams.accountMaxLeverage`, default `null`): the P14-C
paper schema persists no per-account exchange leverage cap, so deriving one
would be invention. It is classified as external policy/config, not durable
account state.

### 13B.2 Conservative final-gate status after Wave 2

F14-01 and F14-02 are corrected; **F14-03 remains OPEN**. Phase14's overall
final milestone gate is **NOT** claimed PASS here — only
`PHASE14_WAVE2_COMPLETE`. This wave does not constitute
`PRODUCTION PAPER MECHANICS READY`, `PAPER_APPROVED`, `SHADOW`, or `LIVE`;
the maximum lifecycle remains `PAPER`.

---

## 13C. Phase14 Wave3-A — production instrument acquisition authority

Wave3-A closes only the acquisition-authority prerequisite for F14-03. The
production composition can now request a canonical pair and receive an opaque,
immutable binding issued only after the real CoinDCX Futures instrument REST
pipeline performs request/response pair binding, runtime schema validation,
lossless Decimal normalization, INR-margin validation, and perpetual-product
validation. The production mint constructs the default CoinDCX transport
internally; it accepts no caller client, transport, callback, metadata, brand,
or factory flag. Structural `InstrumentMetadata` and caller-computed hashes do
not carry the binding's private-field provenance.

The new `P14_PRODUCTION_INSTRUMENT_SPEC_IDENTITY_V1` namespace is separate
from both the older P14-B evidence-routing identity and the future
`P14_INSTRUMENT_ECONOMICS_SNAPSHOT_V1`. Its canonical preimage binds source,
pair, static product/currency identity, exact multiplier/tick/step economics,
and the static minimum/maximum order constraints obtained from the same
normalized response. Mutable tradeability, fee, leverage-tier, and funding
policies remain outside this identity and retain their existing owners.

No instrument cache or TTL exists on this reader, so Wave3-A invents none: each
authority request performs a fresh read. P14-I exposes the pair-only authority
request outside its economic mutation queue and outside every account DB
transaction. No OPEN/CLOSE economic input or formula changes in this wave.

**Conservative status:** the F14-03 acquisition prerequisite is implemented,
but F14-03 remains **OPEN**. `PaperInstrumentEconomicsSnapshot`, schema/durable
binding, execution-policy identity/domain validation, immutable policy conflict
handling, and the CLOSE lifecycle-multiplier correction are not implemented.
Status: **AWAITING_F14_03_SCHEMA_IMPLEMENTATION**.

---

## 13D. Phase14 Wave3-B — durable instrument economics and policy authority

Wave3-B adds the immutable, content-addressed
`PaperInstrumentEconomicsSnapshot` and binds every newly created OPEN/CLOSE
`PaperExecutionIntent` through the pair-scoped composite foreign key. Existing
intent rows remain nullable by migration design and are never backfilled:
reconciliation deterministically reports every such historical or active row
as `LEGACY_UNVERIFIABLE_INSTRUMENT_ECONOMICS`.

Production OPEN acquires the genuine Wave3-A pair-only CoinDCX binding outside
every database transaction, derives RiskEngine instrument fields from that
binding, validates exact positive `DECIMAL(36,18)` economics, and requires the
retained policy multiplier to match. The canonical policy hash is recomputed
at consumption; fees are non-negative, slippage is in `[0,10000)`, and the
multiplier is positive. Both snapshot tables use create-or-compare semantics:
an identical row is reused, while any same-ID content conflict fails closed
without mutation.

MTM resolves multiplier only through the opening intent's durable instrument-
economics snapshot. CLOSE loads the same opening binding, uses its multiplier
and tick, persists the same economics ID on the close intent, and rejects a
policy multiplier mismatch. Restart requires no process-local instrument
capability. P14-H recomputes both hashes, validates domains/pair and multiplier
equality, checks OPEN/CLOSE lifecycle equality, and diagnoses legacy NULL
bindings without repair.

`ALL_ASTRA_F14_01_TO_F14_07_CORRECTIONS_IMPLEMENTED`

Status: **AWAITING_FINAL_ASTRA_REGATE**. This is not an independent final gate
PASS. Funding remains unsupported/excluded and the maximum lifecycle remains
PAPER.

---

## 13D. Final-Gate Correction Wave 4A — F14-02 public market-evidence trust bypass

The Wave 2 F14-02 correction was **insufficient**. A later Astra pass
reproduced two production-reachable trust bypasses against it, and this wave
closes both. Scope is F14-02 only.

### Reproduced before the correction

| # | Attack | Pre-fix result |
|---|---|---|
| A | Constructor option **getter TOCTOU**. The Wave 2 constructor read `socketFactory`/`orderbookRestTransport`/`markRestTransport`/`conversionTransport`/`clock` once to decide trust ("every seam is the genuine default") and again to build the provider. Caller getters returned `undefined` on the first read and a fake socket factory / fake REST transport on the second. Fabricated frames then entered through the provider's OWN internal acquisition callbacks, which supplied the capability themselves. | Execution evidence **AVAILABLE**; valuation evidence **AVAILABLE**; fabricated trusted mark **999999**; **0** network requests; attacker supplied **no** capability |
| B | **Deep-imported acquisition token.** `PRODUCTION_ACQUISITION_CAPABILITY` was `export const` in `acquisition-capability.ts` (barrel-absent, but deep-importable) and was accepted both as a public constructor option and as a public `ingest*` argument. | Manually fabricated mark/conversion accepted as `PRODUCTION_ACQUISITION`; valuation **AVAILABLE** at 999999 |

### Correction

Trust no longer derives from a token, nor from any inference about option
values. It derives from **which construction path built the provider**.

- **The capability is no longer a value.** `PRODUCTION_ACQUISITION_CAPABILITY`
  is deleted. `acquisition-capability.ts` retains only the
  `PaperEvidenceAcquisition` label type and exports **no runtime value at
  all**. Production acquisition provenance is object identity in the
  module-private `PRODUCTION_PROVIDERS` `WeakSet` inside `paper-evidence.ts`,
  written only by that module's own factory — the same construction Wave3-A
  uses for `INSTRUMENT_BINDING_ISSUER`. There is nothing to import, name,
  copy, serialize, or structurally reproduce, and it is not a string/boolean
  brand.
- **No capability parameter survives anywhere.** `acquisitionCapability` is
  removed from `CoinDcxPaperEvidenceOptions` and from every public `ingest*`
  signature. Public ingestion is permanently `CALLER_SUPPLIED`; no argument
  can upgrade it.
- **Options are captured exactly once.** `captureOptions` materializes every
  caller property into a frozen record at the boundary; the constructor never
  touches the caller's object again, so no getter or Proxy can present a second
  value. `instruments` is copied, so a live array cannot mutate after
  validation.
- **A production provider has no injectable acquisition dependency.**
  `createProductionPaperEvidenceProvider({ instruments, policy? })` is the sole
  production mint; it selects the real `ProductionCoinDcxSocketFactory`, the
  real `CoinDcxTransport`s and the real `SystemClock` itself. The public
  `CoinDcxPaperEvidence` constructor keeps its injectable seams for tests and
  can **never** be production-trusted under any option combination.
- **Three independent proofs at the issuer** (§6): genuine registered instance
  (`new.target`), `PRODUCTION_PROVIDERS` membership, and per-datum
  `PRODUCTION_ACQUISITION` provenance. `instanceof` alone is explicitly not
  acquisition provenance; a Proxy over a genuine provider is rejected.
- **Zero-network testing of the genuine path exposes no trust authority.**
  Tests intercept `CoinDcxTransport.prototype.executeRead` and
  `ProductionCoinDcxSocketFactory.prototype.createSocket` with the test
  runner's own mocking — the seam Wave3-A's accepted instrument-authority tests
  already use. A `vi.spyOn` is not an export.

Every frozen P14-B rule is preserved and still evaluated first: REST never
blesses a WS generation, wrong generation / stale quote / stale mark / stale
conversion / clock regression are rejected, and there is no candle, LTP, or
private-position fallback. Wave3-A instrument authority is untouched and stays
disjoint: market-evidence trust cannot mint an instrument binding, and instrument
authority cannot mint a production provider.

### Post-correction result (same attacks, same entry points)

| Probe | Result |
|---|---|
| Option reads per property during construction | `{clock: 1, socketFactory: 1, conversionTransport: 1}` |
| Attacker fake socket factory sockets created | **0** (never installed) |
| Attacker fake REST transport calls | **0** (never installed) |
| Execution evidence from the TOCTOU provider | `UNAVAILABLE / PROVIDER_NOT_PRODUCTION_ACQUIRED` |
| Valuation evidence from the TOCTOU provider | `UNAVAILABLE / PROVIDER_NOT_PRODUCTION_ACQUIRED` |
| Deep import of `acquisition-capability` | runtime exports `[]`; token `undefined` |
| Capability/registry leaks from `paper-evidence` | `[]` |
| Forged OPEN / CLOSE / MTM end-to-end (live DB) | rejected `EVIDENCE_UNAVAILABLE` with no fill, ledger, reservation or revision movement attributable to the request |

### Evidence

`tests/unit/execution/trusted-evidence.test.ts` (27 tests) covers §18.1–§18.12
and §18.16: both getter-TOCTOU variants (asserting each option is read exactly
once and the attacker's dependency is never installed), no option combination
producing trust, the token being unimportable, manual orderbook/mark/conversion
each unable to upgrade, injected socket factory and REST transport untrusted,
Proxy/subclass/structural/own-property-shadow rejection, the genuine production
path still succeeding, generation/staleness/clock gates unchanged, and
capability/instrument-authority separation.
`tests/integration/execution/paper-production-runtime.test.ts` (42 tests) covers
§18.13–§18.15 end-to-end on a live database: forged and getter-TOCTOU providers
cannot OPEN or CLOSE, and forged valuation evidence cannot influence risk
admission for an account holding a genuine OPEN position.
`tests/architecture/phase14-import-graph.test.ts` (25 tests) adds four
mechanical guards — no `src` module exports any acquisition capability value
under any name, the constructor never reads a caller option twice, the
production factory accepts no injectable acquisition dependency, and no public
`ingest` entry point accepts a capability argument. No allowlist is used.

**`F14_02_CORRECTED`** — and separately, still open:

Astra's same pass found that CLOSE does not maintain `consecutiveLossCount`,
`cooldownActiveUntilMs`, or `peakEquityInr`. That defect is **deliberately not
touched in this wave** and remains **OPEN**.

Status: **AWAITING_F14_01_CORRECTION**, then **AWAITING_FINAL_ASTRA_REGATE**.
Phase 14 is **not** PASS.

### 13D.1 Correction 4A.1 — prototype-patch production trust bypass

Wave 4A was **still insufficient**. An independent verifier found a third,
equivalent production-reachable bypass and F14-02 stayed OPEN.

**The exploit.** Ordinary application code — no Vitest, no test helper, no
acquisition token — deep-imports `CoinDcxTransport` and
`ProductionCoinDcxSocketFactory`, whose `executeRead` and `createSocket`
prototype properties are both `writable: true, configurable: true`, replaces
them, and then calls `createProductionPaperEvidenceProvider`. The production
factory reached the network *through those exported prototypes*, so the
attacker's implementations became the privileged acquisition path.

Reproduced before the fix, verbatim:

| Probe | Pre-fix |
|---|---|
| `executeRead` / `createSocket` descriptors | `writable=true configurable=true` |
| fake transport privileged calls | **1** |
| fake socket privileged calls | **2** |
| trusted execution evidence | **AVAILABLE (forged)** |
| trusted valuation evidence | **AVAILABLE (forged)** |

**Why the earlier fix missed it.** Wave 4A made trust depend on *which
construction path built the provider* (object identity in the module-private
`PRODUCTION_PROVIDERS`). That is necessary but not sufficient: provider
identity says nothing about whether the acquisition *implementation* is still
the real one. The trust boundary must include acquisition **implementation
integrity**.

**The correction.** The privileged acquisition implementation is now
module-local to `paper-evidence.ts` — the same module that owns the registry,
the provider class and the factory:

- `privilegedGetJson` performs the production REST reads directly over Node's
  `https`, preserving the transport's semantics for these endpoints exactly
  (all three P14-B production endpoints are unauthenticated public GETs): same
  paths — pinned to `transport.ts`'s frozen map and held there by an
  architecture test — same 10 s timeout, same 5 MB response cap, same lossless
  numeric parsing, same typed CoinDCX errors.
- `PrivilegedProductionSocket` constructs the socket with byte-identical
  socket.io configuration to `ProductionCoinDcxSocket` (websocket-only
  transport, no library reconnection, no autoConnect, exact-numeric parser,
  `forceNew`). Generation IDs, reconnect handling, causality and staleness are
  untouched.
- Neither is exported from its own file, from any barrel, or under any other
  name, and neither is a property of any exported object — so in CommonJS there
  is no namespace entry to assign to either. The factory closes over them
  directly and never calls back out through an exported class prototype.
- `#startSocket` and the provider's `read*` methods select the privileged
  implementation on `PRODUCTION_PROVIDERS.has(this)`, and the
  exported-transport / exported-socket-factory branches now pass
  `internal = false`. A patched exported prototype is therefore not merely
  bypassed — anything it produces is permanently caller-supplied.

The public `CoinDcxTransport` and `ProductionCoinDcxSocketFactory` remain fully
usable for everything else, including Wave3-A instrument acquisition; they are
simply no longer on the privileged path.

**Post-correction, same attacks:**

| Probe | Pre-import patch (§12) | Post-import patch (§13) |
|---|---|---|
| fake transport privileged calls | **0** | **0** |
| fake socket privileged calls | **0** | **0** |
| attacker ever asked to supply a socket | **no** | **no** |
| trusted execution evidence | **UNAVAILABLE** | **UNAVAILABLE** |
| trusted valuation evidence | **UNAVAILABLE** | **UNAVAILABLE** |

`PROTOTYPE_PATCH_TRUST_BYPASS = SAFE`.

**The test seam was the exploit, and is gone.**
`tests/helpers/production-acquisition-harness.ts` used to patch exactly those
two prototypes. It no longer can prove anything, so it now intercepts strictly
*below* the production authority, at the external I/O boundary: `https.request`
for REST and the `socket.io-client` package for WS. Neither is a
repository-exported production API, so the test mechanism no longer
demonstrates that a repo module surface is replaceable.

**Boundary stated, not overclaimed.** The privileged primitives still stand on
a Node builtin and one third-party package. Replacing those is a strictly
broader capability that defeats every module in the process equally and lies
outside this repository's module convention; it is not a repo-exported
production API. `§8` is covered concretely: replacing `Date.now` alone cannot
fabricate provenance — a test drives a fully attacker-controlled clock, passes
every freshness gate, and still gets `PROVIDER_NOT_PRODUCTION_ACQUIRED`,
because the clock influences freshness of already-acquired data and never
acquisition provenance.

**Evidence.** `tests/unit/execution/prototype-trust-bypass.test.ts` (6 tests):
post-import patch, pre-import patch (with `vi.resetModules`, so a fix that
merely captured prototypes at module init would fail), no trusted
quote/depth/mark/conversion for a patched attacker, no reachable or mutable
privileged dependency (no own data properties; every readable accessor returns
a primitive), the `Date.now` distinction, and a positive control proving the
genuine privileged path still mints both bundles.
`tests/integration/execution/paper-production-runtime.test.ts` (44 tests) adds
live-DB §19 coverage: a prototype-patched attacker cannot OPEN and cannot
CLOSE, with zero privileged calls to either replacement, and the genuinely OPEN
position is **not** wedged — a genuine provider still closes it afterwards.
`tests/architecture/phase14-import-graph.test.ts` (28 tests) adds three
structural guards: the privileged primitives exist and are exported from
nowhere, the production path routes through them on the registry check with the
exported-transport branch left untrusted, and the pinned endpoint paths stay in
sync with `transport.ts`.

**One architectural invariant was narrowed, deliberately.** Phase 3 invariant
44 forbids importing socket.io outside the websocket layer. Constructing the
privileged socket from a module-local binding requires that import inside
`paper-evidence.ts`, because any cross-module reference is a writable property
on the CommonJS exports object and is therefore patchable — the very thing
being fixed. The invariant now carries exactly one pinned exception
(`src/integration/coindcx/paper-evidence.ts`) and additionally asserts the
exception set equals that single entry, so it polices its own size instead of
hiding future drift. Its original purpose — no proliferation of WebSocket
implementations outside the websocket layer — is unchanged.

Status unchanged by this correction: **F14-02 correction awaiting targeted
verify**, F14-01 durable loss/cooldown/peak-equity defect still **OPEN**,
Phase 14 final **NOT PASS**.

---

## 13E. Final Correction — F14-01 durable loss / cooldown / peak-equity state

The last open Astra blocker. `docs/RISK_LEVERAGE_ENGINE.md` §12.4/§12.5 assign
`consecutiveLossCount`, `cooldownActiveUntilMs` and `peakEquityInr` to the
`AccountRiskStateProvider` adapter — "Phase 13 only compares the supplied
values against configured thresholds; it never recomputes them from raw trades
itself". Phase14's durable paper account IS that adapter, and it was
maintaining none of the three: they were written once at account creation and
never again.

### Reproduced

| Astra observation | Cause |
|---|---|
| 3 realized losing CLOSEs (−₹1,100, −₹1,087.68, −₹1,075.36) against a configured limit of 3 left `consecutiveLossCount = 0`, `cooldownActiveUntilMs = NULL`, and a 4th OPEN FILLED | the CLOSE economic transaction booked realized PnL and fees but never touched either field |
| cash reached ₹100,879.10 and MTM equity ₹100,990 while stored `peakEquityInr` stayed ₹100,000 | nothing ever advanced the high-water mark, so §12.4's drawdown measured decline from the inception value |
| stale risk state still reconciled HEALTHY | P14-H had no risk-state check at all |

### Frozen semantics recovered (not invented)

| Rule | Source | Implementation |
|---|---|---|
| LOSS = a closed trade's realized PnL `< 0` → +1 | §12.5 | the exact gross realized PnL P14-E already booked to the fill, the `REALIZED_PNL` ledger entry and the lifecycle row — never recomputed |
| PROFIT or BREAKEVEN (`≥ 0`) → reset to 0 | §12.5 | breakeven clears the streak, it does not preserve it |
| Cooldown start = the close that FIRST reaches the limit sets `closeTimeMs + cooldownMs` | §12.5 | "first reach" is literal, so a later loss never re-arms or extends the boundary |
| Cooldown boundary: blocked strictly while `evaluationTimeMs < cooldownActiveUntilMs` | §12.5 | unchanged gate, now fed genuine state |
| `peakEquityInr` = running high-water mark of `currentEquityInr`, never auto-resets | §12.4 | exact Decimal `max`; no path lowers it |
| `currentEquityInr` INCLUDES unrealized PnL | §12.3 | so MTM observations are observations of the high-watered quantity |

Fee treatment is deliberate: §12.1 keeps `realizedTradingPnlInr` and `feesInr`
as separate daily-PnL components and `accounting.ts` documents the account's
`R` column as "cumulative booked gross realized trading PnL", so the streak is
classified on gross realized trading PnL. Funding is excluded and contributes
nothing (§31).

### Correction

- **CLOSE (atomic).** `src/execution/persistence/durable-risk-state.ts` holds the
  frozen rules as pure functions. The CLOSE economic transaction now folds the
  loss streak and cooldown into the SAME `paperAccount.update` that books
  realized PnL and fees, under the SAME account-row lock, with the SAME single
  `revision` increment. There is no follow-up write, so a rolled-back CLOSE
  advances no risk state, and F14-06's exactly-once revision semantics are
  unchanged.
- **Peak on CLOSE, only when exact.** Equity is `cash + Σ unrealized`, so
  post-close cash equals equity only when the account holds no OPEN position.
  A CLOSE that leaves the account flat advances the mark to that exact cash; a
  CLOSE with positions still open makes no peak claim and leaves it to the next
  MTM observation. No guess, one formula.
- **Peak on OPEN/MTM.** `advanceDurablePeakEquity` writes the observed
  authoritative equity BEFORE §12.4's drawdown gate measures against it. The
  network read is already finished, so no I/O happens under the lock; the write
  is conditional on the derivation's own revision, so a concurrent mutation
  fails closed as `STALE_ACCOUNT_REVISION` rather than overwriting a newer peak
  from a stale basis. [§26] An observation at or below the stored mark writes
  nothing and leaves the revision untouched, so no admission race is
  manufactured. [§27] Admission now binds to the post-advancement revision;
  when no advancement was needed the two values are identical.
- **Reconciliation (§22).** A new `RISK_STATE_MISMATCH` fault, flagging only
  what committed facts mathematically prove, never repairing.

### What reconciliation can and cannot prove

| Field | Provable? | Check |
|---|---|---|
| `consecutiveLossCount` | **Fully** — a pure fold over every closed lifecycle's own realized PnL and close time; policy-independent | `DURABLE_CONSECUTIVE_LOSS_COUNT_MISMATCH` |
| `cooldownActiveUntilMs` | **Only against the configured limit/duration**, which are policy, not durable facts | `DURABLE_COOLDOWN_BOUNDARY_MISMATCH`, checked when a policy is supplied and deliberately left unverified otherwise — never guessed |
| `peakEquityInr` | **Lower bound only.** Historical marks are NOT durably stored, so the true high-water of an account that held open positions is genuinely unrecoverable and is not reconstructed | `PEAK_EQUITY_BELOW_PROVABLE_MINIMUM`, from starting capital and cash at each moment the account demonstrably held no open position (where equity equals cash exactly) |

Fault identity stays deterministic — the semantic hash carries immutable facts
only, never a detection timestamp — so the same defect yields the same
`faultId` on every run. Funding is excluded from the peak bound: it is always
0 in valid Phase14 state and a nonzero value is already owned by
`FUNDING_INVARIANT_VIOLATION`, so folding it in would report one corruption
twice.

### Evidence

`tests/unit/execution/persistence/durable-risk-state.test.ts` (11 tests) pins
the frozen rules themselves: increment, profit reset, breakeven reset, first-reach
cooldown arming, no re-arm or extension on a later loss, no-limit configuration,
deterministic replay, exact Decimal sign, strict-advance-only peak, and the mark
never lowering.

`tests/integration/execution/paper-production-runtime.test.ts` (61 tests) adds
the live-DB proofs: Astra's exact three-loss reproducer with the fourth OPEN now
refused and no economics; the inclusive-end cooldown boundary; profitable reset;
restart restoring streak, cooldown and peak from durable state across fresh
compositions; account isolation; a duplicate terminal CLOSE retry advancing the
streak exactly once; a profitable flat CLOSE advancing the peak to exact
post-close equity; an unrealized MTM gain advancing the peak with a later
decline never lowering it and drawdown measured from the historical mark; the
no-churn and stale-revision behaviours of the peak write; a losing CLOSE never
lowering the mark; and the four reconciliation faults plus the two cases
reconciliation deliberately refuses to guess.

Status: **F14-01 corrected, awaiting targeted verify.** Funding remains
unsupported/excluded and the maximum lifecycle remains PAPER — no part of this
wave changes that.

---

## 14. Final Phase14 Status

| Question | Answer |
|---|---|
| Phase 14 implementation complete? | **YES** (A through J) |
| Production PAPER mechanical path (dispatch → risk → durable admission → evidence → execution) | **PROVEN** |
| Restart / fencing / reconciliation | **PROVEN, Wave1-corrected** (§13: F14-04/05/06/07) |
| Production risk-input authority | **PROVEN, Wave2-corrected** (§13B: F14-01 — derived from durable state under the admitted revision) |
| Production market-evidence provenance | **Wave4A + 4A.1-corrected** (§13D/§13D.1: F14-02 — trust originates from the production construction path AND the privileged acquisition implementation is module-local, so no exported prototype can be patched onto it) |
| Funding economic parity | **INTENTIONALLY UNSUPPORTED / PROVIDER-BLOCKED** (§11) |
| Maximum lifecycle | **PAPER** |
| Transitive paper/live import isolation | **PROVEN — strict zero, no exceptions** (§10) |
| Live execution adapter | **NOT_IMPLEMENTED / NOT_ACTIVE** (§10) |
| Drawdown gate sensitivity to unrealized PnL | **FULL MTM FOR OPEN ADMISSION** — every durable OPEN position valued from production-acquired fresh mark/conversion evidence (§13B.1) |
| F14-02 public market-evidence trust bypass | **CORRECTION IMPLEMENTED, awaiting targeted verify** (§13D/§13D.1 — getter TOCTOU, deep-imported token, and prototype-patch bypass all closed and re-probed) |
| F14-01 durable loss/cooldown/peak-equity state | **CORRECTION IMPLEMENTED, awaiting targeted verify** (§13E — maintained atomically on CLOSE, advanced from authoritative MTM on OPEN, and reconciled against committed history) |
| F14-03 instrument acquisition authority prerequisite | **IMPLEMENTED in Wave3-A** — genuine pair-only CoinDCX acquisition produces an opaque binding; no caller metadata can mint it |
| F14-03 durable economics/policy correction | **IMPLEMENTED in Wave3-B** — immutable pair-bound economics, canonical policy validation, OPEN→MTM→CLOSE lifecycle authority, restart, and legacy fail-closed reconciliation |
| Final Astra milestone gate | **NOT PASS** — `ALL_KNOWN_F14_01_TO_F14_07_CORRECTIONS_IMPLEMENTED`, `AWAITING_FINAL_ASTRA_REGATE` |
| Ready for Phase 15 ranking? | Only if Phase 15 explicitly consumes funding-excluded diagnostics as diagnostics, and does **not** treat funding-excluded PnL as production-approval economics. If Phase 15's dependency on funding-excluded profitability is ever ambiguous, that ambiguity should be documented as a Phase 15 limitation — P14-J does not invent or authorize Phase 15 policy here. |

**Correct one-line summary:** Phase 14 is a mechanically production-ready
PAPER runtime with restart-safe fencing, durable admission, trusted-evidence-
gated execution, and account-scoped reconciliation health-gating — **not** a
full CoinDCX economic-parity paper simulation, and **not** promotion-eligible.
Wave 1 (F14-04/05/06/07) and Wave 2 (F14-01/F14-02) of the final-gate
correction are complete; Wave3-A establishes the production instrument
authority prerequisite and Wave3-B implements the durable F14-03 correction;
Wave4A closes the two F14-02 market-evidence trust bypasses a later Astra pass
reproduced against Wave 2 (§13D), Wave4A.1 closes the prototype-patch bypass an
independent verifier then found against Wave4A (§13D.1), and §13E closes the
last blocker — durable `consecutiveLossCount`, `cooldownActiveUntilMs` and
`peakEquityInr` maintenance. **ALL_KNOWN_F14_01_TO_F14_07_CORRECTIONS_IMPLEMENTED**;
final acceptance remains **AWAITING_FINAL_ASTRA_REGATE**, and Phase 14 is not
PASS. Funding remains unsupported/excluded and the maximum lifecycle remains
PAPER.

---

## 15. Validation commands run for this slice

```
npx tsc --noEmit --project tsconfig.test.json   # typecheck
npm run lint                                     # eslint (unchanged rule set)
npm run build                                    # production build
npx prisma validate                              # schema unchanged
npx vitest run tests/architecture/phase14-import-graph.test.ts
npm test                                          # full suite, including all P14-A..I regressions
```

Wave 1 correction (F14-04/05/06/07) additionally ran:

```
npx vitest run tests/integration/execution tests/unit/dispatch tests/unit/risk \
  tests/unit/coin-runtime tests/unit/execution tests/architecture
npx vitest run   # full suite — 159 files / 1947 tests passed
```

Wave 2 correction (F14-01/F14-02) additionally ran:

```
npx prisma validate                               # schema UNCHANGED (no migration)
npm run typecheck                                 # 0 errors
npm run lint                                      # 0 errors (10 pre-existing `any` warnings, untouched fixture code)
npm run build                                     # clean
npx vitest run tests/integration/execution/paper-production-runtime.test.ts \
  tests/unit/execution/trusted-evidence.test.ts \
  tests/unit/execution/persistence/session-fault-recovery.test.ts \
  tests/architecture/phase14-import-graph.test.ts
npx vitest run tests/integration/execution tests/unit/dispatch tests/unit/risk \
  tests/unit/coin-runtime tests/unit/execution tests/architecture
                                                  # 48 files / 779 tests passed
npm test   # full suite — 160 files / 1998 tests passed, 0 failures (+51 vs Wave 1)
```

Wave3-A adds focused production instrument-authority, CoinDCX reader/
normalizer, trusted-evidence, P14-I composition, and architecture regressions.
Its exact command counts are recorded in the Wave3-A correction report; Prisma
schema and migrations remain unchanged.
