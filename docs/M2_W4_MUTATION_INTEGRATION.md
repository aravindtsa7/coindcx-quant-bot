# M2 W4: shared REST budget in the mutation paths (note)

**Status: offline integration for review, under the bounded U-M2-1 approval** (the practical-cancel budget port, the
additive `BUDGET_REFUSED` result, the Phase 17 permit field). It grants no execution authority and no live permission.
- No production mutation budget is bound anywhere in `src/`, so every production mutation is refused before any request.
- Production initialization, the probe endpoints (U-M2-4) and all configuration values (U-M2-8) remain open.
- W5 (candle reader) is pending. **Final no-bypass completion is not claimed.**

## Interfaces

| Change | Where |
|---|---|
| `PracticalCancelBudgetPort` (`admit` / `consume` / `release`); `PracticalCancelDependencies.budget` (required) | `execution/live/practical-cancel/ports.ts` |
| `PracticalCancelLocalRefusal` gains `BUDGET_REFUSED` (additive; maps to the existing `ABORTED_BEFORE_DISPATCH` no-dispatch report) | same |
| `LiveMutationBudgetPort` (`admit` / `release`); opaque `budgetPermit` on `LivePlaceOrderRequest` and `LiveCancelOrderRequest` | `execution/live/gateway.ts` |
| `LiveExecutionServiceDependencies.budget` (optional; absent means no permit, so the adapter refuses) | `execution/live/service.ts` |
| Consumed-permit hand-off on the invocation: `attachCancelTransportBudget` (boundary only), `takeCancelTransportBudget` (transport only, once) | `execution/live/practical-cancel-transport-evidence.ts` |
| Mutation budget (opaque single-use `MutationPermit`, coordinator-backed budget, set-once production binding) | `integration/coindcx/rate-limit/runtime/mutation-budget.ts` (type-only imports) |
| W2 client: `consumeGrant` / `BudgetPermit.consume` (start check without a STARTED report) and `reportStarted` | `rate-limit/runtime/client.ts` |
| Port implementations (`createPracticalCancelBudgetPort`, `createLiveMutationBudgetPort`, production variants) | `integration/coindcx/live/mutation-budget-ports.ts` |
| `CoinDcxOrderMutationTransport.execute(…, budgetPermit?)`; `readBudget` option (LIST_ORDERS) | `integration/coindcx/live/mutation-transport.ts` |
| `CoinDcxLiveFuturesOrderGateway`: passes `budgetPermit`; `readBudget` option | `integration/coindcx/live/order-gateway.ts` |

The limiter imports no execution module. The execution layer imports only the port types it declares. The port
implementations are typed structurally, so they import no execution module either.

## Practical cancel

1. `PracticalCancelGatewayBoundary.invoke` first **awaits** `budget.admit`, before the final guard sequence.
2. The private `#enter` then runs synchronously, from the first guard to the sole invocation. With fresh observations
   through the existing clock, it re-checks every existing guard:
   - ownership and the certificate and armed binding;
   - reservation;
   - `checkPracticalCancelGuard`: clock, certificate, runtime epoch, enablement, account binding, dwell and TTL window,
     and the original watch;
   - armed time;
   - the lifecycle (`ADMISSION_CLOSED`).
3. After the last lifecycle observation and before `enterPracticalCancelGateway`, it **consumes** the admission. This is
   the limiter's start check: session, epoch, local TTL, revoke, STOP and scope block.
   - Consumption is synchronous and never reports a start.
   - A refused consumption, or a missing, throwing or malformed port, gives `NOT_ENTERED BUDGET_REFUSED`. The existing
     UNENTERED no-wire cleanup follows.
   - No certificate is reissued or reconsumed.
4. The consumed permit is attached to the invocation. The genuine transport takes it inside its no-write preparation
   region; anything other than a genuine consumed CANCEL permit gives the existing no-write `PRE_DISPATCH`.
5. `markCancelTransmissionPossible` still immediately precedes the request factory. The factory now runs inside
   `permit.start`, which reports STARTED **at request creation**, including when the factory throws. Completion is
   reported only on the request's `close` event.
6. On `NOT_ENTERED`, the admission is released. Release voids only a never-consumed permit; a consumed one is never
   released.

Existing outcome classification is unchanged: `projectResult`, the no-write proof and `AMBIGUOUS` on uncertainty.

**Uncertain capacity, by design:** a permit consumed but never started gets neither a STARTED report nor a release.
This happens on an entry refusal, a preparation failure (even with the transport's no-write proof), or a
non-provenance gateway. Its charge stays uncertain at the coordinator until the reconnect inventory lists it as used.
The W1 one-use protocol makes a used grant irrevocable, so refunding such a permit would be a protocol change (open
item).

## Phase 17 create and cancel

- `LiveExecutionService` awaits `budget.admit({ gatewayCall })` **before** `armDispatchWire` / `armCancelWire`, so the
  durable arm stays the last check before the wire.
- The permit, or `null` when refused, is carried in `budgetPermit`.
- The transport derives the budget kind from the closed endpoint (`CREATE_ORDER` → CREATE, `CANCEL_ORDER` → CANCEL), not
  from the caller's label. It **consumes the permit synchronously before signing**, with no await until the request
  exists.
- A missing, `null`, forged, read, wrong-operation, expired, revoked or reused permit, or a disconnected limiter,
  gives `PRE_DISPATCH 'BUDGET_REFUSED'` before any request.
- From there the existing paths follow:
  - create: `PRE_DISPATCH_FAILURE`, then `releaseDispatchClaim`, then `LIVE_PROVIDER_ERROR`;
  - cancel: `completeCancelAttempt` `REJECTED`, then `NOT_CANCELLABLE`.
- After transmission becomes possible, classification is unchanged: a definite response stays definite, and an
  uncertain one stays ambiguous and is never resent.
- After the gateway returns, the service releases the permit; this voids only a never-consumed permit.
- **No automatic mutation retry exists.** A later attempt is a new `dispatch` / `cancel` that passes every gate and a
  fresh admission.

**Order observation (`LIST_ORDERS`)** goes through the same transport. It acquires its own read permit from the
transport's read budget: the owned transport uses the set-once production read binding, and non-owned transports use
`readBudget`. Without a read budget it gets `PRE_DISPATCH 'READ_BUDGET_REFUSED'`, which `fetchOrder` maps to
`AMBIGUOUS`. A mutation permit never pays for a read.

**Phase 18 orphan cleanup (`GatewayOrphanCancellation`) is not integrated.**
- It carries no permit, so it is refused before any request (`PRE_DISPATCH_FAILURE BUDGET_REFUSED`, recorded by the
  existing orphan path as `CANCEL_REJECTED`).
- Integrating it needs its own admission placement relative to `armOrphanCancelWire`, which is a separate decision.

## Composition (production wiring disabled)

The practical-account coordinator and the production runtime pass the production budget ports. These delegate to
`bindProductionMutationBudget`, which nothing binds, so every production mutation is `BUDGET_REFUSED`. Stage policies,
gates, certificates, `authorityEligible` and Invariant 28 are unchanged.

## Architecture changes for review

- **Practical-cancel transport-provenance test:**
  - Narrow amendment: the marker pin now reads `markCancelTransmissionPossible(…);` followed directly by
    `const started = permit.start(() => requestModule.request`. The marker still immediately precedes the single
    factory.
  - New pins: the boundary calls `attachCancelTransportBudget` and the transport calls `takeCancelTransportBudget`. The
    admission await precedes `#enter`, `#enter` is fully synchronous, the guard → lifecycle → consume → attach → entry
    order holds, and the transport takes the permit only inside the no-write preparation region.
- **M2 boundary test:**
  - The runtime gains `mutation-budget.ts` (type-only imports).
  - The limiter importers are exactly the four read primitives, `live/mutation-transport.ts` and
    `live/mutation-budget-ports.ts`.
  - The limiter imports no non-limiter module.
- **Coverage (partial; complete mutation-path coverage is not claimed):**
  - The mutation transport's request site is COVERED for the practical cancel and Phase 17 create/cancel. Every request
    is inside a permit start, the endpoint fixes the kind, and consumption comes before signing with no later await.
  - PENDING request site: the candle reader (W5).
  - PENDING mutation path: Phase 18 orphan cancellation (`GatewayOrphanCancellation`). It carries no permit and has no
    admission, so it is refused before any request. It is disabled/unwired with respect to the budget, not paced.
- **Coordinator model test:** its dependency allowlist gains `./mutation-budget-ports`.

## Existing tests changed (fixture injection only; no assertion weakened)

- The practical-cancel harness (and the CommonJS child fixtures derived from it) injects a granting fixture port that
  mints genuine limiter permits.
- Direct `transport.execute` and `gateway.placeOrder` / `cancelOrder` calls pass a fresh genuine fixture permit per
  request. Gateways get a fixture read budget.
- The credential-source and trusted-binding child programs mint a genuine fixture cancel permit for their direct
  `cancelOrder` probes.
- The DB-backed practical dispatch suite injects the fixture port (type-checked; not run, see the W4 report).

## Acceptance debt (not established by the W4 checkpoint)

**Disposable-database suites: NOT RUN.** No approved disposable-DB credentials were available; operational
credentials were not read and the local MySQL was not contacted. Outstanding, to be run only through the approved
harness (`scripts/run-live-*-db-integration.ts` with `tests/helpers/p18b-disposable-mysql.ts`):
- `tests/integration/execution/live-practical-cancel-dispatch.integration.test.ts` (W4 fixture budget injected; type-checked only)
- `tests/integration/execution/live-execution-persistence.integration.test.ts`
- `tests/integration/execution/live-reconciliation-persistence.integration.test.ts`
- the remaining Stage 1B2 suites of `scripts/run-live-practical-mutation-db-integration.ts`
  (mutation-safety migration shape, cancel transaction primitives, cancel store, interlock, no-wire, unknown acquire,
  previous runtime)
- the 13 DB-marked unit files excluded from the DB-free list (`cancel-transaction-primitives`, `durable-integrity`,
  `gate-and-policy`, `practical-mutation/{dispatch,nowire-store,preflight,previous-runtime-store,store,unknown-acquire-store}`,
  `practical-persistence/{locked-account-scope,repository}`, `reconciliation/claim-generation-retry`, `repository`)

Other open items:
- Orphan-cancellation admission (pending mutation path above).
- The W5 candle reader.
- Consumed-but-never-started grants stay uncertain; no refund or protocol change.
- Production binding and configuration (U-M2-4/5/7/8/9/10/11).

## Test-runner note

`practical-cancel/service.test.ts` intermittently ended with vitest's `Timeout calling "onTaskUpdate"`. This was
pre-existing at the W3 commit.
- **Cause:** its CommonJS-loader tests are synchronous (`execFileSync`). vitest runs them back to back as microtasks,
  so the worker cannot read IPC replies for the whole block. Once the block runs past 60 s, the worker's RPC timer fires
  before the waiting reply is read.
- **Fix (harness only):** one `setImmediate` turn in a `beforeEach` of that block. No assertion, skip or timeout change.
