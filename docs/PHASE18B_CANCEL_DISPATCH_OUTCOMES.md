# Unwired cancel dispatch permission and coupled outcomes

This contract is defined before implementation. It is a provider-independent
extension of the reviewed Stage 1B2 store, not production execution wiring.

## Closed ownership lifecycle

Each row below transfers one original committed arm's exclusive ownership.
Reservations happen synchronously before any await. No database read mints a
replacement owner. Original arm revision R is immutable.

| Owner | Start | Reserved | Confirmed commit | Proven rollback | Unknown commit |
| --- | --- | --- | --- | --- | --- |
| Armed ticket: permission creation | ARMED | PERMIT_CREATING | TRANSFERRED; one READY permit | ARMED | PERMIT_CREATION_UNKNOWN; cleanup only |
| Permit: consumption | READY | CONSUMING | TRANSFERRED; one UNENTERED attempt | READY, except a consumption conflict permanently REFUSED | CONSUMPTION_UNKNOWN; no attempt, no dispatch retry |
| Unentered owner: cleanup | eligible unentered state | CLEANING | SPENT | original state | CLEANUP_UNKNOWN; identical cleanup only |
| Attempt: entry | UNENTERED | none (synchronous) | ENTERED | never restored | not applicable |
| Attempt: reported result | ENTERED | none (synchronous) | RESULT_RECORDED; one receipt | never restored | not applicable |
| Outcome receipt: completion | READY or COMMIT_UNKNOWN | COMPLETING | SPENT | previous state | COMMIT_UNKNOWN; same immutable receipt only |

After TRANSFERRED, old tickets/permits have no cleanup or dispatch rights.
An entry/result issuer has zero production callers in this wave. Test access
is explicitly architecture-pinned. Thrown, timed-out, unknown or malformed
results after entry become possible-wire AMBIGUOUS. A post-entry no-wire
result requires a separate genuine internal transport-result brand; a caller
label cannot establish it. These receipts report results; they do not prove
provider state, cancellation finality or account continuity.

## Durable boundary and ownership obligation

Creation rechecks authority and the exact armed pair without changing rows.
Consumption repeats those checks and CASes the exact original order revision
R to R+1, retaining CANCEL_RESERVED and cancelWireArmed. A confirmed commit
alone issues an attempt. A CAS loser has no attempt and no cleanup rights.
Neither R+1 nor armedAtMs is a sent marker or ownership/no-wire proof.

Unknown consumption cleanup rests on an exclusive original ownership chain:
only the confirmed arm issuer produces its ticket; creation reserves that
ticket synchronously and transfers it permanently; only its one permit can
consume; CONSUMPTION_UNKNOWN is entered only after CAS work completed but commit
acknowledgement was lost. No attempt was issued, no other permit can be created,
and neither token is reconstructed after restart. A CAS loser becomes REFUSED
and has no cleanup path. R+1 alone supplies none of this proof.

Cleanup checks lifecycle-derived revision bounds as additional refusal checks:
READY permission R, UNENTERED attempt R+1, unknown consumption R or R+1.
Unknown read-only creation is distinct and permits only R. Its cleanup-only
owner is retained privately for identical retries. Completed cleanup must remain
at the original generation and corresponding completion revision; no later
generation is guessed from historical lease data.

Cleanup reserves and privately retains its original ownership origin before any
await. CLEANUP_UNKNOWN never supplies that origin. Every repeated retry uses the
same original pre-completion revision bounds (READY and unknown creation: R;
UNENTERED: R+1; genuine unknown consumption: R or R+1). Completed retry accepts
only a corresponding bound plus one. Proven rollback restores only the exact
reserved state; an unknown retry cannot restore dispatch eligibility or change
its reason. Unrelated revision advancement is refused without writes.

The permit is not restartable or serializable. Never reconstruct it from armed
rows or replace R with a newly read revision. An armed orphan remains refused.

## Implemented internal APIs

The store exposes `createCancelDispatchPermission`,
`consumeCancelDispatchPermission`, `completeUnenteredCancelDispatch`, and
`completeCancelLease`, with exact closed input fields defined in `ports.ts`.
The opaque permit/attempt/outcome TypeScript aliases share a private-field
owner class; every operation checks BOTH its closed role and its lifecycle.
No record or status supplied by a caller grants ownership.

The internal synchronous `enterPracticalCancelGateway`,
`issuePracticalCancelOutcome`, and `issuePracticalCancelTransportNoWire` have
zero production callers and exactly the new unit/integration fixture callers.
The no-wire token is attempt-bound. There is no implemented production transport
issuer, and these test fixtures are not a production proof fallback. A future
trusted owner must project the real gateway result into this closed reported
result contract and prove transport no-write before issuing its no-wire token.
Raw reasons, errors, payloads and observations are not retained. Unexpected,
hostile, timed-out or thrown results normalize to fixed ambiguity categories.

## Authority and transactions

Creation and consumption independently reprove genuine account-allowlisted
STAGE_5A_CANCEL_ONLY enablement, genuine runtime identity/epoch, exact fence,
lease and original full consumed-certificate provenance, reconciliation,
dwell/effective lifetime and digest-verified exact-case order/exchange/claim
identity. The certificate snapshot must originate at acquisition/arm, not be
reconstructed from current mutable rows. Reserve enough signed MySQL INT
revision space for consumption and completion.

Reuse the existing practical scope and lock order (latch/episode, state,
fence, referenced episodes, certificate before lease), then reconciliation
for authority operations, then order and intent. Cleanup/completion needs no
renewed healthy authority. All coupled writes use one caller-owned transaction.

| Report | Practical completion | Phase 17 claim |
| --- | --- | --- |
| CANCEL_ACCEPTED | ACCEPTED | CANCEL_ACKNOWLEDGED, arm cleared |
| REJECTED | REJECTED | CANCEL_REJECTED, arm cleared |
| AMBIGUOUS | AMBIGUOUS | CANCEL_AMBIGUOUS, arm cleared |
| Genuine PRE_DISPATCH_FAILURE | PRE_DISPATCH_FAILURE | NONE, arm cleared |

Preserve economic order state, consumed certificates, quarantine and sticky
manual review. Acceptance is request acknowledgement only. Complete both sides
atomically and re-read them. Only exact accepted/acknowledged and
rejected/rejected armed historical pairs widen classification; sticky ambiguity
and all incompatible combinations remain refused.

Unknown completion retry uses the identical immutable receipt and rechecks the
full certificate/lease/arm/epoch/order/exchange/generation/outcome/fault-code
mapping and cleared arm. The Phase 17 same-state early return is insufficient.
Refuse if a later generation makes the original details unverifiable.

The core also conservatively refuses retry after order-revision drift. It uses
the internal caller-transaction `reproveCancelOrderWithinCallerFencedTransaction`
for sealed-intent/mirror integrity on creation and completion retry; the raw
identity projection and the Phase 17 same-state shortcut are insufficient.
This helper is neither a public read API nor new evidence/authority machinery.

The new dispatch unentered-cleanup completed retry also uses this integrity
helper inside the same practical-account -> order -> intent transaction before
returning ALREADY_COMPLETED. It checks the sealed intent and immutable mirrors
without a reconciliation lock or renewed health. Legacy no-wire retries without
dispatch-origin revision bounds retain their existing behavior. Integrity refusal
retains CLEANUP_UNKNOWN, performs no repair or durable writes, and is not
misclassified as an operational conflict requiring escalation.

## Limits and review acceptance

No production gateway caller, entry/result issuer caller, runtime wiring,
provider confirmation fallback, strict Tier-A relaxation, stream/latch change,
economic-state folding, armed-orphan release, Prisma change or campaign access.
The future gateway owner still needs an immediate genuine private-stream guard.
A database CAS does not atomically fence an external socket write.

Acceptance requires ownership-transfer/loser/unknown-commit races, real committed
and rolled-back transactions, atomic outcome fault injection, exact retry and
tampering checks, signed-INT boundaries, supersession, existing recovery and
architecture regressions. Use a new isolated loopback MySQL instance, strict
database flags, explicit Vitest run mode and six workers. No soft-skipped body
counts as acceptance. Preserve the frozen migration and captured evidence.

Acceptance separately tests local same-permit exclusivity and two independent
real MySQL caller-fenced transactions competing on immutable R/generation. The
direct internal-CAS fixture mints no second permit or production attempt. Only
one increment succeeds; the durable loser and its unchanged-R retry refuse.
