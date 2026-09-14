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

### 13.5 Conservative final-gate status (unchanged from before this wave)

F14-01/F14-02/F14-03 are untouched by this wave and remain open. Phase14's
overall final milestone gate is **NOT** claimed PASS here — only
`PHASE14_WAVE1_COMPLETE`. The "Final Phase14 Status" table in §14 below still
governs the mechanical-readiness claim already established through P14-J;
this wave neither raises nor lowers it, and does not itself constitute
`PRODUCTION PAPER MECHANICS READY`.

---

## 14. Final Phase14 Status

| Question | Answer |
|---|---|
| Phase 14 implementation complete? | **YES** (A through J) |
| Production PAPER mechanical path (dispatch → risk → durable admission → evidence → execution) | **PROVEN** |
| Restart / fencing / reconciliation | **PROVEN, Wave1-corrected** (§13: F14-04/05/06/07) |
| Funding economic parity | **INTENTIONALLY UNSUPPORTED / PROVIDER-BLOCKED** (§11) |
| Maximum lifecycle | **PAPER** |
| Transitive paper/live import isolation | **PROVEN — strict zero, no exceptions** (§10) |
| Live execution adapter | **NOT_IMPLEMENTED / NOT_ACTIVE** (§10) |
| F14-01 / F14-02 / F14-03 (risk-evidence authority / market-evidence public ingestion / ExecutionPolicy validation-multiplier binding) | **OPEN — not addressed by this wave** |
| Final Astra milestone gate | **NOT YET PASS** — pending F14-01/02/03 and a final targeted re-verify of this wave |
| Ready for Phase 15 ranking? | Only if Phase 15 explicitly consumes funding-excluded diagnostics as diagnostics, and does **not** treat funding-excluded PnL as production-approval economics. If Phase 15's dependency on funding-excluded profitability is ever ambiguous, that ambiguity should be documented as a Phase 15 limitation — P14-J does not invent or authorize Phase 15 policy here. |

**Correct one-line summary:** Phase 14 is a mechanically production-ready
PAPER runtime with restart-safe fencing, durable admission, trusted-evidence-
gated execution, and account-scoped reconciliation health-gating — **not** a
full CoinDCX economic-parity paper simulation, and **not** promotion-eligible.
Wave 1 of the final-gate correction (F14-04/05/06/07) is complete;
F14-01/02/03 remain open, so **PRODUCTION PAPER MECHANICS READY is not yet
claimed**.

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
