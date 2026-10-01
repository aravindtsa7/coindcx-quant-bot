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
The original core wave kept entry/result issuers at zero production callers.
The unwired orchestration extension below pins their sole boundary caller. Test
access remains explicitly architecture-pinned. Thrown, timed-out, unknown or malformed
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

The internal synchronous `enterPracticalCancelGateway` and
`issuePracticalCancelOutcome` now have only the unwired gateway-boundary caller.
`issuePracticalCancelTransportNoWire` now has that same sole boundary caller,
only after consuming genuine matching local-preparation evidence. Their
direct test access remains exactly the original unit/integration fixtures.
The no-wire token is attempt-bound. The separately documented unwired transport
bridge proves only local preparation failure before native request-factory
entry; test fixtures are not a production proof fallback. Its closed contract
is in `PHASE18B_CANCEL_TRANSPORT_PROVENANCE.md`. Ordinary structural gateway
results still cannot produce no-wire proof.
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

No operational gateway caller or runtime wiring,
provider confirmation fallback, strict Tier-A relaxation, stream/latch change,
economic-state folding, armed-orphan release, Prisma change or campaign access.
The unwired gateway owner requires an immediate genuine private-stream guard.
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

## Unwired orchestration contract (defined before implementation)

The next owner is an unwired `practical-cancel` service, not Phase17
`cancelDurable`. Its closed call is `{ intentId, expected, certificate }`.
Account, fingerprint, runtime, both genuine configuration enablements, timeout,
clock, recovery instance and cancel-only gateway are constructor dependencies.
No per-call account/order/pair/exchange selector or trusted-time override exists.
There is no operational importer, public barrel export or concrete network
dependency. Production readiness still cannot pass with the existing stream.

| Local operation | Start | Reservation | End |
| --- | --- | --- | --- |
| cancel | IDLE, no pending bookkeeping | RUNNING synchronously before first await | IDLE or one pending continuation |
| retryBookkeeping | exact service-bound READY continuation | RUNNING synchronously before first await | SPENT on confirmed finish; READY on refused/uncertain bookkeeping |
| duplicate/reentrant call | RUNNING or pending ownership | refused | no durable access or gateway call |

| Private continuation kind | Retained original | Only allowed work |
| --- | --- | --- |
| ACQUIRE | genuine unknown-acquire receipt read before error sanitization | resolve; if restored, replace with ABANDON and abandon |
| ABANDON | acquired owner | exact existing abandon |
| ARMED | original armed ticket and fixed reason | exact existing no-wire completion |
| UNENTERED | current permit/attempt/unknown-creation owner and fixed reason | exact existing unentered completion |
| OUTCOME | identical immutable outcome receipt | exact coupled completion |

Continuations have private fields, service-instance identity and synchronous
retry reservations. They are non-serializable, non-restartable and never expose
their owner, receipt, errors or payloads. Clones and cross-service use refuse.
NOT_COMMITTED is reported as such, never as a completed cancel. Malformed-latched
results are blocked/manual-review results, never COMPLETED. Operational errors
remain operational and typed store contradictions are not reclassified or repaired.

The original-watch checker is synchronous and uses the exact certificate object
issued by this recovery instance and its exact retained watch. It reuses the
private authority predicates, requires original account/fingerprint/runtime,
current PROVEN_READY binding, no latch/trip/hold and effective unextended expiry.
It performs no persistence read or authority renewal. Durable consumption does
not erase this association; monitorAuthority remains unchanged and cannot serve
as this checker once the account is MUTATING. Missing association, disarm,
replacement, trip or stopped watch refuses. UNCHANGED is never cached authority.
`stopWatch` still refuses to disarm while a mutation lease is held; a refused
stop does not erase a retained live watch. Startup disarm removes the original
association and blocks the checker without releasing any held lease.

The defining recovery module pins `checkOriginalCertificateWatch` as a
non-writable, non-configurable own static method during initialization. In the
actual CommonJS build, its `PracticalRecoveryService` export is a non-configurable
lexical getter with no setter. Assignment, Reflect.set, defineProperty and
deletion cannot replace either lookup, including before the gateway consumer
is imported. The supported tsx CommonJS loader already emits a non-configurable
getter; initialization accepts it only if it is setter-free and resolves to the
exact lexical class. This closes the reviewed checker/class-export substitution path;
it does not freeze unrelated recovery methods or introduce a new authority.
The gateway still invokes the genuine private-brand and original-association
checks freshly. A consumed attempt whose original watch is lost cannot enter,
even after replacement attempts; only existing eligible owned no-wire cleanup
remains. Bookkeeping retries never consume again or dispatch. These guarantees
do not claim isolation from arbitrary replacement of the Node module loader,
require cache, intrinsics or executable files by code controlling the process.

The entire newly introduced dispatch lookup chain is protected during its
defining modules' initialization. Boundary and service classes, prototypes and
genuine instances are frozen; `invoke`, `cancel` and `retryBookkeeping` cannot
be replaced or shadowed. Freezing instances alone would not protect inherited
methods. The CommonJS boundary constructor and guard-function exports, and
service/bookkeeping class exports, are non-configurable lexical getters with
no setters. Supported tsx getters must already bind the exact lexical value.
Preloading either module before consumer import cannot redirect these exports.
No mutable injected callback establishes readiness or selects final dispatch.
An ordinary gateway callback is bound once into a private field by the genuine
boundary. A genuine provenance-capable gateway instead has a private registered
invocation path protected in its defining modules; public gateway/transport
method replacement cannot redirect that path.

These protections prevent replacing final dispatch after consumption, including
a replacement that sends and falsely returns NOT_ENTERED. Original-watch loss
still produces zero gateway calls and only genuine eligible owned cleanup.
They preserve the existing synchronous entry/invocation ordering, timeout,
immutable reports and bookkeeping-only retries. No production importer set or
issuer caller is broadened; recovery APIs and the V2 checker protection are
unchanged. This remains property-substitution protection for the new chain,
not isolation from an attacker controlling the module loader, intrinsics,
committed core dependencies, trusted composition or executable files.

The service checks original watch and non-regressing trusted time before acquire,
before arm, before permission, before consumption and immediately before entry.
Creation and consumption continue to reprove all durable authority independently.
Only a confirmed consumption produces an attempt. CAS losers get no cleanup.
Unknown consumption permanently prohibits dispatch retry, while genuine local
ownership alone may clean up using the existing unchanged origin/revision bounds.

The gateway boundary builds a frozen request exclusively from the genuine
attempt's original clientOrderId, exchangeOrderId and pair and trusted timeout.
It checks genuine runtime/practical enablement, credential account/fingerprint,
original watch, dwell, effective expiry and time, then spends entry and invokes
cancelOrder exactly once with no await/hook/queue between them. A bounded local
wait uses the policy timeout; settlement is once-only and late results are ignored.
Only this boundary calls entry/outcome and verified no-wire token issuers.

| Gateway observation after entry | Immutable report |
| --- | --- |
| exact own-data CANCEL_ACCEPTED with observation field | CANCEL_ACCEPTED; observation ignored |
| exact own-data REJECTED with nonempty reasonCode | REJECTED; fixed core reason |
| AMBIGUOUS, structural PRE_DISPATCH_FAILURE, throw, timeout, malformed/hostile result | AMBIGUOUS |
| exact private invocation envelope with consumed genuine pre-factory no-write evidence | PRE_DISPATCH_FAILURE; entered outcome completion only |

No raw result or economic observation is retained. No fetch/ingest occurs.
Structural PRE_DISPATCH_FAILURE is not genuine transport proof. No-write
issuance is restricted to the separate local-preparation provenance contract;
after native factory entry it is permanently unavailable. Before entry, owned cleanup remains available.
Completion uncertainty retries bookkeeping only with the identical receipt.

Local synchronous ordering does not atomically fence remote runtime supersession,
provider events or external socket entry. After entry uncertainty is possible-wire;
completion can refuse after supersession, and armed orphans remain blocked.
Strict Tier-A, consumed certificates, quarantine, sticky review/ambiguity and all
economic state remain unchanged. No provider confirmation, continuity, cancellation
finality or reconciliation acknowledgement is manufactured.
