# M2: Phase 18 orphan-cancellation budget integration (note)

**Status: offline implementation for review, uncommitted.**
- This is not M2 acceptance. The DB acceptance suites remain NOT RUN.
- The coverage allowlist is now empty (every provider REST request site covered, every mutation path integrated). That is
  a static coverage result only, not acceptance.
- The path stays disabled and unwired. Orphan cleanup policy, stage policy and execution authority are unchanged, and
  production composes no orphan budget, so a production orphan cancel is still refused before any request.

## Order (per orphan, inside `LiveReconciliationService.#handleOrphans`)

1. Durable claim (`claimOrphanCancellation`, unchanged).
2. **Await budget admission**: `LiveMutationBudgetPort.admit({ gatewayCall: 'cancelOrder', lifetimeMs: requestTimeoutMs })`,
   the existing W4 port. Budget only: a missing, refusing, throwing or malformed port gives no permit.
3. **Re-evaluate after the wait**, with fresh observations:
   - the cleanup capability, genuine policy and account allowlist (`#permittedOrphanCleanup`; an immutable constructor
     snapshot, re-read here). If cleanup is no longer permitted, nothing is armed: the claim stays `CANCEL_CLAIMED` and
     unarmed, and the next generation's existing recovery reclaims it with zero requests;
   - ownership, lease, fence, generation, runtime epoch, authorization and the claim itself, inside the durable
     `armOrphanCancelWire` transaction (unchanged, row-locked, fresh reads).
4. Durable arm (`armOrphanCancelWire`, unchanged and still the last check before the wire).
5. `cancelVenueOrder({ ..., budgetPermit })`. The adapter passes the opaque permit unchanged to the gateway's
   `budgetPermit`; the gateway passes it to the transport with no await in between.
6. **Consumption at the existing synchronous final boundary**: the mutation transport consumes the permit (kind `CANCEL`,
   derived from the closed `CANCEL_ORDER` endpoint) synchronously before signing; from consumption to request creation
   there is no await (W4 pin). STOP (local latch or coordinator view), expiry, revocation, binding (operation, endpoint,
   read permit, forged object) and reuse are all refused here, before any request.
7. `finally`: the permit is released. Releasing an unconsumed permit voids it (known non-use, capacity refunded);
   releasing a consumed one is a no-op (its charge stays until STARTED and completion are reported).

STARTED is still reported at actual request creation and completion at request close (transport, W4).

## Outcomes and classification (unchanged)

- **No permit, or a refused permit** (missing budget, refusal, coordinator unavailable, STOP while waiting or before
  admission, wrong binding, forged, read, reused, expired or revoked during the arm): the transport refuses before any
  request, which is the existing `PRE_DISPATCH_FAILURE`, recorded with the existing classification `CANCEL_REJECTED` and
  fault code `BUDGET_REFUSED`. No additive result was needed.
- **Arm refused after the wait** (ownership superseded): the existing exception propagates. The permit is released
  unused, and the claim stays unarmed (its durable state is certain, never sent). It is not released in-run; the next
  generation's existing recovery reclaims it.
- **Definite outcomes stay definite** (`CANCELLED`, `REJECTED` with `HTTP_400`). **Ambiguous stays ambiguous**
  (`CANCEL_AMBIGUOUS` plus the sticky blocking finding) and is never resent: a later run re-asserts the finding without
  reaching admission or the wire.
- No automatic retry, no refund of a consumed grant, no hook token and no cancellation-under-STOP exception.

Operational consequence to note (unchanged classification): `CANCEL_REJECTED` is terminal for that orphan's automatic
cleanup, so a budget refusal (for example STOP or throttle) retires automatic cleanup for that orphan until an operator
acts. The orphan stays recorded and blocking.

## Files

- `src/execution/live/reconciliation/service.ts`: optional `orphanCancellationBudget` dependency,
  `#permittedOrphanCleanup`, `#admitOrphanCancelBudget`, `#releaseOrphanCancelBudget`, and the
  admission/re-check/arm/call order above.
- `src/execution/live/reconciliation/ports.ts`: optional `budgetPermit` on `cancelVenueOrder`, and
  `LiveOrphanCancelBudgetPort`, structurally the cancel half of the W4 `LiveMutationBudgetPort` and satisfied by the same
  `createLiveMutationBudgetPort`. It is declared here because a type-only import of the gateway module from the
  reconciliation service made `gateway.ts` reachable from modules the Phase 18B boundaries forbid (shadow runtime, live
  repository, practical-mutation repository); four architecture tests caught this, and the service now imports nothing
  from `../gateway` (pinned).
- `src/execution/live/reconciliation/gateway-orphan-cancellation.ts`: passes `budgetPermit` to `cancelOrder`.
- New `tests/integration/coindcx/rate-limit/orphan-cancel-admission.test.ts` (9 tests).
- `tests/architecture/rest-limiter-coverage.test.ts`: pins the integration; the orphan entry leaves
  `PENDING_MUTATION_PATHS`; the empty-allowlist exit is recorded as coverage only, not M2 acceptance.
- `tests/integration/coindcx/rate-limit/live-mutation-admission.test.ts`: retitled W4 test (assertion unchanged).

## Tests (`orphan-cancel-admission.test.ts`)

The genuine reconciliation service, orphan adapter, order gateway and mutation transport against a loopback venue; the
in-memory reconciliation repository; a synthetic cleanup policy from the genuine configuration gate for a test account.
They cover:
- the synthetic authorized path: claim, admission, arm, exactly one request, STARTED and completion once;
- missing, refusing and throwing budgets: zero requests, existing classification;
- wrong-binding (CREATE, read), forged and reused permits: zero requests each, a single genuine first use;
- unchanged definite and ambiguous outcomes, with no resend;
- ownership superseded while admission waits: arm fenced out, zero requests, permit released unused, unarmed claim kept
  and reclaimed by the next run's existing recovery;
- permit expiry during the durable arm, and revocation during it (coordinator STOP): zero requests, capacity refunded;
- STOP while admission waits (kill switch on the waiting client), STOP before admission and an unavailable coordinator;
- shared accounting with one coordinator slot: the orphan cancel waits behind a read, holds the slot while in flight,
  and a Phase 17 mutation waits behind it.

Two mutation checks confirm the tests discriminate: passing no permit from the adapter fails 5 of 9, and moving
admission after the arm fails 7 of 9.

## DB acceptance debt (NOT RUN)

`tests/integration/execution/live-reconciliation-persistence.integration.test.ts` and the other DB suites listed in the
W4 note are not run. They inject their own orphan port and need no fixture change (the new request field is optional);
the Prisma repository's arm and claim are unchanged.

## Production decisions still required

- Whether, and with which budget, production composes `orphanCancellationBudget` (now unwired: refused).
- Whether a budget refusal should keep `CANCEL_REJECTED` (current, terminal for automatic cleanup) or leave the claim
  for reclaim (a policy change, not made here).
- Production budget binding, coordinator supervision, and the W6 list (U-M2-4/5/7/8/9/10/11, M6 hook registration).
