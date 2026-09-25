# Phase 18 — Reconciliation + Crash Recovery

Status: **CURRENT** (Wave A blocker remediation applied, independently
**CLOSED/PASS**; Wave A2 crash-recovery remediation for F18-14/F18-15 applied;
Wave A3 remediation for F18-16/F18-17/F18-18 applied; Wave B evidence-
correctness remediation for F18-03/F18-04/F18-08/F18-09 applied; Wave B2
remediation for F18-03 (broadened)/F18-04 (corrected)/F18-09 (broadened)/
F18-20/F18-21/F18-22 applied; Wave B3 remediation for F18-23 (new)/F18-21
(re-corrected, no exemption)/F18-24 (documented, no speculative field)
applied; Wave B4 remediation for F18-25 (new)/F18-26 (new)/F18-24 (wording
corrected again)/F18-27 (new, BLOCKER) applied, and F18-04's Wave B3 closure
formally superseded — a current-account boundary alone is no longer
sufficient once F18-27 is accounted for, see §6.4.4; Wave B5 remediation for
F18-24 (one remaining absolute claim, in `order-reconciliation.ts`, now
closed with a permanent architecture test), F18-28 (new — the Wave B4
continuity-capability parameter was itself forgeable), and F18-29 (new — a
durably `CANCEL_AMBIGUOUS` orphan could emit a redundant generic finding
alongside its sticky one) applied — Wave B independently **CLOSED/PASS for
safety** (F18-03/F18-04-safety/F18-08/F18-09/F18-20/F18-21/F18-22/F18-23/
F18-24/F18-25/F18-26/F18-27/F18-28/F18-29 all accepted); Wave C1 remediation
for **F18-06** (new — durable orphan cancellation ambiguity had no
authoritative in-band operator resolution path) applied, independently
accepted **CLOSED/PASS**; Wave C1.1 remediation for two LOW findings from that
review — **F18-30** (the Phase16 SOL architecture guard's word-boundary regex,
introduced while fixing a "Resolution" false positive, was narrowed too far
and missed real SOL/Solana-specific names in several casings) and **F18-31**
(the `resolvedBy` field on a resolution was documented ambiguously enough to
invite an overclaim about what it establishes, when it is currently only a
caller-asserted audit label — see §13.4.1) — applied; Wave C1.2 remediation
for two further LOW findings from review of Wave C1.1 — **F18-32** (§13.4.3 —
the Wave C1.1 fix for F18-30 only covered model and enum names; the
field-name half of the same guard still used a 3-literal-string exact match,
so SOL/Solana-specific field names could still bypass it), independently
accepted **CLOSED/PASS**, and **F18-33** (§13.4.4 — the F18-31 exact-phrase
ban is bypassable by any differently-worded false claim, so a second,
proximity-based guard was added) — applied; Wave C1.3 remediation for three
further LOW findings from review of Wave C1.2's F18-33 guard specifically —
**F18-34** (the guard's concept vocabulary required the one exact phrase
"authorized operator" and missed plain "authorized"/"approved"/"user"/
"admin"/"principal" claims), **F18-35** (its future-design recognition missed
several legitimate future-transport phrasings), and **F18-36** (its shared
±150-character window let a qualifier belonging to one claim launder a
separate claim, including across sentences and across "but"/"however" within
one sentence) — all three fixed by replacing the window with sentence/
clause-scoped reasoning (§13.4.4) — applied and independently accepted
**CLOSED/PASS**; Wave C1.4 remediation for **F18-37** (LOW, found by the
Wave C1.3 closure review — the clause-scoped guard's boundary set was
incomplete, so a colon, dash, parenthetical, or unrecognized contrastive
transition still let one clause's qualifier cover a separate claim, §13.4.4)
— applied, **not closed**: independent review of Wave C1.4 raised **F18-38**
and **F18-39** (MEDIUM, §13.4.4); Wave C1.5 remediated both, and the Wave C1.5
closure review returned **FAIL**, raising **F18-40**, **F18-41**, and
**F18-42** (MEDIUM, §13.4.4); Wave C1.6 remediation for F18-40/F18-41/F18-42 —
applied; the **Wave C1.6 independent review returned FAIL** because of one
new finding, **F18-43** (MEDIUM, §13.4.4), while accepting **F18-38**,
**F18-39**, **F18-40**, **F18-41**, and **F18-42** as review **PASS**; the
final C1 guard cleanup remediation for F18-43 — applied, and the **C1 final
closure review returned PASS**: **F18-37 through F18-43 are independently
CLOSED/PASS**; **Wave C2** remediation for **F18-10** (HIGH — the orphan
cancellation per-run ceiling could be parsed to `Infinity` or to any
unbounded value, defeating the cleanup bound, §13.5) — applied, and the
**Wave C2 independent review returned PASS: F18-10 is CLOSED/PASS**;
**Wave C3** remediation for **F18-11** (MEDIUM — incomplete real-MySQL
adversarial acceptance matrix), **F18-12** (LOW — run finding-count
accounting), **F18-13** (LOW — documentation overclaim), and **F18-19** (LOW —
migration freeze discipline and accounting) — applied; Wave C3 also
discovered **F18-44** (MEDIUM — two different accounts' concurrent first
generation claims can deadlock in MySQL; fail-closed, but nothing retried
it), and **Wave C3.1** remediation for F18-44 (a bounded retry of the whole
`claimGeneration` transaction on Prisma `P2034`, §4.5) — applied; the
**Wave C3 + C3.1 independent review returned PASS: F18-11, F18-12, F18-13,
F18-19, and F18-44 are CLOSED/PASS**; **Wave C4** remediation for **F18-45**
(LOW — safety-contract documentation contradicted implemented behavior: the
ambiguous-create TIF rule, and wording implying every venue mutation passes
the continuity barrier when reconciliation-owned orphan cleanup does not,
§21) — applied, and the **Wave C4 independent review returned PASS: F18-45
is CLOSED/PASS**. **F18-01 through F18-45 — every known numbered Phase 18
finding — are CLOSED/PASS.** Phase 18 nevertheless remains **CURRENT**, not
complete: authoritative account continuity is **NOT IMPLEMENTED** and Phase
18 completion is **BLOCKED ON PROVIDER CAPABILITY** (§6.4.5); live
authorization readiness is **NOT READY**; LIVE-VENUE VERIFIED is **NO**; no
real production order has been placed).

Independent review accepted every Wave A/A2/A3, Wave B/B2/B3/B4/B5, Wave C1,
C1.1, C1.2, and C1.3 finding as PASS (F18-01 through F18-09, F18-14 through
F18-18, F18-20 through F18-36, and F18-06 — the full accepted baseline is in
§1): Wave A, Wave B, F18-06, and F18-30 through F18-36 are independently
**CLOSED/PASS**. The Wave C1.3 closure review surfaced one further LOW
finding, **F18-37**, and each later review found the guard still incomplete:
F18-38/F18-39 after Wave C1.4, F18-40/F18-41/F18-42 after Wave C1.5 (whose
closure review returned FAIL). Wave C1.6 fixed exactly F18-40, F18-41, and
F18-42 within the same `findUnsafeResolvedByClaims` guard; its independent
review returned FAIL because of F18-43 while accepting F18-38 through F18-42
as PASS. The final C1 guard cleanup fixed exactly F18-43 in that same guard,
and the C1 final closure review returned PASS: F18-37 through F18-43 are
independently **CLOSED/PASS**. Wave C2 remediated exactly **F18-10** (HIGH,
§13.5), a runtime fix to the orphan cancellation per-run ceiling's parsing
and consumption with no schema or migration change, and its independent
review returned PASS: F18-10 is **CLOSED/PASS**. Wave C3 remediated exactly
F18-11, F18-12, F18-13, and F18-19 (§21), with no runtime, schema, or
migration change; it also discovered F18-44, which Wave C3.1 remediated with
a bounded retry of the generation claim transaction (§4.5). The Wave C3 +
C3.1 independent review returned PASS: F18-11, F18-12, F18-13, F18-19, and
F18-44 are **CLOSED/PASS**, so F18-01 through F18-44 are all closed. Wave C4
remediated exactly **F18-45** (LOW), a documentation and source-comment
correction with no executable, schema, or migration change, and its
independent review returned PASS: F18-45 is **CLOSED/PASS**, so F18-01
through F18-45 are all closed. None of
F18-30 through F18-43 touches F18-06's runtime behavior — the orphan state
machine, the resolution authority, its account/orphan/revision binding, its
outcomes, the schema, and the migration are all byte-for-byte unchanged since
F18-06 was accepted; only test detection logic (F18-30, F18-32) and
documentation/comments/an architecture guard (F18-31, F18-33 through F18-43)
were corrected. Live
authorization readiness is **intentionally, deliberately NOT READY**: F18-06
adds an administrative recovery path, strictly separate from live-mutation
authorization (§F18-27/§F18-28 are completely unaffected — see §13.4's
explicit statement of this boundary), and does not attempt, and was
explicitly told not to attempt, to make live trading operational. This is not
a claim that Wave A, Wave A2, Wave A3, Wave B, Wave B2, Wave B3, Wave B4, Wave
B5, Wave C1, Wave C1.1, Wave C1.2, Wave C1.3, Wave C1.4, Wave C1.5, Wave
C1.6, the final C1 guard cleanup, Wave C2, Wave C3, Wave C3.1, Wave C4, or Phase 18 overall is complete — §1 and §21 name every open item precisely. Every known
numbered finding (F18-01 through F18-45) is CLOSED/PASS. Authoritative
account continuity is **NOT IMPLEMENTED**, and Phase 18 completion is
**BLOCKED ON PROVIDER CAPABILITY** (§6.4.5).
**LIVE-VENUE: NOT VERIFIED** — no cell in §1's "Externally live-verified"
column is `Yes`.

**The single most important consequence of Wave B4, unchanged and reaffirmed
by Wave B5:** no REST-only reconciliation result — however clean, however
stable, however completely evidenced — may authorize a normal Phase 17 live
mutation (OPEN, ordinary cancel, CLOSE). `authorizeCurrentHealthy`/`reconcileAccount` still
compute and publish an honest `HEALTHY` account STATUS (repeated REST reads
agree at the points they were sampled, and no known problem exists), but the
SEPARATE `requireCurrentReconciliation` barrier — the one and only choke point
every normal Phase 17 live mutation passes through in production — refuses to release
authorization from that status alone, because REST polling structurally
cannot prove no venue-side mutation happened after the final read.
Reconciliation-owned orphan cancellation (§13) is a separate, explicitly
configured remediation path that does not pass this barrier; it grants no
normal trading authority, proves nothing about continuity, and does not make
live authorization ready. Wave B5
closes the one gap in HOW that refusal was enforced (F18-28: the refusal
itself was sound, but a caller-suppliable override parameter could have
bypassed it had anything ever supplied one — nothing in production did, but
"nothing does today" is not the same guarantee as "nothing can"). See §6.4.4
for the full reasoning, the "evidence capability" model, and why this is
accepted rather than "solved." **Wave C1 does not touch any of this**: F18-06
adds a way for an operator to resolve a durable orphan cancellation ambiguity,
which is a fact about `live_orphan_venue_order.cancel_state`, not about
`live_reconciliation_state`/`requireCurrentReconciliation` at all — resolving
an ambiguity can never, by itself, make live-mutation authorization available
where F18-27/F18-28 would otherwise refuse it. See §13.4 for the exact
boundary and the tests that prove it.

Phase 17 made this repository capable of mutating CoinDCX state and deliberately
left one question unanswered: after a restart, a crash, or an ambiguous
mutation, *is the database still telling the truth about the exchange?* Phase 18
answers it only as far as sampled REST evidence can: it checks durable state
against repeated REST reads of the venue and blocks the account whenever they
disagree or the evidence is insufficient. It does **not** prove account
continuity (that no venue-side change happened after the final read), so a
clean result is informational only and normal live mutation remains
intentionally unreachable (§6.4.4, and the status summary below).

The invariant:

> After process restart, crash, ambiguous mutation, or lost response, no new
> live mutation may be authorized until authoritative reconciliation establishes
> a safe state for the affected account/order/position.

---

## 1. Verification status of every claim

### Current status (F18-13)

| Question | Answer |
| :--- | :--- |
| Phase 18 status | **CURRENT** — not complete |
| Numbered findings | **F18-01 through F18-45: all CLOSED/PASS** — no known numbered finding is open |
| Authoritative account continuity | **NOT IMPLEMENTED** — the provider contract offers point-in-time account identity only (§6.4.5) |
| Phase 18 completion | **BLOCKED ON PROVIDER CAPABILITY** — CoinDCX provides point-in-time account identity (`/users/info` → `coindcx_id`), but no documented provider API establishes gap-free authoritative account-state continuity through mutation authorization and consumption (§6.4.5) |
| Live authorization readiness | **NOT READY** |
| LIVE-VENUE VERIFIED | **NO** — no Phase 18 behaviour has been exercised against the real CoinDCX venue |
| Why live mutation is unreachable | `currentAccountContinuityCapability()` returns `REST_CURRENT_STATE_OBSERVED`, never `ACCOUNT_CONTINUITY_PROVEN`. Sampled REST current state is informational only: it cannot show that nothing changed at the venue after the final read. So `requireCurrentReconciliation` refuses every normal Phase 17 live mutation (OPEN, ordinary cancel, CLOSE) with `ACCOUNT_CONTINUITY_NOT_PROVEN`, even for a `HEALTHY` account (F18-27/F18-28, §6.4.4). CoinDCX exposes useful point-in-time account identity, but no documented provider primitive proves gap-free account state through mutation authorization and consumption (§6.4.5). This is intentional. Reconciliation-owned orphan cancellation is a separate bounded path that does not pass this barrier and grants no trading authority (§13). |

### Proof categories

The columns below are distinct kinds of evidence. None implies the next.

| Label | Column | What it means | What it does NOT mean |
| :--- | :--- | :--- | :--- |
| STRUCTURALLY VERIFIED | Structurally tested | An architecture/static test over source, import graph, schema, or docs | That the behaviour works at runtime |
| UNIT-VERIFIED | Fixture/fake tested | Exercised in-process with in-memory repositories, fixture evidence, and fake ports | Database behaviour, or venue behaviour |
| REAL-MYSQL VERIFIED | Real-DB tested | Exercised against a disposable real MySQL database over real connections (transactions, locks, unique indexes, rollback), with the venue still faked | Anything about the real venue |
| PROVIDER CONTRACT / DOCUMENTATION EVIDENCE | (prose, §7–§8, §21) | Based on the documented CoinDCX API contract and the limited authenticated Phase 2 read observations recorded in `docs/COINDCX_READ_LAYER.md` | That Phase 18's use of those reads has been verified live |
| LIVE-VENUE VERIFIED | Externally live-verified | An authenticated call made by this Phase 18 behaviour against the real CoinDCX venue | — **no cell is Yes** |
| OPERATIONAL READINESS | (status above) | Safe to enable normal live mutation | — **NOT READY** |

No automated fake, unit, or real-MySQL result in this document is live-venue
proof, and none establishes operational live readiness.

This table is the honest summary. Nothing below it upgrades a claim beyond what
this column says.

| Area | Implemented | Structurally tested | Fixture/fake tested | Real-DB tested | Externally live-verified |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Startup barrier (account-scoped, durable) | Yes | Yes | Yes | **Yes** | n/a |
| Runtime-epoch binding (restart begins blocked) | Yes | Yes | Yes | **Yes** | n/a |
| Durable generation / fencing | Yes | Yes | Yes | **Yes** | n/a |
| Stale-worker commit refusal (every write path) | Yes | Yes | Yes | **Yes** | n/a |
| Evidence provenance + completeness model | Yes | Yes | Yes | **Yes** | **No** |
| Causal-ordering rejection | Yes | Yes | Yes | n/a | **No** |
| Conflicting-duplicate fail-closed | Yes | Yes | Yes | n/a | **No** |
| Ambiguous-create unique-proof resolution | Yes | Yes | Yes | **Yes** | **No** |
| Ambiguous-create multi-candidate refusal | Yes | Yes | Yes | **Yes** | n/a |
| Cancellation-ambiguity recovery | Yes | Yes | Yes | **Yes** | **No** |
| Orphan detection | Yes | Yes | Yes | **Yes** | **No** |
| Orphan cleanup (disabled by default) | Yes | Yes | Yes | **Yes** | **No** |
| Position ownership attribution | Yes | Yes | Yes | **Yes** | **No** |
| `live_position` production writer | Yes | Yes | Yes | **Yes** | **No** |
| Idempotent rerun (no duplicate effect) | Yes | Yes | Yes | **Yes** | n/a |
| Crash-boundary recovery | Yes | Yes | Yes | **Yes** | n/a |
| Durable wire-arm crash recovery (F18-14, §4.3) | Yes | Yes | Yes | **Yes** | n/a |
| Fail-closed fencing with no missing-delegate bypass (F18-15, §16) | Yes | Yes | Yes | n/a | n/a |
| Legacy migration conservative backfill (F18-16, §4.4) | Yes | Yes | n/a | **Yes** | n/a |
| Phase17 real-MySQL fixture parity (F18-17) | Yes | n/a | n/a | **Yes** | n/a |
| Contradictory wire-armed state fails closed (F18-18, §16) | Yes | Yes | Yes | **Yes** | n/a |
| Live mutation barrier integration | Yes | Yes | Yes | **Yes** | **No** |
| Paper/live isolation | Yes | Yes | n/a | n/a | n/a |
| Credential secrecy | Yes | Yes | Yes | **Yes** | n/a |
| Pair genericity | Yes | Yes | Yes | **Yes** | **No** |
| Bracketed repeated-read-agreement check, ABA-honestly-documented (F18-04, §6.2–6.4) | Yes | Yes | Yes | **Yes** | **No** |
| Separability check uses final-read-only provenance, not merged bracket (F18-23, §6.5) | Yes | Yes | Yes | **Yes** | **No** |
| Incomplete-read single-candidate resolution refusal (F18-03, §8) | Yes | Yes | Yes | **Yes** | **No** |
| Missing-leverage exact-match refusal for ambiguous create (F18-08, §8) | Yes | Yes | Yes | **Yes** | **No** |
| Provider-completeness/timestamp assumption audit (F18-09, §7.1/§6.3) | Yes | Yes | n/a | n/a | n/a |
| Known-order advance withheld under incomplete evidence (F18-20, §8.1) | Yes | Yes | Yes | **Yes** | **No** |
| TIF-identity-observability gate for ambiguous create, unconditional (F18-21, §8) | Yes | Yes | Yes | **Yes** | **No** |
| Adapter `maxPages` construction-time validation + zero-page defense (F18-22, §7.2) | Yes | Yes | Yes | n/a | **No** |
| TIF-absence wording corrected to evidence-bounded claim, not absolute (F18-24, §8.2, §6.4.4) | Yes (documented + architecture-pinned) | Yes | n/a | n/a | n/a |
| Durable orphan `CANCEL_AMBIGUOUS` reasserted every generation, independent of current evidence (F18-25, §13.1) | Yes | Yes | Yes | **Yes** | **No** |
| Orphan cancellation durably wire-armed BEFORE the HTTP call (F18-26, §4.3, §13.2) | Yes | Yes | Yes | **Yes** | **No** |
| Account-continuity gate: `requireCurrentReconciliation` never authorizes from REST-only evidence (F18-27, §6.4.4) | Yes | Yes | Yes | **Yes** | **No** |
| Account-continuity capability cannot be caller-forged: no public parameter exists at all (F18-28, §6.4.4) | Yes | Yes | Yes | **Yes** | n/a |
| Sticky orphan-ambiguity finding suppresses the redundant generic orphan finding (F18-29, §13.1) | Yes | n/a | Yes | **Yes** | **No** |
| Durable, audited operator resolution of `CANCEL_AMBIGUOUS`; never live-authorizing (F18-06, §13.3/§13.4) | Yes | Yes | Yes | **Yes** | **No** |
| Orphan cancellation per-run ceiling bounded to a safe integer 1..20; invalid config fails closed (F18-10, §13.5) | Yes | Yes | Yes | n/a (the ceiling matrix and cap proof are unit-level) | **No** |
| Complete reconciliation runs racing on one account: one authoritative history, one economic event, at most one wire cancel (F18-11, §15) | Yes | n/a | n/a | **Yes** | n/a |
| Cross-account isolation under concurrent reconciliation and forged cross-account leases (F18-11, §15) | Yes | n/a | n/a | **Yes** | n/a |
| Operator resolution racing a reconciliation run (F18-11, §13.4) | Yes | n/a | n/a | **Yes** | n/a |
| Run `finding_count` = total findings, `blocking_finding_count` = blocking subset (F18-12, §15) | Yes | n/a | n/a | **Yes** | n/a |
| Accepted migrations frozen; changes only as forward migrations (F18-19, §15.1) | Yes | Yes | n/a | n/a (parity scripts run separately) | n/a |
| Concurrent first claims for two different accounts: a deadlock victim is retried in a fresh transaction, never surfaced (F18-44, CLOSED/PASS, Wave C3.1, §4.5) | Yes (bounded retry, 3 attempts) | n/a | Yes | **Yes** (`[C3.1-1]`, `[C3.1-2]`, `[C3-11c]`) | n/a |

"Externally live-verified" means an authenticated call was made to the real
CoinDCX venue. **No cell in that column is Yes.** The venue-facing evidence
adapter reuses the Phase 2 authenticated read path. That path's documented
contract, plus a limited authenticated live observation recorded by Phase 2
(flat-position nullability, 2026-09-03, `docs/COINDCX_READ_LAYER.md` §9.5), is
PROVIDER CONTRACT / DOCUMENTATION EVIDENCE only. It is not verification of
Phase 18's orders/positions pagination, completeness, or reconciliation
behaviour, and Phase 18 itself has never called the venue. §21 ("Not verified
against the real venue") lists what a real venue would still have to confirm.

---

## 2. Module map

Execution owns the *ports*; the integration layer owns the *adapter* and the
wiring — the identical split Phase 17 froze.

```
src/execution/live/reconciliation/     (no dependency on src/integration/** at all)
  types.ts                  domain vocabulary + the finding taxonomy
  evidence.ts               provenance, conservation, causal ordering, snapshot identity
  ports.ts                  the three narrow ports + durable record shapes
  findings.ts               deterministic finding identity, status resolution
  order-reconciliation.ts   order comparison, ambiguous-create matching, orphan detection
  position-attribution.ts   lineage-derived ownership, exact aggregate reconciliation
  barrier.ts                the startup barrier + runtime-epoch minting
  orphan-policy.ts          disabled-by-default orphan cancellation gate
  gateway-orphan-cancellation.ts  the ONLY orphan-cancel implementation (wraps the P17 port)
  service.ts                the controlled reconciliation root
  repository.ts             Prisma adapter — where the fencing actually lives
  index.ts                  public barrel (inert; reaches no integration module)

src/integration/coindcx/live/
  reconciliation-evidence-adapter.ts   read-only evidence over the Phase 2 read client
  production-runtime.ts                extended: composes reconciliation, gates every normal Phase 17 mutation
```

### 2.1 What Phase 18 deliberately did NOT add

- **No new endpoint.** Order and position reads use `FUTURES_ORDERS` and
  `FUTURES_POSITIONS`, which Phase 2 already established in the frozen
  read-only transport.
- **No new signing site.** The repository still has exactly three files naming
  `X-AUTH-SIGNATURE`, pinned by an architecture test.
- **No second mutation owner.** Orphan cancellation travels the existing
  Phase 17 chain. `GatewayOrphanCancellation` depends on the
  `CoinDcxFuturesOrderGateway` *port*, builds no request, names no endpoint, and
  holds no credential.
- **No change to the Phase 17 state machine.** `LIVE_ORDER_TRANSITIONS` is
  untouched. Phase 18 declares its own separate, explicitly reconciliation-scoped
  relation (`LIVE_RECONCILIATION_TRANSITIONS`) rather than widening the frozen one.

---

## 3. The startup barrier

Every account capable of live trading begins each runtime in a state equivalent
to `RECONCILIATION_REQUIRED`, and stays there until a run of **this** process
commits a HEALTHY verdict.

Five durable states: `RECONCILIATION_REQUIRED`, `RUNNING`, `HEALTHY`,
`UNHEALTHY`, `MANUAL_REVIEW_REQUIRED`.

**An absent `live_reconciliation_state` row reads as `RECONCILIATION_REQUIRED`.**
A database that has never seen an account fails closed rather than defaulting
open, so applying the migration alone cannot enable trading anywhere.

### 3.1 Why this is not an in-memory boolean

The authority is the durable row. The **runtime epoch** is only the *binding*
between that row and the process that proved it:

| Situation | Barrier result |
| :--- | :--- |
| No durable row | `NO_CURRENT_RECONCILIATION` |
| `RUNNING` | `RECONCILIATION_IN_PROGRESS` |
| `UNHEALTHY` | `RECONCILIATION_UNHEALTHY` |
| `MANUAL_REVIEW_REQUIRED` | `MANUAL_REVIEW_REQUIRED` |
| `HEALTHY`, stamped by a **different** epoch | `STALE_RUNTIME_GENERATION` |
| `HEALTHY`, but `healthyGeneration != currentGeneration` | `STALE_RUNTIME_GENERATION` |
| `HEALTHY`, this epoch, current generation, zero blocking findings | **PERMITTED** |

A restart gets a new epoch, so a HEALTHY row left by a previous process no
longer satisfies the barrier — without that row being rewritten, and without the
barrier ever being satisfiable by process-local state alone. Clearing the
process's memory cannot turn the gate *on*; only a committed run can.

The production composition root mints an opaque runtime identity internally.
Callers cannot select its epoch, the runtime has no epoch getter, and cloning or
fabricating a structural object does not reproduce its ECMAScript private slot.
The stored epoch string is therefore a database fence value, not sufficient
authority by itself. Two runtimes composed from the same credentials receive
independent identities and must each complete their own reconciliation.

The last row is deliberately redundant: a `HEALTHY` status carrying blocking
findings is contradictory, and the conservative reading wins.

---

## 4. Generation fencing

Multiple workers must not independently repair the same account. Ownership is a
durable, monotonic generation:

| Mechanism | Enforcement |
| :--- | :--- |
| One owner per generation | `UNIQUE(account_id, generation)` on `live_reconciliation_run` |
| No stale commit, on **any** path | every write re-reads the state row `FOR UPDATE` and compares `current_generation` **and** `current_runtime_epoch` against the lease, inside the same transaction |
| Crash leaves a recoverable state | claiming marks the account `RUNNING` (which the barrier treats as blocked) and withdraws `healthy_generation` immediately |
| A dead run is fenced, not stuck | the next claim marks every still-`RUNNING` run `ABANDONED` |
| No process-local locks | none of the above involves an in-process mutex |

### 4.1 Generation versus external mutation ownership

Generation supersession and external mutation-claim acquisition serialize on
the same account `live_reconciliation_state` row. The OPEN/CLOSE dispatch claim,
the normal cancel claim, and the orphan cancel claim validate an opaque
authority naming the exact account, run, generation, runtime epoch, and state
revision inside the transaction that acquires mutation ownership.

**`claimGeneration` never refuses because an external mutation claim is
outstanding.** An earlier Wave A design did refuse in that case (`LOST` for
any account with a `DISPATCH_RESERVED`/`CANCEL_RESERVED`/`CANCEL_CLAIMED`
row), on the theory that reconciliation should never step on a mutation in
flight. That made a crash between "local reservation taken" and
"reconciliation completes" **permanent** (F18-14, Wave A2 BLOCKER): only a
completed reconciliation can ever clear such a claim, and only a new
generation can run one, so a dead worker's leftover claim bricked the account
forever. §4.3 is the fix.

Phase 17 observation application and reconciled-state repair revalidate the
same opaque generation authority in their economic transaction. Position
ownership materialization and orphan cancellation claim/completion do the same.
A plain DTO containing copied account/generation/epoch fields is not accepted.

### 4.2 Derived HEALTHY only

`completeRun` no longer accepts a caller-selected status. The trusted service
issues an unforgeable completion proof over the exact run, snapshot digest,
generation, and complete finding-digest set. Persistence derives the result
from durable rows under the account lock. `HEALTHY` requires a validated
snapshot, complete order and position reads, no unresolved blocking or
manual-review finding, no ambiguous/outstanding external mutation, and current
run/generation/epoch ownership. Missing evidence and copied or fabricated proof
objects fail closed.

Claiming a generation **immediately nulls `healthy_generation`**. That is what
makes a crash mid-run safe: there is no window in which a stale HEALTHY verdict
remains readable while a newer run is in flight.

The real-MySQL suite proves the stale lease is refused by `completeRun`,
`recordSnapshot`, `persistFindings` and `clearPositionOwnership` — not just by
the completion path — using two independent Prisma connections.

### 4.3 Durable wire-arm crash recovery (Wave A2 / F18-14)

The durable model distinguishes two things that Wave A conflated into one
state (`DISPATCH_RESERVED` / `CANCEL_RESERVED` / orphan `CANCEL_CLAIMED`):

1. **local mutation reservation** — this process has claimed the *right* to
   attempt a wire mutation, but nothing has necessarily been attempted yet;
2. **durable wire-arm** — a SEPARATE, later, independently-fenced transaction
   has committed proof that the wire request MAY be about to leave the
   process, immediately before the HTTP call.

Concretely: `LiveOrder.dispatchWireArmed` / `LiveOrder.cancelWireArmed` /
`LiveOrphanVenueOrder.cancelWireArmed` are `BOOLEAN NOT NULL DEFAULT false`
columns, each flipped exactly once, by `armDispatchWire` / `armCancelWire` /
`armOrphanCancelWire`, which re-validate the caller's reconciliation
authorization against the CURRENT durable generation — identically to every
other fenced write — before flipping it. `LiveExecutionService.dispatch` and
`.cancelDurable` always call the matching arm BEFORE the gateway; no code
path calls a gateway without first committing the arm.

**Why a stale worker can never send.** The arm is fenced exactly like every
other write. If a newer generation has been claimed since the local
reservation was taken, the arm transaction is refused before it commits —
the stale worker's authorization no longer names the current generation —
so it sends zero wire requests (Case A). If the arm DOES commit before a
newer generation is claimed, that commit is itself durable proof a request
may have left the process; a newer generation inherits that proof, never
inference from timing (Case B).

**Why restart no longer deadlocks.** `claimGeneration` places no fence on
outstanding claims at all (§4.1). Every claim a new generation inherits is
classified, at the start of `reconcileAccount`, before any venue evidence is
even read:

| Wire-arm flag | Classification | Recovery |
| :--- | :--- | :--- |
| `false` (never armed) | Case A / C — local-only reservation | Reclaimed with **zero** exchange mutation: `DISPATCH_RESERVED` → `CREATED` (`RECON_DISPATCH_RESERVATION_RECLAIMED`); cancel/orphan-cancel claim → `NONE` (`RECON_CANCEL_RESERVATION_RECLAIMED`) |
| `true` (armed) | Case B / D — wire may have been attempted | Left untouched by the reclaim step; resolved only through the SAME evidence-based pipeline every other advance uses (`resolveAmbiguousCreate` for a create, `reconcileIdentifiedOrder` for a cancel, or `CANCEL_AMBIGUOUS` for an orphan claim) — never a blind resend, and the account stays blocked until evidence (or a human) resolves it |

No process liveness, PID, in-memory heartbeat, or timeout participates in
that decision anywhere — only the durable flag this process itself
committed. `planClaimRecovery` (`order-reconciliation.ts`) is pure and
evidence-independent; the service applies its proposed reclaims through
`commitReconciledState` under the CURRENT generation's genuine `RUNNING`
authority, the same path §8's crash-interrupted-claim resolution already
used. There is no `forceClearReservation()`-style unauthenticated helper:
recovery is capability-controlled and DB-fenced exactly like every other
Phase 18 write.

A `CANCEL_REQUESTED` order whose venue evidence proves it still rests
UNAFFECTED (no fill progress, not cancelled) is resolved by clearing the
cancel claim alone (`CLEAR_CANCEL_CLAIM`) — `order.state` is deliberately
never moved back to `ACKNOWLEDGED` through the observation pipeline, because
the frozen Phase 17 `LIVE_ORDER_TRANSITIONS['CANCEL_REQUESTED']` has no such
path and Wave A2 does not widen it (§18's Phase 17 regression guarantee).

### 4.4 Legacy outstanding claims migrate as possibly-sent, never as unarmed (Wave A3 / F18-16)

The wire-arm columns default to `false`, which is the CORRECT reading for a
row this migration's own backfill did not touch — but it is the WRONG reading
for a row that was already sitting in `DISPATCH_RESERVED` / `CANCEL_RESERVED`
/ orphan `CANCEL_CLAIMED` the instant the migration ran. Before Wave A2
existed, Phase 17 (and pre-Wave-A2 Phase 18 orphan cancellation) followed
"claim the durable reservation, then immediately attempt the wire mutation" —
there was no separate, independently durable arm checkpoint in between, and no
historical column ever recorded whether the wire request left the process for
such a row.

**Absence of proof is not proof of absence.** The migration
(`prisma/migrations/20260921010000_phase18_wave_a2_crash_recovery/migration.sql`)
therefore backfills every pre-existing outstanding claim to `true` — possibly
wire-attempted — immediately after adding the columns:

```sql
UPDATE `live_order` SET `dispatch_wire_armed` = true WHERE `state` = 'DISPATCH_RESERVED';
UPDATE `live_order` SET `cancel_wire_armed` = true WHERE `cancel_state` = 'CANCEL_RESERVED';
UPDATE `live_orphan_venue_order` SET `cancel_wire_armed` = true WHERE `cancel_state` = 'CANCEL_CLAIMED';
```

A row not in one of those three outstanding states is unaffected and correctly
keeps the default `false`: a `CREATED` order was never claimed, a terminal
order has no outstanding claim to misclassify, and an absent cancel/orphan
claim means none is outstanding either.

The practical effect, proven against real MySQL
(`tests/integration/execution/live-reconciliation-persistence.integration.test.ts`,
"Wave A3 §F18-16"): a migrated legacy claim is classified identically to a
genuinely wire-armed Wave A2 claim (§4.3's Case B/D) — Phase 18 crash recovery
NEVER reclaims it as safely unsent, and it is resolved only through
authoritative venue evidence or a human, never a blind resend. This is the
precise distinction from a genuinely NEW, never-armed Wave A2 local
reservation (§4.3's Case A/C), which is still safely reclaimed with zero
exchange mutation.

### 4.5 Bounded retry of the generation claim on a MySQL deadlock (Wave C3.1 / F18-44)

**Defect.** Phase 18 repository transactions run at MySQL's default
REPEATABLE READ. When two DIFFERENT accounts with no runs yet claim their
first generation at the same moment, each `claimGeneration` transaction's
`updateMany({ accountId, status: 'RUNNING' })` finds no row and takes an
exclusive next-key lock on the end of the
`live_reconciliation_run_account_generation_unique` index (the supremum
record). Each transaction's run `INSERT` then waits for an insert-intention
lock in that same range, and InnoDB rolls one back as the deadlock victim
(captured from `SHOW ENGINE INNODB STATUS`). Prisma surfaces this to
application code as `PrismaClientKnownRequestError` with code `P2034`
("Transaction failed due to a write conflict or a deadlock"). The victim's
transaction is rolled back completely: no run row, state still
`RECONCILIATION_REQUIRED` at generation 0, no finding or orphan row, and no
evidence read or wire action, because the claim is the first durable step of
a run. Before C3.1 the error reached the caller, so one account's
reconciliation could fail because an unrelated account reconciled at the same
moment. A standalone reproduction deadlocked 28 of 40 first-claim pairs.

**Remediation.**
- **Boundary:** the WHOLE claim transaction, and only it. The pre-transaction
  state-row upsert is idempotent and stays outside. Every attempt is a fresh
  `$transaction` that re-locks and re-reads the state row and recomputes the
  generation and run id; nothing from a rolled-back attempt is reused.
- **What is retried:** only `PrismaClientKnownRequestError` with code `P2034`
  (`isRetryableTransactionConflict`), matched by class and code, never by
  message text. `P2002` still means another worker won that generation and
  returns `LOST` without retrying; a stale-generation or any other
  `LiveExecutionError`, and every other Prisma or unknown error, propagate
  after one attempt.
- **Budget:** `CLAIM_GENERATION_MAX_ATTEMPTS = 3` (the first attempt plus at
  most two retries). There is no sleep or backoff: the victim has already been
  rolled back, and its retry simply waits on the winner's locks. Each retry is
  logged as a warning. Across 11 real-MySQL suite runs, 88 deadlock victims
  were retried and every one succeeded on its second attempt; none needed a
  third.
- **Exhaustion fails closed** with `LIVE_PERSISTENCE_FAULT` (details: account,
  attempts, `P2034`), keeping the final Prisma error as its `cause`. No run is
  fabricated, the account stays blocked, and `reconcileAccount` stops before
  reading evidence or reaching any wire port.
- **Unchanged:** isolation level (no switch to ReadCommitted), Wave A fencing,
  `LOST` semantics, crash recovery, and every later transaction in a run,
  none of which is retried.

Proof: `tests/unit/execution/live/reconciliation/claim-generation-retry.test.ts`
(error classification, a fresh transaction per attempt that claims from state
re-read in the new transaction, exhaustion, non-retryable errors, `LOST`
unchanged, and no evidence read or wire action after exhaustion) and the real
MySQL cases `[C3.1-1]` (20 concurrent pairs of new accounts, each ending with
exactly one generation-1 run and no partial rows), `[C3.1-2]` (same-account
fencing unchanged), and `[C3-11c]` (complete runs, both accounts now always
complete). At the time of Wave C3.1, F18-44 remained open pending
independent review. **The Wave C3 + C3.1 independent review has since
returned PASS: F18-44 is CLOSED/PASS.**

---

## 5. Authoritative exchange snapshot

Evidence comes from the existing authenticated read client. The production
adapter is permanently bound at composition to the configured credential
account. `reconcileAccount` rejects another account before a generation claim
or provider read; evidence carries the bound identity rather than a caller
label; orphan cleanup and live enablement use that same account.

Every record is
validated at the integration boundary and then re-validated in the domain:

- exact-decimal conservation (`filled = total − remaining − cancelled`, all
  operands mandatory and non-negative, `remaining + cancelled ≤ total`);
- a positive fill must carry a positive cumulative average price, and a zero
  fill must carry none;
- causal ordering: a provider event time after the read window that produced it
  is rejected, as is an order updated before it was created;
- identity: evidence produced for a different account is rejected;
- duplicates: the same venue id twice is fine **only** if the canonicalized
  content is identical; a conflicting duplicate fails closed;
- two distinct venue position identities for one pair fail closed.

Malformed, incomplete, contradictory or identity-mismatched data never produces
a HEALTHY account. Unusable evidence is recorded as a durable blocking finding
rather than thrown past the barrier.

---

## 6. Snapshot consistency — the TOCTOU limitation, stated plainly

**CoinDCX provides no atomic multi-endpoint snapshot.** The orders read and the
positions read happen at two different times and the venue may move between
them. Phase 18 does not hide this, and — as of Wave B (§F18-04) — does not
rely on a lone timestamp comparison to detect it either.

### 6.1 Why the Wave A2 timestamp check was insufficient (F18-04)

`evidenceWindowIsSeparable` (still present, still checked, but no longer the
only gate — see §6.2) compares provider EVENT TIMESTAMPS of records already
present in the evidence against the two read windows. That check is vacuously
satisfied by a genuinely dangerous case it cannot see at all: a brand-new
venue order created after the orders read finished but before the positions
read started, that never touches the position aggregate (a resting limit
order, unfilled). There is no timestamp to compare against, because the order
simply never appears in the (single) orders read in the first place.
`laterObservations` is empty, `every()` passes vacuously, and a Wave A2-only
reconciler would declare the account HEALTHY while an unaccounted-for order
sits on the book.

### 6.2 The bracketed repeated-read-AGREEMENT check (Wave B, corrected Wave B2)

Every reconciliation run reads orders and positions **twice each**, in the
fixed sequence:

```
ordersA -> positionsA -> ordersB -> positionsB
```

and requires **both**:

- `ordersA` and `ordersB` are byte-identical (order-insensitive, full record
  content — not just a timestamp); and
- `positionsA` and `positionsB` are byte-identical, likewise.

**[Wave B2 / F18-04 correction] This is NOT a snapshot-consistency proof, and
the original Wave B text above (still visible in git history) overstated what
it establishes — independent review confirmed this.** The corrected, precise
claim is:

**What this genuinely proves:** the record set CoinDCX reports at the END of
the bracket (`ordersB`/`positionsB`) is identical, field for field, to what it
reported at the START (`ordersA`/`positionsA`). That detects any venue
movement that is STILL VISIBLE in the second read — a new order, a fill, a
cancellation, or a position change that persists — and gives the reconciler
one piece of evidence, confirmed twice, to act on.

**What this does NOT prove: that no venue mutation occurred during the
bracket.** A classic **ABA** sequence — an order or position that appears and
then fully reverts before the second read — is invisible to a content
comparison of only the two endpoints: `ordersA` and `ordersB` are genuinely,
correctly equal, and the check reports "agreement" even though the venue moved
in between. CoinDCX exposes no snapshot revision, no monotonic account event
sequence, and no authoritative replay of the interval, so **no number of
repeated REST reads — two, three, or five — closes this gap.** It is a
structural property of polling a venue with no continuity mechanism, not a bug
in the read count, and more reads do not fix it (they only reduce the
transient-disagreement case, which is a different, genuinely-detectable
scenario — see the ABA test suite in `snapshot-stability.test.ts`).

**Why this remains safe for what Phase 18 actually applies it to.** Every
economic effect this service can produce — ambiguous-create resolution,
known-order advancement, position ownership — is computed from the FINAL
agreed-upon record (`ordersB`/`positionsB`), the current authoritative state,
**never from an intermediate observation**. An ABA event that fully reverts
before the final read cannot cause a WRONG economic effect: there is nothing
left in the evidence this run sees to act on incorrectly. What it CAN cause is
a MISSED one — a transient fill or exposure that nets back to exactly its
prior state leaves no trace for Phase 18 to reconcile. That is a disclosed,
accepted limitation of REST polling with no venue-side event stream, not
something this protocol claims to close, and it existed identically before
Wave B (a single read pair has the SAME blind spot, just without even
detecting the transient-but-not-fully-reverted case).

If the two brackets disagree, the run retries the whole four-read sequence up
to `maxSnapshotAttempts` times (a safe positive integer, implementation-
validated, capped at an implementation-owned ceiling — never caller-supplied
without bound, precisely to avoid an F18-10-style `Infinity` bug in a new
place). Exhausting the budget records a blocking `RECON_EVIDENCE_SNAPSHOT_UNSTABLE`
finding and the run stops **before computing or applying any order, orphan, or
position effect** — a disagreeing pair of reads is never "probably fine"
evidence for a provisional economic mutation (§F18-03's "no provisional
effects in a blocking run" principle applies here too).

The port that supplies evidence (`LiveVenueEvidenceProvider`) reflects this
directly: it exposes separate `readOrders`/`readPositions` methods rather than
one combined read, and callers (only the reconciliation service, in
production) are expected to call each more than once per run.

A clock-domain allowance still exists in exactly one place — comparing a venue
`created_at` against a local submission window for ambiguous-create resolution
— and it is documented as a clock allowance, never an economic tolerance. It
is applied only to an already-economically-unique candidate, so it can never
act as a tie-break, and it is never used to turn two candidates into one
(§6.4).

### 6.3 Provider timestamps: what they are trusted for, and what they are not

- **Allowed without a stronger provider guarantee:** audit metadata,
  diagnostics, the bounded local read-window causality check
  (`assertCausalOrdering`), and the local-clock submission-window tolerance
  described above.
- **NOT allowed, and not relied on:** host/venue clock alignment as proof that
  no mutation occurred, provider `updated_at` monotonicity as a substitute for
  the bracketed re-read, or cross-endpoint timestamp comparability as proof of
  a consistent cut. The stability protocol replaces every place a timestamp
  comparison was standing in for that proof with an actual repeated,
  content-compared read — with the ABA caveat in §6.2 still applying to that
  replacement, honestly.

### 6.4 CURRENT-STATE reconciliation, not HISTORY-CONTINUITY proof

**Precisely what `HEALTHY` means in this system, and what it deliberately does
not claim:**

> `HEALTHY` means the twice-confirmed CURRENT venue state (open orders,
> positions) reconciles exactly against durable local records. It does **not**
> mean every venue-side event since the last reconciliation has been observed,
> and it does not mean historical PnL/fee continuity has been proven.

Phase 18 does not compute, verify, or reconstruct realized PnL or fee history
— that is out of scope for this system entirely, handled (if at all) by other
layers. The THREE economic effects Phase 18 itself can durably apply are:

1. binding an ambiguous create to a proven venue order id (only from a
   COMPLETE, agreed read — §8);
2. advancing a known order's fill/state (only from a COMPLETE, agreed read —
   §F18-20, §7);
3. deriving position ownership shares (only from a COMPLETE, agreed read,
   cross-checked EXACTLY against durable local fill lineage — §10).

Every one of them requires the evidence to be both complete (§7) and
twice-agreed (§6.2) before touching durable state, and every one of them acts
on the FINAL state only. An ABA event that leaves no trace in that final state
cannot make any of the three produce a wrong result — it can only mean Phase
18 never learns the event happened, which is the honestly-disclosed limitation
above, not a new hole this protocol opened.

**This is a considered, bounded design choice, not an oversight:** a stronger
`HISTORY_CONTINUITY_PROVEN` status would require a venue-side mechanism this
system does not have (a snapshot revision, a monotonic event sequence, or an
authoritative replay of the interval) and CoinDCX's verified contract offers
none of the three. Absent that mechanism, Phase 18 chooses to reconcile
CURRENT state precisely rather than refuse to ever reach `HEALTHY` at all —
while keeping every DURABLE ECONOMIC WRITE gated on completeness and
agreement, so the missing continuity proof degrades to "an unobserved event
might exist" rather than "an observed event might be wrong."

### 6.4.1 F18-04 closure: Option A vs Option B, and which one this is

Independent review posed the closure question precisely: *can a fully-reverted
ABA event make `HEALTHY` unsafe for the operations `HEALTHY` unlocks?* Two
designs were considered:

- **Option A — prove current state is always sufficient.** Would require a
  proof, for EVERY operation `HEALTHY` unlocks, that an unobserved-and-reverted
  transient cannot make it unsafe: OPEN idempotence, CLOSE ownership, position
  ownership, no ambiguous outstanding local mutation, no missing local fill
  lineage, admission/risk state, retry semantics. That is a whole-system proof
  spanning Phase 17's admission/idempotence machinery, not something this
  document can respectably assert without redoing that verification.
- **Option B — block whenever local durable state is history-sensitive,
  reconcile current-state-only otherwise.** Requires identifying, from durable
  facts, every local state whose TRUE progression an ABA event could have
  changed, and confirming each one already independently blocks `HEALTHY`.

**Phase 18 implements Option B.** §6.4.2 enumerates what every operation
`HEALTHY` unlocks actually depends on; §6.4.3 is the history-sensitive
predicate and the proof that it is already enforced, structurally, by the
existing per-order/per-position reconciliation pass — not a new gate bolted on
top.

### 6.4.2 What `authorizeCurrentHealthy` actually unlocks, and what each depends on

| Operation | Current open orders | Current aggregate positions | Local durable order lineage | Local fill history | Strategy ownership | Venue-history continuity |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| OPEN (dispatch arm) | — | — | required (admission/idempotence, Phase17) | — | — | **not required** |
| CLOSE | — | required (position exists) | required (ownership) | required (owned quantity) | required | **not required** |
| Normal cancel (cancel arm) | required (order still open) | — | required (exact order id) | — | — | **not required** |
| Dispatch/cancel wire-arm | — | — | required (current revision, current state) | — | — | **not required** |
| Final state commits | — | — | required (revision-guarded) | — | — | **not required** |

Every row's "required" column is satisfied from **current, durable, local**
facts Phase17 already re-validates transactionally at the moment of use
(revision guards, sealed intent digests, admission consumption) — none of them
is satisfied by, or depends on, `HEALTHY` having proven anything about venue
history BETWEEN reconciliation runs. `HEALTHY` is the STARTUP/RESTART gate
(§3): it establishes that the account's CURRENT state is safe to start
mutating from; it is not re-consulted mid-mutation, and every mutation's own
transaction re-proves its own preconditions independently. This is why no row
in the table needs venue-history continuity: the continuity Option A would
have had to prove is never actually load-bearing for any of these operations
in the first place, because Phase17's OWN transactional guards are what
protect them, not `HEALTHY`'s historical completeness.

### 6.4.3 The history-sensitive predicate

Rather than a new, separately-maintained flag, the predicate IS the existing
per-order/per-position reconciliation pass, because every state below is
already derived from durable facts and already produces its own blocking
finding through a mechanism this document has already described:

| Durable fact | Mechanism that already blocks it | Finding |
| :--- | :--- | :--- |
| `SUBMISSION_AMBIGUOUS` | `resolveAmbiguousCreate` (unconditionally blocked, §8/F18-21) | `RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE` (or `..._PROVEN_ABSENT`/`..._MULTIPLE_CANDIDATES`/`..._UNRESOLVED`) |
| `DISPATCH_RESERVED` + `dispatchWireArmed` | same path (`requiresAmbiguousCreateResolution`) | same as above |
| `CANCEL_RESERVED`/`CANCEL_AMBIGUOUS` on a known order | `reconcileIdentifiedOrder`; clears ONLY on a complete, proven venue view (§F18-14) | `RECON_CANCEL_RESOLVED_FROM_VENUE` (clears) or stays outstanding |
| Orphan `CANCEL_AMBIGUOUS` | `#recoverOrphanCancelClaims`/orphan claim path — NEVER auto-clears (§9) | `RECON_ORPHAN_CANCEL_AMBIGUOUS`, permanent until an operator resolves it |
| Local active order absent/contradicted vs. venue | `reconcileIdentifiedOrder` | `RECON_ORDER_ABSENT_FROM_VENUE` / `..._STATE_CONFLICT` / `..._ECONOMICS_CONFLICT` / `..._FILL_REGRESSION` |
| Position ownership discrepancy | `reconcilePosition` (§10) | `RECON_POSITION_*_MISMATCH` / `..._CONFLICT` / `..._UNATTRIBUTED_EXPOSURE` |
| Any blocking finding, generally | `resolveAccountStatus` | `UNHEALTHY` or `MANUAL_REVIEW_REQUIRED` |

An account with **none** of the left column present has nothing for an
unobserved-and-reverted transient to have corrupted: no order lineage depends
on it, no ownership claim depends on it, no outstanding local reservation
could have silently become a wire request. For such an account, current-state
reconciliation (§6.4) is sufficient — proven by there being nothing left
un-checked, not by assuming the ABA gap doesn't matter.

`tests/unit/execution/live/reconciliation/snapshot-stability.test.ts` proves
both halves directly, holding the FINAL REST-visible endpoint pattern
IDENTICAL between the two cases and varying only local durable state:

- **ABA clean-account:** zero history-sensitive local state, identical
  ABA-blind endpoint pattern (both bracketed reads empty/flat) → `HEALTHY`.
- **ABA history-sensitive account:** the exact same endpoint pattern, but a
  local `SUBMISSION_AMBIGUOUS` order → `HEALTHY` forbidden, because the
  existing ambiguous-create gate (now unconditional, §F18-21) blocks it
  regardless of how clean the venue looks.

Real-MySQL equivalents (`[B3-2]`, `[B3-3]`, `[B3-4]`) prove the same pair
against a genuine database, including idempotence and the absence of any
stale ownership/`live_position` effect.

**[Wave B4] What §6.4.1–6.4.3 proved, and what it did NOT prove.** Independent
review confirmed the Option B reasoning above answers exactly the question it
was posed: a fully-reverted ABA event that happened BEFORE or DURING this
run's bracketed reads cannot make `HEALTHY` unsafe, because every durable
state an ABA event could have corrupted already, independently, blocks
`HEALTHY`. That conclusion still holds and is unchanged by this wave. F18-27
is a **different, narrower, and separate** question: not "did something
change and revert during this run's reads," but "could something new appear
in the window AFTER this run's LAST read and BEFORE the authorization this
run's result grants is actually used." No row in §6.4.2's table, and no entry
in §6.4.3's predicate, protects against that — they were never designed to,
because Option B's whole argument rests on Phase17's OWN transactional guards
re-validating CURRENT state "at the moment of use," and F18-27's finding is
precisely that CURRENT state, as REST alone can observe it, is not the same
thing as current state at the moment authorization is actually exercised.
§6.4.4 below is Wave B4's answer to that separate question, and it is why
F18-04's Wave B3 closure is superseded rather than reaffirmed: a
current-account boundary — even a perfectly argued one, as §6.4.1–6.4.3 is —
is not by itself sufficient to authorize a live mutation once this second gap
is accounted for.

### 6.4.4 F18-27: three evidence levels, and why only the strongest may authorize a normal mutation

**The confirmed exploit, restated precisely.** The bracketed protocol's last
read of each kind is `ordersB` then `positionsB` (§6.2). Nothing after
`positionsB` ever reads orders again. A brand-new active venue order created
strictly after `ordersB`'s read — before `positionsB`, between `positionsB`
and `completeRun`, or between `completeRun` and the moment a caller actually
uses the resulting authorization — leaves **zero trace** in this run's
evidence. `positionsB` cannot see it (a resting order with no fill touches no
position aggregate). No subsequent read within the SAME run exists to catch
it. And critically: **adding one does not close the gap, it only relocates
it** — an `ordersC` read would face the identical problem for anything created
after `ordersC`. This is not a bug in the bracket's implementation; it is a
structural property of any finite sequence of REST reads.

**The decisive fact that makes this un-ignorable:** the raced case and the
genuinely clean case produce **byte-identical** evidence. There is no flag,
timestamp, or heuristic reconciliation could check to tell them apart from
inside a single run — by definition, if the new order were visible to this
run in any way, it would already be handled by the ordinary orphan-detection
path (§13). A policy that "usually" catches this by coincidence is not a
policy; the only honest options are to prove continuity through that window
or to refuse to authorize on the strength of REST evidence alone.

**Three evidence levels, named explicitly so Level 2 can never be mistaken for Level 3:**

| Level | Name | What it establishes | What it does NOT establish |
| :--- | :--- | :--- | :--- |
| 1 | Internally valid observation | One provider response, taken alone, passed schema validation, conservation arithmetic, and duplicate/causality checks (§5, §13–§15). | Nothing about any OTHER read, or about time. |
| 2 | `REST_CURRENT_STATE_OBSERVED` | Repeated authoritative reads AGREE at the exact points they were sampled (§6.2's bracketed protocol). This is what `HEALTHY` has always meant (§6.4) and still means — real, useful, honestly-scoped information. | Anything about the interval between samples, or anything after the LAST sample. Cannot rule out a new order created after `ordersB`. |
| 3 | `ACCOUNT_CONTINUITY_PROVEN` | An authoritative, gap-detecting mechanism (a provider-issued snapshot revision, a monotonic account event sequence, or an authoritative replay of the interval) proves no venue-side order or position mutation happened through the boundary where this result is used to authorize a mutation. | — |

**Only Level 3 may authorize a normal Phase 17 live mutation** (OPEN, ordinary
cancel, CLOSE). Reconciliation-owned orphan cancellation (§13) does not
consult this level at all: it is a separate, bounded remediation path, not
trading authority, and running it proves nothing about continuity. Level 2 remains a legitimate,
reported account STATUS (`HEALTHY`/`UNHEALTHY`/`MANUAL_REVIEW_REQUIRED` are
unchanged, and `HEALTHY` still means exactly what §6.4 says); it is simply no
longer, by itself, sufficient to unlock `OPEN`/`CLOSE`/cancel. Code:
`LiveAccountContinuityCapability` (`src/execution/live/reconciliation/barrier.ts`)
names exactly these two reachable values —
`'REST_CURRENT_STATE_OBSERVED'` and `'ACCOUNT_CONTINUITY_PROVEN'` — Level 1 is
implicit (every evidence object that exists has already passed it, or the run
would have failed with `RECON_EVIDENCE_INCOMPLETE`/`_CAUSALITY_VIOLATION`/etc.
before reaching this question at all).

**Provider-capability inventory (§F18-27 required audit, performed before any
code was written).** This repository was searched, not assumed, for an
existing authoritative continuity primitive:

- **REST layer** (`docs/COINDCX_READ_LAYER.md`): the 9 documented endpoints
  page by `page`/`size`/`from_date`/`to_date` only. No sequence, cursor, or
  revision field of any kind, anywhere in the documented contract.
- **Private WebSocket** (`src/integration/coindcx/websocket/private-stream.ts`,
  Phase 4): a genuine, implemented, authenticated account-event stream
  EXISTS. Its own doc comment states plainly: *"Private events are change
  notifications and reconciliation barriers, NOT authoritative truth"* and
  *"Emits `PRIVATE_RECONCILIATION_REQUIRED` on reconnect"* — i.e. even its own
  author does not claim it is gap-free, and a reconnect is explicitly handled
  by falling BACK to REST reconciliation, not by resuming a sequence. It is
  also, separately, **not wired into any live execution or reconciliation
  path today** — grep confirms its only production-adjacent references are
  test files and one connectivity smoke-test evidence artifact
  (`docs/evidence/PHASE4_PRIVATE_WS_SMOKE_2026-09-04.md`, which itself
  recorded zero private events observed).
- **Everywhere `sequence`/`cursor`/`revision` appears in the CoinDCX
  integration folder**, it is a LOCAL, self-assigned counter (`#localSequence`
  in both websocket clients, for the client's own envelope ordering) or the
  LOCAL durable optimistic-concurrency `revision` column this repository
  already owns — never a value CoinDCX itself issues or guarantees continuity
  over.

**Conclusion: no authoritative account-continuity primitive exists in this
codebase today.** `Level 3` (`ACCOUNT_CONTINUITY_PROVEN`) is therefore
UNREACHABLE from the current CoinDCX integration, by honest construction, not
by an arbitrary refusal. `currentAccountContinuityCapability()`
(`barrier.ts`) is the single, exclusively-used source of this fact for
`requireCurrentReconciliation` — it takes no argument, reads no per-request
state, and returns the literal `'REST_CURRENT_STATE_OBSERVED'`; nothing else
in this codebase, including no test-only backdoor reachable from production
composition, can mint `'ACCOUNT_CONTINUITY_PROVEN'` for a genuine mutation
attempt (§F18-27: "do not create a fake `continuityVerified: true`"). The
consequence, stated as plainly as the box at the top of this document does:

> **No REST-only reconciliation result may authorize a normal Phase 17 live
> mutation (OPEN, ordinary cancel, CLOSE), ever, in this codebase as it exists
> today.** This is not a temporary bug; it is the
> honest conclusion of the F18-27 audit, and it will remain true until a
> genuinely authoritative continuity mechanism is built, verified, and wired
> in. That work is explicitly NOT attempted in this wave: §14 of the Wave B4
> task forbids inventing provider guarantees, and no such mechanism currently
> exists to wire in.

**F18-28 (Wave B5): closing the one caller-forgeable gap in that enforcement.**
Wave B4 first shipped `requireCurrentReconciliation` with a public 5th
parameter — `continuityCapability: LiveAccountContinuityCapability =
currentAccountContinuityCapability()` — reasoning that a genuine future
continuity adapter might need an explicit injection point. Independent review
correctly identified this as a forgery hole: the DEFAULT was honest, but
nothing in the type system or the runtime stopped ANY caller from passing the
literal string `'ACCOUNT_CONTINUITY_PROVEN'` positionally and receiving a real
authorization back, with zero actual continuity proof behind it. No production
call site ever did this — `production-runtime.ts`'s `#requireReconciled` is
the only caller and always used the default — but "nothing does today" is a
weaker property than "nothing can," and this document's own "no test-only
backdoor... can mint `'ACCOUNT_CONTINUITY_PROVEN'`" claim (above) was not
actually true until this fix. **The fix removes the parameter entirely, rather
than replacing it with a stronger unforgeable token type**: `requireCurrentReconciliation`
now has exactly 4 parameters, and calls `currentAccountContinuityCapability()`
itself, reading no caller-supplied value of any kind. This was a deliberate
choice between two designs the review explicitly sanctioned — an opaque,
class-based, unforgeable proof object (the pattern `LiveRuntimeIdentity` already
uses elsewhere in this file: a module-private issuer, no public constructor,
frozen state) versus removing the input surface altogether — and the smaller
design was chosen because no production path needs to pass anything today, so
there is nothing to preserve; the day a genuine continuity-proving adapter
exists, `currentAccountContinuityCapability` (and only that function) changes
to derive its answer from that adapter, and this call site does not change at
all. Verified with a forgery matrix (`evidence-and-barrier.test.ts`'s
`P18 Wave B4 §F18-27 the account-continuity gate` describe block, and the
equivalent real-database test `[B5-2]` in
`live-reconciliation-persistence.integration.test.ts`) that attempts the
literal string, plain objects, `Object.create`/prototype-chain constructions,
`Symbol()`/`Symbol.for()`, a boxed `String`, `true`, `null`, and `undefined` as
a raw 5th positional argument (via `as never`/`as unknown` to bypass the
compiler, since a well-typed call site is now rejected by TypeScript itself —
`Expected 4 arguments, but got 5`) — every attempt is silently ignored and
produces the identical `ACCOUNT_CONTINUITY_NOT_PROVEN` refusal as calling with
no 5th argument at all, including against a REAL database-minted, genuinely
fenced HEALTHY authorization (`[B5-2]`), not merely a fake repository stub.

**Where the gate actually lives, and why not lower.** The gate is enforced in
exactly one place: `requireCurrentReconciliation`
(`src/execution/live/reconciliation/barrier.ts`) — the same function every
production live mutation already passed through before this wave
(`production-runtime.ts`'s `#requireReconciled`, the sole caller). It is
deliberately NOT folded into `evaluateReconciliationBarrier` (the pure
fencing/epoch/generation decision that function reuses) or into
`authorizeCurrentHealthy` (the repository method that MINTS a `'HEALTHY'`-mode
authorization object): both of those are also used, via `claimGeneration`'s
`'RUNNING'`-mode authorization, to fence reconciliation's OWN mid-run writes
— an entirely separate concern F18-27 has nothing to do with — and Wave
A/A2/A3's crash-recovery and generation-fencing proofs need a genuine
`'HEALTHY'`-mode object to exercise those (F18-27-orthogonal) properties
against. Placing the gate at the single production choke point instead means:
one authorization-granting decision, one place it can ever be satisfied
(never, today), and zero risk of the fencing/minting logic silently
regressing to "permit anyway" through some other code path.

**The complete-to-mutation race, and the standing threat-model assumption
this leaves.** Even Level 3, if it existed, would only prove continuity
through the moment reconciliation completes — not forever after. Two mutation
authorities are already in play here and must not be confused: Phase 18's
generation fencing (§4) already protects against ANOTHER RECONCILIATION
WORKER of this same system racing a mutation; it says nothing about an
EXTERNAL or MANUAL mutation on the CoinDCX account (a human trading through
the CoinDCX UI directly, a second unrelated system sharing the account, or any
out-of-band API call this codebase did not make) occurring after HEALTHY is
granted and before the next reconciliation run. This system's threat model
has always implicitly assumed — and this section now makes that assumption
EXPLICIT rather than silent — that **no concurrent external/manual mutation of
a live-trading account is supported** while this system is authorizing
mutations against it. If that assumption is ever false in a real deployment,
no one-time reconciliation snapshot, REST-only or continuity-proven, can
protect against it indefinitely; only an ACTIVE, continuously-consumed
continuity mechanism (kept live while trading is enabled, not merely checked
once at startup) could, and none exists here. This is recorded as an open
requirement, not fabricated as a guarantee.

**Consequence for F18-04.** Because Level 3 is unreachable, and only Level 3
may authorize a normal mutation, F18-04's Wave B3 "Option B, current-state
reconciliation is sufficient" closure is **superseded, not reaffirmed**: it
correctly proved current-state-only reconciliation is sufficient for
computing an honest STATUS (§6.4.1–6.4.3, unchanged), but it did not, and
could not, address whether that status may authorize a mutation — a question
F18-27 answers separately, and negatively, for REST-only evidence. F18-04
therefore remains open at the authorization layer even though its
status-layer argument stands.

### 6.4.5 Authoritative account continuity: provider-contract research status

A completed review of the documented CoinDCX provider contract, against the
three things authoritative continuity would need:

| Level | Question | Status |
| :--- | :--- | :--- |
| A — account identity | Which provider account do these credentials act on? | **Supported for point-in-time attestation only.** Authenticated `/users/info` returns the provider account id (`coindcx_id`) at the moment it is called. |
| B — credential binding | Is this the same provider credential generation/session throughout? | **Not provider-proven.** No provider credential-generation or session identity is documented. A locally computed credential fingerprint is not provider authority. |
| C — state continuity | Did no venue-side order or position change happen through the boundary where authorization is used? | **Not proven.** No documented provider primitive (snapshot revision, monotonic account event sequence, or authoritative replay) proves gap-free account state through mutation authorization and consumption. |

**Conclusion: partial primitives exist, but full authoritative continuity
cannot be proven from the provider contract today.** `/users/info` does not
solve continuity: a point-in-time account id says nothing about what happened
between reads. Accordingly:

- **Phase 18: CURRENT.** Continuity remains Phase 18's open item; it is not
  moved to a later phase. **Phase 18 completion: BLOCKED ON PROVIDER
  CAPABILITY**, even though every numbered finding (F18-01 through F18-45) is
  CLOSED/PASS.
- **Authoritative account continuity: NOT IMPLEMENTED.**
  `currentAccountContinuityCapability()` still returns
  `REST_CURRENT_STATE_OBSERVED`, and `requireCurrentReconciliation` still
  refuses every normal Phase 17 live mutation with
  `ACCOUNT_CONTINUITY_NOT_PROVEN`.
- **Live authorization readiness: NOT READY. LIVE-VENUE VERIFIED: NO.**
- Level A (account identity) is now used as a fail-closed **guard** — see
  §6.4.6. It adds no proof field, no continuity enum member, and no
  authorization path: an account-identity success can only let a
  reconciliation run continue to its ordinary checks; it can never make one
  HEALTHY by itself, and it never changes the continuity capability.

### 6.4.6 Provider-confirmed identity facts and what they are used for

CoinDCX support has confirmed:

1. `coindcx_id` is a **permanent trading-account identifier**. It is
   unchanged across API-key rotation, and every subaccount has a different
   one.
2. There is **no** authenticated API-key unique id, generation/version,
   creation timestamp, or credential/session-generation identifier.
3. Futures create supports `client_order_id` (maximum 36 characters). It is
   idempotent: a second create with the same id fails with an error
   code/reason. The exact duplicate code is **not yet confirmed**.

Previously established limitations are unchanged: no account-wide monotonic
sequence, missed private events are dropped (not replayed), no common account
snapshot/revision/watermark, no HFT API. Level B stays unavailable (fact 2),
and Level C stays not proven.

**What was implemented (and what was deliberately not):**

- **Account identity guard.** Live enablement now requires
  `COINDCX_EXPECTED_ACCOUNT_FINGERPRINT`: the lowercase SHA-256 hex of the
  expected `coindcx_id` (the same digest the read-only provider probe
  reports). A missing or malformed value keeps live execution DISABLED
  (`MISSING_ACCOUNT_IDENTITY_BINDING` / `MALFORMED_ACCOUNT_IDENTITY_BINDING`).
  Every reconciliation run — at startup and on every later run that
  re-establishes live authorization — reads `/users/info` through the existing
  Phase 2 read path, reduces `coindcx_id` to that fingerprint at the adapter,
  and compares it BEFORE any durable read, crash recovery, evidence read,
  effect, or orphan cancellation. A mismatch (for example another
  subaccount) completes the run as `MANUAL_REVIEW_REQUIRED`
  (`RECON_ACCOUNT_IDENTITY_MISMATCH`). A missing, empty, multi-record, or
  unreadable identity completes it blocked (`RECON_ACCOUNT_IDENTITY_UNVERIFIED`).
  The raw identifier is never logged, persisted, or placed in findings; only
  12-character fingerprint prefixes appear in a mismatch finding.
- **What identity success means.** `ACCOUNT_IDENTITY_VERIFIED` carries
  `provesAccountContinuity: false`, `provesCurrentReconciliation: false`,
  `provesReconnectContinuity: false`, and `provesCredentialGeneration: false`
  as literals. A rotated API key on the same account verifies identically, by
  design. `currentAccountContinuityCapability()` is untouched and still
  returns `REST_CURRENT_STATE_OBSERVED`.
- **`client_order_id`.** It is now sent on every create and used to resolve
  ambiguous creates by exact match (§8.0). An exact match establishes ORDER
  identity only.
- **Not implemented:** any API-key generation or credential-session identity
  (it does not exist), any continuity proof, and any change to the barrier.

### 6.5 F18-23: merged bracket envelopes must never be fed to the separability check

**Confirmed production-blocking regression, now fixed.** The F18-04 bracketed
protocol (§6.2) reads each endpoint twice and MERGES each kind's two
provenance windows into one wide envelope spanning the whole bracket
(`[ordersA.start, ordersB.end]` for orders, `[positionsA.start,
positionsB.end]` for positions) for completeness accounting. Because the four
reads interleave (`ordersA -> positionsA -> ordersB -> positionsB`), those
merged envelopes overlap BY CONSTRUCTION under any real network latency:
`positionsA` necessarily starts before the merged orders envelope's own end
(`ordersB`'s completion). The separability check (`evidenceWindowIsSeparable`,
§13) was being fed those merged envelopes, so a perfectly clean, fully stable
account — empty venue orders, flat positions, no local unresolved state — was
reported non-separable on essentially every real call and blocked with
`RECON_EVIDENCE_CAUSALITY_VIOLATION`, making production `HEALTHY` practically
unreachable. Every prior test used a frozen (`FixedClock`, never advancing)
clock, under which every read stamps the identical instant and the bug is
invisible — it required a test clock that genuinely advances between calls to
surface.

**The fix is entirely at the call site**, not in `evidenceWindowIsSeparable`
itself, which is unchanged: the reconciliation service now passes the
UNMERGED provenance of the LAST read of each kind — `ordersB.provenance` and
`positionsB.provenance` — to the separability check, instead of the merged
whole-bracket envelopes. Those two are genuinely, structurally sequential (the
same process, the same clock: `ordersB` is fully awaited before `positionsB`
begins), so they do not overlap by construction, and the check's ORIGINAL
invariant — no observation in the later read postdates the boundary between
them — is exactly what it always was designed to verify, now evaluated
against reads that can actually satisfy it.

**This is not a weakening.** A genuinely late-arriving provider observation —
one that postdates `ordersB`'s or `positionsB`'s own read window — still fails
the check and still blocks; `tests/unit/execution/live/reconciliation/snapshot-stability.test.ts`
proves this explicitly with a position observation timed just past the
boundary. What changed is WHICH two windows are asked the separability
question, not what answer counts as safe. It also authorizes no new
cross-clock reasoning: both `ordersB` and `positionsB` are timestamped by the
same local clock in the same process, exactly as the original single-read
design assumed.

The bracket's earlier reads (`ordersA`, `positionsA`) are not wasted: the
stability comparison (§6.2) already proved `ordersA == ordersB` and
`positionsA == positionsB` in CONTENT before the separability check is ever
reached, so re-checking timing against the wider bracket would have been
redundant even where it was not actively wrong.

---

## 7. Pagination and completeness

`provenance.complete` is the **only** thing that licenses the statement "this
order does not exist at the venue".

- Orders are read across **both** sides (the contract requires an explicit
  `side`), over all pages, requesting every documented status — including
  terminal ones, because an order absent from an "open only" filter has not been
  proven absent from the venue.
- Only an empty page proves exhaustion. A short non-empty page is **not**
  treated as terminal; the futures contract does not establish that it is.
- A fixed 100-page guard bounds the scan. Reaching it sets `complete: false`
  with a named reason — never `NOT_FOUND`.
- Any provider or validation failure sets `complete: false`. It is never an
  empty result.
- Duplicate venue ids across pages are content-checked; conflicting duplicates
  fail closed.

Incomplete history is never described as proof that an order never existed.

### 7.1 Wave B (§F18-09): what provider history completeness does and does not license

`provenance.complete` proves only that pagination for THIS read reached an
empty page. It is not, and is not treated as, a contractual guarantee about
the venue's history retention window, about pagination staying stable across
concurrent mutation, or about the absence of undocumented truncation. Phase 18
uses it exclusively as a LOCAL, per-read completeness signal that gates
whether absence-from-this-read may be treated as absence-from-the-venue —
never as a claim that the read proves the venue's entire lifetime history.
Ambiguous-create resolution and identified-order reconciliation both already
route every absence decision through this flag rather than inferring anything
from silence; Wave B changes nothing about that rule, only closes the one gap
where a single visible candidate skipped it entirely (§8).

### 7.2 Wave B2 (§F18-22): `maxPages` is validated, and zero pages can never read as complete

Confirmed exploit: `maxPages = 0` (or `NaN`, negative, fractional, `Infinity`,
or an absurd caller-supplied value) made the adapter's page-loop condition
`page <= maxPages` false on its very first check. The loop body never ran,
zero provider requests were made, `pagesRead` stayed `0`, and the adapter
reported `complete: true` anyway — an authoritative-looking empty result that
never actually asked the venue anything.

Two independent fixes:

1. **Construction-time validation.** `maxPages` must be a safe, positive
   integer no larger than an implementation-owned ceiling
   (`COINDCX_RECONCILIATION_MAX_PAGES_CEILING`, currently 2,000). Anything
   else — `0`, negative, `NaN`, `Infinity`, a fraction, or a value above the
   ceiling — throws at adapter construction, before any provider call.
2. **Defense in depth.** Even if that guard were ever bypassed, completeness
   now additionally requires `pagesRead > 0` — a genuine traversal-termination
   condition can only be "reached" after at least one real page request.

`RECON_EVIDENCE_INCOMPLETE`-style blocking is the only way an adapter with a
misconfigured page budget can now behave: it can never silently fabricate an
empty-but-authoritative result.

---

## 8. Ambiguous create resolution

### 8.0 Exact `client_order_id` resolution (provider-confirmed; supersedes the old local-only rule)

Earlier text in this section said Phase 17's client order id was **LOCAL
ONLY** and not sent to the venue. That was accurate when written and is
**corrected** here: the id is now sent as CoinDCX's provider-confirmed
idempotent `client_order_id` (§6.4.6), and List Orders returns it.

`resolveAmbiguousCreate` now runs two strictly ordered steps:

1. **Exact `client_order_id` match** (`matchVenueOrdersByClientOrderId`):
   strict string equality, no trim, no case folding. A venue `null` (for
   example an order created before the id was sent) never matches.
   - **Two or more** distinct venue orders carry the id →
     `RECON_CLIENT_ORDER_ID_DUPLICATE_AT_VENUE` (manual review; nothing
     adopted).
   - **Exactly one** → `resolveAmbiguousCreateByClientOrderId`. It is adopted
     only if the provider read is COMPLETE, no other local order claims it,
     its stated economics do not contradict the intent, it was created inside
     the persisted submission window, and its status projects onto a
     permitted state. Otherwise the result is `RECON_AMBIGUOUS_CREATE_UNRESOLVED`
     or `RECON_AMBIGUOUS_CREATE_CLIENT_ORDER_ID_CONFLICT`, with no effect.
     Success is `RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID`, whose
     evidence states `establishes: ORDER_IDENTITY_ONLY`.
   - **Zero** → step 2.
2. **No match** → the unchanged time-in-force identity gate
   (`RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE`). Economic matching alone
   still never establishes identity.

**Why step 1 may pass where the TIF gate refuses:** the gate exists because
economic matching cannot prove WHICH venue order a submission created, and
time-in-force is one of the bindings it cannot observe. A venue order carrying
this intent's exact 128-bit content-derived id could only have been created by
this system's own create request, which carried this intent's exact TIF. So
the id — not economics — is the identity proof, and economics become a
consistency check. The TIF gate itself is unchanged.

**A duplicate-id create failure alone never resolves anything.** It is a typed
`DUPLICATE_CLIENT_ORDER_ID` outcome that leaves the order `SUBMISSION_AMBIGUOUS`
(fault `LIVE_SUBMISSION_DUPLICATE_CLIENT_ORDER_ID`). Only step 1 with exactly
one match can bind it. Because the exact provider code is not confirmed,
`COINDCX_DUPLICATE_CLIENT_ORDER_ID_SIGNAL` is `null`, so no response is
classified as a duplicate today. [PROVIDER-IDEMP-01] Because an unconfirmed
duplicate rejection may be any 4xx, every create HTTP failure other than the
exact configured duplicate status + code — every 4xx including 429, every 5xx,
and any malformed error body — is `AMBIGUOUS` (`SUBMISSION_AMBIGUOUS`, never
resent), never terminal `REJECTED`. No provider-verified terminal
create-rejection code exists in this repository, so none is whitelisted, and
the message text is never read. Cancel classification is unchanged.

An order already bound by exchange id whose venue record carries a different
non-null `client_order_id` is `RECON_ORDER_CLIENT_ORDER_ID_CONFLICT` (manual
review).

None of this touches account continuity: the barrier still refuses every
normal mutation with `ACCOUNT_CONTINUITY_NOT_PROVEN`.

### Economic matching (applies only when no `client_order_id` matched)

An ambiguous create resolves only when authoritative evidence contains
**exactly one** venue order matching every immutable economic binding this
repository can actually prove:

**Bound:** pair, side, ordered quantity, wire order type, limit price, and
leverage when *both* sides state it for a general economics comparison
(`matchesImmutableEconomics`, used for identified-order conflict checks, where
identity is already proven by a durable exchange order id and a provider that
omits leverage has not contradicted an already-established fact).

**Wave B (§F18-08): identity establishment uses a STRICTER rule.**
`resolveAmbiguousCreate` — where identity is exactly what is being proven, not
merely checked — uses `matchesProvenEconomicsForAmbiguousCreate` instead: a
local order with a known leverage is **not** an exact match for a venue
candidate that reports no leverage at all. Absence is a fact about the
provider response, not a fact about the venue order's actual leverage, and it
must never substitute for a proof of equality when a durable identity claim is
about to be minted. If the venue contract never supplies leverage for a given
response shape, automatic ambiguous-create resolution for a leveraged intent
against that shape is simply impossible — the order stays reconciliation-
required (typically `..._PROVEN_ABSENT`, since the only candidate that failed
to match economically also cannot supply a second exact match) until an
operator resolves it. That is the conservative, intended outcome, not a bug.

**[Wave B3 / F18-21, superseding the Wave B2 text below] Time in force:
automatic ambiguous-create resolution is now UNCONDITIONALLY blocked for
EVERY local TIF value, with no exemption.** [Wave B4 / F18-24 wording
correction] No authoritative time-in-force field is documented in the
verified current futures List Orders response contract available to this
project, for any record. That is the precise, evidence-bounded claim: this
project has verified and documented the absence of a TIF field in every
response shape it has captured and reviewed. It is not a claim that CoinDCX's
API is structurally incapable of ever returning one under any circumstance —
this project has no way to prove a universal negative about an external
provider it does not control, and does not claim to.

Wave B2 exempted `UNSPECIFIED`/`GOOD_TILL_CANCEL` on the theory that CoinDCX's
own documentation states GTC is the applied default when `time_in_force` is
omitted, making the two indistinguishable at the venue. **Independent review
rejected that reasoning for Wave B3**: this project holds no AUTHORITATIVE,
independently-verified proof of that default strong enough to found a durable
identity-binding decision on — "the documentation says so" is a weaker
evidentiary bar than this repository applies everywhere else (§14: absence is
never proof, and an unverified provider default is not proof either). The
corrected rule has **no exemption**: this project holds no verified proof of
time-in-force for ANY local value, so none of them may license an automatic
identity claim —

```
GOOD_TILL_CANCEL       => unresolved (unconditionally)
UNSPECIFIED             => unresolved (unconditionally)
IMMEDIATE_OR_CANCEL     => unresolved (unconditionally)
FILL_OR_KILL            => unresolved (unconditionally)
POST_ONLY               => unresolved (unconditionally)
```

**The gate: an explicit identity-observability check, checked BEFORE any
candidate is even considered**, so the refusal is reported with its own clear
code — `RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE` — rather than falling
through to "zero candidates" or "multiple candidates," which would misleadingly
suggest more reads or different evidence might help. TIF unobservability is a
limitation of the **verified, documented** provider contract this project has
today, not evidence this particular run happened to lack: no amount of
re-reading ever produces a TIF field the currently-verified response shape
does not carry. [Wave B4 / F18-24] This is deliberately phrased as a
statement about what this project has verified, not as a claim that CoinDCX's
API can never, under any undocumented circumstance, return such a field —
this project makes no claim about behavior it has not observed and cannot
prove a negative about. Resolution stays a manual-review operator decision,
indefinitely, absent a genuinely authoritative provider mechanism, newly
verified and documented, that this project does not currently have (§F18-24).

**Practical consequence, stated plainly:** automatic ambiguous-create
resolution is, as of Wave B3, unreachable in production for every order this
system can currently submit. The candidate-selection logic that decides
"exactly one proven candidate" (leverage-provability, submission window,
multiple-candidate refusal, incomplete-read refusal) is NOT deleted — it
remains correct and load-bearing, exported and unit-tested as
`resolveAmbiguousCreateAgainstObservableCandidates`, ready for the day a
genuinely authoritative TIF proof narrows the gate above. Until then, it is
simply never reached from the real `resolveAmbiguousCreate` entry point.

Every ambiguous-create order therefore stays reconciliation-required and
resolves NEVER, by design, pending §F18-24:

| Situation | Result |
| :--- | :--- |
| Any local TIF value, venue TIF unproven (Wave B3 / F18-21, always true today) | `..._IDENTITY_UNOBSERVABLE` — manual review, **checked before candidate count or completeness** |
| *(unreachable in production; proven correct at the `resolveAmbiguousCreateAgainstObservableCandidates` level)* Exactly one candidate, **complete** read, inside the submission window | `RECON_AMBIGUOUS_CREATE_RESOLVED` — resolved |
| *(same)* Exactly one candidate, **incomplete** read (Wave B / F18-03) | `..._UNRESOLVED` — ambiguous, **never resolved** |
| *(same)* More than one economic candidate (regardless of completeness) | `..._MULTIPLE_CANDIDATES` — manual review |
| *(same)* The candidate is also claimed/contested by another local order | `..._MULTIPLE_CANDIDATES` — manual review |
| *(same)* Zero candidates, **incomplete** read | `..._UNRESOLVED` — ambiguous |
| *(same)* Zero candidates, **complete** read | `..._PROVEN_ABSENT` — manual review |
| *(same)* Candidate outside the persisted submission window | `..._UNRESOLVED` — ambiguous |
| *(same)* Candidate carries a status Phase 17 never modelled | `..._UNRESOLVED` — ambiguous |
| *(same)* Local leverage known, candidate leverage absent (Wave B / F18-08) | not an exact match — falls through to the zero/multiple-candidate rows above |

There is no "closest match", no scoring, and no probability anywhere in the
matching code. Time is never the discriminator between two economic matches.

Note the deliberate asymmetry on the "proven absent" row: even when a complete
read proves the create never landed, Phase 18 records a manual-review finding
rather than silently releasing the intent for retry. Deciding that an order
truly never existed is an operator call.

**Wave B (§F18-03): the "exactly one candidate" row now REQUIRES a complete
read.** Before Wave B, a single visible candidate resolved regardless of
`ordersProvenance.complete` — the completeness check only ever gated the
ZERO-candidate branches. That is exactly the confirmed exploit: page 1 returns
one exact-looking candidate, a later page fails, `ordersProvenance.complete`
is `false`, and a second matching order could exist on the unread page. The
resolver now checks completeness before looking at candidate count at all for
the single-candidate case; an incomplete read with exactly one candidate is
`..._UNRESOLVED`, identical in spirit to the zero-candidate incomplete case.
This blocks regardless of *why* the read is incomplete — a failed page, the
pagination guard, a malformed record, or a provider exception all produce the
same refusal — and, critically, produces **zero durable economic adoption**:
no exchange order id is bound, no observation is folded, even though the
account may separately end up blocked anyway by the account-level
`RECON_EVIDENCE_INCOMPLETE` finding. The two are independent: a run must never
apply a provisional economic effect merely because it expects to be blocked
for some other reason anyway.

### 8.1 Wave B2 (§F18-20): incomplete evidence never advances a KNOWN venue-bound order either

F18-03's completeness gate only ever protected **ambiguous-create identity
establishment**. It did not protect the separate, more common path: an order
already bound to a proven `exchangeOrderId` (`reconcileIdentifiedOrder`).
Confirmed exploit: the order's exact venue record IS found in the evidence
(the specific page that carried it succeeded), `ordersProvenance.complete` is
`false` because some OTHER page failed, and the record shows a proven forward
fill advance. The old code applied it anyway — persisting the fill, the
observation event, and `RECON_ORDER_ADVANCED_FROM_VENUE` — before the run
separately ended up blocked for the unrelated incompleteness. The account
would be blocked either way, but the fill was already durably written.

**Required invariant, applied uniformly:** evidence that is incomplete or
otherwise non-authoritative must not produce any permanent economic effect —
not only ambiguous-create identity, but known-order advancement, fill/event
persistence, cumulative filled quantity, state advancement, and (downstream)
strategy ownership and `live_position` writes.

**The fix.** `reconcileIdentifiedOrder`'s two economic-EFFECT-producing exit
points — the forward-advance branch (`APPLY_OBSERVATION`) and the
cancel-claim-clearing branch (`CLEAR_CANCEL_CLAIM`) — now check
`evidence.ordersProvenance.complete` before returning an effect. An incomplete
read withholds the effect entirely and records a blocking
`RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE` finding instead. This is
deliberately BLANKET, not per-record: the specific record backing the
withheld advance may be perfectly accurate, but the account cannot prove no
other divergence exists elsewhere in the same incomplete read, so the
conservative rule withholds uniformly. Branches that produce NO effect either
way — `VERIFIED_MATCH`, economics-conflict `CONFLICT`, fill-regression
`CONFLICT`, terminal-contradiction `CONFLICT` — are unaffected: there is
nothing for incompleteness to protect against when nothing is written.

Position ownership derivation is unaffected by a SEPARATE code path for the
same reason it was already safe for orphan/positions-incomplete cases: it
reads only DURABLE (already-committed) order fills, never venue evidence
directly, so an order withheld from advancing this run simply contributes its
last durably-proven fill amount — never a fabricated one.

### 8.2 Wave B3/B4/B5 (§F18-24): why no TIF field was added to the wire schema, and a wording correction

The wire schema (`wire-schemas.ts`) uses `.passthrough()` on the order
economics shape, so any unexpected field the real venue response happens to
carry is preserved in the parsed object rather than stripped. It is tempting
to read that as "we could just map it if it's there" — Wave B3 deliberately
did **not**.

No field was added because there is no independently-verified evidence of
what field name (if any) the CoinDCX futures observation response uses for
time-in-force, or what its semantics would be. The project's own prior
research already established, and this document already records (§8), that
the verified List Orders contract returns none. Speculatively adding a parsed
field under a guessed name would be exactly the kind of fabricated provider
behavior this repository's evidence model forbids elsewhere (§14 — absence is
never proof, and this cuts both ways: an UNVERIFIED field's presence is not
proof either).

**[Wave B4] Wording correction.** Independent review found that earlier text
in this document and in the code comments it mirrors (§8 above,
`wire-schemas.ts`, `reconciliation-evidence-adapter.ts`) overstated the claim
as an absolute — "the List Orders response never returns TIF, for any record,
under any circumstance." That overclaims what this project can actually
prove: it has verified and documented the absence of a TIF field in every
response shape it has captured, which is sufficient to justify blocking
automatic resolution (F18-21), but it is not proof that CoinDCX's provider
contract is structurally incapable of ever carrying one. All such wording has
been corrected, here and in code, to the evidence-bounded form: "no
authoritative TIF field is documented in the verified List Orders response
contract available to this project." The runtime behavior is unchanged by
this correction — F18-21 still blocks unconditionally on the absence of
verified evidence, never on a claim of structural impossibility, and an
unverified passthrough field must never by itself re-enable resolution.

**[Wave B5] Wording correction, again.** Independent review found that the
Wave B4 correction above had fixed every instance of the absolute overclaim
EXCEPT one: `order-reconciliation.ts`'s `ambiguousCreateIdentityUnobservableReason`
doc comment still read "the verified List Orders response never carries one,
for any record, under any circumstance," and a second sentence still read
"this evidence contract cannot prove time-in-force for ANY local value."
Both were rewritten to the same evidence-bounded form used everywhere else —
"no authoritative time-in-force field is documented in the verified... List
Orders response contract," "this project has no way to prove a universal
negative," "this evidence contract does not document a provable time-in-force
field for ANY local value." Because this exact mistake recurred once already
(fixed everywhere but one file), it is no longer treated as a one-time text
edit: `tests/architecture/phase18-reconciliation-boundary.test.ts`'s
`P18-§24 F18-24` describe block now permanently bans the literal phrases
`never returns`, `never carries`, `never carry`, `structurally impossible`,
`under any circumstance`, `cannot return`, and `can never return` from every
file under `src/execution/live/reconciliation/` plus `wire-schemas.ts` and
`reconciliation-evidence-adapter.ts` — each phrase was verified absent from
the current, corrected wording (including its negations, which use different
words: "incapable" not "impossible," "every circumstance" not "any
circumstance") before being banned, so this is a plain substring check with no
legitimate current use it could false-positive against. Runtime behavior is,
again, unchanged — this was a documentation/comment-only correction.

If a maintainer ever independently verifies a real field name and its
authoritative meaning against actual CoinDCX documentation or a captured
response, the correct sequence is:

1. add it to `LiveOrderEconomicsSchema` as a typed, non-optional enum of only
   the documented values (never a passthrough guess);
2. map it into `LiveVenueOrderEvidence` with unknown/malformed values
   normalized to "unproven," never guessed;
3. **separately and explicitly** decide whether to narrow
   `ambiguousCreateIdentityUnobservableReason` (§8) — the field's mere
   presence in the wire shape must never, by itself, re-enable automatic
   ambiguous-create resolution. That remains a deliberate, reviewed code
   change, not a side effect of adding a parser.

---

## 9. Cancellation ambiguity recovery

Resolution comes from the venue's own view of the exact order id, through the
same comparison as ordinary drift:

- venue proves `cancelled` → the exact terminal result is persisted;
- venue proves filled → fills are preserved and the order moves to `FILLED`;
- venue proves still open → current venue state is preserved and **no cancel is
  resent**;
- venue view cannot be established → remains reconciliation-required.

**A previously ambiguous cancellation is never automatically resent merely
because the process restarted.** Phase 17's durable `cancel_state` /
`cancel_generation` ownership is preserved untouched.

**Crash recovery (§4.3) feeds the same comparison.** A `CANCEL_RESERVED`
claim that survives a restart is either reclaimed to `NONE` before evidence
is even read (wire never armed) or left in place for this exact comparison
to resolve from venue evidence (wire armed) — it is never a third, separate
recovery mechanism.

---

## 10. Position establishment — the rule that matters most

> An exchange aggregate position alone does **NOT** prove strategy-instance
> ownership.

CoinDCX reports one net position per pair and never reports which strategy
opened it. So ownership is derived in exactly one direction: from local,
Phase 17-verified, accepted fill lineage *upward* to a claimed quantity — and
that claim must then reconcile **exactly** to the venue aggregate.

Signed arithmetic: a BUY adds, a SELL subtracts, for OPEN and CLOSE alike
(a CLOSE of a long *is* a sell, and must reduce the same aggregate).

| Case | Result |
| :--- | :--- |
| DB flat + venue flat | verified match (a stale durable row is cleared) |
| Exactly one instance, sum equals aggregate | ownership established, `live_position` materialized |
| Several instances, shares sum **exactly** to the aggregate | attributed; shares recorded; `live_position` **not** materialized |
| DB open + venue flat | `RECON_POSITION_LOCAL_OPEN_VENUE_FLAT` — conflict |
| DB flat + venue open | `RECON_POSITION_UNATTRIBUTED_EXPOSURE` — conflict |
| Quantity mismatch (any amount) | `RECON_POSITION_QUANTITY_MISMATCH` — conflict |
| Direction mismatch | `RECON_POSITION_DIRECTION_MISMATCH` — conflict |
| Shares fail to sum | `RECON_POSITION_OWNERSHIP_SUM_MISMATCH` — conflict |
| Shares net only by offsetting opposite exposure | `RECON_POSITION_OWNERSHIP_SUM_MISMATCH` — conflict |
| Durable row contradicts proven ownership | `RECON_POSITION_IDENTITY_MISMATCH` — conflict |
| Owners on different instrument snapshots | `RECON_POSITION_IDENTITY_MISMATCH` — conflict |
| Any order on the pair is unresolved | `RECON_POSITION_UNATTRIBUTED_EXPOSURE` — ambiguous |
| Positions read incomplete | `RECON_EVIDENCE_INCOMPLETE` — ambiguous |

**A single strategy instance does not receive an aggregate merely because it is
the only one asking.** With a local lineage of 0.3 against a venue aggregate of
0.5, the residual 0.2 is *not* handed to the only candidate owner; the pair
fails closed.

### 10.1 Why shared ownership does not materialize `live_position`

Phase 17's `live_position` is keyed `(account_id, pair)` with a **single** owner
tuple. When several instances hold provable shares, the exposure is fully
attributed — there is no unknown venue exposure — but no single owner may claim
the aggregate without lying. So the shares are recorded in
`live_position_ownership_share`, `live_position` is deliberately left absent,
and CLOSE for that pair stays fail-closed through Phase 17's existing
`LIVE_POSITION_NOT_AVAILABLE` refusal. This is a representational limit that is
stated rather than papered over.

---

## 11. Conservative classification

Seven categories. Only the first three are compatible with a HEALTHY account:

`VERIFIED_MATCH` · `SAFE_AUTHORITATIVE_ADVANCE` ·
`LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE` — then `CONFLICT` · `ORPHAN` ·
`AMBIGUOUS` · `MANUAL_REVIEW_REQUIRED`.

`AMBIGUOUS` and `MANUAL_REVIEW_REQUIRED` resolve the account to
`MANUAL_REVIEW_REQUIRED` rather than `UNHEALTHY`. Both block mutation; the
distinction tells an operator whether rerunning could ever clear it.

**Destructive correction of conflicting economic history is forbidden.**
Reconciliation never lowers a cumulative fill, never rewrites a settled terminal
order, and never repairs data merely to make the database equal the exchange.
Only three reconstructions are performed, each requiring exactly one provable
result: a uniquely proven ambiguous create, a strictly forward venue-proven
advance, and exact position ownership. Everything else becomes a durable fault.

A finding's `blocking` column **defaults to true**, so a future category cannot
silently permit trading.

---

## 12. Idempotence

| Guarantee | Mechanism |
| :--- | :--- |
| No duplicate fill or order event | Phase 17's `UNIQUE(intent_id, observation_sha256)`, checked before any projection write |
| No duplicate fault | `UNIQUE(account_id, finding_sha256)`; a rerun advances `last_seen_generation` instead of inserting |
| No repeated orphan cancel | the durable `NONE → CANCEL_CLAIMED` conditional claim; re-observing an orphan never resets it |
| No position double-creation | `PRIMARY KEY(account_id, pair, owner_strategy_instance_id)` |
| No revision churn | an unchanged lineage digest short-circuits the write entirely |
| Deterministic content hash | snapshot identity is order-insensitive and excludes local read windows |

The finding digest deliberately **excludes** the generation. Including it would
mint a new row for the same unchanged fact on every run — exactly the churn this
section forbids.

A finding not re-observed in the current generation stops blocking (the barrier
only counts findings whose `last_seen_generation` equals the current generation),
so a fault that genuinely stopped applying does not block forever — and the
historical fact is never deleted.

---

## 13. Orphan venue orders

An orphan is an **active** venue order for the managed account that no durable
local order provably owns. It is classified explicitly and **never** attached to
the nearest local intent — "nearest" is not a relation this code computes.

Automatic cleanup satisfies all nine required conditions:

1. it uses the approved Phase 17 gateway/transport, not a second network owner;
2. it binds the exact venue order identity and nothing else;
3. it requires the current reconciliation lease, revalidated in the claim transaction;
4. it requires explicit configuration (`LIVE_ORPHAN_CANCELLATION_ENABLED=true`, the exact lowercase literal);
5. it **defaults to disabled** — absent, empty, `false`, and every near-miss (`TRUE`, `1`, `yes`, ` true `) refuse;
6. it is account allowlisted, and a malformed or out-of-range per-run ceiling refuses rather than falling back to a default or clamping (the ceiling is a safe integer from 1 to 20, §13.5);
7. it persists the cancellation claim **before** the external mutation;
8. an ambiguous outcome becomes `CANCEL_AMBIGUOUS` plus a blocking manual-review finding, and is **never resent** — including after a restart;
9. no automated test sends a real mutation; the port is injected and the test double records calls.

When cleanup is disabled or the account is not allowlisted, the orphan finding
is persisted and **live trading is blocked** rather than reported healthy.

**Orphan cancellation is not normal trading authority.** It is a separate,
reconciliation-owned remediation path: it runs inside a reconciliation run,
does not pass `requireCurrentReconciliation` (§14), and is bounded instead by
the orphan-cleanup policy (explicit enablement, account allowlist, a 1..20
per-run ceiling, §13.5), reconciliation account/generation fencing, durable
claim → arm → wire ordering (§13.2), and sticky ambiguity (§13.1). It grants
no OPEN, ordinary cancel, or CLOSE authority, proves nothing about account
continuity, and does not make live authorization ready.

### 13.1 F18-25: durable orphan `CANCEL_AMBIGUOUS` is sticky, independent of current evidence

**Confirmed exploit, now fixed.** Point 8 above ("never resent") was already
correctly enforced WITHIN a run that still sees the orphan in fresh evidence:
`#handleOrphans`'s `claimOrphanCancellation` `NOT_CLAIMABLE` branch refused to
reclaim an already-`CANCEL_AMBIGUOUS` record. What was missing was the case
where a LATER generation's evidence simply stops returning that order — a
cancel that actually landed after all, an order that expired, a shifted page
boundary, or nothing but bad luck in what the venue chose to return this time.
`detectOrphanVenueOrders` computes orphans from THIS run's evidence only, so
an invisible orphan produced no finding at all, and the durable
`CANCEL_AMBIGUOUS` record — genuinely still unresolved — silently stopped
blocking the account:

```
Run 1: visible orphan -> cancel ambiguous -> durable CANCEL_AMBIGUOUS -> MANUAL_REVIEW_REQUIRED
Run 2: venue no longer returns the order -> [BEFORE THE FIX] no blocking finding -> HEALTHY
```

**The fix.** `#recoverOrphanCancelClaims` (`service.ts`) now runs, evidence-
INDEPENDENT, at the very start of every generation — before any fresh venue
read — and reasserts a `RECON_ORPHAN_CANCEL_AMBIGUOUS` blocking finding for
EVERY durably `CANCEL_AMBIGUOUS` orphan, regardless of whether this run's
evidence redetects it:

```
Run 2: venue no longer returns the order -> durable ambiguity reasserted regardless -> MANUAL_REVIEW_REQUIRED (unchanged)
```

The reasserted finding uses the SAME content shape
(`stickyOrphanCancelAmbiguousFinding`) whether it is being raised for the
FIRST time (moment of ambiguity) or reasserted every generation after — so it
dedups by content identity (§16) to exactly ONE durable row across every
generation, never accumulating duplicates, never mutating the orphan's
`cancelState`, and never oscillating. Only an authoritative resolution path —
`resolveOrphanCancelAmbiguity`, added by Wave C1 (§13.4, F18-06) — may ever
clear `CANCEL_AMBIGUOUS`; nothing in the reassertion path attempts to, and
this section's reassertion behavior is completely unchanged by that
addition.

Real-MySQL proof: `[B4-1]` in
`tests/integration/execution/live-reconciliation-persistence.integration.test.ts`
runs three successive generations — visible/ambiguous, invisible/still-blocked,
invisible/still-blocked-and-idempotent — over a real database connection,
confirming the finding row count stays at exactly 1 and the orphan row's
`revision` never advances past the original ambiguity write.

### 13.2 F18-26: orphan cancellation is durably wire-armed BEFORE the HTTP call

**Confirmed exploit, now fixed.** Every OTHER Phase18/Phase17 mutation class
(dispatch, normal cancel) commits a durable "wire may be sent" proof
(`armDispatchWire`/`armCancelWire`, §4.3) BEFORE calling the gateway, so a
crash between "the HTTP request may have left this process" and "the response
was durably recorded" is unambiguously distinguishable from "definitely never
sent." Orphan cancellation was the one exception: `#handleOrphans` claimed the
cancellation (`cancelWireArmed=false`) and called `port.cancelVenueOrder(...)`
directly, with no arming step in between:

```
claim orphan cancellation -> cancelWireArmed=false -> HTTP cancel sent -> [crash]
-> restart sees an UNARMED claim -> safely-reclaim path runs -> cancel is sent again
```

**The fix.** `#handleOrphans` now calls the repository's
`armOrphanCancelWire(lease, authorization, exchangeOrderId, generation)` —
which already existed, fully fenced, since Wave A2 (§4.3), but was never
wired into the orphan-cancel call site — immediately after the claim and
BEFORE `port.cancelVenueOrder(...)`:

```
claim -> armOrphanCancelWire (fenced, durable) -> ONLY THEN cancelVenueOrder(...)
```

`armOrphanCancelWire` revalidates the current reconciliation lease
(account/run/generation/runtime-identity/revision) inside the SAME
transaction as every other durable Phase18 write, so:

- **crash BEFORE arm**: the claim is still provably unarmed; the existing
  `reclaimUnarmedOrphanCancelClaim` path safely resets it to `NONE` with ZERO
  wire calls (`[B4-3]`).
- **crash AFTER arm, before the provider result is persisted**:
  `#recoverOrphanCancelClaims` resolves it to `CANCEL_AMBIGUOUS` through the
  exact same durable path an unestablished live outcome already uses — never
  a resend, and now durably sticky besides (§13.1) (`[B4-4]`).
- **stale-generation race**: a worker whose generation was superseded between
  its claim and its arm attempt is fenced OUT at the arm call itself, before
  the gateway is ever reached, with zero wire calls (`[B4-5]`).

This restores orphan cancellation to the exact same `unarmed => provably no
wire permission; armed => may have been sent, never blind retry` guarantee
every other Phase18 mutation class already had, closing the one place Wave A
was not actually intact.

### 13.3 F18-29 (Wave B5): the sticky ambiguity finding suppresses the redundant generic orphan finding

**Confirmed duplicate, now fixed.** §13.1's sticky reassertion
(`#recoverOrphanCancelClaims`) and ordinary orphan detection
(`detectOrphanVenueOrders`) are two independent code paths, and until this
wave nothing coordinated between them. A durably `CANCEL_AMBIGUOUS` orphan
that is STILL visible in the current run's fresh evidence triggered BOTH:

```
RECON_ORPHAN_CANCEL_AMBIGUOUS   (from #recoverOrphanCancelClaims, or from
                                  #handleOrphans discovering the ambiguity
                                  for the first time this same run)
RECON_ORPHAN_VENUE_ORDER         (from detectOrphanVenueOrders, evaluated
                                  earlier in the same reconcileAccount call,
                                  with no knowledge of the ambiguity)
```

Both findings are about the identical underlying orphan. The sticky finding
already expresses the stronger, more specific fact ("a cancel for this order
has an unestablished outcome and durably blocks, independent of current
evidence" — §13.1); the generic finding ("an active venue order has no proven
local lineage") adds no information an operator does not already have from the
sticky one. This was pure duplicate operator noise, not a safety gap — the
account was correctly blocked either way — but independent review correctly
flagged it as a finding that should not exist twice.

**The fix.** `reconcileAccount` (`service.ts`) now collects the set of
exchange order ids covered by a `RECON_ORPHAN_CANCEL_AMBIGUOUS` finding this
generation from BOTH sources — `#recoverOrphanCancelClaims`'s return value
(pre-existing durable ambiguity, known before fresh evidence is even read) and
`#handleOrphans`'s return value (an orphan that becomes ambiguous for the
FIRST time in this same run, known only after the cancel attempt completes) —
and filters `detectOrphanVenueOrders`'s generic findings to exclude any orphan
already in that set, before either list is pushed into the run's findings.
This is presentation-only: it removes a duplicate finding ROW, never the
blocking behavior — the sticky finding the exclusion is built from still
exists, still counts toward `blockingFindingCount`, and remains exactly as
sticky (§13.1) regardless of whether the venue currently returns the order.
`#handleOrphans` itself still receives and processes every orphan
unconditionally; claim/arm/cancel handling (§13.2) is completely unaffected.

Proven at the unit level (`P18 Wave B5 §F18-29 orphan finding dedup`,
`tests/unit/execution/live/reconciliation/service-and-orphan-policy.test.ts`)
for same-run direct discovery, reassertion across multiple generations while
the orphan stays visible, and the case where the venue stops returning the
order entirely (proving the dedup does not depend on continued visibility,
mirroring §13.1's own guarantee). Proven with a real database
(`[B5-1]` in `live-reconciliation-persistence.integration.test.ts`) that
first discovery and a subsequent generation each write exactly one durable
finding row for the orphan, never two.

### 13.4 F18-06 (Wave C1): durable orphan cancellation ambiguity resolution

**The gap, precisely.** §13.1 (F18-25) made a durable orphan `CANCEL_AMBIGUOUS`
cancellation sticky and fail-closed: it reasserts a blocking finding every
generation regardless of whether the venue currently returns the order, and
nothing automatic ever clears it. That is correct and remains completely
unchanged by this wave. What was missing was any AUTHORITATIVE, IN-BAND way
for a human to ever resolve one — an account that hit this state stayed
`MANUAL_REVIEW_REQUIRED` forever, with no code path that could ever legitimately
move it forward, however long an operator had genuinely investigated and
however confident they became about the true outcome.

**The state machine addition.** `LiveOrphanCancelState` gains exactly one new
value, `CANCEL_AMBIGUOUS_RESOLVED`, reachable ONLY from `CANCEL_AMBIGUOUS`
and ONLY through `resolveOrphanCancelAmbiguity`. It is deliberately distinct
from every existing value:

- **not `NONE`** — reusing `NONE` would make `claimOrphanCancellation`'s
  `NONE -> CANCEL_CLAIMED` transition eligible again, silently re-arming
  automatic cancellation for a claim a human just took off the automatic path
  (the exact trap the task's own brief called out explicitly). Because every
  write path that could ever move an orphan's `cancelState`
  (`claimOrphanCancellation`, `armOrphanCancelWire`,
  `reclaimUnarmedOrphanCancelClaim`, `completeOrphanCancellation`) requires
  the CURRENT state to already be `NONE` or `CANCEL_CLAIMED`, none of them can
  ever fire against a `CANCEL_AMBIGUOUS_RESOLVED` row — this is a structural
  property of the existing write-path preconditions, not a new check added
  for this wave, and is proven directly against a real database in `[C1-5b]`
  (every relevant write path attempted against a resolved row, all correctly
  refusing).
- **not `CANCEL_ACKNOWLEDGED` or `CANCEL_REJECTED`** — both of those mean THIS
  SYSTEM independently proved a specific venue outcome from authoritative
  evidence. An operator resolution never does that; using either would
  fabricate a fact this system never verified.

**The resolution vocabulary — deliberately minimal.** An operator resolving an
ambiguity asserts exactly one of two outcomes
(`LiveOrphanCancelResolutionOutcome`):

| Outcome | What it asserts | What it does NOT assert |
| :--- | :--- | :--- |
| `ACKNOWLEDGED_NO_RETRY` | Stop blocking on this specific cancellation attempt; never retry it. | Anything about the true venue outcome. The safe default when no independent proof exists. |
| `CONFIRMED_CANCELLED` | The operator independently verified, OUTSIDE this system (CoinDCX support, the CoinDCX UI, another authoritative out-of-band channel), that this exact order was terminated. | This system never verifies the claim itself — it only durably records that an operator made it. |

No broader vocabulary (a specific fill, an average price, an ownership claim,
a `live_position` state) is representable here at all, by construction: a
resolution never writes to `live_order`, `live_position`, or any ownership
table — only to `live_orphan_cancel_resolution` and
`live_orphan_venue_order.cancel_state`, in one transaction. If an operator's
only honest conclusion is "I don't know what happened, but stop blocking on
it," `ACKNOWLEDGED_NO_RETRY` records EXACTLY that — never upgraded to a
stronger claim the operator didn't actually make.

**The durable audit record.** `live_orphan_cancel_resolution` is append-only:
never updated, never deleted. It carries the exact orphan revision and cancel
generation the resolution answered for, the outcome, a bounded operator/
service identity (`resolved_by`, ≤128 chars), an optional bounded free-text
reference (`note`, ≤512 chars — length-checked at mint time by
`mintOrphanAmbiguityResolutionRequest`, never parsed, never used to derive
identity, never written into any reconciliation finding's evidence), and a
timestamp. `UNIQUE(account_id, exchange_order_id, resolved_cancel_generation)`
means the exact cancellation attempt a resolution targets can be resolved
exactly once — the original ambiguity, and the fact that it was resolved and
by whom, stays provable forever, even after the account is later HEALTHY.

**The authority: `OrphanAmbiguityResolutionRequest`
(`orphan-resolution.ts`).** A distinct, unforgeable, opaque capability —
deliberately NOT `LiveReconciliationAuthorization` (§6.4.2), so resolving an
ambiguity can never be confused with, or accidentally borrow authority from,
machine reconciliation. It follows the exact issuer-object/private-field
pattern `LiveRuntimeIdentity` and `LiveReconciliationAuthorization` already
use: minted only by `mintOrphanAmbiguityResolutionRequest`, read only by
`readOrphanAmbiguityResolutionRequest`, refused by direct construction, a
plain object, a prototype clone, or an `Object.create`-based structural fake
(`tests/unit/execution/live/reconciliation/orphan-resolution.test.ts`). It is
bound, permanently, to one exact `(accountId, exchangeOrderId,
expectedRevision)` triple at mint time. `resolveOrphanCancelAmbiguity` reads
ONLY the identity carried inside the request object — never a
separately-supplied `accountId`/`exchangeOrderId` argument — so there is no
code path through which a request minted for one orphan could ever be applied
against a different one; this is proven directly, including the case where
the identical exchange order id is durably ambiguous under TWO different
accounts simultaneously (`[C1-3]`, real MySQL).

**Deliberately NOT gated on live-mutation continuity.** `requireCurrentReconciliation`
(§F18-27/§F18-28) governs whether a LIVE MUTATION may proceed; it has nothing
to do with whether an operator may resolve a durable ambiguity, and
`resolveOrphanCancelAmbiguity` takes no `LiveReconciliationLease` and no
dependency on reconciliation being able to run at all. This is deliberate: an
account can be simultaneously "cannot authorize any normal live mutation" (always
true today, §6.4.4) and "can have its durable orphan ambiguity resolved by an
operator" — the two are orthogonal recovery concerns, and gating resolution on
live-mutation readiness would make administrative recovery permanently
impossible for exactly the accounts most likely to need it. `[C1-1]` proves
both halves of this in the same real-MySQL test: after a genuine resolution,
`requireCurrentReconciliation` still refuses with `ACCOUNT_CONTINUITY_NOT_PROVEN`
— unchanged, for the unrelated F18-27 reason, never because resolution granted
anything.

**Transactional flow, fencing, and concurrency.** `resolveOrphanCancelAmbiguity`
locks the target orphan row (`FOR UPDATE`), re-checks account/orphan identity
(implicit — both come from the request, never a separate argument), the
expected revision, and the current cancel state, all inside the same
transaction that writes the audit row and the state transition. A stale
revision, a non-ambiguous current state (already resolved, never claimed, or
resolved by a concurrent request that committed first), or a duplicate
resolution for the same `(account, order, cancel generation)` all fail closed
with zero mutation (`[C1-2]`). Two genuinely concurrent resolution requests
over two independent database connections produce exactly one durable
transition, one audit row, and one deterministic loser — proven with real
concurrent connections, not simulated (`[C1-4]`).

**Resolved orphan reappears at the venue.** A prior resolution answers a
PAST ambiguity; it is never silently reinterpreted as "this order can never be
active again." If the exact same exchange order id becomes active at the
venue again in a later generation, `#recoverOrphanCancelClaims` recognizes it
(it tracks resolved exchange order ids from the same `loadOrphanOrders` read
it already performs) and `reconcileAccount` raises the STRONGER
`RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION` finding instead of the generic
`RECON_ORPHAN_VENUE_ORDER` one — never both, and never silently nothing.
Automatic cancellation is never retried (the structural refusal above already
covers that), so this durably blocks pending fresh human review; the original
resolution stays exactly as it was recorded, never reopened or mutated.
Proven at the unit level (the exact §17 scenario, plus a negative control
proving an orphan with no prior resolution is unaffected) and against a real
database (`[C1-5a]`, `[C1-7]`).

**Complete list of what F18-06 explicitly does NOT do**, stated to match the
task brief's own emphasis: it does not infer resolution from venue absence, a
restart, a generation change, or any automatic signal — F18-25's stickiness is
completely unchanged, and the ONLY way `CANCEL_AMBIGUOUS_RESOLVED` is ever
reached is a genuine `OrphanAmbiguityResolutionRequest`; it does not fabricate
a fill, an average price, order/strategy ownership, `live_position`, PnL, or
venue order history; it does not expose an HTTP route (this wave is domain/
persistence correctness only, proven through the repository/service boundary
and tests — no dashboard or transport surface was added); it does not weaken
generation fencing, runtime identity, or reconciliation authority anywhere
(resolution uses none of them); and it does not change what `HEALTHY` means
or unlock any live mutation that F18-27/F18-28 would otherwise refuse.

Full test inventory: `tests/unit/execution/live/reconciliation/orphan-resolution.test.ts`
(mint/forgery), `service-and-orphan-policy.test.ts`'s
`P18 Wave C1 §F18-06` block (domain-level: resolution stops reassertion,
cross-order isolation, stale revision, not-ambiguous refusal, duplicate
refusal, no-auto-cancel trap, reappearance, negative control), and
`live-reconciliation-persistence.integration.test.ts`'s `[C1-1]`–`[C1-7]`
(real MySQL: basic resolution, stale revision, cross-account isolation,
concurrent resolution, resolution-then-reconciliation ordering, the
structural never-reverted proof, crash/restart, reappearance).

### 13.4.1 F18-31 (Wave C1.1): `resolvedBy` is a caller-asserted audit label, not an authenticated operator identity

Independent review of F18-06 found the `resolvedBy` documentation was not
explicit enough about what the string actually proves. Stated plainly, for
the avoidance of any doubt:

> `resolvedBy` is currently a caller-asserted audit label.
>
> Wave C1 provides the domain/persistence resolution primitive only. It does
> not authenticate an operator identity, because no operator-facing
> transport/authentication surface exists in this phase (no HTTP route, no
> CLI, no dashboard, no production caller of `resolveOrphanCancelAmbiguity`
> exists anywhere in this repository today).
>
> Any future HTTP/CLI/dashboard/operator transport MUST authenticate and
> authorize the operator first, then derive `resolvedBy` from that trusted
> principal, rather than accepting an arbitrary caller-supplied identity
> string as it does today.

A genuinely-minted `OrphanAmbiguityResolutionRequest` (§13.4's "The
authority" paragraph) proves only that a structurally genuine resolution
request was minted inside this domain API with the supplied audit label — it
is **not** proof that an authenticated operator approved the action, and this
document, and the module's own doc comments, now say so explicitly rather
than leaving it implied. This does not change anything about the
unforgeability of the capability itself (§13.4's forgery-resistance tests are
untouched and still pass): the capability is genuinely un-fake-able as an
*object* — nothing can conjure a valid `OrphanAmbiguityResolutionRequest`
without going through `mintOrphanAmbiguityResolutionRequest` — but the
*string* it carries for `resolvedBy` is exactly as trustworthy as whatever
in-process caller supplied it, and today that caller is a test, not an
authenticated human.

This wave deliberately does **not** add authentication, RBAC, admin users,
JWT permissions, a dashboard route, an API endpoint, or a CLI tool — there is
no operator transport for any of those to protect yet, so building
authentication now would have nothing real to gate. That remains future work
for whichever wave first introduces an operator-facing transport surface.

A permanent architecture check
(`tests/architecture/phase18-reconciliation-boundary.test.ts`, `P18-§F18-31`)
bans a short list of specific affirmative wordings from ever reappearing in
`orphan-resolution.ts`, `ports.ts`, `repository.ts`, or this document, so the
exact overclaim already found once cannot silently return in a later wave
(see that test file for the banned strings; they are deliberately not
reproduced verbatim here, since quoting them would itself trip the same
check on this document). The ban only matches affirmative claim phrasing, not
a bare substring, because the CORRECT wording above legitimately reuses
similar words inside a negation ("NOT an authenticated operator identity",
"NOT proof that an authenticated operator approved...") — banning a bare
substring outright would have forbidden the very disclaimer this finding
requires. §13.4.4 (F18-33, Wave C1.2) hardens this further with a
proximity-based check that catches a differently-worded overclaim too, not
only the exact strings on the original list.

### 13.4.2 F18-30 (Wave C1.1): the Phase16 SOL/Solana architecture guard, restored to full coverage

The Wave C1 fix for `LiveOrphanCancelResolution` tripping the Phase16
"zero SOL-specific models/fields/enums" schema guard
(`tests/architecture/phase16-new-coin-proof.test.ts`) replaced the guard's
original bare `/sol/i` substring test — which flagged the legitimate,
non-coin-specific model name `LiveOrphanCancelResolution` purely because it
contains the letters "sol" inside "Resolution" — with an ad hoc word-boundary
regex, `/(^|[a-z0-9])Sol([A-Z]|$)/`. That regex fixed the false positive but
was narrower than it should have been: because it required an exact-case
`Sol` substring immediately followed by another capital letter or the end of
the identifier, it missed real coin-specific names in other castings —
`SOLCandle` and `solCandle` (wrong case), and `Solana`/`SolanaCandle` (the
full coin name, where "ana" follows "Sol" rather than a capital letter or
nothing).

**The fix.** This file already defines a correct, independently-tested,
token-aware identifier splitter, `identifierWords` (used by
`isSuspiciousCoinIdentifier` to detect BTC/ETH/SOL ticker hardcoding
elsewhere in this same test file) — it correctly splits camelCase,
PascalCase, ALL_CAPS runs, underscores, and digits into whole words. The
schema-level SOL guard was reinventing its own narrower regex instead of
reusing that tokenizer. Wave C1.1 adds a small, SOL/Solana-specific token set
(`SOL_SPECIFIC_TOKENS = {'SOL', 'SOLANA'}` — kept separate from the shared
`COIN_SYMBOLS = {'SOL','BTC','ETH'}` set so BTC/ETH ticker-hardcoding
detection elsewhere is untouched) and a new `isSolSpecificIdentifier` helper
that reuses `identifierWords` and rejects a name only when one of its WHOLE
words is `SOL` or `SOLANA`, case-insensitively — never on a bare substring.

This correctly rejects (all now covered by an explicit test):
`SolCandle`, `SOLCandle`, `solCandle`, `SolPosition`, `SOLPosition`,
`solPosition`, `Solana`, `SolanaCandle`, `SOLANAPosition`, `solanaOrder` —

while still correctly allowing (also covered by an explicit test):
`Resolution`, `LiveOrphanCancelResolution`, `Console`, `PaperConsole`,
`ConsolidatedResult` — none of which tokenize to a whole `sol` or `solana`
word.

**Proof the broader coin-neutrality proof was not weakened.** The BTC/ETH
ticker-hardcoding checks (`isSuspiciousCoinIdentifier`, `COIN_SYMBOLS`,
`FORBIDDEN_COIN_TOKENS`, `scanSourceFileForCoinHardcoding`) are byte-for-byte
unchanged — Wave C1.1 only added a new, additional, narrower helper for the
schema-level SOL/Solana check; it did not modify or replace anything the
existing BTC/ETH/new-coin proof relies on. All pre-existing tests in this
file (structurally coin-styled identifiers, ordinary-English-identifier
non-flagging, AST-level coin hardcoding detection, protected-core import
boundary) pass unchanged, alongside the new SOL/Solana reject/allow matrix.

### 13.4.3 F18-32 (Wave C1.2): the Prisma field-name guard used exact-match, not the tokenizer

Independent review of Wave C1.1 found the *field*-name half of the §13.4.2
schema guard was never actually fixed — only the *model* and *enum* halves
were. The field check still compared a field's first token against exactly
three literal strings (`sol`, `solUsdt`, `solana`, case-insensitively), so a
field named `solPosition`, `SOLPosition`, `SolanaCandle`, `SOLANAPosition`, or
any other SOL/Solana-specific name that isn't one of those three exact
strings would pass the check silently. This was a real gap in the invariant
this file exists to prove (§13.4.2: "zero SOL/Solana-specific models, fields,
or enums"), not merely a style issue — a field is exactly as coin-specific a
piece of schema as a model or an enum.

**The fix** reuses `isSolSpecificIdentifier` (§13.4.2) for the field check
too, instead of the three-literal-string comparison — the same fix pattern as
§13.4.2 itself: no new bespoke matcher, no return to a bare `sol` substring
test (which would reintroduce the original false positives this whole guard
exists to avoid). A dedicated helper,
`isSolSpecificSchemaFieldLine`, extracts a schema line's first token exactly
as the real scan does and applies the tokenizer to it, so the same function
is exercised by both the real-schema assertion and a new adversarial test
that constructs synthetic field-declaration lines the current schema does not
contain (`sol`/`SOL`/`Sol`, `solPosition`/`SOLPosition`, `SOL_Order`,
`MySolPosition`, `Sol2Position`, and their Solana-named equivalents — all
rejected; `resolution`, `resolutionState`, `resolvedPosition`, `console`,
`consolidatedResult`, `liveOrphanCancelResolution` — all allowed), so the
guard is exercised against names the schema does not contain yet, not only
against the current schema. That is a finite adversarial sample, not a proof
over every possible name.

### 13.4.4 F18-33 (Wave C1.2, hardened Wave C1.3): a clause-scoped guard, not just an exact-phrase list

The §13.4.1 (F18-31) architecture check bans a short, specific list of exact
overclaim phrases. Independent review pointed out the obvious limitation of
any exact-phrase list: differently worded text that expresses the identical
false claim (about what `resolvedBy` establishes) passes trivially just by not
matching one of the listed strings verbatim.

**Wave C1.2's first attempt** at a second layer
(`findUnsafeResolvedByClaims`,
`tests/architecture/phase18-reconciliation-boundary.test.ts`) reasoned about
PROXIMITY: every mention of `resolvedBy`/`resolved_by` was checked against a
shared ±150-character window of surrounding text. Independent review found
three concrete defects in that design (F18-34/F18-35/F18-36): its concept
vocabulary was too narrow (missed plain "authorized"/"approved"/"user"/
"admin"/"principal" claims that didn't happen to use the one exact phrase it
knew about); its future-design recognition was too narrow (missed several
legitimate future-transport phrasings); and — the more serious defect — a
single shared window let a qualifier that belonged to ONE claim "launder" a
completely SEPARATE claim merely because both landed inside the same window,
including within one sentence split by "but"/"however".

**Wave C1.3 replaces the window with clause-scoped reasoning.** The text is
split into sentences (on `.`/`!`/`?`/`;`, after collapsing all whitespace —
including line-wrap newlines inside a hand-wrapped paragraph or JSDoc `* `
continuation — to a single space, so a sentence hand-wrapped across several
source lines is treated as the one logical sentence it is); each sentence is
then split further on a contrastive conjunction (`but`/`however`/`while`/
`whereas`), so two clauses joined by a contrast word in the SAME sentence are
still classified independently. Each resulting clause is judged strictly on
its own local content: does THIS clause mention `resolvedBy`/`resolved_by`
(a clause that never mentions it cannot make a claim about it, and is never
evaluated); does THIS clause contain an authentication/verification/trust/
authorization concept word (the vocabulary was widened past the original
single exact phrase to prefix-match every inflection of authenticate/verify/
trust/authorize/authorise/approve, plus "principal"/"user"/"administrator"/
"admin"/"operator identity"/"human identity"); does THIS clause contain an
explicit negation; does THIS clause contain an explicit future-design marker.
A clause is flagged only when it mentions `resolvedBy`, contains a concept
word, and contains neither a negation nor a future marker — all within
itself. No neighboring clause, sentence, or file-wide occurrence can supply
the missing qualifier. This directly closes the laundering gap: a safe or
future-framed sentence elsewhere in the text no longer excuses a separate,
unqualified affirmative claim, and a safe clause on one side of "but"/
"however" no longer excuses an unsafe clause on the other side of the same
sentence. This is still deliberately narrow and specific to this one concern
— not a general natural-language linter — and still does not replace the
§13.4.1 exact-phrase ban, kept as a cheap first layer.

The guard is proven adversarially, not only against the current real source
text: `tests/architecture/phase18-reconciliation-boundary.test.ts`'s
`P18-§F18-33` block feeds it synthetic cases written for this test alone —
14 unsafe current affirmative claims across the widened concept vocabulary,
8 legitimate same-clause negations, 7 legitimate future-design statements, 3
sentences mixing a safe current clause with a safe future clause, 3
cross-sentence cases proving a safe/future sentence cannot launder a separate
unsafe sentence, and 2 same-sentence cases proving a safe clause cannot
launder a contradictory unsafe clause joined by "but"/"however" — before
being run against the real scope: `orphan-resolution.ts`, `ports.ts`,
`repository.ts`, and this document. (Consistent with §13.4.1's own
precedent, none of the adversarial false-claim examples are reproduced
verbatim in this document — doing so would trip this very check on this
file; see the test file for the exact wording used.)

**Wave C1.4 (F18-37) tightens the same locality rule.** The Wave C1.3
closure review found the clause-scoped design sound but its boundary set
incomplete: a colon, an em/en dash, a spaced hyphen, a parenthetical, or a
contrastive transition outside the four it knew ("yet", "although",
"though", "nevertheless", "on the other hand") left two independent claims in
one clause, so a negation belonging to the first still covered the second.
Rather than only widening the separator list, Wave C1.4 scopes every
qualifier to the smallest local claim it belongs to: parentheticals are
evaluated on their own and the enclosing text is evaluated with them removed;
the strong-boundary and contrastive-transition sets are widened as above; a
segment that still holds several `resolvedBy` mentions is split at each
mention, so one mention's qualifier never covers another (mentions joined
only by punctuation or "and"/"or"/"nor" remain one coordinated subject); a
negation excuses a claim only when it precedes the claim's first concept
word, so a trailing negation that belongs to a different phrase no longer
counts; and a future marker no longer excuses a mention explicitly anchored
in the present tense. Proven against 22 new synthetic unsafe cases (colon,
dash, conjunction, parenthetical, multiple-mention, and locality groups) and
15 new synthetic safe cases, with every Wave C1.3 case still passing.

Fixing F18-37 also exposed one line in this section whose wording had passed
the Wave C1.3 guard only through the very defect being fixed: a dash-set
aside restated the overclaim as a standalone proposition, and the C1.3 guard
excused it solely because of an unrelated "not" later in the same sentence.
That aside was reworded to name the false claim without restating it,
consistent with this section's own rule against reproducing overclaim
wording. No other documentation change was needed; `orphan-resolution.ts`,
`ports.ts`, and `repository.ts` scan clean with no edits.

**Wave C1.5 (F18-38, F18-39) and its failed closure review.** Independent
review of Wave C1.4 did not close F18-37 and raised two MEDIUM findings. In
F18-38, a single-mention claim still absorbed an unrelated leading clause
joined by a bare comma, so that clause's future or negation words qualified a
separate present-tense claim. In F18-39, an elided-subject continuation after
a split (one that omits the literal identifier) was never evaluated at all.
Wave C1.5 dropped a bare-comma leading clause, counted modal verbs as future
markers, and let a continuation inherit the subject when it opened with one
of a fixed list of predicate verbs. Its closure review returned **FAIL** with
three MEDIUM findings. **F18-40:** the leading-clause fix only worked for a
bare comma; joining the unrelated clause with "and"/"or"/"then", or with no
comma at all, still let it qualify the new claim. **F18-41:** a regression
introduced by C1.5 itself: a modal anywhere in the local claim excused it,
so a trailing phrase about some other subject (auditors, reviewers, a
dashboard) laundered a complete present-tense assertion that the C1.4 guard
had correctly flagged. **F18-42:** continuation inheritance relied on a closed
verb list, so continuations using copulas, "contains", "holds", "carries",
"equals", or an unlisted leading adverb were still dropped.

**Wave C1.6 (F18-40, F18-41, F18-42).**
- *F18-40:* the connector word no longer decides anything. A leading clause
  stays part of the claim only when it grammatically governs the mention:
  there is no clause break, the whole prefix is one once/exists or
  when/added subordinate clause, or the mention is the object of a
  base-form future-action verb ("… and derive … from the trusted
  principal"). Otherwise the claim starts at the new clause. A governing
  verb missing from that list fails loud (the prefix is dropped and the
  claim is judged alone), not silently.
- *F18-41:* future evidence counts only when it governs the predicate: a
  modal directly after the mention (optionally after adverbs), a governing
  once/when subordinate clause, or a future marker in the governing clause
  whose object is the mention. A modal or "future" after the assertion is
  complete no longer counts, and a present-tense anchor always overrides.
- *F18-42:* inheritance is reversed. A continuation inherits the subject
  unless it opens with its own: a determiner, a pronoun other than "it", an
  auxiliary-inverted question ("does this clause …"), or a bare noun that is
  not a finite-verb form. Finite verbs are recognized by shape (auxiliaries
  and modals, or an -s/-ed word followed by an object opener), not by a
  closed list. Leading adverbs (including any -ly adverb and "in practice")
  are skipped first.

Two guard refinements came from scanning this document with the new rules;
the documentation itself was correct and was not changed for them. A
continuation that is an auxiliary-inverted question was being read as a
verb-led continuation, and a quantified reference to the identifier as a word
("any … mention") was being read as a claim about the field's value; both are
now recognized, narrowly (an unquantified mention, or "does" followed by a
bare verb, is still evaluated). The architecture test file adds 66 permanent
cases (including every reproducer named by the C1.5 closure review) and still
passes every earlier C1.3, C1.4, and C1.5 case unchanged, together with a
clean scan of `orphan-resolution.ts`, `ports.ts`, `repository.ts`, and this
document.

**Wave C1.6 independent review and the final C1 guard cleanup (F18-43).**
The Wave C1.6 review returned **FAIL** because of one MEDIUM finding,
**F18-43**, and accepted F18-38, F18-39, F18-40, F18-41, and F18-42 as PASS.
*F18-43:* the quantified-mention refinement above was an early return. Any
local claim containing "a/the/each/every … mention" was treated as prose
about the identifier, so a real identity assertion whose subject merely used
the word "mention" was never evaluated. The cleanup removes that early return
and classifies the predicate that follows the noun phrase instead:
- the mention is excused only when it is the object of a text-analysis verb
  ("flags", "detects", "scans", "rejects", …, or an auxiliary-inverted
  "does … contain" question) and is followed only by a restrictive relative
  clause, a participle, or a locative phrase, never by a finite predicate of
  its own (so an embedded "confirms/checks a … mention stores …" is still a
  claim), and never by a comma-set relative clause;
- when the mention is the subject, it is excused only by a text-analysis
  passive that names what the analysis looks for ("is checked for …
  wording"); any predicate coordinated after that is still judged with
  resolvedBy as its subject;
- every other predicate (store/identify/contain/represent/record/name/hold/
  carry/equal, a copula, "has been …", "is populated from …") is an ordinary
  claim about resolvedBy and goes through the normal negation/future/
  present-anchor rules. Inspection predicates with no concept word ("is
  inspected", "is checked by the architecture guard") were already safe
  through those normal rules and need no exception.

The architecture test file adds 44 permanent cases: the 11 required
real-assertion cases, the 6 required meta-prose cases, and a bounded
same-invariant sweep of 27 more (20 real-assertion, 7 meta-prose). The sweep
found one further bypass of the same invariant, a comma-set "…, which …"
relative clause after an analysed mention, and it is fixed in the same pass.
Every earlier C1.3 through C1.6 case still passes unchanged, and
`orphan-resolution.ts`, `ports.ts`, `repository.ts`, and this document still
scan clean with no edits.
At the time of that cleanup, F18-37 and F18-43 remained open until
independently reviewed. **The C1 final closure review has since returned
PASS: F18-37 through F18-43 are CLOSED/PASS.**

### 13.5 F18-10 (Wave C2): the per-run orphan cancellation ceiling is bounded

**Confirmed defect, remediated in Wave C2, pending independent review.**
`LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN` bounds how many orphan cancellations
one reconciliation run (one `reconcileAccount` generation) may start. The
service enforces it with `if (attempted >= maxCancellationsPerRun) break;` in
`#handleOrphans`, where `attempted` counts orphans actually claimed for a
wire cancel in that run.

*Root cause.* `resolveOrphanCleanupPolicy` checked the raw string against
`/^[1-9]\d*$/` and then called `Number(raw)`. The pattern has no length
limit, so any all-digit string passed:
- a digit string long enough to overflow (400 nines, or a 1 followed by 309
  zeros) became `Infinity` or `1e308`, so `attempted >= Infinity` was never
  true and a single run cancelled **every** orphan it saw;
- values above 2^53 became unsafe, rounded integers;
- nothing capped the value at all, so `1000000` was accepted as-is.

Two further gaps sat on the same path:
- a non-string value (for example a number or `null` from a
  programmatically built configuration) silently took the default instead of
  being refused;
- the service stored whatever object it was given as `orphanPolicy` and
  read `maxCancellationsPerRun` from it without checking that it was a
  genuine configuration-issued policy, so a structural look-alike carrying
  `Infinity` bypassed both the issuer check and any parser fix.

*Remediation.* One validation boundary, and one invariant enforced at it:
- **Hard ceiling.** `MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING = 20`. None
  existed before. 20 is 4x the default of 5, and it caps one run's
  worst-case sequential cancel wire time at 20 x the 15 s default request
  timeout, about 5 minutes. Orphans beyond the ceiling are not lost: each
  stays durably recorded and blocking, and the next run attempts the next
  batch.
- **One parser.** Absent (`undefined` or the empty string, exactly as the
  enable flag treats them) takes the default of 5. Otherwise only canonical
  decimal digits are accepted: no sign, leading zero, whitespace, exponent,
  or fraction. The string's length is checked **before** any numeric
  conversion, so an overflowing digit string never reaches `Number`. The
  result must then satisfy `isValidMaxOrphanCancellationsPerRun`: a safe
  integer with `1 <= value <= 20`. Anything else, including a non-string
  value, a value above the ceiling, and every exponent form, returns
  `DISABLED` with the new reason `MALFORMED_MAX_PER_RUN`. It is never
  clamped and never falls back to the default.
- **The policy constructor re-checks the same invariant**, so no issued
  `OrphanCleanupPolicy` can hold an invalid limit.
- **The service accepts only a genuine policy.** It reads the record through
  `OrphanCleanupPolicy.read` at construction and throws
  `LIVE_EXECUTION_DISABLED` for anything else, the same construction-time
  refusal `maxSnapshotAttempts` uses. After that it holds only the validated
  record.

*Fail-closed behaviour.* An invalid ceiling issues no policy, so the
composition root wires no cancellation capability. Orphans are still
recorded, `RECON_ORPHAN_CLEANUP_DISABLED` blocks the account, and nothing is
cancelled.

*Unchanged.* Claim then arm then wire (F18-26), sticky `CANCEL_AMBIGUOUS`
(F18-25), single-finding suppression (F18-29), F18-06 operator resolution,
crash recovery (which never sends a wire call), the account-continuity
posture, the schema, and the migrations are unchanged. The per-run budget
resets with each run, as it always has. A crash mid-run followed by a
restart cannot exceed the limit within the new run, and cannot resend the
cancel that was in flight: recovery turns that one into sticky
`CANCEL_AMBIGUOUS`.

*Proof.* `tests/unit/execution/live/reconciliation/orphan-ceiling.test.ts`
(91 cases):
- the dangerous-input matrix, as strings and non-strings;
- the valid matrix and the ceiling / ceiling + 1 boundary;
- refusal of forged policies at service construction;
- service-level proof, with more eligible orphans than the ceiling, that
  exactly the configured number of wire cancels start per run, including
  with ambiguous outcomes and across a crash and restart.

One architecture pin adds that `LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN` is read
in exactly one source file. At the time of Wave C2, F18-10 remained open
pending independent review. **The Wave C2 independent review has since
returned PASS: F18-10 is CLOSED/PASS.**

---

## 14. Live mutation barrier integration

The barrier runs in `LiveExecutionRuntime` **before** the Phase 17 authority
mint, on all three normal mutation paths:

- `openLive` → `CREATE`
- `cancelLive` → `CANCEL`
- `closeLive` → `CLOSE`, **plus** the pre-existing
  `requireAuthoritativeLivePosition` check, which is still performed
  independently rather than assumed from the barrier.

It also gates `syncLive` (checked as `CREATE`), which is read-only at the
venue but writes durable order state.

It does **not** gate reconciliation-owned orphan cancellation, which runs
inside `reconcileAccount` through `GatewayOrphanCancellation` and is bounded
by its own policy and fencing instead (§13). That path grants no normal
mutation authority.

It is an **additional** gate, never a replacement. Every Phase 17 enablement,
research, kernel, risk-admission and position-ownership check still runs exactly
as before; the barrier can only refuse a mutation, never authorize one.

**[Wave B4 / F18-27] As of this wave, the barrier refuses every mutation on
all three paths, unconditionally, regardless of reconciliation status.** All
three call `requireCurrentReconciliation`, which now requires
`ACCOUNT_CONTINUITY_PROVEN` (§6.4.4) in addition to every fencing/state check
it already performed — and nothing in this codebase can currently produce
that proof. This is not a narrowing of what the barrier protects against; it
is the same barrier, with one more precondition that happens to be
permanently unsatisfied today. See §6.4.4 for the full reasoning and the
inventory proving no shortcut exists.

**[Wave B5 / F18-28] That precondition cannot be forged by any caller.**
`requireCurrentReconciliation` has exactly 4 parameters — there is no
argument through which `production-runtime.ts` (or anything else) could pass
a value that changes the outcome. See §6.4.4's dedicated F18-28 paragraph for
the forgery matrix this was verified against.

---

## 15. Persistence

Five additive tables. No existing table is altered, nothing is backfilled, and
no exchange state is guessed during migration.

- **`live_reconciliation_state`** — the barrier row: status, current generation,
  current runtime epoch, healthy generation, blocking finding count, revision.
- **`live_reconciliation_run`** — one attempt per `(account, generation)`, unique;
  carries the owning epoch, the validated snapshot digest, and both read windows.
  On completion, `finding_count` is the **total** number of durable findings the
  run's completion proof covers (every unresolved finding last seen in that
  generation, blocking or not), and `blocking_finding_count` is the blocking
  subset only. The two are never conflated: a non-blocking finding
  (`VERIFIED_MATCH`, `SAFE_AUTHORITATIVE_ADVANCE`,
  `LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE`) counts toward the total and
  never toward the blocking count or the account's blocking state. A run that
  never completes (superseded or crashed) keeps both at their default of 0.
  Real-MySQL proof: `[C3-12a]`–`[C3-12e]` (F18-12).
- **`live_reconciliation_finding`** — one durable fact per content digest, with a
  `first_seen` / `last_seen` generation window and sanitized evidence only.
- **`live_orphan_venue_order`** — orphan observations plus the durable
  cancellation claim, keyed by exact venue order identity.
- **`live_position_ownership_share`** — proven per-instance ownership with its
  lineage digest and intent-id list.

All economic values are `DECIMAL(36,18)`, the repository-wide convention; the
migration declares no `FLOAT`, `DOUBLE`, or `REAL`. Provider and local times are
`BIGINT` epoch milliseconds and are labelled by authority. Both Phase 18 foreign
keys are explicitly named and use `RESTRICT`, so reconciliation history is never
cascade-deleted.

Migrations (three, all accepted and frozen, §15.1):

1. `prisma/migrations/20260921000000_phase18_reconciliation/` — the five tables
   above;
2. `prisma/migrations/20260921010000_phase18_wave_a2_crash_recovery/` — the
   three wire-arm columns plus their §4.4 conservative legacy backfill;
3. `prisma/migrations/20260922000000_phase18_wave_c1_orphan_resolution/` — the
   Wave C1 (F18-06) forward migration: the `live_orphan_cancel_resolution`
   audit table and the additive `CANCEL_AMBIGUOUS_RESOLVED` enum value.

`npm run verify:migration:phase18` applies every migration to a disposable
MySQL database and diffs it against the datamodel: **no Phase 18-owned object
differs.** The same whole-schema diff still reports the two older, untouched
foreign-key differences on `paper_execution_intent` (Phase 14) and
`ranking_result` (Phase 15). Phase 18 deliberately does **not** rewrite that
pre-existing drift, and an architecture test asserts the migration never names
those tables.

### 15.1 Migration freeze discipline (F18-19)

- **An accepted migration is immutable.** All three Phase 18 migrations above,
  and every earlier migration, are accepted. Their bytes are pinned by SHA-256
  (over CRLF-normalized text, so a Windows and a Unix checkout of the same
  committed file agree) in `tests/architecture/phase18-migration-freeze.test.ts`.
  The Wave C1 migration's digest is
  `14272259dc91d1a1c63325f47bf073b75e6a85583f3907de3c11b935e86cebf7`.
- **Any later schema or persistence correction is a NEW forward migration**,
  in a new directory whose timestamp sorts after every accepted one. The same
  test fails for a back-dated or interleaved directory. Wave C1 is the model:
  it changed the schema by adding `20260922000000_…`, not by editing the Wave A
  migrations.
- **Never edit a frozen migration to make parity or a test pass**, and never
  "fix" a failure of the freeze test by updating its pinned digest. Restore the
  migration and add a forward migration instead.
- **The parity scripts do not authorize rewriting history.**
  `verify:migration:phase17` and `verify:migration:phase18` only apply the
  migrations to a disposable database and diff the result against the
  datamodel. They write, reset, or regenerate nothing, and the freeze test pins
  that too. A parity failure means the datamodel and the migrations disagree;
  the answer is a forward migration, or correcting the datamodel.
- **Known unrelated drift does not justify editing a frozen migration.** The
  `paper_execution_intent` / `ranking_result` foreign-key name differences
  predate Phase 18. If they are ever corrected, that is a forward migration
  owned by whoever takes it on, not an edit to the Phase 14 or Phase 15
  migrations.

---

## 16. Security

- No reconciliation file imports `node:http`/`https`/`net`/`tls`, Axios, fetch,
  a signer, or any CoinDCX module — proven over the transitive import graph.
- No reconciliation file names a CoinDCX endpoint path, an auth header, or a
  credential configuration key.
- Finding evidence passes `assertCredentialFree` at construction and is then run
  through the shared redactor, so a developer who attaches a credential-shaped
  key at any depth gets a hard failure, not a redacted log line.
- The schema declares no column whose name suggests credential material, and no
  raw provider payload column exists.
- Tested with hostile provider data that tries to smuggle credential-looking
  values through free-text venue fields: no persisted row and no log line
  carries key, secret, signature, or authorization material, and the run still
  fails closed.
- **A missing Phase 18 Prisma reconciliation delegate fails closed (F18-15,
  Wave A2 HIGH).** `assertReconciliationFence` (`src/execution/live/repository.ts`)
  used to infer "this is a harmless unit-test transaction double" from the
  STRUCTURAL absence of a `liveReconciliationState` Prisma delegate on the
  transaction object, and silently skipped the fence when that inference
  fired. Any accidental mismatch in production between the generated Prisma
  client and the deployed schema — a stale client, a partially-applied
  migration — would have hit that exact branch and silently disabled Phase 18
  fencing instead of blocking live mutation. The fence now recognizes ONLY an
  explicit `LIVE_EXECUTION_TEST_TRANSACTION` symbol marker that a real Prisma
  client or interactive transaction can never carry; its absence is what
  makes the fence fail closed by default, on every mutation path
  (`claimDispatch`, `armDispatchWire`, `commitState`,
  `applyObservationAtomically`, `claimCancel`, `armCancelWire`,
  `completeCancelAttempt`, `markExpiredDispatchUnresolved`,
  `commitReconciledState`), with the deterministic
  `LIVE_RECONCILIATION_REQUIRED` code and zero durable reservation or wire
  mutation. `tests/unit/execution/live/reconciliation-fence-fail-closed.test.ts`
  proves it directly.
- **Contradictory durable wire-armed state fails closed (F18-18, Wave A3
  LOW).** The valid-state matrix: `dispatchWireArmed` may be `true` ONLY while
  `state === 'DISPATCH_RESERVED'`; `cancelWireArmed` (`live_order`) may be
  `true` ONLY while `cancelState === 'CANCEL_RESERVED'`; the orphan
  equivalent may be `true` ONLY while `cancelState === 'CANCEL_CLAIMED'`.
  Every legitimate write path that leaves the owning state now explicitly
  clears the corresponding flag — `applyLiveOrderObservation`,
  `markSubmissionAmbiguous`, `markRejected`, `releaseDispatchClaim`,
  `reclaimDispatchAfterCrash`/`reclaimCancelAfterCrash`,
  `completeCancelAttempt`, `markExpiredDispatchUnresolved`, and
  `completeOrphanCancellation` — so no code path can produce a row that
  violates the matrix. `toStateRecord` (`src/execution/live/repository.ts`)
  and `toOrphanRecord` (`src/execution/live/reconciliation/repository.ts`)
  validate the matrix on every single durable read; a row that violates it
  anyway — direct SQL, a future regression, replication corruption — is
  never silently accepted or coerced, and fails closed with
  `LIVE_DURABLE_INTEGRITY_VIOLATION`, exactly like a sealed-content-digest
  mismatch. Proven by the full combinatorial matrix in
  `tests/unit/execution/live/wire-armed-integrity.test.ts` and by
  representative real-MySQL corrupted-row cases (direct SQL, bypassing the
  repository) in the Wave A3 §F18-18 suite.

---

## 17. Crash injection

Tested boundaries: after the ownership claim; after the exchange snapshot read;
after one order is reconciled; before transaction commit; after a durable
mutation claim but before the venue response; after the venue response but
before projection persistence; during `live_position` materialization; during
reconciliation completion; **after a local dispatch/cancel/orphan-cancel
reservation but before its durable wire-arm; and after the wire-arm but
before response persistence** (§4.3, F18-14).

The recovery argument is uniform and does not depend on process memory: **the
only write that can unblock an account is `completeRun` committing HEALTHY for
the current generation of the current runtime epoch.** A run that dies anywhere
before that leaves the account `RUNNING` — which the barrier treats as blocked —
and the next start claims a strictly newer generation that fences the dead one
out and marks it `ABANDONED`.

---

## 18. Paper/live isolation

Paper execution does not depend on CoinDCX live reconciliation. Architecture
tests prove that no file under `src/execution/**` outside `live/`, and no
upstream analytical layer, reaches the reconciliation tree; that the paper
production runtime reaches neither reconciliation nor live mutation; and that
the Phase 14 paper reconciler and the Phase 18 live reconciler share no module.

---

## 19. Pair genericity

No BTC/ETH/SOL/XRP-specific executable logic exists in the reconciliation tree
or its evidence adapter, enforced by a word-boundary architecture scan over
comment-stripped source, plus a check that no file compares a pair against a
literal. The real-DB suite reconciles a second pair through identical code, and
the Phase 16 protected-core invariants continue to pass.

---

## 20. How to enable orphan cancellation (and why it is off)

Phase 18 adds these to the Phase 17 configuration. All Phase 17 requirements
still apply unchanged.

```
LIVE_ORPHAN_CANCELLATION_ENABLED=true            # the exact lowercase literal
LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST=<account id>[,<account id>…]
LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN=<integer 1..20>     # optional; default 5
```

`LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN` accepts only canonical decimal digits
from `1` to `20` (`MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING`). Unset or empty
means the default of 5. Any other value (a sign, a leading zero, whitespace,
an exponent, a fraction, or a value above 20) turns orphan cancellation
**off** with reason `MALFORMED_MAX_PER_RUN`. It is never clamped and never
replaced by the default (§13.5).

The shipped defaults are `false` and empty. With cleanup off, an orphan still
blocks live trading — it is simply never cancelled automatically.

---

## 21. Known limitations and Phase 19 deferrals

**Not verified against the real venue.** Before any real reconciliation run, a
maintainer should confirm, read-only, outside this implementation:

1. real-venue serialization of the documented list-orders and positions responses;
2. the futures provider's actual page-size cap and account-scale pagination behaviour;
3. whether `updated_at` on a futures order is monotonic in practice, since the
   causal-ordering rule treats a future-dated event time as unusable;
4. the real magnitude of venue-versus-host clock skew, which drives the single
   submission-window allowance;
5. production error bodies and latency behaviour on both read paths.

**Deliberately absent:**

- **No atomic venue snapshot, and no ABA immunity.** Disclosed in §6 and
  corrected in Wave B2 (§6.2–6.4): repeated-read agreement detects movement
  still visible in the second read, but a fully-reverting transient event
  between reads is structurally invisible to any REST-polling protocol,
  regardless of read count. Phase 18's durable economic writes remain safe
  against this (they only ever act on the final agreed state), but the
  ACCOUNT may reach HEALTHY without Phase 18 having observed every venue-side
  event since the last reconciliation. See §6.4 for exactly what `HEALTHY`
  does and does not claim.
- **No automatic resolution of a provably-absent ambiguous create.** It becomes
  a manual-review finding; releasing the intent for retry is an operator decision.
- **No automatic resolution of an ambiguous create whose identity depends on
  an unobservable field.** A local `FILL_OR_KILL`/`IMMEDIATE_OR_CANCEL` time
  in force can never be automatically resolved against this evidence contract
  (§8, F18-21) — this is permanent, not merely "insufficient evidence today".
- **No CLOSE for a shared position.** Representational limit of Phase 17's
  single-owner `live_position` (§10.1).
- **No automatic repair of any conflicting economic history**, by design.
- **No background reconciliation poller.** Reconciliation is invoked explicitly
  at startup or by an operator; a periodic re-reconciliation loop, funding
  accounting, liquidation/maintenance-margin modelling, shadow-mode analytics,
  and automatic promotion to LIVE all remain later-phase scope.
- **The Phase 17 durable-integrity boundary is unchanged.** A writer with full
  SQL access who rewrites content and its digest together remains outside the
  threat model, exactly as Phase 17 states.

**Wave A2 fixed exactly two findings — F18-14 (crash-recovery deadlock, §4.3)
and F18-15 (fail-open fencing, §16) — and no others. Wave A3 fixed exactly
three more — F18-16 (legacy migration safety, §4.4), F18-17 (a Phase 17
real-MySQL test-fixture gap, unrelated to production behaviour), and F18-18
(contradictory wire-armed state now fails closed, §16) — and no others.**

**Wave B claimed four findings fixed — F18-03, F18-04, F18-08, F18-09 —
but independent review found F18-03, F18-04, and F18-09 insufficient and
identified two new BLOCKERs (F18-20, F18-21) and one HIGH (F18-22) introduced
or exposed by Wave B's own changes. F18-08 was independently confirmed PASS
and was NOT touched again.**

**Wave B2 remediated six items. Independent review of Wave B2 accepted five
as PASS — F18-03, F18-08, F18-09, F18-20, F18-22 — and found F18-04 "not
proven" and F18-21 still unsafe (the GTC/UNSPECIFIED exemption), and
identified two new findings introduced or exposed by Wave B2's own changes:
F18-23 (HIGH) and F18-24 (LOW).**

- **F18-03 (broadened, §8.1)** — the completeness gate that Wave B applied
  only to ambiguous-create identity now ALSO applies to known-order
  advancement (this is the same fix as F18-20; the two findings share one
  remediation). **PASS.**
- **F18-08 (§8)** — missing venue leverage is not an exact match. **PASS,
  untouched since Wave B.**
- **F18-09 (broadened, §7.1/§6.3)** — extended to explicitly cover the F18-04
  correction's implications for what "stable" evidence can and cannot
  license. **PASS.**
- **F18-20 (§8.1)** — `reconcileIdentifiedOrder`'s known-venue-ID advancement
  path now checks `ordersProvenance.complete`. **PASS.**
- **F18-22 (§7.2)** — the evidence adapter's `maxPages` is now validated at
  construction, plus a zero-pages defense-in-depth check. **PASS.**

**Wave B3 remediates exactly four items and no others:**

- **F18-04 (formally closed, §6.4.1–6.4.3, Option B)** — Wave B2 corrected the
  documentation but did not formally answer "can a fully-reverted ABA event
  make `HEALTHY` unsafe for the operations it unlocks?" Wave B3 answers it:
  Option B (current-state reconciliation, history-sensitive durable state
  blocked). §6.4.2 enumerates every operation `HEALTHY` unlocks and what it
  actually depends on (none of them depend on venue-history continuity —
  Phase17's own transactional guards protect them). §6.4.3 is the
  history-sensitive predicate, proven to already be enforced by the existing
  per-order/per-position reconciliation pass. Tested directly: identical
  final REST-visible state, clean account reaches `HEALTHY`, history-sensitive
  account (a local `SUBMISSION_AMBIGUOUS` order) does not.
- **F18-21 (re-corrected, §8)** — Wave B2's GTC/UNSPECIFIED exemption is
  retracted. No local TIF value is exempt; automatic ambiguous-create
  resolution is unconditionally blocked until a genuinely authoritative
  provider TIF proof exists (§F18-24). The candidate-selection logic this
  superseded is preserved, tested, and load-bearing again the day that proof
  exists (`resolveAmbiguousCreateAgainstObservableCandidates`).
- **F18-23 (new, §6.5)** — confirmed production-blocking regression: the
  separability check was fed MERGED whole-bracket provenance windows, which
  overlap by construction under any real network latency, false-blocking a
  clean, stable account with `RECON_EVIDENCE_CAUSALITY_VIOLATION` on
  essentially every real call. Fixed at the call site: the check now uses the
  UNMERGED, genuinely-sequential final (B) read of each kind.
- **F18-24 (documented, §8.2)** — audited whether a TIF-like field could be
  safely mapped from the wire response. No independently-verified field name
  or semantics exist, so none was added; adding a speculative one would
  itself have been the kind of fabricated provider behavior this repository
  forbids. Documented the exact sequence required before one safely could be.

**Independent review of Wave B3 accepted seven items as PASS — F18-03, F18-08,
F18-09, F18-20, F18-21, F18-22, F18-23 — and found F18-04 FAIL (a
current-state-only argument does not by itself justify live-mutation
authorization once F18-27 is accounted for) and F18-24 FAIL (the "never
returns"-style absolute wording overstated what this project can prove about
an external, undocumented-beyond-what's-verified provider), and identified
three new findings: F18-25 (BLOCKER), F18-26 (BLOCKER), F18-27 (BLOCKER).**

**Wave B4 remediates exactly four items and no others:**

- **F18-25 (new, §13.1)** — a durable orphan `CANCEL_AMBIGUOUS` cancellation
  is now reasserted as a blocking finding at the start of EVERY generation,
  independent of whether the current run's fresh evidence still shows the
  orphan. Fixed in `#recoverOrphanCancelClaims` (`service.ts`); the
  reassertion uses the same finding content whether raised at the moment of
  ambiguity or reasserted later, so it dedups to exactly one durable row.
  Proven across 3 successive real-MySQL generations (`[B4-1]`).
- **F18-26 (new, §13.2)** — orphan cancellation now calls the repository's
  pre-existing `armOrphanCancelWire` (Wave A2, previously unwired) BEFORE the
  HTTP cancel call, restoring the same `unarmed => no wire; armed => never
  blind resend` guarantee every other Phase18 mutation class already had.
  Proven for legitimate cancel (`[B4-2]`), crash-before-arm (`[B4-3]`),
  crash-after-arm (`[B4-4]`), and stale-generation-race (`[B4-5]`) — all real
  MySQL.
- **F18-24 (wording corrected again, §8, §8.2)** — the prior wave's
  correction still contained absolute claims ("the response never returns
  TIF, for any record"). Replaced everywhere with the evidence-bounded form:
  no authoritative TIF field is documented in the verified provider contract
  available to this project. Runtime behavior is UNCHANGED — F18-21 still
  blocks unconditionally on the absence of verified evidence, never on a
  claim of structural impossibility.
- **F18-27 (new, §6.4.4)** — the confirmed race (a venue order appearing
  after the final REST read is invisible to that run, and no additional read
  closes the window) is accounted for, not "solved": a new
  `LiveAccountContinuityCapability` gate in `requireCurrentReconciliation`
  (the single production choke point every normal Phase 17 live mutation
  passes through) refuses to authorize ANY normal mutation from REST-only
  evidence, because no
  authoritative continuity mechanism exists anywhere in this codebase
  (inventoried, not assumed — §6.4.4). `HEALTHY` STATUS is unaffected and
  still means exactly what §6.4 says. F18-04's Wave B3 closure is
  consequently superseded at the authorization layer (§6.4.4's final
  paragraph) — its status-layer argument (§6.4.1–6.4.3) stands unchanged.

**Independent review of Wave B4 accepted F18-03, F18-04 (safety layer only —
§6.4.1's status-layer argument; the authorization layer remains open, see
below), F18-08, F18-09, F18-20, F18-21, F18-22, F18-23, F18-25, F18-26, and
F18-27 as PASS, and the Wave A/A2/A3 regression suite as PASS. It asked for
exactly three further fixes, all LOW/MEDIUM severity and none a safety
regression:**

**Wave B5 remediates exactly three items and no others:**

- **F18-24 (wording corrected a third time, §8.2)** — one absolute claim
  survived the Wave B4 correction pass, in `order-reconciliation.ts`'s
  `ambiguousCreateIdentityUnobservableReason` doc comment. Rewritten to the
  same evidence-bounded form used everywhere else, and — because this exact
  mistake recurred once already — now permanently enforced by an architecture
  test (`tests/architecture/phase18-reconciliation-boundary.test.ts`'s
  `P18-§24 F18-24` describe block) that bans the literal overclaim phrases
  from every Phase18 production source file, not merely this one instance.
- **F18-28 (new, §6.4.4)** — `requireCurrentReconciliation`'s Wave B4
  `continuityCapability` parameter was caller-suppliable: any caller could
  pass the literal `'ACCOUNT_CONTINUITY_PROVEN'` and mint a real
  authorization with zero actual continuity proof. Fixed by removing the
  parameter entirely rather than replacing it with a stronger token type — no
  production call site ever passed anything beyond the default, so there was
  nothing to preserve. `requireCurrentReconciliation` now has exactly 4
  parameters and reads `currentAccountContinuityCapability()` itself,
  consulting no caller-supplied value. Verified with a forgery matrix (the
  literal string, plain objects, prototype/`Object.create` constructions,
  `Symbol()`/`Symbol.for()`, a boxed `String`, `true`/`null`/`undefined`, all
  attempted as a raw 5th positional argument bypassing the compiler) at both
  the unit level and against a real, genuinely-fenced, database-minted
  HEALTHY authorization (`[B5-2]`).
- **F18-29 (new, §13.3)** — a durably `CANCEL_AMBIGUOUS` orphan still visible
  in fresh evidence could emit both the sticky `RECON_ORPHAN_CANCEL_AMBIGUOUS`
  finding and the generic `RECON_ORPHAN_VENUE_ORDER` finding for the
  identical underlying orphan — duplicate operator noise, not a safety gap
  (the account was correctly blocked either way). Fixed by suppressing the
  generic finding for any orphan already covered by a sticky ambiguity
  finding raised this same generation, from either the pre-existing-ambiguity
  path or the same-run first-discovery path. Proven not to weaken F18-25's
  stickiness or F18-26's wire-arm sequence: both remain independently tested
  and passing, unchanged by this wave.

**Independent review of Wave B5 accepted F18-24, F18-28, and F18-29 as PASS,
completing Wave B: independent review now regards Wave A as CLOSED/PASS and
Wave B as CLOSED/PASS for safety (F18-03, F18-04-safety-layer, F18-08, F18-09,
F18-20 through F18-29 all accepted). It asked for exactly one further item,
outside Wave B's own scope:**

**Wave C1 remediates exactly one item and no others:**

- **F18-06 (new, §13.3–§13.4)** — a durable orphan `CANCEL_AMBIGUOUS`
  cancellation is sticky and fail-closed by design (F18-25) and correctly has
  no automatic resolution path, but until this wave it ALSO had no
  AUTHORITATIVE, IN-BAND way for a human to ever resolve one — an account that
  reached this state stayed `MANUAL_REVIEW_REQUIRED` permanently, with no
  legitimate way forward. Fixed by adding a durable, audited, unforgeable
  operator-resolution path (§13.4): a new terminal `CANCEL_AMBIGUOUS_RESOLVED`
  state (structurally unreachable from any automatic write path, and never
  reusing `NONE` or a system-proved outcome value), an append-only audit
  table (`live_orphan_cancel_resolution`), and a distinct, revision-fenced,
  single-target capability (`OrphanAmbiguityResolutionRequest`,
  `orphan-resolution.ts`) — deliberately separate from
  `LiveReconciliationAuthorization` and from live-mutation authorization
  (§F18-27/§F18-28 are completely unaffected). A resolved orphan reappearing
  at the venue raises a stronger, dedicated finding
  (`RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION`) rather than being silently
  reinterpreted by the old resolution or silently ignored. F18-25's
  stickiness, F18-26's wire-arm sequence, and F18-29's dedup are all proven
  unchanged and still independently passing.

**Independent review of Wave C1 accepted F18-06 as PASS — the resolution
vocabulary, the state-machine addition, the audit record, the
`OrphanAmbiguityResolutionRequest` capability, its account/orphan/revision
binding, and its complete separation from live-mutation authorization were
all accepted. It asked for exactly two further items, both LOW severity and
neither a safety regression:**

**Wave C1.1 remediates exactly two items and no others:**

- **F18-30 (§13.4.2)** — the Phase16 "zero SOL-specific models/fields/enums"
  schema architecture guard used a bespoke word-boundary regex
  (`/(^|[a-z0-9])Sol([A-Z]|$)/`), introduced while fixing a false positive on
  the legitimate model name `LiveOrphanCancelResolution`. That regex was
  narrower than intended: it missed real SOL/Solana-specific names in several
  casings (`SOLCandle`, `solCandle`, `Solana`, `SolanaCandle`,
  `SOLANAPosition`, `solanaOrder`). Fixed by reusing this same test file's
  own already-correct, already-tested token-aware identifier splitter
  (`identifierWords`, which `isSuspiciousCoinIdentifier` already relies on
  for BTC/ETH/SOL ticker-hardcoding detection elsewhere in this file) instead
  of a bespoke regex, with a new SOL/Solana-specific token set kept separate
  from the shared BTC/ETH/SOL ticker set so that unrelated detection is
  untouched. An explicit reject/allow test matrix now pins both directions.
- **F18-31 (§13.4.1)** — `resolvedBy`'s documentation did not state clearly
  enough that it is a caller-asserted audit label, not an authenticated
  operator identity — there is no operator-auth transport in this phase for
  it to be authenticated by. Fixed by making that boundary explicit in
  `orphan-resolution.ts`'s doc comments and in this document (§13.4.1), and
  by adding a permanent architecture check
  (`P18-§F18-31` in `phase18-reconciliation-boundary.test.ts`) that bans the
  specific affirmative overclaim from ever reappearing. This wave
  deliberately does NOT add authentication, RBAC, a dashboard route, an API
  endpoint, or a CLI tool — no operator transport exists yet for any of those
  to protect.

Neither F18-30 nor F18-31 touches F18-06's runtime behavior in any way: the
orphan state machine, `OrphanAmbiguityResolutionRequest`, its
account/orphan/revision binding, the two resolution outcomes, the schema, and
the migration are all byte-for-byte unchanged by Wave C1.1 — only a test's
detection logic (F18-30) and documentation/comments (F18-31) were corrected.

**Independent review of Wave C1.1 found it not yet closed: F18-30 and F18-31
were both remediated, but review of that remediation itself surfaced two
further items, both LOW severity and neither a safety regression:**

**Wave C1.2 remediates exactly two items and no others:**

- **F18-32 (§13.4.3)** — the Wave C1.1 fix for F18-30 corrected the SOL/Solana
  schema guard's MODEL and ENUM checks to use the whole-word tokenizer
  (`isSolSpecificIdentifier`), but left its FIELD check comparing a field's
  first token against exactly three literal strings
  (`sol`/`solUsdt`/`solana`), so a field named e.g. `solPosition`,
  `SOLPosition`, or `SolanaCandle` — anything not equal to one of those three
  exact strings — still silently bypassed the guard. Fixed by reusing the
  same tokenizer for fields too (`isSolSpecificSchemaFieldLine`), not a new
  bespoke matcher and not a reversion to a bare `sol` substring test. Proven
  against 27 synthetic rejected field names (including underscore- and
  digit-separated and prefixed forms) and 11 synthetic allowed ones, plus the
  real schema (still zero coin-specific fields today), plus an explicit
  BTC/ETH regression check proving the separate, untouched ticker-hardcoding
  detector still behaves identically.
- **F18-33 (§13.4.4)** — the F18-31 architecture guard bans a short list of
  exact overclaim phrases; independent review correctly pointed out that any
  differently worded false claim making the identical assertion bypasses an
  exact-phrase list trivially. Fixed by adding a second, proximity-based
  guard (`findUnsafeResolvedByClaims`) alongside the existing phrase ban
  (kept, not removed): it flags any `resolvedBy`/`resolved_by` mention found
  near an authentication/verification/trust/"operator identity"/"principal"
  concept word UNLESS the same nearby text also contains an explicit negation
  or an explicit future-transport qualifier. Proven adversarially against 6
  synthetic false claims (none reproduced verbatim in this document — see the
  test file), 7 synthetic legitimate negations/future-statements, a
  negation-laundering adversarial case, and the real scope
  (`orphan-resolution.ts`, `ports.ts`, `repository.ts`, this document).

Neither F18-32 nor F18-33 touches F18-06's runtime behavior, F18-30's fix, or
F18-31's own wording in any way beyond what was needed to fix the guard
itself: the orphan state machine, `OrphanAmbiguityResolutionRequest`, its
account/orphan/revision binding, the two resolution outcomes, the schema, and
the migration remain byte-for-byte unchanged since F18-06 was accepted.

**Independent review of Wave C1.2 accepted F18-32 as PASS, but found F18-33's
own remediation (the proximity-based guard) not yet closed: three further
items, all LOW severity, none a safety regression, all concerning the guard's
own precision rather than anything about `resolvedBy` itself:**

**Wave C1.3 remediates exactly three items and no others, all within the same
`findUnsafeResolvedByClaims` guard:**

- **F18-34 (§13.4.4)** — the Wave C1.2 guard's concept vocabulary was
  effectively the single exact phrase "authorized operator" (plus
  "authenticat"/"verifi"/"trusted"/"principal"), so a claim tying the audit
  label to a different but equally-false concept — an authorized *user*, a
  trusted *administrator*, an approving *principal* — bypassed it (see the
  test file for the exact synthetic wording; it is not reproduced here for
  the same reason §13.4.1's own overclaim phrases aren't). Fixed by widening
  the concept match to prefix-cover every inflection of
  authenticate/verify/trust/authorize/authorise/approve, plus
  "principal"/"user"/"administrator"/"admin"/"operator identity"/"human
  identity", proven against 14 synthetic unsafe current claims and 8
  synthetic legitimate same-clause negations.
- **F18-35 (§13.4.4)** — the Wave C1.2 guard's future-design recognition
  covered only two fixed phrases ("future...transport", "once authentication
  exists"), so several legitimate future-transport phrasings independent
  review supplied — "future authenticated transport should populate
  resolvedBy...", "when a protected operator transport is added,
  resolvedBy must come from..." — were incorrectly flagged. Fixed by
  widening future-marker recognition, proven against 7 synthetic legitimate
  future-design statements and 3 sentences that mix a safe current clause
  with a safe future clause in one sentence (a plain current/future
  contrast must not be rejected merely because auth words appear somewhere
  in it).
- **F18-36 (§13.4.4)** — the more serious defect: the Wave C1.2 guard shared
  ONE window per mention, so a negation or future marker belonging to one
  claim could "launder" a completely separate, unqualified claim merely by
  landing in the same window — across sentences, and even across "but"/
  "however" within a single sentence. Fixed by replacing the shared window
  with sentence/clause-scoped reasoning (§13.4.4): each clause is judged
  strictly on its own local content, so a neighboring clause can never
  supply a qualifier it doesn't itself contain. Proven against 3
  cross-sentence laundering cases and 2 same-sentence contradictory-clause
  cases, all of which the Wave C1.2 window design would have missed.

None of F18-34/F18-35/F18-36 touches F18-06's runtime behavior, or any
earlier wave's fix: the orphan state machine, `OrphanAmbiguityResolutionRequest`,
its account/orphan/revision binding, the two resolution outcomes, the schema,
the migration, F18-30's field-name guard, and F18-31's exact-phrase ban all
remain byte-for-byte unchanged since they were last accepted.

**The Wave C1.3 closure review accepted F18-33, F18-34, F18-35, and F18-36
as PASS, completing F18-30 through F18-36 as CLOSED/PASS. It surfaced one
further LOW item, outside those three findings' specified scope:**

**Wave C1.4 remediates exactly one item and no others:**

- **F18-37 (§13.4.4)** — the Wave C1.3 clause-scoped guard's boundary set
  was incomplete. A colon, an em/en dash, a spaced hyphen, a parenthetical,
  or a contrastive transition it did not list ("yet", "although", "though",
  "nevertheless", "on the other hand") left two independent claims in one
  clause, so a negation belonging to the first still covered the second.
  Fixed by scoping each qualifier to the smallest local claim: parentheticals
  evaluated separately, a widened boundary/transition set, per-mention
  splitting when a segment holds several `resolvedBy` mentions, negations
  counted only when they precede the claim's first concept word, and a
  present-tense anchor overriding a future marker. Proven against 22 new
  synthetic unsafe and 15 new synthetic safe cases, with every earlier case
  still passing. One dash-set aside in §13.4.4 that had passed the Wave C1.3
  guard only through this defect was reworded to name the false claim
  without restating it; no other documentation or source change was needed.

F18-37 touches no runtime file, schema, or migration; F18-06, F18-30's
field-name guard, and F18-31's exact-phrase ban are unchanged.

**Independent review of Wave C1.4 did not close F18-37.** It raised two
MEDIUM findings in the same guard, **F18-38** and **F18-39** (§13.4.4). Wave
C1.5 remediated both. **The Wave C1.5 closure review returned FAIL**: every
required C1.5 case passed, but targeted probes of the same two invariants
produced three MEDIUM findings, one of them a regression introduced by C1.5:

- **F18-40 (§13.4.4)** — the F18-38 fix dropped an unrelated leading clause
  only after a bare comma; joined by "and"/"or"/"then", or with no comma, it
  still qualified a separate present-tense claim.
- **F18-41 (§13.4.4, regression)** — C1.5 made any modal verb anywhere in the
  local claim count as a future marker, so a trailing phrase about another
  subject excused a complete present-tense assertion that C1.4 had flagged.
- **F18-42 (§13.4.4)** — F18-39's continuation inheritance used a closed verb
  list, so continuations built on a copula, "contains", "holds", "carries",
  "equals", or an unlisted adverb were still dropped.

**Wave C1.6 remediates exactly F18-40, F18-41, and F18-42 and no others**, in
the same guard: governed-object scoping replaces the connector rule, future
evidence must govern the predicate, and continuation inheritance is reversed
(inherit unless the clause opens with its own subject). It changes no runtime
file, schema, or migration.

**The Wave C1.6 independent review returned FAIL** because of one new
finding, and accepted **F18-38, F18-39, F18-40, F18-41, and F18-42 as review
PASS**:

- **F18-43 (§13.4.4, MEDIUM)** — the C1.6 quantified-mention refinement
  returned safe for any claim containing "a/the/each/every … mention", so a
  real identity assertion whose subject used the word "mention" was never
  evaluated.

**The final C1 guard cleanup remediates exactly F18-43 and no other**, in the
same guard: the early return is replaced by classifying the predicate after
the mention (§13.4.4), with 44 permanent cases including a bounded
same-invariant sweep. It changes no runtime file, schema, or migration.

**Status after the final C1 guard cleanup: F18-38, F18-39, F18-40, F18-41,
and F18-42 are review PASS; F18-37 and F18-43 are OPEN.** F18-43 is in
remediation by this cleanup, which has NOT itself been independently reviewed
as of this writing; F18-37 remains open pending final independent closure.
This document does not claim PASS for F18-37 or F18-43, and does not claim
Phase 18 complete.

**The C1 final closure review returned PASS: F18-37 through F18-43 are
independently CLOSED/PASS.** That completes F18-30 through F18-43.

**Wave C2 remediates exactly F18-10 and no other finding:**

- **F18-10 (§13.5, HIGH)** — the orphan cancellation per-run ceiling was
  parsed with an unbounded digit pattern followed by `Number`, so it could
  become `Infinity`, an unsafe integer, or any arbitrarily large value, and
  the service bound on cancellations per run could then never be reached.
  The service also read the ceiling from an unverified policy object. Fixed
  by one parser with a length check before conversion, an explicit hard
  ceiling of 20, the same invariant re-checked by the policy constructor,
  and a genuine-policy check at service construction. An invalid ceiling
  turns cleanup off (`MALFORMED_MAX_PER_RUN`) rather than clamping or
  defaulting. No schema or migration change.

**Status after Wave C2: F18-10 is OPEN, pending independent review of Wave
C2.** This document does not claim PASS for F18-10 and does not claim Phase
18 complete. F18-11, F18-12, F18-13, and F18-19 are untouched by Wave C2.

**The Wave C2 independent review returned PASS: F18-10 is CLOSED/PASS.**

**Wave C3 remediates exactly F18-11, F18-12, F18-13, and F18-19**, with no
runtime, schema, or migration change. This repository holds no copy of the
original review text for these four (only the one-line titles below), so
each was reconstructed from the current code and documentation:

- **F18-11 (MEDIUM) — incomplete real-MySQL adversarial matrix.** Most
  required invariants already had real-MySQL proof: generation fencing and
  stale-lease refusal on every write path (`[1]`, `[2]`, Wave A), crash and
  restart persistence (`[15]`, `[16]`, A2, B4), idempotent reruns (`[3]`,
  `[13]`, `[14]`, B-series), orphan claim/arm/ambiguity (`[7]`, `[8]`, B4),
  resolution-versus-resolution (`[C1-4]`), reappearance (`[C1-5a]`, `[C1-7]`),
  and ambiguous known orders (`[4]`, `[5]`, B-series). The gaps: `[1]` raced
  only `claimGeneration`, never two COMPLETE runs; cross-account isolation was
  proven only for resolution (`[C1-3]`) and at the credential check, never for
  concurrent reconciliation or a forged cross-account lease; resolution was
  never raced against a reconciliation run; and no test read the durable run
  counters. Wave C3 adds 10 real-MySQL cases: `[C3-11a]` (two complete runs
  racing with orphan cleanup: one authoritative history, at most one wire
  cancel, never resent), `[C3-11b]` (two complete runs racing a fill advance:
  exactly one durable economic event), `[C3-11c]` (two accounts reconciled
  concurrently with an identical orphan id: fully independent), `[C3-11d]`
  (account A's genuine lease and authorization can never claim, arm, or
  complete account B's orphan), `[C3-11e]` (operator resolution racing a
  reconciliation run), and `[C3-12a]`–`[C3-12e]` below. Each race runs three
  rounds over two independent connections and logs its interleaving. Three
  things are kept distinct here: (1) this coverage expansion is the F18-11
  remediation; (2) `[C3-11c]` DISCOVERED a new runtime defect, F18-44 below,
  and in Wave C3 it asserted F18-44's fail-closed contract rather than hide
  it; (3) Wave C3.1 remediated F18-44, and `[C3-11c]` now requires both
  accounts to complete in every one of its five rounds, alongside the new
  `[C3.1-1]`/`[C3.1-2]`.
- **F18-12 (LOW) — run finding-count accounting.** The defect as summarized
  (`finding_count` storing the blocking count) is **not present in the
  current code**: `completeRun` writes `finding_count` = the total durable
  findings covered by the completion proof and `blocking_finding_count` = the
  blocking subset. What was missing was any proof or statement of that: no
  test read either column. Wave C3 adds the real-MySQL matrix `[C3-12a]`–
  `[C3-12e]` (0/0, informational-only, blocking-only, mixed total above
  blocking with state driven only by the blocking subset, and deterministic
  reruns) and documents the contract in §15.
- **F18-13 (LOW) — documentation overclaim.** Corrected: the introduction
  said Phase 18 "answers" whether the database tells the truth and lets
  trading continue once it has, which REST-only evidence cannot support; §1
  called the Phase 2 read path "already-production-verified" (Phase 2 records
  one limited live observation, not verification of Phase 18's use of it) and
  pointed at the wrong section; §13.4.3 called a finite adversarial sample
  "proven correct" for all names; and `docs/ARCHITECTURE.md` §2.21 said
  evidence "proves completeness" and that trading resumes once authoritative
  evidence establishes safety. §1 now opens with the current status and a
  proof-category legend (STRUCTURALLY / UNIT / REAL-MYSQL VERIFIED, PROVIDER
  CONTRACT / DOCUMENTATION EVIDENCE, LIVE-VENUE, OPERATIONAL READINESS).
- **F18-19 (LOW) — migration freeze discipline and accounting.** §15 listed
  only two of the three Phase 18 migrations, and no rule or test protected
  accepted migrations; the parity scripts would pass an edit made to a frozen
  migration together with the schema. §15.1 now states the rule, and
  `tests/architecture/phase18-migration-freeze.test.ts` pins every accepted
  migration's digest, allows new migrations only as later-timestamped forward
  migrations, and pins that the parity scripts never write, reset, or
  regenerate.

**New finding opened by Wave C3** (the record as written at discovery; its
remediation follows below):

- **F18-44 (LOW at discovery, since classified MEDIUM) — cross-account
  deadlock in the first generation claim.**
  Reproduced by `[C3-11c]` in about 40% of runs (6 of 15, then 5 of 12 before
  the test was made to assert the contract). Phase 18 repository transactions
  run at MySQL's default REPEATABLE READ. For an account with no runs yet,
  `claimGeneration`'s `updateMany({ accountId, status: 'RUNNING' })` on
  `live_reconciliation_run` matches nothing, so InnoDB takes a gap lock on the
  index range where the other account's first run would go. Both transactions
  then insert their first run into each other's locked gap, and MySQL rolls
  one back as a deadlock. It is **fail-closed**: the losing claim rolls back
  entirely, so that account stays `RECONCILIATION_REQUIRED` with no run, no
  orphan row, and no wire call, and the other account is unaffected. But
  reconciling one account can make an unrelated account's reconciliation fail,
  and nothing retries it. `[C3-11c]` asserts exactly that contract and that a
  plain retry converges. Candidate remediations, not applied here: a bounded
  retry of the claim transaction on a MySQL deadlock (it is fully rolled back,
  so a retry is safe), or `ReadCommitted` isolation for it, as the Phase 14
  persistence layer already uses to avoid gap locks. Either changes accepted
  Wave A runtime code and deserves its own review.

**Status after Wave C3: F18-10 is CLOSED/PASS. F18-11, F18-12, F18-13, and
F18-19 are remediated and OPEN pending independent review of Wave C3. F18-44
is OPEN and not remediated.**

**Wave C3.1 remediates exactly F18-44 and no other finding** (§4.5), before
the Wave C3 independent review:

- **Reproduced independently first.** A standalone script raced
  `claimGeneration` for 40 pairs of brand-new distinct accounts over two
  connections: 28 pairs deadlocked. InnoDB's deadlock report showed both
  transactions holding an exclusive next-key lock on the supremum of
  `live_reconciliation_run_account_generation_unique` (taken by the
  `updateMany` over an account with no runs) while each run `INSERT` waited
  for an insert-intention lock there. That refines the index named in the
  discovery entry above. The application received
  `PrismaClientKnownRequestError` code `P2034`, and every victim was fully
  rolled back (no run row, generation 0, `RECONCILIATION_REQUIRED`).
- **Fix.** A bounded retry of the whole claim transaction: at most three
  attempts, only on `P2034` matched by class and code, each attempt a fresh
  transaction that re-reads state; exhaustion fails closed with
  `LIVE_PERSISTENCE_FAULT` and the Prisma error as its cause. No isolation
  change, no schema or migration change.
- **Evidence.** After the fix the same script surfaced 0 failures across 240
  claims (9 to 30 retries per 80, all succeeding on the second attempt), and
  11 real-MySQL suite runs retried 88 deadlock victims with no third attempt
  and no deadlock reaching a caller. 21 unit cases and 2 new real-MySQL cases
  (`[C3.1-1]`, `[C3.1-2]`) plus the strengthened `[C3-11c]` pin the behaviour.

**Status after Wave C3.1: F18-10 is CLOSED/PASS. F18-11, F18-12, F18-13, and
F18-19 (Wave C3) and F18-44 (Wave C3.1) are remediated and OPEN pending
independent review.** This document does not claim PASS for any of them and
does not claim Phase 18 complete.

**The Wave C3 + C3.1 independent review returned PASS: F18-11, F18-12,
F18-13, F18-19, and F18-44 are CLOSED/PASS.** F18-01 through F18-44 are all
closed.

**Wave C4 remediates exactly F18-45 and no other finding**, as documentation
and source-comment corrections only (no executable, schema, or migration
change):

- **F18-45 (LOW) — safety-contract documentation contradicted implemented
  behavior.**
  - *Ambiguous-create time-in-force.* `docs/ARCHITECTURE.md` §2.21 said an
    ambiguous create adopts a unique matching candidate and that a missing
    time-in-force "only widens matching, so it can never cause a wrong order
    to be adopted" (and still described leverage as matched "where both sides
    state it"). The implemented rule (`resolveAmbiguousCreate`, F18-21) refuses
    automatic identity adoption for every ambiguous create, before any
    candidate is considered, with the `MANUAL_REVIEW_REQUIRED` finding
    `RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE`; no venue identity is
    bound and no economic effect is applied. §2.21 now says exactly that.
  - *Normal mutation versus orphan cleanup.* This document, `ARCHITECTURE.md`,
    and comments in `barrier.ts` said the continuity barrier is the choke
    point "every live mutation" passes, that only Level 3 may authorize "a
    mutation", and that no REST-only result may authorize "a live mutation".
    In fact `requireCurrentReconciliation` gates the normal Phase 17 paths
    (`openLive`, `cancelLive`, `closeLive`, and the venue-read-only
    `syncLive`), while an explicitly configured reconciliation-owned orphan
    cancellation runs inside `reconcileAccount` without passing it. That
    wording is now scoped to normal Phase 17 mutation, and the orphan path is
    described consistently as a separate, bounded remediation path (policy,
    allowlist, 1..20 ceiling, generation fencing, claim → arm → wire, sticky
    ambiguity) that grants no trading authority, proves nothing about
    continuity, and does not make live authorization ready (intro, §6.4.4,
    §13, §14). §14 also named only three gated paths and now lists
    `syncLive`.
  - *Continuity research status.* §6.4.5 records the provider-contract
    review (Level A point-in-time account identity via `/users/info`;
    Levels B and C not provider-proven) and that authoritative continuity is
    **NOT IMPLEMENTED**.

**Status after Wave C4 (as recorded at the time): F18-45 is OPEN, pending
independent review of Wave C4.**

**The Wave C4 independent review returned PASS: F18-45 is CLOSED/PASS.**

**Current status: F18-01 through F18-45, every known numbered Phase 18
finding, are CLOSED/PASS. Phase 18 remains CURRENT, not complete:
authoritative account continuity is NOT IMPLEMENTED, and Phase 18 completion
is BLOCKED ON PROVIDER CAPABILITY. CoinDCX provides useful point-in-time
provider account identity (`/users/info` → `coindcx_id`, Level A), but
the currently documented provider APIs neither prove credential/session
authority (Level B) nor establish gap-free authoritative account-state
continuity through mutation authorization and consumption (Level C), §6.4.5.
`currentAccountContinuityCapability()` still returns
`REST_CURRENT_STATE_OBSERVED`, and every normal Phase 17 live mutation still
fails closed with `ACCOUNT_CONTINUITY_NOT_PROVEN`. Live authorization
readiness: NOT READY. LIVE-VENUE VERIFIED: NO.** This document does not claim
Phase 18 complete.
Live-mutation
authorization readiness remains explicitly, deliberately **NOT READY**:
F18-27's consequence is completely unchanged by this wave and stated plainly
again — Phase 18, as it stands with REST-only evidence, cannot authorize any
normal Phase 17 live mutation — this may make Phase 18 operationally incomplete for live
trading until a genuine continuity mechanism exists, and that is reported
honestly here rather than concealed for schedule convenience. Wave C1 added
exactly one administrative recovery path, strictly separated from
live-mutation authorization by construction and by test; Wave C1.1 corrected
two LOW documentation/test-detection findings from that wave's review; Wave
C1.2 corrected two further LOW findings from review of Wave C1.1's own
remediation; Wave C1.3 corrected three further LOW findings from review of
Wave C1.2's F18-33 guard specifically; Waves C1.4, C1.5, and C1.6 and the
final C1 guard cleanup continued correcting that same guard (F18-37 through
F18-43), and deliberately did not, and was
explicitly told not to, redesign F18-06's authority model, add
authentication, or attempt to make live trading operational.**

These remain open, unresolved, and unclaimed by anything in this document
(no numbered finding remains open):

- An authoritative account-continuity mechanism (F18-27's Level 3) does not
  exist and is not attempted in this wave (the provider contract offers only
  point-in-time account identity, §6.4.5); live-mutation authorization
  remains structurally unavailable until one is built, verified against the
  real venue, and wired in.

---

## 22. Test inventory

| Suite | Tests | Covers |
| :--- | :--- | :--- |
| `tests/unit/execution/live/reconciliation/evidence-and-barrier.test.ts` | 50 | conservation, causal ordering, duplicates, snapshot identity, window separability, the full barrier decision table, F18-27's account-continuity gate (both branches, the exact-race indistinguishability proof); Wave B5 F18-28 forgery matrix (14 forged shapes as a raw 5th argument, all silently ignored) |
| `tests/unit/execution/live/reconciliation/snapshot-stability.test.ts` | 25 | bracketed snapshot-stability protocol, F18-23 real-latency regression (incl. exact-boundary edge case), F18-04 Option B (ABA clean-account / history-sensitive-account), F18-27 end-to-end (clean run blocked at the barrier; the same race caught one generation later as an ordinary orphan) |
| `tests/unit/execution/live/reconciliation/order-reconciliation.test.ts` | 44 | immutable economic matching, ambiguous-create branches, drift/late-fill/regression, cancellation recovery (including crash-recovered claims resolved from venue evidence), orphan detection, `planClaimRecovery` |
| `tests/unit/execution/live/reconciliation/position-attribution.test.ts` | 24 | signed lineage arithmetic and every §11 position case |
| `tests/unit/execution/live/reconciliation/service-and-orphan-policy.test.ts` | 36 | the disabled-by-default gate, orchestration, orphan handling, idempotence, service-level fencing; Wave B5 F18-29 orphan finding dedup (same-run discovery, multi-generation reassertion, venue-visibility-lost case); Wave C1 F18-06 domain-level resolution (stops reassertion, cross-order isolation, stale revision, not-ambiguous refusal, duplicate refusal, no-auto-cancel trap, reappearance, negative control) |
| `tests/unit/execution/live/reconciliation/claim-generation-retry.test.ts` | 21 | Wave C3.1 F18-44: only Prisma `P2034` (by class and code) is retryable; a fresh transaction per attempt that claims from state re-read in the new transaction; exhaustion after 3 attempts fails closed with `LIVE_PERSISTENCE_FAULT` and the Prisma cause; non-retryable errors (stale generation, unknown, P1001, P2028, in-body domain errors) are attempted once; `LOST` (P2002) unchanged; no evidence read or orphan cancel after exhaustion |
| `tests/unit/execution/live/reconciliation/orphan-ceiling.test.ts` | 91 | Wave C2 F18-10: the per-run orphan cancellation ceiling. Dangerous string and non-string inputs (Infinity, NaN, overflow, exponent, zero, negative, fractional, unsafe, whitespace, over-ceiling), the valid and boundary matrix, forged-policy refusal at service construction, and service-level proof that exactly the limit of wire cancels start per run, including ambiguous outcomes and a crash plus restart |
| `tests/unit/execution/live/reconciliation/orphan-resolution.test.ts` | 28 | Wave C1 F18-06: `mintOrphanAmbiguityResolutionRequest` shape/bounds validation (outcome, revision, bounded `resolvedBy`/`note`), and forgery resistance (plain object, `Object.create`, distinct class, boxed/bare string, null/undefined, direct construction with a forged issuer) |
| `tests/unit/execution/live/reconciliation/secrecy-and-hostile-data.test.ts` | 24 | credential refusal at any depth, hostile-data logging, finding identity, status resolution |
| `tests/unit/execution/live/reconciliation-fence-fail-closed.test.ts` | 9 | F18-15: a missing Prisma reconciliation delegate blocks OPEN/CLOSE-shaped/cancel on every mutation path, zero reservation, zero wire mutation, deterministic error |
| `tests/unit/execution/live/wire-armed-integrity.test.ts` | 28 | F18-18: the full combinatorial valid-state matrix for `dispatchWireArmed`/`cancelWireArmed` (`live_order`) and orphan `cancelWireArmed`, fail-closed with zero reconciliation effect and zero live mutation |
| `tests/unit/prisma/phase18-schema.test.ts` | 26 | additive migration, fencing constraints, explicit FK names, Decimal columns, fail-closed enum defaults (updated for Wave C1's `CANCEL_AMBIGUOUS_RESOLVED` value) |
| `tests/unit/prisma/phase18-wave-c1-schema.test.ts` | 12 | Wave C1 F18-06: the new migration is additive (one new table, one additive enum widening, no other table touched), the new enum/model shape, the unique constraint binding a resolution to one cancellation attempt, the FK to its orphan, bounded operator-identity/note columns |
| `tests/architecture/phase18-reconciliation-boundary.test.ts` | 276 | transitive port boundary, no second mutation owner, paper isolation, pair genericity, test safety, barrier wiring; Wave B5 F18-24 permanent absolute-wording ban (15 files) plus doc-quotation-framing check, F18-28 exact-call-site pin; Wave C1.1 F18-31 exact-phrase overclaim ban (3 files + this document) plus a positive assertion that the correct caller-asserted-label disclaimer is present; Wave C1.3 F18-33/34/35/36 sentence/clause-scoped overclaim guard (§13.4.4) — 42 adversarial cases (unsafe current claims, same-clause negations, future-design statements, current/future contrast sentences, cross-sentence and same-sentence laundering attempts) plus a scan of the same 4 files; Wave C1.4 F18-37 — 37 further cases (colon, dash, conjunction, parenthetical, multiple-mention, and locality laundering; legitimate plain, future, boundary, parenthetical, and coordinated wording); Wave C1.5 F18-38/F18-39 — 35 cases (comma scoping, implied subject, strong separator, explicit new subject, pronoun continuation, and regression probes); Wave C1.6 F18-40/F18-41/F18-42 — 66 cases (connector-joined new-subject clauses and governed-object controls, trailing-modal assertions and governing-modal controls, open-class and adverb-led continuations, explicit-subject controls, pronoun continuation, quantified identifier mentions); final C1 guard cleanup F18-43 — 44 cases (quantified-mention subjects with real identity predicates, meta-prose controls, and a bounded same-invariant sweep); Wave C2 F18-10 — 1 pin that `LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN` is read in exactly one source file |
| `tests/architecture/phase18-migration-freeze.test.ts` | 15 | Wave C3 F18-19: every accepted migration (all three Phase 18 migrations included) pinned by CRLF-normalized SHA-256, new migrations allowed only as later-timestamped forward migrations, and both migration parity scripts pinned as compare-only (no write, reset, or regeneration) |
| `tests/integration/execution/live-reconciliation-persistence.integration.test.ts` | 103 | real MySQL: all 18 original required durable proofs; F18-14 Wave A2 crash recovery (§16 OPEN/regular-cancel/orphan-cancel unarmed+armed cases, §17 both race orderings, §18 the exact reviewer-confirmed regression reproduction for create and cancel); F18-16 Wave A3 legacy migration backfill and blocked-not-reclaimed proof; F18-18 representative corrupted-row cases; secrecy and pair genericity; Wave B/B2/B3 (F18-03/04/08/09/20/21/22/23) real-DB proofs; Wave B4 F18-25 (3-generation sticky orphan ambiguity), F18-26 (armed cancel + 3 crash/race scenarios), F18-27 (clean run reaches HEALTHY status but the barrier still refuses authorization); Wave B5 F18-29 (`[B5-1]`, dedup across generations) and F18-28 (`[B5-2]`, forgery matrix against a real DB-minted authorization); Wave C1 F18-06 `[C1-1]`–`[C1-7]` (basic resolution, stale revision, cross-account isolation, concurrent resolution over two connections, resolution-then-reconciliation ordering, structural never-reverted proof, crash/restart, reappearance); Wave C3 F18-11 — 5 adversarial cases (two complete runs racing with orphan cleanup, two complete runs racing a fill advance, concurrent cross-account reconciliation with an identical orphan id including the F18-44 fail-closed deadlock contract, forged cross-account lease/authorization, operator resolution racing a run) and F18-12 — 5 cases (run finding_count total versus blocking subset: 0/0, informational-only, blocking-only, mixed, deterministic reruns); Wave C3.1 F18-44 — 2 cases (20 concurrent pairs of new accounts each claiming exactly one generation-1 run with deadlock victims retried in fresh transactions; same-account fencing unchanged under the retry), and `[C3-11c]` strengthened to five rounds in which both accounts must complete |
| `tests/integration/execution/live-execution-persistence.integration.test.ts` | 48 | Phase 17 real-MySQL idempotence/cancellation/admission suite, now passing 48/48 with the F18-17 fixture fix (the test-only reconciliation-authorization subclass also overrides `armDispatchWire`/`armCancelWire`) |

The Phase 18 real-DB suite runs under `npm run test:integration:live-reconciliation`,
which sets `REQUIRE_LIVE_RECONCILIATION_DB_INTEGRATION=1` so a missing database
fails the run instead of silently skipping.

**No test places or cancels a CoinDCX order.** The evidence provider is a
fixture, the orphan-cancellation port is a fake that records attempts, and the
database suite makes no network call at all.
