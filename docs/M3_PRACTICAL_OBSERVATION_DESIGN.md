# M3: practical observation assessment (design for review)

**Status: unwired review candidate (design and pure offline evaluator), checkpointed locally for the M3 decision
review. The formal M3 milestone is not complete.**
- Register D4c (the client's weaker REST-observation basis) remains **CLIENT PROPOSAL (NOT APPROVED)**.
- The roadmap clean gate for M3 is not met, and AS1 is not satisfied.
- Nothing here is production readiness, an execution authorization, or approval of D4c.
- Sources: `FULL_BOT_ROADMAP_V3.md` (§1 non-bypass rules, §2, §6 M3/M4, §7 O1–O6, §12) and `CAPABILITY_REGISTER_V3.md`
  (H1–H6, A1–A6, B3/B9/B12/B13, C1–C4, D1–D5, §5).

## Conflicts with the accepted M3 requirements (identified, not broadened)

1. **Evaluator before the decision.** Roadmap M3 builds the pure evaluator "only if approved". This wave builds it before
   the review decides, as an unwired candidate the review can inspect. Approval of D4c is not implied, and M3 is not
   complete.
2. **Shadow evidence V2.** M3 lists shadow evidence recorded beside `authorityEligible` via an additive migration. That
   is out of this scope (no migration and no persistence) and is not done.
3. **Separate policy and path.** M3 lists "a separate, reviewed policy and path for any later use". Not designed or built.
4. **Clean gate.** The M3 exit needs the strict real-MySQL suite on a clean committed tree. This wave has no database
   access and stays uncommitted, so the clean gate is not met.
5. **Prerequisites.** M3 depends on M1 (provider contract closure) and AS1 (account-scope decision). Neither is closed:
   D2, A2, B3, B8/B9 and C2–C5 remain open. The evaluator keeps every affected item as explicit input evidence, never
   as an assumed answer.

## Decisions

- **Placement.** `src/execution/live/practical-observation/assessment.ts`: one file, no imports, imported by nothing in
  `src/` (architecture-pinned). It reuses the existing concepts by name only, without coupling: the register §5
  ownership classes, read provenance (complete or truncated pagination, read start/end), the incarnation/epoch and the
  reconnect latch (D5).
- **Separate assessment, never a fallback.** Strict continuity (`requireCurrentReconciliation`,
  `currentAccountContinuityCapability()`), `practicalPrivateStreamReadiness`, `PROVEN_READY`, the certificate issuer,
  `authorityEligible`, gates, stage policy, Invariant 28 and private-stream states are unchanged and are not consulted.
- **Positive basis (B12, O2).** Exactly two REST passes over a declared scope (account plus components from ORDERS,
  POSITIONS and TRANSACTIONS). Every record (key, canonical fingerprint) and every ownership class agrees. Pass 2
  starts after pass 1 ends, the total read span is within `maxTotalReadDurationMs`, and the age of the oldest evidence
  is within `maxEvidenceAgeMs` at the caller-supplied `evaluatedAtMs`. The result is `OBSERVED_CONVERGENCE`, labelled
  `OBSERVED_CONVERGENCE_IS_NOT_ATOMIC_CONSISTENCY`.
- **Incomplete evidence is explicit (O3).** Missing account scope, truncated or unknown pagination, missing record
  timestamps and missing fill identifiers (when TRANSACTIONS is in scope) each appear as an `evidenceGaps` entry per pass
  and component, with an explicit `blocking` flag. All of them block, except missing fill identifiers in
  CUMULATIVE_STATE mode. So does a failed read, a missing or undeclared component, another account, or a wrong pass
  count.
- **Modes: cumulative comparison is separate from fill-level accounting (B3, B13, O6).** `mode` is a required input.
  - `FULL_EVIDENCE` is the first candidate's behaviour, unchanged: missing fill identifiers block.
  - `CUMULATIVE_STATE` compares the available cumulative state within the declared scope. Missing fill identifiers are
    recorded as non-blocking gaps.
  - In both modes, `fillLevelAccounting` reports complete fill reconstruction, exactly-once execution accounting and
    fee accounting as the literal `UNKNOWN` (reason `STABLE_FILL_ID_CONTRACT_UNRESOLVED`, plus `FILL_IDS_MISSING` and
    `CUMULATIVE_STATE_MODE` when they apply).
  - The scope's required `requiredAccounting` list declares what accounting the selected scope needs. Any entry blocks
    (`ACCOUNTING_UNSUPPORTED_FOR_SCOPE`) in both modes, even with fill identifiers present, because no fill-level
    capability is supported.
- **Ownership (§5).** A record must be OWNED with named lineage (`BOT_CREATE_RESPONSE` or
  `RESOLVED_UNDER_CONFIRMED_CONTRACT`). `TAG_CORRELATED_ONLY` is treated as UNRESOLVED: a tag is correlation evidence,
  not proof of ownership. UNRESOLVED, FOREIGN_OBSERVED and VENUE_GENERATED records, or a class that differs between
  passes, prevent convergence. OWNED without lineage, or an unknown class, is invalid input.
- **Private stream (O3, O4, D2, D4b).** Events are revocation inputs only. These revoke:
  - an event observed at or after the window start;
  - buffered, unapplied events;
  - a disconnect, or a disconnect observed during the window;
  - the reconnect latch;
  - an unknown or changed epoch.

  Silence is recorded (`quietStream`) and never credited (`quietStreamProvesNoActivity: false`). The join
  acknowledgement is `UNKNOWN` unless the input carries a provider-confirmed acknowledgement for the current epoch.
  An `UNKNOWN` acknowledgement is recorded and is non-blocking for the REST observation comparison only
  (`joinAcknowledgementBlocksComparison: false`). It is never described as private-stream readiness
  (`privateStreamReadiness: 'NOT_ASSESSED'`; the existing predicate is unchanged), nor as satisfaction of the
  provider's synchronization procedure.
- **Provider procedure (D4a, E21).** Always `providerSynchronization.status: 'NOT_ESTABLISHED'`, with
  `REST_ONLY_ASSESSMENT` and `WEBSOCKET_DERIVED_STATE_NOT_COMPARED` (and `JOIN_ACKNOWLEDGEMENT_UNKNOWN` when applicable).
- **Invalidation.** `recheckObservationCandidate` can only downgrade a candidate that the evaluator itself produced.
  These invalidate it: new observed events, an epoch change, a disconnect, the latch, buffered events, stale evidence or
  an earlier evaluation time. Structural copies are not candidates.
- **Grants nothing.** Every result carries the constant `GRANTS_NOTHING`, with literal `false` for certificate, mutation
  budget, order permission, authority eligibility, strategy lifecycle promotion, live readiness and strict continuity.
  Tests show that no outcome is accepted by any existing authority, enablement, certificate, reconciliation,
  orphan-policy, permit or stream-readiness reader.
- **Thresholds.** `maxEvidenceAgeMs` and `maxTotalReadDurationMs` are required explicit inputs: positive safe integers,
  with no default. Tests use synthetic values only. No value is proposed or approved (§12).

## Open review questions (not decided here)
- Whether D4c is approved at all, and whether any later reviewed path should treat an `UNKNOWN` join acknowledgement as
  blocking. For this comparison it is pinned as recorded and non-blocking.
- How M4 derives fingerprints, ownership classes and evidence flags from provider data (an unwired M4 candidate is a
  separate review item).
- Acceptance criteria, then values, for evidence age and read duration (§12).

## Files and tests
- `src/execution/live/practical-observation/assessment.ts`.
- `tests/unit/execution/live/practical-observation/assessment.test.ts` (50 tests): incomplete evidence, disagreement,
  timing and staleness, event invalidation, reconnect and epoch changes, uncertain ownership, quiet streams,
  thresholds, malformed input, candidate recheck, both modes and the accounting scope, the pinned stream wording, and
  no-grant/forgery checks against existing readers.
- `tests/architecture/m3-practical-observation-boundary.test.ts` (4 tests): no imports, not imported, no
  clock/I/O/randomness, no authority minting, all grants literal `false`.
