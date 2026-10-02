# Unwired credential-origin construction

## Closed API and limits

The integration-owned createCoinDcxPracticalCredentialSources factory captures
one closed configuration, validates primitive snapshots, resolves only the
repository default HTTPS/WSS pair, constructs owned components, and finally
publishes one opaque association. Construction performs no HTTP request, creates
no socket and starts no timer or lifecycle. Failed construction publishes nothing.

The association retains one exact frozen reader/privateStream/gateway tuple.
Repeated reads return that tuple; checking requires that exact tuple and exact
instances. Every construction has a fresh origin even for identical credentials.
No adoption, rotation, injected dependency, barrel or operational importer exists.
checkCoinDcxCredentialScope compares private configured account/fingerprint
expectations with a closed composition-time scope input. It grants no authority
and cannot redirect a request. Its results contain only fixed categories.

| API | Closed output / ownership |
| --- | --- |
| createCoinDcxPracticalCredentialSources(options) | CONSTRUCTED with one private-branded association, or REFUSED with INVALID_OPTIONS, OPTION_READ_FAILED, INVALID_CREDENTIALS, INVALID_ACCOUNT_EXPECTATIONS, INVALID_ENDPOINT, INCOMPATIBLE_ENVIRONMENT, UNSUPPORTED_ENVIRONMENT or CONSTRUCTION_FAILED |
| readCoinDcxPracticalCredentialSources(association) | exact original frozen source tuple, or null for a nongenuine association |
| checkCoinDcxPracticalCredentialSources(association, sources) | LOCAL_CONSTRUCTION_ASSOCIATED, or REFUSED / INVALID_ASSOCIATION or INSTANCE_ASSOCIATION_MISMATCH; no property reads on candidate tuples |
| checkCoinDcxCredentialScope(association, expected) | CONFIGURED_SCOPE_MATCH, or REFUSED / INVALID_ASSOCIATION, INVALID_SCOPE or CONFIGURED_SCOPE_MISMATCH |

Options have exactly apiKey, apiSecret, configuredAccountId,
expectedProviderAccountFingerprint, optional restOrigin and optional
streamEndpoint. The scope input has only the two expectation fields, as own
data properties; accessors refuse without invocation. The read tuple has only
reader, privateStream and gateway. Required strings cannot be omitted. Association
records have no publicly readable credential/scope fields or origin digest.

| Lifecycle | Allowed operation | Result |
| --- | --- | --- |
| CAPTURE | Read each accepted own option once | primitive snapshots or sanitized refusal |
| VALIDATE | Non-coercing checks, then primitive string/URL operations | default compatible pair or refusal |
| CONSTRUCT | Protected lexical owned constructors | all genuine children or refusal |
| PUBLISHED | Read, exact association check, configured-scope equality | original tuple / fixed local result |

Own getters are read once before child construction. Inherited, unknown and
symbol options refuse. Getter/proxy capture failures are caught without inspecting
their thrown values. Primitive nonempty credentials must be unpadded; no credential
bytes are changed. Only omitted/undefined endpoints select defaults. The accepted
pair is https://api.coindcx.com and wss://stream.coindcx.com. Embedded credentials,
queries, fragments, non-origin paths and other environments refuse without fallback.
Raw syntax is checked before URL normalization can erase dot paths, empty userinfo
or control characters. A trailing origin slash is allowed; no path is accepted.
Configured account IDs/fingerprints are expectations, not authenticated identity.

## Protected ownership

The factory owns publication and the private association. Source defining modules
own lexical construction helpers and capture original method descriptors during
module initialization. Newly owned instances shadow mutable legacy prototypes
with immutable captured methods/accessors. Child read/mutation transports, signers
and socket adapters use the same protection. Legacy injection and prototypes stay
available; no global legacy prototype freeze is introduced.

Owned clocks/scheduling use immutable built-in bindings with existing timing
semantics. The factory accepts no clock, signer, socket factory, transport, gateway,
logger or readiness callback. Helper exports are pinned at defining-module creation;
pre-existing nonconfigurable tsx getters are verified against lexical identities.
The association constructor, prototype, methods and instance are frozen and its
issuer/private fields cannot be supplied by structural callers.

Construction helpers have exact architecture-pinned callers. The factory adds no
network or crypto owner. Existing transport-evidence issuers, entry/outcome owner,
original-watch checker and permanent admission/drain protections are unchanged.
No recovery or cancel service implementation is imported or instantiated.

Credentials and expectations remain in private storage, not public association
fields, JSON, inspection, refusals, errors or logs. Errors have fixed messages and
no hostile causes. Private closures do not expose raw signer/transport/socket state.
The existing read port still reports provider-observed fingerprints according to
its existing contract; these are not copied from private configured expectations.

This is local construction provenance only: it does not prove provider acceptance,
account ownership, subscription scope, readiness, reconciliation or continuity.
It cannot reset the reconnect latch, create confirmation, certify or satisfy strict
Tier-A. Native loader/cache/file replacement, intrinsic tampering, arbitrary
privileged internal calls and compromised third-party dependencies are outside the
property-substitution threat model. Configuration getters execute during capture;
this is not a sandbox for arbitrary JavaScript.

## Deferred composition and acceptance

A later reviewed coordinator can read/check this exact tuple and configured scope,
then separately establish genuine runtime, enablement, reconciliation, original
watch and certification. This wave does not do that or start/stop provider components.
Durable consumption still does not atomically fence native socket entry. Armed
orphans remain blocked. Provider-origin incarnation-bound confirmation, exact-gap
reconciliation and authoritative gap-detecting continuity remain external blockers.

Acceptance requires behavioral same/foreign origin, configured-scope, read-once,
hostile/coercion input, redaction and pre/post-import replacement tests in built
CommonJS and supported tsx; exact architecture pins; preserved existing strict
database regressions; typecheck/lint/build; sequential Prisma validation/generation;
and one six-worker full gate with all discovered strict database flags and no skips.
Only synthetic credentials/local mocks and a fresh owned loopback database are used.

The explicitly approved seventeenth file is the existing Phase18 reconciliation
architecture pin. Its exact gateway reacher list adds only this disconnected
factory alongside the existing runtime; a separate assertion requires zero
factory reachers. Signer constructor ownership adds only its defining module,
while protected helper callers remain exactly client/private-stream/mutation
transport. Neutral transport-evidence test access remains unchanged.
