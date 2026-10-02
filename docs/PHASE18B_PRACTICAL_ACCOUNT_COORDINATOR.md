# Unwired practical-account coordinator

The coordinator owns one genuine credential-origin association and the original
owned reader, private stream, gateway, recovery service, reconciliation service,
mutation store and persistence repository. Construction performs no network,
socket, timer or database operation. A private issuer and association ownership
map prevent structural construction, foreign associations and duplicate owners.
No operational root or barrel reaches this module.

The current CoinDCX adapter has **no provider subscription confirmation**.
Genuine startup remains `BLOCKED` at `STREAM_PROOF`. Local credential association,
REST success, authenticated join transmission, event receipt and elapsed time do
not establish readiness or account continuity. Synthetic downstream readiness in
tests is model evidence only. This implementation does not make Phase18 operational.

## Threat model and dependencies

Application-owned exports, classes, own instance methods, schema graphs, exported
RegExp/Set membership and mutable contents may be replaced after their defining
module initializes, including before a consumer imports it. Selected bindings are
protected in their owners under emitted CommonJS and tsx. Original function/class
identities and public legacy schema identities remain. Import reachability alone
does not authorize protection of every export. Native intrinsics, module-loader
compromise, third-party library internals and explicitly trusted Prisma are excluded.

Native safety error readers use private instance records, exact defining kinds and
runtime closed-code validation. Foreign subclasses, forged prototypes, Proxy values
and arbitrary constructor codes cannot classify trusted failures. Mutable public
fields do not change a retained record. Class/code alone proves neither no durable
effect nor unknown-acquire authority: the genuine private receipt association and
the original same-transaction no-write proof remain necessary. Contradiction,
rollback, prewrite and commit-unknown distinctions remain unchanged.

Safety snapshots inspect own descriptors, never accessors or Proxy traps. Dynamic
Error messages are masked. Native AppError records use the reviewed kind/code
literal vocabulary and detached details. Logger resolves the cyclic safety reader
at call time; both import orders are tested. Legacy public serializers remain.

REST user-info/order/position, private notification and cancel/error grammars have
independent owner-held recipes. No public mutable children, `_def`, shapes, options,
checks, refinements or status membership are reused. All failure issues and nested
union errors are detached into original ZodError instances before returning them.
Returned-error and success-data mutation cannot reach the private recipes. Public
schemas remain legacy objects; unrelated schemas and shared Zod prototypes are not
frozen. Exact LosslessNumber lexemes, pagination/scope checks, cardinality, defaults,
optional/null/passthrough grammar, PII stripping and acknowledgement ambiguity remain.
Identity refuses length zero only: no trim/case folding; fingerprint uses exact UTF-8.

Recovery membership is the exact private predicate for `QUARANTINED`, `CERTIFYING`
and `PROVIDER_UNAVAILABLE`, independent of the public Set. Digest and client-id
validation use private literals and captured native RegExp execution. Selected
constant contents are protected without changing unrelated exported collections.

Owned private streams copy immutable primitive routing metadata before subscriber
delivery. Lifecycle reason/generation payloads are also immutable. Original native
socket/generation/stop checks run between subscribers; a genuine stop legitimately
cancels stale delivery. Invalid-event counters and reconciliation latches retain
their original behavior. The application-owned decoder installs its original bound
`add` as a protected own method. Stock Socket.IO framing and callback/reconstruction
state, legacy non-owned streams and unrelated candle algorithms remain unchanged.

## Arithmetic contract

The original LiveCalcDecimal clone retains identity, precision 128, ROUND_HALF_UP,
toExpNeg -160 and toExpPos 160. Its constructor/method/configuration bindings are
captured. Configuration scalars remain writable native data properties because
Decimal arithmetic legitimately writes them internally; descriptor integrity is
checked. A private synchronous section accepts fixed strings only, restores the
captured configuration before and after calculation, and returns primitives only.
No callback, accessor, Proxy, await or public intermediate Decimal enters it.
Restoration failure refuses with LIVE_NUMERIC_FAILURE before any result escapes.
Exact addition/subtraction is checked against primitive BigInt conservation.
DECIMAL(36,18) boundaries and canonical bytes are unchanged. Neither the shared
core Decimal context nor any shared Decimal/Zod prototype is frozen or configured.
Owned adapter subtraction uses protected helpers and native normalized financial
snapshots; unrelated public Decimal APIs retain their behavior.

## Startup and admission

One original 300000 ms scheduling budget applies for the owner lifetime. Repeated
`start()` observes the retained result and never restarts or recertifies. Every
awaited result is retained, including a late certificate; late results never admit.
Stop/deadline/ownership/original-watch checks guard each successor. Invalid clocks,
backward time and unsafe deadline arithmetic refuse. Stop and budget expiry wake
an active dwell pause without leaving a hanging promise.

| Phase | Required result and successor checks |
|---|---|
| Previous-runtime load/recovery | Exact durable rows; original eligibility; armed orphans never released |
| Startup recovery | READY, original fence/generation retained |
| Stream proof | Genuine start plus PROVEN_READY; actual current adapter refuses here |
| Watch | Original WATCHING incarnation retained; no latch reset |
| Reconciliation | COMPLETED/HEALTHY generation greater than watch-at-arm and startup fence |
| Certification | Native original certificate/watch association; late certificate retained only for settlement |
| Dwell monitor/pause | CERTIFICATE_STILL_VALID, absolute TTL, original watch and max of both dwell ceilings |
| Admission | OPEN only after all fresh checks; at most one pending observer |

Cancellation reserves BUSY synchronously and retains one chain before invocation.
Synchronous throw and asynchronous rejection become sanitized terminal unknown
effect, never NOT_COMMITTED or stranded BUSY. Public bookkeeping results omit the
exact private continuation. Only REFUSED/PREFLIGHT/INVALID_INPUT and NOT_COMMITTED
with certificateStatus ISSUED may reopen after fresh original watch/owner/TTL checks.
Other results close admission. Cleanup retains the exact native continuation; it
never creates new authority or enters the gateway. Permanent stop cancels pending
observer scheduling and retains active observer work and the original subscription.

## Shutdown

One original 30000 ms scheduling budget covers the single-owner phase pump. Every
successor, including synchronous teardown, checks that same deadline. Already
started work and late facts remain observable after expiry, but no new phase is
scheduled. Concurrent/later calls share retained phase operations and obtain fresh
frozen reports. They do not renew budgets or repeat effects.

| Phase | Ownership and completion requirement |
|---|---|
| Stop request | Permanently close admission; cancel pending observer/dwell scheduling |
| Startup/cancel settlement | Await original work; unknown effect is terminal |
| Bookkeeping settlement | Observe an existing retry or spend one exact eligible retry token across the chain |
| Cancel drain | `observeDrainWithoutRetry()` reserves observation of existing work only; no retry or nested budget |
| Observer settlement | Retain active monitor; rejection prohibits positive shutdown |
| Recovery settlement | One retained settlement observation |
| Stop watch | At most one call; durable refusal is terminal and never blindly retried |
| Final settlement | Positive settlement after STOPPED |
| Unsubscribe/stop stream | Original teardown once, within the original budget |
| Stopped | COMPLETE only after all required positive phase receipts |

`snapshotDrainWithoutRetry()` is synchronous read-only private-state observation,
with no reservation, timer, I/O, retry or gateway entry. Legacy standalone `drain()`
behavior is unchanged. Public reports distinguish PENDING_OBSERVATION,
TERMINAL_REFUSAL, BUDGET_EXPIRED and COMPLETE, with unique pending-operation count,
last settled phase and closed sanitized reason. A remaining bookkeeping continuation
after the sole retry token is spent is a refusal, not phantom pending work. Late
settlement updates retained facts; it cannot clear a durable stopWatch refusal.
LOCAL_DRAINED and LOCAL_SHUTDOWN_COMPLETED are local results only, never provider
continuity or proof of native socket shutdown.

## Verification and limits

Coordinator unit tests execute the current production body with deterministic
dependency doubles and controlled promises/timers. They cover original A/B/C/D,
startup/stop/deadline/watch-loss boundaries, active observer rejection, sole retry,
concurrent shutdown and synchronous teardown expiry. These are labelled MODEL tests.
The trusted-binding suite executes genuine owners/construction in emitted CommonJS
and tsx before coordinator consumer import and after owned construction, in both
AppError/logger import orders. It covers binding/content/parser-return/arithmetic/
error/identity/event/decoder attacks and compatibility with zero constructor I/O.
Real MySQL integration covers the genuine coordinator's STREAM_PROOF refusal and
read-only drain preservation of exact cleanup ownership. Downstream dispatch tests
use explicitly synthetic provider fixtures over genuine durable transitions.

Tier-A continuity, original issuer/writer/caller/primitive restrictions, certificate
eligibility, TTL, policy and armed-orphan restrictions remain. Database consumption
does not atomically fence the final socket entry: the original native watch guard
and documented database-to-socket supersession limitation remain. Acceptance does
not authorize operational wiring, live execution, provider calls or a completion tag.
