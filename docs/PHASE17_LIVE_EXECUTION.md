# Phase 17 — CoinDCX Live Execution

Status: **CURRENT** (targeted closure polish; no real production order has been placed).

Phase 17 converts an already-authorized execution request into authenticated
CoinDCX futures order operations. It adds the first code in this repository
capable of mutating exchange state — and pairs that capability with a gate that
keeps it switched off, an explicitly enumerated mutation-capability chain, and
a state model that refuses to guess when the exchange does not
answer.

**Live trading is disabled by default and is not enabled anywhere in this
repository.** Enabling it requires an explicit production configuration that no
test, script, or default value supplies.

---

## 1. Verification status of every claim

This table is the honest summary. Nothing below it upgrades a claim beyond
what this column says.

| Area | Implemented | Structurally tested | Mocked / stub-venue tested | Real-DB tested | Externally live-verified |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Deterministic intent identity | Yes | Yes | n/a | n/a | n/a |
| Deterministic local client identity | Yes | Yes | Yes | n/a | n/a |
| Live execution authority chain | Yes | Yes | Yes | n/a | n/a |
| Paper/live authority isolation | Yes | Yes | n/a | n/a | n/a |
| Disabled-by-default gate | Yes | Yes | n/a | n/a | n/a |
| Instrument constraints + quantization | Yes | Yes | n/a | n/a | **No** |
| Create-order dispatch | Yes | Yes | Yes (loopback stub) | n/a | **No** |
| Cancel-order dispatch | Yes | Yes | Yes (loopback stub) | n/a | **No** |
| List-orders observation | Yes | Yes | Yes (loopback stub) | n/a | **No** |
| Acknowledgement / partial / full fill model | Yes | Yes | Yes | n/a | **No** |
| Idempotent dispatch claim | Yes | Yes | Yes | **Yes** | n/a |
| Atomic observation + projection application | Yes | Yes | Yes | **Yes** | n/a |
| Restart-safe exclusive cancellation claim | Yes | Yes | Yes | **Yes** | **No** |
| Immutable stored-intent digest | Yes | Yes | n/a | **Yes** | n/a |
| Uniform durable-read integrity boundary | Yes | Yes | n/a | **Yes** | n/a |
| Bounded in-memory admission-consumption state | Yes | Yes | n/a | n/a | n/a |
| Ambiguous-outcome fail-closed | Yes | Yes | Yes | n/a | **No** |
| Credential redaction | Yes | Yes | Yes | n/a | n/a |
| Architecture boundary | Yes | Yes (TypeScript AST graph + primitive-capability inventory + adversarial fixtures) | n/a | n/a | n/a |

"Externally live-verified" means an authenticated call was made to the real
CoinDCX venue. **No cell in that column is Yes.** Everything exchange-facing was
exercised against a loopback HTTP stub. Section 10 lists exactly what a real
venue would still have to confirm.

---

## 2. Module map

Execution owns the *ports*; the integration layer owns the *adapter* and the
wiring. That split is what lets the architecture test prove the boundary.

```
src/execution/live/                    (no dependency on src/integration/** at all)
  errors.ts                fault taxonomy + credential-free details guarantee
  decimal.ts               exact fixed-point decimals, BigInt increment arithmetic
  types.ts                 domain vocabulary (plain data, confers no capability)
  identity.ts              canonical intent id + deterministic client order id
  execution-policy.ts      content-addressed live execution policy
  gate.ts                  disabled-by-default enablement resolution
  instrument-constraints.ts  authoritative bounds + explicit quantization
  intent.ts                immutable LiveExecutionIntent
  authority.ts             LIVE-only authority + the two mints
  state-machine.ts         durable states, financial monotonicity, conflicts
  gateway.ts               CoinDcxFuturesOrderGateway PORT (no HTTP, no credentials)
  repository.ts            persistence port + Prisma adapter
  service.ts               the controlled execution root
  index.ts                 public barrel (no mints, no composer, no adapter)

src/integration/coindcx/live/          (contains the explicitly bounded mutation chain)
  endpoints.ts             create, cancel, and list-observation endpoints
  wire-schemas.ts          zod validation for private order responses
  mutation-transport.ts    authenticated POST transport + dispatch classification
  order-gateway.ts         CoinDCX adapter implementing the execution port
  production-runtime.ts    the single approved production root
```

`production-runtime.ts` lives under `src/integration/` rather than
`src/execution/` on purpose: Phase 14 froze a lint-enforced rule that no
`src/execution/**` file may name the CoinDCX integration surface. Phase 17 keeps
that rule intact and strengthens it — the Phase 17 execution tree reaches *no*
integration module, not even a type-only one — and follows the precedent already
set by `paper-production-runtime.ts`.

### 2.1 Exact authenticated mutation boundary

```text
LiveExecutionRuntime / composeLiveExecutionRuntime
  [src/integration/coindcx/live/production-runtime.ts]
    -> LiveExecutionService
       [src/execution/live/service.ts]
    -> CoinDcxLiveFuturesOrderGateway
       [src/integration/coindcx/live/order-gateway.ts]
    -> CoinDcxOrderMutationTransport
       [src/integration/coindcx/live/mutation-transport.ts]
    -> HmacSha256Signer
       [src/integration/coindcx/signer.ts]
    -> node:http / node:https
```

Only `mutation-transport.ts` owns both outbound HTTP and access to the signer
for order mutation. `order-gateway.ts` is the sole direct importer of that
transport; `production-runtime.ts` is the sole importer of the gateway. The
signer is shared with the pre-existing authenticated read/private-stream paths,
but is no longer re-exported from the public CoinDCX barrel. Exact network and
CoinDCX-crypto owner lists are pinned by architecture tests; adding a file under
the live directory is not permission.

The import proof uses the TypeScript AST. It follows static imports,
re-exports/barrels, literal dynamic imports, direct/static CommonJS require,
statically resolvable require aliases, `module.require`, and `createRequire`.
Computed or indirect loading in production source is rejected as unresolved;
the test does not claim that a regex or an untyped filename convention is a
complete TypeScript module-graph proof.

---

## 3. Current official CoinDCX contract evidence

Evidence was re-checked on 2026-09-20 against the current official
[CoinDCX API Reference](https://docs.coindcx.com/). No request was sent to the
real venue.

### 3.1 VERIFIED current CoinDCX contract

| Item | Verified contract |
| :--- | :--- |
| Base/authentication | `https://api.coindcx.com`; signed JSON using `X-AUTH-APIKEY` and `X-AUTH-SIGNATURE` |
| Create | `POST /exchange/v1/derivatives/futures/orders/create` |
| Create envelope | `{ timestamp, order: { ... } }` |
| Create fields used | `side`, `pair`, `order_type`, `price`, `stop_price`, `total_quantity`, optional `leverage`, `notification`, optional `time_in_force`, `margin_currency_short_name` |
| Order types used | `limit_order`; MARKET remains blocked by the Wave A notional boundary |
| Time in force | `good_till_cancel`, `fill_or_kill`, `immediate_or_cancel`; omit for MARKET |
| Post-only | `post_only` is documented as unsupported |
| Create response | One-element order array; newly placed order status is `initial` |
| Exchange identity | Order `id` returned by CoinDCX |
| Cancel | `POST /exchange/v1/derivatives/futures/orders/cancel` with `{timestamp,id}`; success acknowledgement `{message,status,code}` |
| Observation | `POST /exchange/v1/derivatives/futures/orders` (List Orders) |
| Observation request | `timestamp`, comma-separated `status`, `side`, `page`, `size`, and `margin_currency_short_name` array |
| Observation statuses | `open`, `filled`, `partially_filled`, `partially_cancelled`, `cancelled`, `rejected`, `untriggered` |
| Financial operands | `total_quantity`, `remaining_quantity`, `cancelled_quantity`, and `avg_price` |
| Failures | HTTP status plus documented error message/reason; documented cases include 400, 422, and 500 |

The executable schema requires the documented order envelope and one-element
create response. Flat create bodies, bare or multi-order create responses,
unknown statuses, and malformed error responses fail closed.

The adapter requests `size=200`; that is an internal request choice, **not** a
verified futures provider maximum. The actual provider page-size cap is **NOT
VERIFIED**. Every non-empty page is followed regardless of its length. An empty
page is the current proof of exhaustion; a fixed 100-page safety guard prevents
an infinite/unbounded scan, and reaching it returns
`LIVE_ORDER_OBSERVATION_PAGINATION_LIMIT` ambiguity rather than `NOT_FOUND`.
Pages are processed incrementally and only the one matching row is retained.
Selection remains by exact exchange `id`; duplicate matches on the same or
different pages are an identity-ambiguity fault. Array position is never
identity.

### 3.2 Client identity (`client_order_id`, provider-confirmed in Phase 18)

When Phase 17 shipped, the official futures Create Order, List Orders, and
Cancel Order contracts did not establish a `client_order_id` field, so
`p17-<32 hex>` was kept as a deterministic LOCAL idempotency key only and was
not sent.

That has since changed (Phase 18, provider-identity wave). CoinDCX support has
confirmed that futures create supports `client_order_id`, maximum 36
characters, and that it is idempotent: a second create with the same id fails
with an error code/reason (the exact code is not yet confirmed). The read-only
provider probe observed the field in List Orders (`null` on orders created
without one). Therefore:

- The unchanged 36-character `p17-<32 hex>` id is now sent on every normal
  create as `client_order_id` (mandatory in `LiveCreateRequestSchema`). Its
  format and derivation did not change, so already-persisted intents keep
  their ids.
- It is derived from the intent's economic content and persisted with the
  intent before the dispatch claim, the pre-wire arm, and the first network
  attempt. A retry of the same intent reuses it; a different intent gets a
  different one; nothing regenerates it after a timeout, and an ambiguous
  create is still never resent.
- The adapter refuses (`PRE_DISPATCH_FAILURE`, nothing sent) any id that is
  not exactly the frozen format within 36 characters.
- `exchangeClientOrderId` carries the venue's own value only when it is
  byte-identical to the local id; a different non-null venue value is an
  identity mismatch. `null` stays `null` and is never filled with the local id.
- A duplicate-id create failure has a typed outcome
  (`DUPLICATE_CLIENT_ORDER_ID`) that fails closed as `SUBMISSION_AMBIGUOUS`,
  never success or `REJECTED`. The exact provider signal
  (`COINDCX_DUPLICATE_CLIENT_ORDER_ID_SIGNAL`) is `null` until CoinDCX confirms
  the code, so today no response is classified as a duplicate.
- Because any create HTTP failure could be that unconfirmed duplicate, every
  create HTTP failure other than the exact configured duplicate signal is
  `AMBIGUOUS` — there is no terminal `REJECTED` for a create HTTP failure
  (PROVIDER-IDEMP-01, see §7's outcome table).

Cancel still binds the exchange-confirmed `id`, and fetch still selects by
`id`. See `docs/PHASE18_RECONCILIATION.md` §8.0 for how reconciliation may use
the id to identify an ambiguous create.

### 3.3 Unsupported semantics and remaining unknowns

- **Post-only.** The current documentation explicitly says it is unsupported.
  The adapter fixes `supportsPostOnly: false`; policy cannot override it.
- **Time in force.** LIMIT maps explicit GTC/FOK/IOC end-to-end. `UNSPECIFIED`
  omits the field and receives the documented default GTC. MARKET plus any TIF
  is rejected before mutation.
- **Conditional orders.** `stop_*` and `take_profit_*` remain outside Phase 17;
  `untriggered` therefore fails closed.
- **Unknown:** no live-venue call has confirmed actual serialization,
  pagination behavior at account scale, or production error/latency edges.

---

## 4. Authority chain

A live order mutation requires all of the following, in this order, inside one
mint function. There is no other path to a `LiveExecutionAuthority`.

1. **Configuration enablement** — a genuine `LiveExecutionEnablement`, which
   only `resolveLiveExecutionGate` can issue, and whose account and pair
   allowlists must both contain this order's account and pair.
2. **Phase 12 research approval** (OPEN only) — `issueResearchApprovalOrigin`
   must return a genuine origin for this exact pair/strategy/version/parameter
   tuple. CLOSE is research-exempt by the frozen Phase 14 rule.
3. **Phase 10 kernel origin** — `authorizeStrategyDispatch` (OPEN) or
   `createStrategyRiskHandoff` (CLOSE) must issue a genuine strategy origin.
4. **Phase 13 risk acceptance** — the real `RiskAdmissionCoordinator` must
   return `ADMITTED` (OPEN) or `ACCEPTED_NO_CAPACITY_OWNERSHIP` (CLOSE).
5. **Position ownership** (CLOSE only) — the durable position's full
   instance/strategy/version/parameter tuple must match the decision.

Only then is the intent built — and it is built **from the accepted decision's
own approved economics**, never from caller input:

| Intent field | Source |
| :--- | :--- |
| `quantity` | `decision.approved.approvedQuantity` (OPEN) / the position's owned quantity (CLOSE) |
| `leverage` | `decision.approved.approvedLeverage` (OPEN) / `null` (CLOSE) |
| `riskDecisionId` | the accepted decision |
| `admissionId` | the genuine admission record (OPEN) / `null` (CLOSE) |
| `side` | admission direction (OPEN) / opposite of the held position side (CLOSE) |
| `pair`, strategy tuple | the admission / decision |

The caller supplies only non-economic shape: order type, time in force, and a
limit price — each of which is then validated against the policy and the
instrument.

For CLOSE, the composition additionally requires an existing authoritative
`live_position` row. Phase17 defines and consumes this durable ownership record
but does **not** populate it from CoinDCX. The production writer/reconciliation
source belongs to Phase18. Until Phase18 establishes that state, production
CLOSE fails before authority mint or gateway mutation with
`LIVE_POSITION_NOT_AVAILABLE`. Phase17 tests seed `live_position` only to prove
CLOSE ownership, revision, direction, and reduction mechanics; that seeding is
not a production writer.

`LiveExecutionAuthority` holds its record in an ECMAScript-private field and is
constructed only with a module-private issuer symbol. Every forgery route the
Phase 17 brief lists is tested and fails closed: plain-object fabrication,
object-spread reconstruction, prototype forgery, subclassing, exported-namespace
mutation, stale reuse, reuse for another pair, reuse for another account, reuse
after intent mutation, and paper-to-live substitution in both directions.

---

## 5. Identity

**Intent identity** is `sha256` over a canonical preimage binding every
outcome-relevant field: account, pair, side, OPEN/CLOSE, quantity, order type,
price, time in force, leverage, risk decision id, admission id, the full
strategy tuple, the execution policy id, and the instrument spec snapshot id.
Audit-only lineage (research approval, source decision) is deliberately
excluded, exactly as Phase 14 excludes it, so a genuine approval reissue never
forks an existing economic identity. No clock, random value, insertion order,
process state, or database sequence participates.

**Local client identity** is derived from the same preimage in its own hash domain and
then truncated per this documented adapter policy (P17-I06):

```
p17- + first 32 lowercase hex characters of SHA-256   →  36 chars, [a-z0-9-]
```

The current futures contract does not establish this field, so Phase 17 pins
the format locally and does not put it on the wire. A truncation
collision cannot cause an order to be reused: `UNIQUE(client_order_id)` on both
Phase 17 tables turns it into a hard `LIVE_INTENT_CONFLICT`.

---

## 6. State model

Ten states, with unresolved mutation/conflict states non-dispatchable in this phase:

```
CREATED ──► DISPATCH_RESERVED ──┬──► ACKNOWLEDGED ──┬──► PARTIALLY_FILLED ──┬──► FILLED
     ▲                          │                   │         │            │
     │ (only on a proven        ├──► REJECTED       ├──► CANCEL_REQUESTED ──┼──► CANCELLED
     └── pre-dispatch failure)  ├──► SUBMISSION_AMBIGUOUS (terminal, Phase 18 resolves)
                                └──► PARTIALLY_FILLED / FILLED (venue reported fills with the ack)
```

Frozen rules, each with a test:

- Provider data is validated before the append-only event insert or mutable
  order projection. Pair, exchange order id, side, order type, margin currency,
  original quantity, LIMIT price, and provider conversion rate (when supplied)
  must match immutable local economics.
- `filled = total_quantity - remaining_quantity - cancelled_quantity`, using
  Decimal arithmetic. All three operands are mandatory and non-negative;
  `remaining + cancelled <= total` and `filled <= total` must hold.
- An acknowledgement is **not** a fill. A zero-fill ack never advances quantity.
- Cumulative fill is monotonically non-decreasing forever.
- A provider cumulative fill above zero must carry its current cumulative
  average execution price. A same-quantity average-price correction is a real
  financial update, not a duplicate, and a growing fill replaces the old
  average with the new provider cumulative average.
- `FILLED → PARTIALLY_FILLED` is forbidden. `SUBMISSION_AMBIGUOUS` cannot be
  resolved here. Late execution evidence after `CANCELLED` or `REJECTED` is
  preserved and moves the order to `RECONCILIATION_REQUIRED`; Phase 17 never
  decreases its cumulative fill or automatically dispatches from that state.
- A cancel acknowledgement is **not** proof that nothing filled. Fills confirmed
  before or around the cancel are preserved, and a cancel that races a complete
  fill resolves as `FILLED`, never as a `CANCELLED` row holding a full fill.
- A **late** observation (older provider event time, lower cumulative fill) is
  ignored as out-of-order delivery. A **fresh** observation that contradicts
  durable truth (fill regression, over-fill, fills on a rejected order) is a
  hard fault.
- `DISPATCH_RESERVED → CREATED` exists for exactly one condition: the gateway
  proved the request never left the process. Every other unresolved outcome
  becomes `SUBMISSION_AMBIGUOUS` instead.

---

## 7. Idempotence and concurrency

Every guarantee is enforced by the database, not by an in-memory lock.

| Mechanism | Enforcement |
| :--- | :--- |
| One order per intent | `PRIMARY KEY(intent_id)` on both `live_execution_intent` and `live_order` |
| No client-order-id reuse | `UNIQUE(client_order_id)` on both tables |
| One dispatcher | a row-locking transaction verifies the canonical intent, every immutable order mirror, current admission validity, durable admission allocation, state and revision before the conditional `CREATED → DISPATCH_RESERVED` update |
| Durable reads are trustworthy | every authoritative read recomputes the stored intent digest and re-proves the `live_order` immutable mirror columns against it; transactional state writes verify before writing and roll back their own state/fault/revision changes on mismatch |
| Process-local consumption state is bounded | the live consumption marker is a field of the admission entry, not a separate map, so it cannot outlive or outnumber the admission population |
| No lost update | row lock plus conditional update on expected state, revision, intent id, client order id, account, pair, and canonical ordered quantity |
| Repeated provider event | `UNIQUE(intent_id, observation_sha256)` |
| Event + financial projection | One row-locking transaction validates, inserts the event, and updates the order; any failure rolls back both |
| One active cancel mutation | Row lock plus durable `cancel_state` / `cancel_generation`; only `NONE → CANCEL_RESERVED` reaches the gateway |
| Immutable intent reuse | Stored canonical content digest is recomputed from every immutable column and compared with the incoming canonical digest |

The durable claim is taken **before** the wire call, so a crash between claim
and response can never present as "never dispatched" on restart.

`dispatchClaimTimeoutMs` is only an ambiguity-classification threshold. An
expired `DISPATCH_RESERVED` row becomes `SUBMISSION_AMBIGUOUS`; timeout never
proves the create was unsent, never releases the claim, and never permits a
blind retry.

`live_admission_consumption` proves that capacity is allocated to one immutable
intent; it is not proof that the admission remains current. Every new
`CREATED → DISPATCH_RESERVED` attempt revalidates the genuine coordinator
admission, including an identical retry after a proven pre-dispatch failure.
A released or revoked admission therefore cannot be revived by its durable
same-intent consumption row. Releasing an admission after an order is already
acknowledged does not retroactively invalidate that order or its durable cancel
capability.

Cancellation is reconstructed after restart from durable account ownership,
pair, exchange order id, intent identity, current order state, and the trusted
configured credential-account boundary. It does not require the original
OPEN admission or a process-local authority object. `CANCEL_RESERVED`,
`CANCEL_ACKNOWLEDGED`, `CANCEL_AMBIGUOUS`, and `CANCEL_REJECTED` are durable;
an ambiguous attempt is never blindly resent.

Ambiguity handling (P17-I07/I14/I20): if a create-order mutation's outcome
cannot be established, the order becomes `SUBMISSION_AMBIGUOUS` with a durable
fault, and any later dispatch of the same intent throws
`LIVE_SUBMISSION_AMBIGUOUS`. There is no retry path. Reading it back is also
refused, because that is reconciliation and belongs to Phase 18.

Outcome classification in the transport is what makes this precise:

| Wire situation | Classification | Consequence |
| :--- | :--- | :--- |
| Socket never connected (DNS failure, connection refused) | `PRE_DISPATCH` | Claim released; the intent stays retryable |
| Timeout, reset, aborted, oversized or unparseable body after connect | `UNESTABLISHED` | `SUBMISSION_AMBIGUOUS`; never resent |
| Create: exact configured duplicate `client_order_id` status + code | `DUPLICATE_CLIENT_ORDER_ID` | `SUBMISSION_AMBIGUOUS`; never resent (signal is `null` until CoinDCX confirms the code) |
| Create: any other HTTP failure (every 4xx including 429, every 5xx, malformed error body) | `AMBIGUOUS` | `SUBMISSION_AMBIGUOUS`; never resent. [Phase 18 PROVIDER-IDEMP-01] Superseded the original "4xx other than 429 is a definite refusal → `REJECTED`" rule: that was a generic status inference, not provider evidence, and an unconfirmed duplicate-`client_order_id` rejection may be a 4xx that proves an earlier create landed. No provider-verified terminal create-rejection code exists in this repository, so none is whitelisted. |
| Cancel: HTTP 4xx other than 429 | definite refusal | `CANCEL_REJECTED` (cancel classification unchanged) |
| Cancel: HTTP 429 or 5xx | `AMBIGUOUS` | Fails closed — the contract does not establish that a throttled or errored mutation was not processed |

The 429 choice is deliberately conservative and is a known operational
trade-off: a rate-limited create-order permanently parks that intent for Phase
18 rather than risking a duplicate order. Rate-limit avoidance is the mitigation.

---

## 8. Persistence

Five additive tables, extending the Phase 14 intent/order/fact split. No
existing table is altered, nothing is backfilled, and no exchange state is
guessed during migration.

- **`live_execution_intent`** — immutable economic identity plus full risk and
  research lineage and a canonical immutable-content digest. The digest is
  recomputed from the stored columns on EVERY authoritative read, replay,
  recovery and restart path, not only on reuse, so changing a column without
  changing the digest is detected wherever it is read. Primary key is the
  deterministic intent id.
- **`live_admission_consumption`** — one durable winner per OPEN admission.
- **`live_position`** — authoritative CLOSE ownership instance and revision.
  Phase17 consumes this table but has no production venue-to-table writer;
  establishing and reconciling it is Phase18 scope.
- **`live_order`** — mutable state projection: state, exchange order id (only
  when genuinely supplied), ordered / cumulative filled / remaining quantity,
  average fill price, last venue status, provider event time, fault code, and
  the `revision` concurrency token, plus independent cancel claim/generation.
- **`live_order_event`** — append-only log of validated observations, keyed for
  dedup by `(intent_id, observation_sha256)`. Event insertion and projection
  mutation occur in the same transaction under a target-order row lock.

All economic values are `DECIMAL(36,18)`, the repository-wide convention.
Timestamps are split by authority: `provider_event_time_ms` is venue time,
`created_at`/`updated_at` are local operational time. No raw credential-bearing
provider payload is stored anywhere.

Migration: `prisma/migrations/20260920000000_phase17_live_execution/`.
Applying all migrations to a disposable MySQL database and diffing it against
the current datamodel produces no difference for any Phase17-owned table,
index, unique constraint, enum, or foreign key. Explicit Prisma `map` metadata
pins all three Phase17 FK names. The same whole-schema diff reports two older,
untouched FK-name differences on `paper_execution_intent` (Phase14) and
`ranking_result` (Phase15); Wave D does not rewrite those historical migrations.

---

## 9. Security

- The trusted production composer reads the configured key/secret and passes
  them through the gateway constructor into `CoinDcxOrderMutationTransport`;
  only the transport retains them, creates the signed payload/signature, and
  constructs the outbound authentication headers.
- No gateway result carries them. Transport failures surface as fixed reason
  codes (`TIMEOUT`, `TRANSPORT_ERROR`, `HTTP_503`), never as venue or OS message
  text.
- `LiveExecutionError` **refuses construction** if its `details` contain a key
  the shared logger classifies as sensitive, at any depth, and additionally
  passes what survives through `redactSensitiveData`.
- The execution service, repository, state machine, and authority chain never
  see a credential at all — the composition hands credentials only to the
  adapter.
- Tested with JSON-encoded hostile HTTP error bodies: no result value, error,
  audit row, or log line from the Phase17 path contains the key, secret,
  signature, authorization value, or raw signed request material.

Evidence classification: the capability boundary is **STRUCTURALLY PROVEN**;
behaviour is **UNIT TESTED**; persistence and concurrency are **REAL-DB
PROVEN**; exchange mapping is **MOCK/LOOPBACK ADAPTER TESTED** and
**OFFICIAL-DOC VERIFIED**; every real exchange operation remains **LIVE-VENUE
NOT VERIFIED**. Startup reconciliation and ambiguous-mutation repair are
**PHASE 18 DEFERRED**.

---

## 10. Known limitations and Phase 18 deferrals

**Not verified against the real venue.** Every exchange interaction was tested
against a loopback stub. Before any real order, a maintainer should confirm, in
a read-only or single minimal-notional manual test outside this implementation:

1. real-venue serialization of the documented create/cancel/list responses;
2. the futures provider's actual page-size cap and account-scale pagination behavior;
3. the operational behavior of `cancelled_quantity` during cancellation races;
4. production error bodies and latency behavior.

**Deferred to Phase 18 (deliberately absent here):** startup reconciliation,
orphan exchange-order cleanup, crash-recovery reconciliation, exchange-versus-
database repair, automatic restart recovery of ambiguous orders, the production
writer/reconciliation source for `live_position`, funding accounting, liquidation and maintenance-margin
modelling, automatic promotion to LIVE, shadow-mode analytics, BTC/ETH live
rollout, production capital enablement, and any retry of an ambiguous mutation.

**Other current limits:** production CLOSE is unavailable until Phase18 supplies
authoritative durable `live_position` state; a 429 on a mutation parks the intent as ambiguous;
restart-safe cancellation is limited to orders with a durable exchange order
id and never resolves an ambiguous create; and list-orders observation is used
only within a cancel or an explicit sync, never as a background poller.

**The bound of the durable-integrity boundary.** Every authoritative read
recomputes the sealed intent digest and re-proves the `live_order` immutable
mirror columns against it, so altering any single stored column fails closed on
every path. What this does NOT defeat is a writer with full SQL access who
rewrites the content and its digest together. That is detectable only where an
independently minted intent exists to compare against — `ensureIntent`, and
therefore every dispatch — and is not detectable on a pure recovery path such
as `cancelDurable` or `syncOrderState`, which have no second source of truth.
Anyone able to perform that rewrite can equally rewrite `live_order` directly,
so the database remains a trusted component; this section states that plainly
rather than implying the digest makes it untrusted. `live_position` carries no
digest at all because Phase17 never writes it, and is therefore only ever
compared against an already-verified intent, never trusted on its own.

---

## 11. How to enable live execution (and why it is off)

Live mutation requires **all** of the following. Any single omission, typo, or
near-miss value fails closed with a named reason:

```
NODE_ENV=production
LIVE_EXECUTION_ENABLED=true          # the exact lowercase literal; 'TRUE', '1', 'yes' are refused
LIVE_EXECUTION_ACCOUNT_ALLOWLIST=<account id>[,<account id>…]
LIVE_EXECUTION_PAIR_ALLOWLIST=<pair>[,<pair>…]
LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR=<positive fixed-point decimal>
COINDCX_LIVE_ACCOUNT_ID=<trusted configured owner of these credentials>
COINDCX_API_KEY=<key>
COINDCX_API_SECRET=<secret>
```

The shipped defaults are `false` and empty. `composeLiveExecutionRuntime` throws
`LIVE_EXECUTION_DISABLED` when the gate refuses, and no gateway, transport,
signer, or credential object is constructed in that case.

CoinDCX does not provide a safely documented pre-mutation credential-owner
proof used by this phase. `COINDCX_LIVE_ACCOUNT_ID` therefore makes that
limitation explicit and establishes the trusted deployment boundary; it must
also appear in the account allowlist. Phase 17 rejects MARKET live orders
because no authoritative conservative future-fill-price bound is available.
LIMIT notional is converted from quote currency to INR with the risk-bound
settlement rate and multiplier, and may exceed neither the accepted risk
envelope nor the configured INR ceiling.

---

## 12. Test inventory

| Suite | Tests | Covers |
| :--- | :--- | :--- |
| `tests/unit/execution/live/identity.test.ts` | 30 | canonical identity, collision resistance, client-order-id policy |
| `tests/unit/execution/live/decimal-and-constraints.test.ts` | 28 | exact decimals, BigInt increments, quantization, instrument bounds |
| `tests/unit/execution/live/gate-and-policy.test.ts` | 43 | disabled-by-default, malformed config, fixed exchange capabilities, policy content addressing |
| `tests/unit/execution/live/state-machine.test.ts` | 47 | ack≠fill, average correction, late-fill conflicts, partials, duplicates, forbidden transitions |
| `tests/unit/execution/live/authority.test.ts` | 34 | authority chain, paper/live isolation, forgery routes, intent binding |
| `tests/unit/execution/live/service.test.ts` | 47 | dispatch lifecycle, current-admission retry validation, TIF preservation, durable restart cancellation, cancel concurrency, conflict containment |
| `tests/unit/execution/live/order-gateway.test.ts` | 48 | current contract mapping, safe incremental pagination, exact-ID selection, hostile response validation, financial conservation |
| `tests/unit/execution/live/repository.test.ts` | 15 | claim, revision guard, conflict detection, canonical observation identity |
| `tests/unit/execution/live/durable-integrity.test.ts` | 71 | per-column tamper sweeps, cancellation verify-before-write rollback, immutable-mirror state-commit refusals, per-path side-effect proofs, and a poisoned-database bypass proof over every public repository method |
| `tests/unit/execution/live/errors-and-redaction.test.ts` | 12 | taxonomy, credential-free details |
| `tests/unit/execution/live/position-ownership.test.ts` | 2 | explicit missing durable-position failure and exact seeded ownership lookup |
| `tests/unit/execution/live/admission-consumption-lifecycle.test.ts` | 6 | one consumption marker per admission across submission, rejection, timeout, pre-dispatch failure, cancellation and ambiguity |
| `tests/unit/dispatch/admission-consumption-bounded.test.ts` | 17 | consumption-state boundedness, eviction with the owning entry, and structural pinning of the coordinator state containers |
| `tests/unit/prisma/phase17-schema.test.ts` | 37 | additive migration, immutable digest, cancellation claim fields, Decimal columns, enums, explicit FK names |
| `tests/architecture/phase17-live-execution-boundary.test.ts` | 41 | transitive import-graph boundary, removal of inferred status route, and explicit Phase 18 position-writer boundary |
| `tests/architecture/phase17-mutation-capability.test.ts` | 25 | exact network/signing owners, dynamic-loader fail-closed rules, reviewer bypass probes |
| `tests/integration/execution/live-execution-persistence.integration.test.ts` | 48 | real MySQL atomic replay, cancel single-winner/restart safety, cancellation rollback, immutable-mirror dispatch races, released-admission retry refusal, and uniform durable-integrity checks |

The final-blocker validation run executed 509 selected Phase17 and dispatch
unit/schema/architecture tests plus 48 strict real-DB tests. The full repository
run executed 2,919 tests across 200 test files.

No test places a CoinDCX order. The only gateway any lifecycle test uses is
`FakeOrderGateway`; the adapter suite talks to a loopback stub server; the
database suite makes no network call at all.
