# One further local interactive collection attempt

Prepared 13 October 2026, Asia/Calcutta. **Do not launch yet: the recorded authorization has expired.**
This handoff was prepared without collection, provider requests, real credential decryption/loading,
or campaign initialization. Native Windows spawn EPERM remains intermittent and unexplained.
The five passing offline comparisons do not establish a fix or reliable startup.

HEAD: `6619c66bd9dcf16049e8fdb2e96145a2b2324575`.
Branch: `feature/m2-w1-limiter-scheduler`. Worktree was clean at entry; this handoff is uncommitted.

## Enforced prerequisite

The existing `operator/collection-authorization.pending.json` expires at
`2026-10-10T19:42:53.595Z` (**11 October 2026, 01:12:53.595 IST**).
Its schema and exact bindings match, and it was valid at its recorded time; it is invalid now.
The actual wrapper's read-only validation returns
`RECORDED_PROVIDER_AUTHORIZATION_MISMATCH_OR_EXPIRED` before invoking the supervisor or loading credentials.
No authorization record, expiry, operator statement, signature or attestation was changed or invented.

A separately recorded, reviewed current authorization with actual recording time and explicit expiry
is required before launch, followed by resealing its inventory entry and repeating the existing full
custody/binding checks. It must retain the same account, scope and digests below. Do not merely edit
the old expiry or bypass validation. The review file created here is explicitly **not** authorization.
The earlier statement that no other API script was running remains historical; it is not a fresh
process/IP inventory. No new attestation about external/manual/shared traffic is made.

| Binding | SHA-256 |
|---|---|
| Canonical invocation | `634e9dbf6fb0effc4d6c953e23ee0e32638ab923a81f9fe5f2d37011b0c37ffe` |
| Reviewed proposal parameters | `c5274306c77b6336bc102a491e0de6c3bad74903211f57f2f4aa31616d808da5` |
| Existing expired authorization bytes | `6afab52a3aebb3cf6c2c2e4cd2c76ebaf50d1d50e2fe947a590f9f79d465bce7` |

## Exact operator command

After the prerequisite is satisfied, paste this once into a normal interactive Windows PowerShell
console running as the existing operator, without elevation, redirection, a job or a pipeline:

```powershell
& ([scriptblock]::Create([IO.File]::ReadAllText('C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\scripts\sync-read-launch\invoke-collection-once.ps1')))
```

The script preserves/restores the console's process environment and working directory, and starts
the absolute installed Node in the protected runtime with a minimal environment, the protected
module guard and the installed tsx loader. No execution-policy change or dependency install occurs.
The wrapper calls the existing `identity-supervisor.cjs` exported `supervise` exactly once, with:

```text
action: run-provider
input: C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\operator\campaign-input.pending.json
authorization: C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\operator\collection-authorization.pending.json
IPC key file: C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\operator\ipc-keys.dpapi
credential-source: protected-dpapi
```

The fixed credential store is `operator-credentials/coindcx-api.dpapi` under that runtime.
Its ciphertext digest is bound by the private input and inventory; no fallback, provisioning,
ciphertext overwrite or original `.env` access is permitted. Credential loading remains deferred
until the existing independent authorization gate passes.

Before starting Node, PowerShell exclusively creates and durably flushes
`C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\operator\collection-attempt-2.console-claim.json`.
This also consumes the handoff if the parent Node process cannot start. Inside Node,
admission independently exclusively creates and flushes
`C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\operator\collection-attempt-2.claim.json`.
It is retained on success, expiry refusal, failed preflight, EPERM, cancellation or report failure.
Every interactive invocation consumes this one admission, including one made prematurely while
authorization is expired. A partial/empty claim also blocks reuse. There is no deletion, refund,
automatic retry, relaunch or alternate bootstrap. Preparation has **not** created either claim.

The wrapper checks the existing namespace's five recorded file hashes, both valid fresh state slots,
zero clients/journal sequence, null scheduler, absent owner lock and absent collection/shutdown reports.
The unchanged supervisor performs complete custody preflight before its collection child spawn,
uses absolute executable paths, the minimal child environment and three piped streams.
HEARTBEAT is 1,000 ms, lease 15,000 ms and shutdown wait 15,000 ms.
Its outer collection deadline is 1,055,000 ms; custody preflight is separately bounded at 120,000 ms.
The provider campaign retains its 900,000 ms collection bound.

## Messages, exit codes and stopping

Initial output is `COLLECTION_CONSOLE_ADMITTED`, then `COLLECTION_ATTEMPT_ADMITTED`. After successful validation, expect
`COLLECTION_SUPERVISOR_ONCE`, then a final JSON result and normally `COLLECTION_OPERATOR_EXIT=<code>`.
The existing supervisor buffers its allowed safe child events into `supervisor-result.json`;
absence of continuous console events is expected. No raw child stderr is forwarded; its byte count is retained.

| Exit | Meaning |
|---|---|
| 0 | Supervisor returned 0 and task-child exit was confirmed. Review reports for actual collection status/coverage; this is no acceptance or trading grant. |
| 1 | Child startup/run/cleanup failed, exit unresolved or evidence write failed. EPERM appears as `SUPERVISOR_CHILD_STARTUP_FAILED`, `spawnErrorCode: EPERM`. |
| 3 | Interactive/admission/prerequisite/preflight refusal. Current expiry produces `RECORDED_PROVIDER_AUTHORIZATION_MISMATCH_OR_EXPIRED`. |
| 4 | `COLLECTION_CONSOLE_ADMISSION_REFUSED` or `COLLECTION_ATTEMPT_ALREADY_CONSUMED`; supervisor is not called and existing evidence is retained. |
| 130 | Operator stop with confirmed task-child exit, or cancellation before supervision. Exact underlying supervisor code/signal remain in evidence. |

Press **Ctrl+C once** and leave the console open. The wrapper records `COLLECTION_STOP_REQUESTED`;
the existing supervisor stops HEARTBEAT and sends piped STOP. It waits up to 15 seconds, then
terminates only its collection child if needed, and waits another 15 seconds for confirmation.
Unconfirmed child exit is reported as failure, never success. During synchronous custody preflight,
signal handling may be delayed until that bounded preflight returns. A cancellation observed before
child acknowledgement prevents HEARTBEAT and initiates STOP through the existing lifecycle.
Do not close the console, delete the claim, or rerun the command after any outcome.

PowerShell itself may interrupt before capturing the native exit on Ctrl+C. The durable
`collection-exit.json` and exact `supervisor-result.json` are authoritative; do not infer success
from the shell prompt or an old `$LASTEXITCODE`. A native executable launch failure before Node
starts produces no Node report, but the PowerShell console claim remains consumed.

## Return these non-secret results

Return these two files if produced, plus the final console message if a file is absent:

```text
C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\offline\interactive-collection-attempt-2\collection-exit.json
C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\offline\interactive-collection-attempt-2\supervisor-result.json
```

Also return the existing child reports if produced:

```text
C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\campaign\readonly-campaign-collection-6ee22446e815b391\reports\campaign-report.json
C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\campaign\readonly-campaign-collection-6ee22446e815b391\reports\shutdown.json
```

No ciphertext, decrypted credential, `.env`, memory dump or raw environment is requested.
Missing child reports after startup failure do not authorize a second invocation.

## Verified preparation and retained limits

Evidence: `C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\offline\interactive-handoff-20261013`.
Final inventory: 1,870 entries, including the two uncommitted wrapper files and private non-authorizing review.
354 Git-blob and 1,507 dependency provenance bindings verified; new wrappers match the worktree bytes.
The selected ciphertext, IPC ciphertext, private input/expired authorization and all namespace files
retain their bytes, owners and DACLs. Both state slots remain journalSeq 0, scheduler null, zero clients;
no owner lock, collection report, shutdown report or unresolved charge exists. No namespace reset,
repair, reinitialization or IPC-key decryption was performed.

Ten affected offline admission/lifecycle tests, typecheck, affected lint, PowerShell parse checks
and extracted-function synthetic console-admission checks pass. The latter invoke only the
admission function on disposable evidence fixtures, never the operator script or launch command.
Tests use synthetic credentials, denied network transports and disposable fixture files.
The unchanged five-comparison, 35-test and 12-check evidence is reused; 644 prior sealed files verified.
The original worktree state, 50 dirty fingerprints and 14 frozen migrations remain preserved.
Earlier deeper-descendant ACL-restoration uncertainty remains; complete restoration is not claimed.

Scope remains one personal/manual/shared account, no subaccount; 39 physical attempts total
(3 USER_INFO, 24 orders, 12 positions), three evaluations, one two-pass cycle each, 15 minutes,
page size 25 and two pages per segment. Identity must match before scans in every evaluation.
Both order sides use the existing single combined status filter. Existing limiter/timeouts,
first-error stops and request audit ceilings remain unchanged. No retries, probes, alternate filters,
additional endpoints, database access, trading, hooks or live execution authority.

Stream UNKNOWN; transactions CLIENT_ADAPTER_UNSUPPORTED; lineage UNAVAILABLE;
external/manual/shared/IP traffic UNKNOWN_NOT_CONTROLLED. All authority grants false.
No full-account consistency or formal M3/M4 acceptance is claimed.
