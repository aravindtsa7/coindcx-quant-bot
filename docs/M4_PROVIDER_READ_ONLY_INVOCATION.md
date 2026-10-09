# Explicit provider-capable read-only invocation — review candidate

Bootstrap checkpoint: `a85ec0bf7aa82cfd6c1448dd6f988ac90d4939f6`.
This extension is uncommitted and unapproved for real use. No provider request, real credential read,
real campaign installation or authorization was made during implementation. All campaign values in
[the unchanged proposal](launch/m4-orders-positions-proposal.json) remain `PROPOSED_NOT_APPROVED`.

## Entry and boundary

The explicit `coindcx-sync-read-bootstrap.ts` entry now accepts `prepare`, `initialize-campaign`,
`run-provider` and `run-loopback`. The old synthetic bootstrap commands remain loopback-only; the legacy
`coindcx-sync-read-launch.ts collect --spec ...` remains hard-blocked and points to the explicit entry.
Both CLIs and every new module start nothing on import. Production application startup and production budget
bindings are unchanged. This extension installs no hooks, execution service, mutation gateway or order capability.

Only these semantic operation/endpoint pairs are composed. Their HTTP method is POST, which alone does not
establish read-only behavior:

| Operation | Fixed existing endpoint ID | Existing fixed path |
| --- | --- | --- |
| IDENTITY | USER_INFO | `/exchange/v1/users/info` |
| INR_ORDERS | FUTURES_ORDERS | `/exchange/v1/derivatives/futures/orders` |
| INR_POSITIONS | FUTURES_POSITIONS | `/exchange/v1/derivatives/futures/positions` |

The committed client's existing INR payload construction, validation, signing and HTTP dispatcher are reused.
The transport's narrower closed semantic allowlist rejects every other endpoint before budget acquisition or
signing. The campaign wrapper exposes only three read functions, checks identity before account reads, requires
the exact side/status/page/size selection, rejects extra selectors, stops on the first read error and enforces
a hard 39-primitive ceiling. Each primitive constructs at most one request; there is no retry, redirect-following
composition, second budget acquisition or unpaced fallback. Already-started requests can finish after STOP;
queued permit starts check the stopped gate and cannot create another HTTP request. Active capacity is not refunded.

## Exact proposal and traffic scope

Every proposal field except account, lineage, report destination and the eventual authenticated session binding
is pinned by a canonical SHA-256 digest:
`61c257519c8aadbf5354a094e6f86f458ffc5eca08bff3912a5e4987b561d9c5`.
This verifies the exact existing numeric proposal and its filter construction; it approves none of it.

`3 evaluations × [1 identity + 1 cycle × 2 passes × (2 sides × 2 order pages + 2 position pages)] = 39`.
The breakdown is 3 identity, 24 orders and 12 positions requests. Order status is one combined filter string:
`open,filled,partially_filled,partially_cancelled,cancelled,rejected,untriggered`, on each buy/sell page.
Both components have page size 25 and at most two pages per segment. Client validation and loopback evidence
do not confirm provider acceptance of the combined filter. A provider-required split or any extra request needs
a new calculation, proposal and authorization; this entry refuses a changed parameter digest.

The proposed 2 starts/1000 ms, 20/60000 ms, P1 ceiling 13/60000 ms and concurrency 3 with one P0 reserve apply
to **managed campaign/coordinator traffic only**. An isolated namespace does not coordinate other installations,
unmanaged account users or every consumer sharing a public IP. `managedTraffic.knownConsumers` is an explicit
operator inventory, recorded as `declaredKnownManagedConsumers`; the current campaign/installation must appear.
`managedTraffic.externalTraffic` must remain `UNKNOWN_NOT_CONTROLLED`. Aggregate allocation and other traffic
must be reviewed; the code never attests exclusivity or a global provider/IP quota guarantee.

## Required input fields

Supply one absolute JSON file with `kind = COINDCX_READ_ONLY_CAMPAIGN_INPUT`,
`valuesStatus = PROPOSED_NOT_APPROVED`, and these fields. No credentials belong in this file.

- `target`: either `{kind: COINDCX_PROVIDER, origin: https://api.coindcx.com}` or
  `{kind: LOOPBACK_FIXTURE, origin: http://127.0.0.1:<explicit-port>}`. No URL credentials, alternate host, path,
  query or fragment. Loopback credentials must have synthetic `OFFLINE-` prefixes.
- `host`: the complete [reviewed bootstrap input](M4_READ_ONLY_BOOTSTRAP.md), including campaign/installation IDs,
  coordinator and client configuration, supervision, expected Windows owner, ownership-query timeout and report
  directory. `networkAccess` must be `COINDCX_PROVIDER_AUTHORIZATION_REQUIRED` for provider mode or `LOOPBACK_ONLY`
  for fixtures. These modes are bound in the installation manifest; an old loopback installation cannot be relabelled.
- `proposal`: all fields from the existing proposal, with explicitly supplied account and lineage availability,
  and the approved destination under the host's report directory. `budget.connectionId` must be null initially.
- `connectionBinding = AUTHENTICATED_CAMPAIGN_SESSION_AT_START`: the host inserts its actual authenticated M2
  installation/client binding after startup. That binding is runtime provenance, never fixture provenance.
- `accountMapping.{accountId,expectedProviderAccountFingerprint,sourceReference,verifiedAt,independentlyEstablished}`:
  independently supplied expected mapping, valid dated source and `independentlyEstablished = true`. Account and
  fingerprint must match the proposal exactly. No fingerprint is learned from the same unknown first response.
  Future dates are rejected; source trust and sufficient freshness still require operator review.
- `credentialProvenance.{accountId,sourceReference,establishedAt}`: separate operator source reference and date,
  matching the mapped account. This declaration alone does not prove credential identity or origin; each evaluation's
  existing identity read and exact fingerprint check must succeed before any account scan.
- `lineageProvenance`: either `{kind: SUPPLIED,sourceReference,exportedAt}` matching separately supplied durable
  `proposal.configuration.lineage`, or `{kind: UNAVAILABLE,reason}` matching that exact explicit lineage marker.
  Null remains incomplete. Unavailable lineage is never replaced by empty arrays or a fabricated bot namespace.
  The engine classifies every order/position as UNRESOLVED, adds OWNERSHIP_LINEAGE_UNAVAILABLE and prevents
  convergence even with empty scans. Account identity never implies order/position ownership. Supplied empty
  inventories still need an independently documented basis.
- `managedTraffic.{knownConsumers,externalTraffic}`: each consumer has
  `{consumerId,coordinatorInstallationId,operations: READ_P1_API_AUTH}`; external traffic remains unknown.

Missing stream observation remains UNKNOWN. Transactions remain CLIENT_ADAPTER_UNSUPPORTED, not confirmed
provider absence. The scope is exactly ORDERS_POSITIONS_ONLY_INFORMATION_COLLECTION, never full-account sync.
D4c, AS1, provider contracts, accounting/history completeness and formal M3/M4 acceptance stay unapproved;
every certificate, mutation-budget, authority-eligibility, lifecycle, continuity and live-readiness grant stays false.

## Campaign credentials and authorization

The loader reads only these four operator-supplied environment names, and only after authorization validation
for provider initialization/run. `prepare` reads no environment or authorization file:

```text
COINDCX_CAMPAIGN_API_KEY
COINDCX_CAMPAIGN_API_SECRET
COINDCX_CAMPAIGN_IPC_READ_KEY
COINDCX_CAMPAIGN_IPC_STOP_KEY
```

The IPC values must be distinct 256-bit lowercase hexadecimal secrets. No automatic dotenv loading, operational
configuration search or inherited live-credential alias fallback exists. The CLI accepts no credential arguments.
Provider credentials and capability keys are not sent through IPC; only challenge proofs and existing session
resume material cross IPC. Known-secret echoes are redacted from detached report/CLI output and from throttle
headers before forwarding to IPC. An altered Retry-After remains conservatively unparseable, never shortened.
The host process and its operator still hold secrets in memory; their custody and environment access need review.

`run-provider` and provider-mode `initialize-campaign` require a separate absolute authorization JSON file.
The implementation validates this record; it neither issues authorization nor proves its issuer. Required fields:

```text
kind = RECORDED_READ_ONLY_COLLECTION_AUTHORIZATION
target = COINDCX_PROVIDER
authorizationId, authorizedBy, authorizedAt, expiresAt
invocationSha256                    (canonical digest printed by prepare)
accountId, expectedProviderAccountFingerprint
scope = ORDERS_POSITIONS_ONLY_INFORMATION_COLLECTION
maximumRequests = 39
approvedProposalParametersSha256   (the pinned digest above)
reviews.hostSecurity
reviews.credentialCustody
reviews.supervisorAndStop
reviews.reportAccess
reviews.stateLifecycle
reviews.aggregateManagedBudget
residualHostAssumptions = EXPLICITLY_REVIEWED_NO_ACL_REMOTE_OR_PROCESS_IDENTITY_PROOF
```

References must identify the operator's actual review records. No real authorization record or completed review
references are provided here. The record must bind this entire invocation (including account, namespace, input
provenance, traffic declaration and report destination), be currently effective and not expired. Admission and
start gates also refuse after expiry. One host accepts at most one invocation; shutdown latches STOP and this entry
cannot reset it. There is no automatic namespace rotation or uncertainty-clearing fallback.

Authorization JSON validation proves field consistency, not approval authenticity. Protection of authorization/input
files and the issuing process is an unmet real deployment prerequisite. Local owner/write checks do not implement
restrictive Windows ACLs, remote-client exclusion, process identity, anti-relay protection or an independent supervisor.
IPC authenticates possession of READ versus STOP keys and installation/session bindings. READ can acquire only
P1/API_AUTH/READ and cannot STOP/RESET; STOP-only cannot acquire reads/mutations or RESET. Key holders remain trusted
to follow start/completion reporting discipline. These capabilities do not establish provider limits, account
exclusivity, OS identity or execution authority. Unreviewed security assumptions cannot become readiness merely by
entering fixture strings in a record.

## Future invocation, after separate review and authorization

Exact argv, from `C:\TSA\coindcx-m2-w1`, with operator-owned absolute input/authorization paths substituted:

```powershell
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-bootstrap.ts prepare --input C:\operator-owned\campaign-input.json
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-bootstrap.ts initialize-campaign --input C:\operator-owned\campaign-input.json --authorization C:\operator-owned\collection-authorization.json --confirm NEW_READ_ONLY_CAMPAIGN
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-bootstrap.ts run-provider --input C:\operator-owned\campaign-input.json --authorization C:\operator-owned\collection-authorization.json
```

The final command must be launched by the separately reviewed supervisor with **piped stdin**, not directly in a TTY.
The supervisor sends HEARTBEAT within the explicitly configured lease and STOP to end collection. EOF, invalid lines,
signals and lease loss stop reads. An independent deployment/supervisor identity is not supplied or proven here.
Initialization is a deliberate new-directory operation; never initialize or repair existing production state.
For offline testing, use `run-loopback`, the separate LOOPBACK_FIXTURE input and synthetic environment values,
without any provider authorization. Outputs retain LOOPBACK_FIXTURE provenance and cannot serve as provider evidence.

## Verification and remaining prerequisites

Offline tests use synthetic environment values, task-owned directories, loopback and real M2 IPC. They cover import
with HTTP/HTTPS/listen forbidden, missing inputs/authorization, semantic mutation/endpoint refusal, identity mismatch,
target separation, first error/429, saturation, supervision, STOP, redaction and ceiling enforcement. The unchanged
39-request legacy loopback fixture and existing real-coordinator pacing tests remain in the explicit DB-free list.
The new entry's real-coordinator loopback run retains the exact three-evaluation numeric proposal, then supervises
STOP after its first complete 13-request evaluation; it does not fake elapsed campaign intervals or provider provenance.

Real prerequisites remain: independently established account/fingerprint and credential source; explicit lineage
availability and supplied-source trust when applicable; actual managed-consumer and aggregate-budget allocation;
operator-owned namespace/report paths and storage review; authorized supervisor and separate key custody; protection
of input/authorization/state/pipe/report access and reviewed host assumptions; implementation review and separate
recorded permission for this named account/configuration/bounded read-only collection. No such values, reviews or
authorization were approved by offline tests. Exact logs, exit codes and preservation checks are in
`.local/m4-provider-invocation-evidence-20261009/`.
