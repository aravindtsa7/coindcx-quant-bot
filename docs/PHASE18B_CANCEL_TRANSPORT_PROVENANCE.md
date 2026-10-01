# Unwired practical cancel transport provenance

This closed contract is defined before implementation against
93bacc8d9e18778c3620ee4871b443a04984b636. It adds no operational composition.

## API and exact privileged caller sets

The neutral internal `practical-cancel-transport-evidence.ts` module exposes no
barrel API. Its source registration is an internal issuer, not configuration:

| Operation | Only production-source caller |
| --- | --- |
| installCancelTransportBrand, installCancelGatewayBrand | respective producer defining-module static initialization; one-time lexical private-brand readers |
| registerCancelTransportSource | CoinDCX mutation transport constructor |
| registerCancelGatewaySource | CoinDCX order gateway constructor |
| hasCancelTransportSource | practical cancel gateway boundary constructor |
| reserveCancelTransportInvocation, invokeCancelTransport, settleCancelTransportInvocation, closeCancelTransportInvocation | practical cancel gateway boundary |
| beginCancelTransportPreparation, markCancelTransmissionPossible, issueCancelTransportNoWrite | mutation transport private implementation |
| readCancelTransportRequest | order gateway and mutation transport private implementations |
| propagateCancelTransportResult | order gateway private implementation |
| issuePracticalCancelTransportNoWire, entry and outcome issuers | practical cancel gateway boundary |

Registration/issuance exports are privileged internals restricted by exact
architecture pins, like the existing core ownership issuers. Arbitrary code
calling those privileged internals, replacing Node's loader/cache, intrinsics or
executable files is outside this property-substitution threat model. Public
gateway methods, structural provenance ports and caller-selected source/binding
records cannot register or redirect the genuine private path.

The ordinary Phase17 `cancelOrder` and wire-result contracts remain unchanged.
The genuine gateway privately registers an invocation closure over its genuine
transport source. The boundary discovers only that identity association; no
per-call source or callback is accepted. Ordinary gateway doubles keep the
existing conservative projection. Registration closures call ECMAScript-private
implementations; the public `cancelOrder`/`execute` methods are not trusted
lookups in this new path.

The producer defining modules install one-time lexical native-private-brand
readers. Registration rejects structural objects and requires the gateway's
actual private transport association. Later brand-reader replacement refuses.
The protected `CoinDcxOrderMutationTransport.executePracticalCancel` verifies
that native brand and calls its private implementation. Constructor exports,
neutral exports and invocation/evidence classes are pinned at module creation.

Each opaque invocation binds one genuine UNENTERED original attempt, one exact
frozen four-field `LiveCancelOrderRequest` (clientOrderId, exchangeOrderId, pair,
trusted timeoutMs), one source and one invocation. Evidence is private-branded,
frozen, non-serializable and bound to that invocation. It grants no authority.

## Closed lifecycle

| Start | Operation | End |
| --- | --- | --- |
| no invocation | reserve exact genuine owner/request/source before final guard | RESERVED |
| RESERVED | genuine ENTERED owner invokes the private registered path once | INVOKING |
| INVOKING | genuine source starts local preparation once | PREPARING |
| PREPARING | preparation fails before native request factory | NO_WRITE; one evidence |
| PREPARING | immediately before native factory call | POSSIBLE, irreversible |
| any live state | boundary reserves terminal settlement | SETTLED |
| SETTLED with exact NO_WRITE observation/evidence | consume once | CLOSED; truthful no-write report |
| SETTLED otherwise, or timeout/refusal | close | CLOSED; no proof |

Observation state is retained independently of boundary settlement. Terminal
settlement is reserved before result reflection/evidence consumption. Timeout
closes the invocation and records AMBIGUOUS. Late values are ignored before
reflection; late rejection is handled. They cannot mint usable proof, alter an
outcome, resend or restore ownership. A proof-free response uses the existing
accepted/rejected/ambiguous mappings; structural PRE_DISPATCH_FAILURE stays
AMBIGUOUS.

## Actual proof boundary

Only the real transport's private preparation region may issue evidence. That
region builds its own plain body from validated primitive snapshots of the exact
original request, serializes, constructs URL and signs with its private secret
using native HMAC. Before beginning preparation, outside its proof-producing
catch, timestamp must be a primitive non-negative safe-integer number; retained
base URL, key, secret, original exchange ID and fixed endpoint path must be
primitive strings. Non-coercing checks refuse callback-bearing values with a
fixed error outside that catch, which the boundary records as AMBIGUOUS without
proof. No malformed value is serialized, inspected or logged. The gateway clock
is read once outside the region: a thrown error is ambiguity, never proof.

The transport reads each option once. Credential validation, legacy signing and
private practical-secret retention use the same primitive snapshots. A missing
(undefined) base URL retains the existing configured default; an explicit
malformed null value is retained separately for practical validation and refuses
without changing ordinary Phase17 nullish-default behavior. No malformed URL is
silently replaced for the practical path. There are no injected preparation
callbacks or mutable public signer lookups.

The V1 clock-object and URL-object callbacks were directly reproduced through
the genuine bound gateway: each caused one factory call/write before false
no-write completion. The standalone secret getter probe confirmed repeated
transport option reads, but false proof through the genuine bound gateway was
not reproduced: the gateway already copies that option once. Its read-once and
retained-primitive checks are defensive hardening, not a third confirmed bound
gateway vulnerability.

Preparation-input audit: timestamp and request ID are primitive local body
fields; base URL and endpoint path are primitive URL inputs; key/secret are
primitive header/HMAC inputs; content length derives only from the serialized
primitive body. Timeout is already bound/validated by the boundary. Response
limits are used only after factory entry, outside the no-write proof region.
No remaining ordinary configured/injected callback-bearing input enters that
region. Existing process-loader/intrinsic/file replacement exclusions remain.

Immediately before `http/https.request`, mark POSSIBLE. A synchronous factory
throw, connection refusal, DNS/TLS error, reuse, queued write failure, timeout or
uncertain/partial response thereafter cannot produce practical no-write proof.
The legacy connected=false classification is not consulted for proof.

Before final guard, create/reserve context. After final fresh original-watch
guard, spend entry and immediately call the selected private invocation; no
await/telemetry/queue is inserted. Guard refusal closes context and uses only
eligible unentered cleanup. After entry every result uses an outcome receipt.

Genuine evidence is converted to the existing attempt-bound no-wire token and
immediately into one immutable outcome. Coupled completion uses the unchanged
store: PRE_DISPATCH_FAILURE/NONE, cleared arm, consumed certificate, quarantine,
unchanged economic state. Unknown consumption never invokes; unknown completion
retries the identical receipt only. No resend or restarted permission exists.

All new trusted exports and source/invocation/evidence methods are protected in
their defining module for tsc CommonJS and supported tsx. Existing recovery,
service and boundary protections remain. Database consumption still does not
atomically fence socket entry or remote runtime supersession.

## Acceptance and limits

Tests cover genuine original watches and native local transport, pre-factory
failure, factory throw, refused/reused/connected sockets, queued writes, response
failure, forgery/binding/reuse, late hostile values, module replacement and real
MySQL coupled completion/unknown commits. Use synthetic credentials, loopback
fixtures and a fresh guarded instance excluding port 54054. Six workers, strict
DB flags and zero soft-skips are required. No provider calls or campaign.

The separately approved fixture correction guarantees a case-changing lowercase
hex tag while preserving width/uniqueness and unchanged refusal/zero-write
assertions. The digits-only no-op was reproduced historically; the exact causes
of the two historical failures remain unverified.

Provider confirmation, exact-gap reconciliation, strict continuity, practical
armed recovery and operational lifecycle/composition remain unresolved. No
Prisma, authority, stream, latch, economic-state or live-enablement change.
