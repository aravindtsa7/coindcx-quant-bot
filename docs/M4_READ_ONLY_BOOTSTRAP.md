# Isolated read-only campaign bootstrap — 2026-10-09

Checkpointed bootstrap; subsequent provider invocation remains an uncommitted review candidate.
See [the explicit provider invocation specification](M4_PROVIDER_READ_ONLY_INVOCATION.md) for the extension and
remaining security/input/authorization prerequisites. The loopback-only statements below describe the checkpoint.
Preparation checkpoint:
`942222adbed855457b95b1730304022cf1e3ab44`, following campaign checkpoint
`a9eecc36e950d0b25eb3cfddbd4565e51906f5cd`.
Every [campaign proposal](launch/m4-orders-positions-proposal.json) value remains PROPOSED_NOT_APPROVED.
No real account mapping, credentials, state installation, provider contact or collection has been supplied or performed.

## Request construction and pacing evidence

`sync-read-adapter.ts` iterates the **buy and sell segments**, then bounded pages. Its order-page call passes
`status: statuses.join(',')`. The committed client validates and passes that single string into one read endpoint
request; the transport creates one HTTP request under one fresh M2 permit. There is no loop over statuses,
additional account endpoint, pagination preflight read or automatic retry in this composition.

The unchanged bound is `3 evaluations × [1 identity + 1 cycle × 2 passes × (2 sides × 2 order pages + 2 position pages)]`
= **39 requests: 3 identity + 24 orders + 12 positions**. Both order sides use the seven-status combined filter,
page size 25. Client-schema acceptance and observed loopback request bodies do not confirm provider acceptance of
the combined filter. Any later provider-driven split, extra endpoint, retry or changed scan bound needs a revised
calculation, proposal and authorization. Required transactions are never removed from a broader synchronization scope.

Real M2 tests keep the proposed limiter policy unchanged: 2 starts/1000 ms, 20/60000 ms, P1 ceiling 13/60000 ms,
concurrency 3 and one P0-reserved slot. They record `http.request` creation timestamps inside the permit start boundary,
not server-arrival timestamps. One complete 13-request evaluation exercises both REST passes and all side/page
combinations; the original three-evaluation numeric proposal is stopped before the second evaluation. Its fourteenth
P1 admission refuses after the proposed 5000 ms deadline and creates no HTTP request.

A separate loopback lab load holds two P1 requests, observes a P0 request in the reserved third slot, refuses another
P1 admission, fills the 20-request minute window with P0 reads, refuses the next request without HTTP, then observes
admission after the actual minute expires. It is limiter stress evidence, not an expansion of campaign scope.
Other cases route a fixture 429 through M2 and disconnect the coordinator during admission. Neither starts an
unpaced fallback. Exact times/counts and exits are under `.local/m4-bootstrap-evidence-20261009/`.
The always-granting preparation fixture remains explicitly unsuitable as limiter-pacing evidence.
These results establish offline behavior only and approve no numeric values or provider limits.

## Explicit invocation and initialization

`scripts/sync-read-launch/campaign-host.ts` exports explicit `initializeCampaignHost` and `startCampaignHost` operations.
It starts nothing on import. The separate CLI has a `require.main === module` entry guard and no production importer.
The old real `collect --spec` entry remains hard-blocked. This new implementation is deliberately **LOOPBACK_ONLY**:
it refuses any origin other than an explicit HTTP `127.0.0.1` port before creating a request.

The CLI accepts only a task-owned `.local` JSON input labelled SYNTHETIC_LOOPBACK_BOOTSTRAP_INPUT, with an
OFFLINE account label and synthetic OFFLINE provider key/secret. Tests generate that input; it is not a real launch
configuration. The fixture account/fingerprint/lineage are never copied into the real proposal. Example exact syntax:

```powershell
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-bootstrap.ts initialize --offline-input <absolute-task-owned-input.json> --confirm NEW_READ_ONLY_CAMPAIGN
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-bootstrap.ts run --offline-input <same-input.json>
```

The run command requires a supervisor stdin pipe. Its owner supplies HEARTBEAT lines within the explicitly configured
lease, or STOP. EOF, invalid input and SIGINT/SIGTERM request STOP; there is no reset/recovery command. Input/progress
outputs never contain capability keys, provider credentials or raw account identifiers. The supervisor pipe closes at
shutdown, rather than keeping a finished host process alive.

Host input fields are explicit: `valuesStatus`, `networkAccess`, `campaignId`, `installationId`, full validated
`coordinator` and `client` configuration, `supervision.{heartbeatIntervalMs,leaseMs,shutdownWaitMs,pollMs}`,
`expectedWindowsOwner`, `ownershipCheckTimeoutMs` and `reportDirectory`. Owner queries are bounded by the explicit
timeout and batch paths within each operation without caching prior ownership. The directory basename must equal `readonly-campaign-<campaign-id>`;
the pipe must equal `\\.\pipe\coindcx-readonly-campaign-<installationId>`; client/host pipe identities must match;
probe scopes must be empty and the report directory must be the namespace's `reports` directory.
Supervision/runtime numbers in tests are synthetic fixtures, not approved real-use defaults.

Initialization validates configuration, distinct capability keys and the parent owner before any state write.
The campaign directory must **not exist**, including an existing empty directory. An exclusive mkdir claims it;
the committed two-slot state store flushes initial slots and writes a NEW_READ_ONLY_CAMPAIGN marker. The host writes
installation/configuration/key-digest and report-owner manifests. Any interrupted/failed initialization leaves its
partial directory intact and unstartable. Initialization never replaces or repairs it, and startup never initializes.

Startup validates manifest identity, configuration/key digests, namespace, OS owner and both checksummed state slots.
Unlike generic M2 single-slot torn-write recovery, this campaign refuses either missing/corrupt slot. Incompatible
versions/configuration also refuse. An exclusive OWNER.lock establishes single host ownership, followed by M2's pipe
bind. A second instance cannot write coordinator state. A stale lock is not automatically removed; resolving it needs
separate operator review, never this CLI. The owner removes only its own token-matched lock on orderly close.

M2 restoration receives no elapsed-time or termination evidence: old charges/slots remain conservative and throttles
re-wait their full duration. Restored STOP or UNKNOWN blocks this host. There is no automatic UNKNOWN recovery,
RESET_STOP, reconstruction from an empty inventory or creation of a new namespace as a capacity-reset fallback.
An approved aggregate account budget arrangement must prevent using another namespace to bypass unresolved charges.

## Authenticated control and read capability

`campaign-access.ts` supplies distinct 256-bit read and STOP keys. IPC transmits neither these secrets nor provider
credentials. The coordinator sends a fresh random challenge. The client HMAC binds the installation, challenge, role,
HELLO/RESUME and resume identity. The coordinator's HMAC binds the challenge, role, epoch, session, instance and initial
state. Invalid keys, wrong installation, forged role and replayed/tampered coordinator welcome fail authentication.
This proves possession of a campaign key, not an OS process identity or an execution authority.
An authenticated READ key holder is still trusted to follow the committed client's start/completion reporting
discipline. Authentication does not prove that a hostile key holder performed a claimed request or completion.
Key custody and exclusion of untrusted key holders remain host-security prerequisites.

The opt-in M2 access policy is always supplied by this host. READ sessions can request only P1/API_AUTH/READ;
CREATE, CANCEL, PROBE, P0 and PUBLIC requests refuse. READ sessions cannot STOP or RESET. OPERATOR_STOP sessions
cannot acquire read/mutation permits and can request STOP only; RESET always refuses. A role is bound to the
authenticated session and cannot be elevated by a request field. Legacy trusted-host M2 behavior is unchanged when
no campaign policy is supplied; the host never uses that mode. P0 lab stress uses that legacy mode separately to
exercise the existing scheduler's reservation, without claiming it has campaign authentication.

The host captures the actual authenticated installation/epoch/client/session IDs and derives its connection ID
from those bindings. It checks the proposal's connection, limiter, class, scope and admission deadline against actual
construction. It creates the existing client with that real coordinator budget and explicit transport timeout, then
passes only identity/orders/positions methods to the unchanged campaign runner. There is no production binding,
execution service, mutation budget, hook or second budget acquisition. Identity still verifies before each evaluation's
account scans. Missing stream observation remains UNKNOWN; every grant remains false.

## Supervision, report access and shutdown

The supervising caller alone receives the host lifecycle capability. It must supply heartbeats; expired leases cannot
be renewed after expiry. Lease loss latches STOP and aborts collection. STOP acknowledgements have an explicit bound
and are called durable only after M2 acknowledges its committed STOP. Disconnect/UNKNOWN also close the read gate.
Admission/start boundaries check the lease directly, so a delayed timer cannot authorize a later request.
Unused acquired permits are voided only with positive non-use evidence; active requests are never refunded.

Owner checks query Windows Get-Acl with a literal path and compare its actual owner to the explicitly expected owner.
Ancestors and directories may not be symlinks/junctions. The installation report-owner manifest must match.
Before any read, the report destination must be a new direct child of the owned report directory, and an exclusive
write/flush probe validates access. The sink refuses overwrite and flushes output. These checks validate reported
ownership and current write access; they do **not** establish restrictive ACLs or prevent host-side path races.

Shutdown aborts observations, requests durable STOP and waits only the explicit shutdown bound for active charges and
pending acknowledgements. It reports unsettled grants, whether STOP was acknowledged, pending reports/control and
delivery of `reports/shutdown.json`. Then it closes connections/coordinator without releasing outstanding capacity.
Late results never alter a delivered campaign snapshot. A lease check cannot abort the existing signal-less primitive
after HTTP creation; capacity stays held until positive completion/teardown evidence reaches M2. Unacknowledged
completion or abrupt host termination remains conservatively uncertain on restart.

## Remaining real-launch blockers

- **Inputs:** independently established account/fingerprint mapping with source/date; dated durable lineage; actual
  credential source/client provenance; installation/connection and aggregate account-budget allocation; expected OS
  owner and authorized report destination; supervisor identity, key custody and heartbeat/STOP operating procedure.
- **Implementation/review:** current CLI/bootstrap permits loopback only. A reviewed provider invocation is still absent.
  No restrictive Windows named-pipe/state/report ACL enforcement, remote-client exclusion or OS process identity proof
  is implemented. Same-host privileged principals, secret confidentiality, absence of active pipe relays/path races and
  integrity of the supervising Node process remain assumptions. Storage/power-loss behavior and independent supervision
  deployment require review; heartbeat possession alone does not prove an independent supervisor process.
- **Authorization:** review this uncommitted bootstrap and approve this campaign's values, namespace and operator
  arrangement, followed by separate permission for real read-only collection. No production binding/startup is authorized.

Unknown stream, unsupported required transactions/accounting, pagination/history/provider contracts, D4c, AS1 and
formal M3/M4 acceptance remain separate convergence/acceptance limitations. The bootstrap creates no certificate,
authorityEligible change, live readiness, mutation permission or synchronization acceptance. Invariant 28, gates,
frozen migrations and the original dirty worktree remain preserved.
