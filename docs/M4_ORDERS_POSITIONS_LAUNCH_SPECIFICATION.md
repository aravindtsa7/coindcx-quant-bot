# One proposed orders/positions information collection

Proposal `m4-orders-positions-information-collection-20261008` is **PROPOSED_NOT_APPROVED**.
The complete proposed field names and values are in
[`launch/m4-orders-positions-proposal.json`](launch/m4-orders-positions-proposal.json).
Every numeric value is proposed for this one campaign; none is an approved default or a confirmed provider limit.
This follows the [launch checklist](M4_READ_ONLY_CAMPAIGN_LAUNCH_CHECKLIST.md) and uses the checkpointed
`runSyncReadCampaign`, existing adapter, asynchronous orchestrator and existing M2-budgeted client reads.

This is explicitly **ORDERS_AND_POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION**.
The new proposal declares exactly these two components, `CUMULATIVE_STATE`, `AVAILABLE_HISTORY`,
and no accounting requirements. It does not change any broader required synchronization scope.
Transactions remain `CLIENT_ADAPTER_UNSUPPORTED`, which says nothing about provider absence.
Adding required transactions to this proposal is rejected, never silently removed. A broader runner configuration
can retain them explicitly, but that required unsupported component prevents convergence.
Account scope is `UNKNOWN`, attestation is `NONE`, D4c and AS1 are `PENDING`, and contracts are `ALL_UNCONFIRMED`.

## Reads and filters

All three are authenticated read endpoints already implemented by the client. Their HTTP method is POST;
no mutation endpoint is composed. The intended provider origin is explicitly `https://api.coindcx.com`.
No request to that origin has been made during preparation.

| Existing client capability | Endpoint | Proposed request selection |
| --- | --- | --- |
| `getUserInfoSafe` | `/exchange/v1/users/info` | One identity read before each evaluation's account scans |
| `listInrFuturesOrders` | `/exchange/v1/derivatives/futures/orders` | Both `buy` and `sell`, separately; INR margin; pages `1` through `2`, size `25` |
| `listInrFuturesPositions` | `/exchange/v1/derivatives/futures/positions` | INR margin; pages `1` through `2`, size `25` |

The exact order status filter is
`open,filled,partially_filled,partially_cancelled,cancelled,rejected,untriggered`.
Both sides pass the existing `ListInrOrdersRequestSchema`; the positions parameters pass
`ListInrPositionsRequestSchema`. This is local client-schema validation, not fresh provider-contract confirmation.
The adapter performs no date filtering. Empty pages end segments; short pages alone do not establish termination.
A two-page scan that does not reach an empty page is explicitly truncated at `SCAN_BOUND`.
Provider page-size caps, stable pagination, retention and complete history remain unverified.

## Proposed bounds and request ceiling

| Configuration fields | Proposed values |
| --- | --- |
| `scanLimits.ORDERS`, `scanLimits.POSITIONS` | Each `{ pageSize: 25, maxPages: 2 }`; orders bound applies to each side |
| `budget.admissionDeadlineMs`, `budget.transportRequestTimeoutMs` | `5000`, `10000` |
| `timeouts.identityReadTimeoutMs`, `readTimeoutMs`, `streamTimeoutMs` | `20000`, `65000`, `5000` |
| `maxCycles` | `1` per evaluation; two REST passes per cycle |
| `thresholds.maxEvidenceAgeMs`, `maxTotalReadDurationMs` | `150000`, `140000` |
| `campaign.durationMs`, `evaluationIntervalMs` | `900000` (15 minutes), `120000` after the preceding evaluation finishes |
| `campaign.maxEvaluations`, `maxConsecutiveFailedReadEvaluations` | `3`, `2` |

One REST pass has at most `2 sides × 2 order pages + 2 position pages = 6` requests.
One evaluation has at most `1 identity + 1 cycle × 2 passes × 6 = 13` requests.
The campaign ceiling is **`3 × 13 = 39` wire requests: 3 identity reads and 36 account reads**.
There is no automatic retry in this path, no retry campaign, and no unpaced fallback.
Any later retry or different bound needs a revised calculation and authorization.
The record bound per pass is 50 orders per side plus 50 positions; pagination can yield fewer records.

Admission plus transport is bounded by 15000 ms per request. The serial orders scan is at most
`4 × 15000 = 60000` ms, and the positions scan at most `2 × 15000 = 30000` ms; both fit 65000 ms.
The components run concurrently within each pass. A conservative evaluation timing bound is
`20000 + 2 × 5000 + 2 × 65000 = 160000` ms.
Three evaluations plus two inter-evaluation waits give `3 × 160000 + 2 × 120000 = 720000` ms,
within the proposed 900000 ms duration. These are collection timeout bounds, not guaranteed successful admission,
provider responsiveness or completion of already-active calls. Total two-pass read duration is bounded at
130000 ms, below the proposed 140000 ms evidence criterion. The 150000 ms evidence-age criterion is a local
engine bound and cannot prove provider data freshness.

## Proposed limiter policy and validation

`budget.kind = SHARED_COORDINATOR_READ_BUDGET`, `scope = API_AUTH`, `priorityClass = P1`.
`budget.connectionId` is unresolved. The JSON specifies every limiter field explicitly:

| Limiter fields | Proposed values |
| --- | --- |
| `windows` | 2 starts per 1000 ms; 20 starts per 60000 ms |
| `fairnessWindowMs` | 60000 |
| `classShares.P1` | min 0, max 13 per fairness window |
| `classShares.P0/P2/P3` | Each min 0, max 20; shared global windows still cap total starts |
| `concurrency`, `p0ReservedSlots` | 3, 1; at most two non-P0 active slots |
| `grantTtlMs`, `maxRequestDeadlineMs`, `overdueGuardMs` | 1000, 5000, 1000 |
| `uncertainChargeAlertMs` | 60000 |
| `retryAfter.noHeaderDefaultMs`, `providerStatedBlockMs`, `localBackoffBaseMs` | Each 60000 |
| `retryAfter.localBackoffMaxMs`, `operationalCapMs`, `clockUncertaintyMs` | 300000, 900000, 2000 |
| `budget.campaignShare.maxStartsPerFairnessWindow` | 13 |

The existing pure `validateRateLimiterConfig` accepts this policy; the proposal also checks timeout, deadline,
request-count and P1-ceiling consistency. The share is a declaration, not a per-campaign reservation implemented
by the coordinator. Other P1 activity can consume that ceiling. The actual shared coordinator must apply the same
policy, and the operator must document aggregate traffic and allocation before launch; exclusive account use is
not inferred. The campaign stops on refusal or throttle instead of changing policy or waiting through a fallback.
This validation establishes local consistency only. Loopback uses immediate fixture permits and a virtual clock;
it **does not test this policy's runtime pacing** or discharge production budget requirements.

## Identity, lineage and provenance procedure

1. The operator supplies `account.accountId` and an independently established expected account fingerprint,
   with the intended account/subaccount mapping, evidence date and trusted source recorded in the launch record.
   No old fingerprint is copied or described as freshly verified. Do not learn the expected fingerprint from the
   same unknown client's first response and thereby accept whatever account it reaches.
2. Use the existing `providerAccountFingerprint` function: lowercase SHA-256 of the exact nonempty `coindcx_id`
   UTF-8 bytes, without trimming or case folding. Handle the raw identifier only through the approved identity
   procedure; do not put it or credentials in reports or command-line arguments.
3. After separate authorization, the existing authenticated identity read runs at the start of **each** evaluation,
   before any orders or positions scan. Both the existing verifier and exact expected-hash comparison must pass.
   Mismatch, unavailable identity or timeout stops collection. This verifies the provider trading account at read
   time, without proving continuity, exclusive use or API-key generation; account read responses do not carry identity.
4. Supply `lineage` from an explicitly identified, dated, read-only durable export, with `ownedOrders`,
   `ambiguousCreates`, `closedIntentTags`, `ownedPositions`, and `botTagNamespace`. Empty arrays need a documented
   basis; fixture arrays do not qualify. Preparation reads no database. Unresolved ownership remains explicit.
5. Record the actual authenticated client's approved construction and credential source reference without exposing
   credential bytes. Its declared account binding and `budgetConnectionId` must match the configuration. Review
   actual construction to establish the M2 budget, P1 class, API_AUTH scope, 5000 ms admission deadline,
   10000 ms transport timeout and identical limiter policy. A caller's capability label alone is insufficient.
   The runner receives only its three narrowed read methods and the existing identity reduction/verifier functions.
6. Record coordinator installation/session identity, pipe and state-directory ownership, supervision, stop status and
   restart policy. It must be connected and not stopped before collection and every new read. Provide a real monotonic
   clock, operator abort signal and durable report sink. No mutation service, mutation budget or execution composition
   may be passed. No double acquisition: the existing transport owns one fresh read permit for each wire request.

## Operator control, stopping and reports

Before launch, identify an accountable supervising operator, permitted launch/stop operators and approved local-host
access controls. Restrict named-pipe clients, state/report directories and `STOP`/`RESET_STOP` to authorized principals;
test that unauthorized clients cannot control the coordinator. The current IPC prototype does not implement or attest
these ACLs. Approve durable initialization and supervision/restart behavior separately. Test-only installation markers
are not production installations. STOP is latched; this campaign must never reset STOP or recover UNKNOWN.

Operator cancellation, coordinator disconnection/STOP/UNKNOWN, budget refusal, provider throttle, identity mismatch
or unverified identity, an observed case classified FAIL, two consecutive failed-read evaluations, duration or evaluation
bounds stop further collection. SIGINT/SIGTERM are wired to the fixture CLI's abort signal; a real composition must
connect and verify the same operator signal. Active read primitives take no abort signal: an already-invoked call
awaiting admission may still start HTTP after stop. No subsequent client call/page is launched. Late results are discarded
as observations; active capacity is never refunded by the runner. Preserve supervision until active calls settle, and
report unsettled calls as UNKNOWN. Do not terminate the coordinator to manufacture free capacity or recover uncertainty.

The proposed report path is
`C:\TSA\coindcx-m2-w1\.local\m4-orders-positions-proposal-20261008\campaign-report.json`.
Verify the path, owner, restrictive Windows ACL, writable capacity and nonexistence before authorization.
The new local sink creates a new file exclusively, refuses overwriting and flushes file contents; its Node mode bits
do not establish Windows ACLs or crash durability of the parent directory. Operator verification is still required.
Delivery is `WRITTEN`, `FAILED` or `NOT_ATTEMPTED`; any failure is an unsuccessful collection delivery, never acceptance.
`COMPLETED` merely means collection reached schedule bounds. Preserve PASS / FAIL / NOT_OBSERVED / UNKNOWN separately.

Missing stream observation is deliberately `NOT_CONFIGURED` and remains UNKNOWN in every evaluation; all cycles revoke.
Do not interpret successful reads as convergence. Complete history, required transaction/accounting evidence, provider
tag/venue-generated-order contracts, page semantics, credential-generation and continuity evidence remain unsupported
or unknown. D4c, AS1 and formal M3/M4 acceptance are separate from permission to collect partial information.
All grants remain false; gates, certificates, `authorityEligible`, Invariant 28 and frozen migrations remain preserved.

## Exact invocation and preparation evidence

Run from `C:\TSA\coindcx-m2-w1` with the already installed local tools. Proposed intended collection invocation:

```powershell
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-launch.ts collect --spec .\docs\launch\m4-orders-positions-proposal.json
```

**This invocation currently exits 2, `REAL_LAUNCH_BLOCKED`, without provider access.**
The CLI has no provider bootstrap. A later reviewed implementation must supply actual dependencies to
`runPreparedCollection` and then the unchanged checkpointed runner. Do not replace this command with a provider probe,
test initializer, synthetic provenance or mutation-capable startup to bypass that blocker. It is an exact proposed entry
command, not a claim that real launch is implemented or ready. Revalidate the final bindings before any later launch.

Offline value validation uses the same specification and parser:

```powershell
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-launch.ts validate --spec .\docs\launch\m4-orders-positions-proposal.json
```

`parametersValid: true` means numeric/filter/local limiter consistency. The literal proposal has
`configurationValid: false`, `readyToContactProvider: false`: account ID/fingerprint, connection ID and lineage are
explicitly null. Even a fully supplied configuration would not satisfy real provenance, controls or authorization alone.

The explicit offline variant exercises the same `collect` parser and `runPreparedCollection`/runner path:

```powershell
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-launch.ts collect --spec .\docs\launch\m4-orders-positions-proposal.json --offline-loopback --fixture-report .\.local\m4-campaign-checkpoint-launch-20261008\loopback-report.json
```

That command is one-shot because the sink refuses overwrite. Its isolated composition binds only `127.0.0.1`, uses
synthetic credentials and explicitly substitutes fixture account/fingerprint, connection, lineage, report destination,
client/coordinator declarations and clock. Numeric proposal values and scope are unchanged. The fixture exercises
all 39 requests and reports zero convergence, UNKNOWN stream and all false grants. It initializes no production state,
binds no production budget and proves no real credential/coordinator provenance. Identity mismatch uses the same
command plus `--fixture-identity-mismatch` and a separate report path; it makes one identity request and zero scans.

## Remaining collection-start blockers

| Classification | Concrete unresolved requirement |
| --- | --- |
| Required input | Intended account ID and independently established expected fingerprint, source/date/mapping |
| Required input | Dated durable lineage export and documented namespace/ownership basis |
| Required input | Actual client construction, approved credential source reference and matching shared coordinator connection/policy/scope/timing provenance |
| Missing implementation | Reviewed real read-only CLI bootstrap/composition, including signal, clock and existing dependencies |
| Missing implementation | Approved production limiter state initialization/lifecycle; accepted marker and initializer are currently `DISPOSABLE_TEST_DIRECTORY` only |
| Missing implementation | Supervision and IPC/state access controls, with restricted operator STOP/RESET_STOP authority and unauthorized-access checks |
| Required input | Approved report destination, verified owner/ACL/access/nonexistence and delivery-failure procedure |
| Authorization | Approval of this campaign's values and separate permission to collect the named account's bounded orders/positions information |

No preparation fixture discharges these blockers. A later authorization would permit only the three identity reads
and up to 36 INR orders/positions reads within the proposed bounds after blockers are resolved. It would not authorize
transactions, full-account synchronization, account-scope attestation, D4c/AS1 decisions, formal M3/M4 acceptance,
mutations, order submission/cancellation, hooks, recovery, migrations or live enablement.
