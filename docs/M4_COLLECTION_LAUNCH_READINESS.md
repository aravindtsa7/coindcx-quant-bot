# Bounded orders/positions collection preparation

Updated 2026-10-10 from identity checkpoint 6cbe926ca0726b2ea51b74e1992c36bb366b099d.
The operator authorized ONE collection only: at most 900,000 ms, three evaluations,
one two-pass cycle each and 39 physical attempts (3 USER_INFO, 24 orders, 12 positions).
Previous collection attempts made zero physical requests. Values apply to this
collection only, never production defaults. Schema PROPOSED_NOT_APPROVED markers
remain; separate recorded authorization gates execution. All authority grants remain false.

The corrected input is [launch/m4-collection-input.pending.json](launch/m4-collection-input.pending.json).
Both limiter copies record the support-stated block as **10,000 ms**. Separate
no-header and local-backoff waits remain **60,000 ms**. Retry-After may lengthen
the wait or fail closed. Effective waits are never shortened. The corrected
shared-use launch parameter digest is c5274306c77b6336bc102a491e0de6c3bad74903211f57f2f4aa31616d808da5;
the explicit launch-validator pin changes with this correction.

Account reference: completed protected identity report SUCCESS/MATCH at
**2026-10-09T09:06:07.287Z**, fingerprint
25ccf725943efd0c94d04b09eeff0d8aa9d542a28d749a1e4229277dffe706b4.
Association with coindcx-primary-manual-shared uses the operator's existing statement
that this key was created for their only personal CoinDCX account, plus the separate
2026-10-10 authorization to read that account. This reference was independently
reviewed before this campaign under the replacement-reference criterion in
M4_OPERATOR_LOCAL_PREPARATION.md; no historical-report attestation is invented.
Historical reference remains separately recorded: **2026-09-24T13:11:41.439Z**,
source C:/TSA/coindcx-quant-bot-clean/.local/provider-probe/2026-09-24T13-12-33-026Z/report.md.
The earlier credential statement is date-only **2026-10-09**, exact time unknown.
The supported timestamp field now uses the actual recording time of today's
separate confirmation, with explicit provenance. No midnight time is inferred.
Protected offline/continuation-20261010/operator-confirmation.json retains the
separate statements, historical/fresh references and mapping review rationale.

The operator reports no other CoinDCX API script is running. This is an operator
statement, not proof of a complete process/IP inventory. Manual/shared activity
is permitted; external consumers and public-IP traffic remain UNKNOWN_NOT_CONTROLLED.
One planned P1/API_AUTH reader uses the new isolated managed coordinator: 13
starts/60,000 ms, aggregate 2/1,000 ms and 20/60,000 ms, concurrency three with one
P0-reserved slot. No mutation consumer is authorized.

Reuse protected runtime C:/Users/kani1/CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07,
identity-supervisor.cjs, the existing bootstrap/operator modules, protected-module
guard and existing CurrentUser DPAPI READ/STOP ciphertext. No dependency install
or alternative launcher. The supervisor uses absolute executables, a minimal child
environment, piped HEARTBEAT/STOP, heartbeat 1,000 ms, lease 15,000 ms, shutdown
wait 15,000 ms and outer deadline 1,055,000 ms followed by bounded child-only shutdown.

Custody trusts CurrentUser, SYSTEM and Administrators, plus TrustedInstaller for
installed OS paths only. It checks integrity, owners, DACLs, ancestor replacement
rights and reparse points. Pipe ACL enforcement, remote exclusion and OS peer/process
identity proof are absent and not claimed. Credential-source custody is separate;
a protected snapshot does not secure that external source. Any authorized file-only
permission repair must save the original descriptor and protected content hash,
retain identical contents and report all unresolved ancestor blockers. The later
directory grant covers only C:/TSA and C:/TSA/coindcx-quant-bot-clean, requires
object-only changes and preserves owners, trusted access and child permissions.

Only USER_INFO and INR futures orders/positions reads are authorized. Orders use
buy/sell and one combined status string per page:
open,filled,partially_filled,partially_cancelled,cancelled,rejected,untriggered.
Page size 25, maximum two pages per segment. Each evaluation verifies identity
before scans. Combined-filter acceptance remains unconfirmed. First read error,
429, mismatch, budget refusal, supervision loss, report failure or configured bound
stops new reads. No retries, alternate filters, probes, extra scans or second campaign.

Deliberately initialize NEW campaign/readonly-campaign-collection-6ee22446e815b391
only after enforced prerequisites pass; never reuse/reset durably stopped diagnostic
state. Reports: reports/campaign-report.json and reports/shutdown.json. No overwrite,
consumed-permit refunds, UNKNOWN recovery or hook registration. Preserve unresolved
charges and durable state. Review protected snapshot bytes, recompute digests,
re-seal inventory and repeat custody before initialization/collection. Authorization
records use actual recording time and operator instructions, never issuer signatures.

Targeted offline checks cover corrected fields, retained waits/Retry-After,
account/provenance validation, authorization before environment lookup, protected
paths, supervisor arguments/deadlines, no-network prepare and budget refusal.
Reuse unchanged passing identity/control/M2 pacing evidence.
Stream remains UNKNOWN; transactions remain CLIENT_ADAPTER_UNSUPPORTED;
lineage remains UNAVAILABLE. No bot ownership, exclusivity, current manual-trade
count, full-account consistency, D4c/AS1 approval or formal M3/M4 acceptance.
Preserve original-worktree state, 50 dirty-file fingerprints, 14 frozen migrations
and all existing evidence. Actual launch outcome belongs in protected continuation evidence.

Continuation result: all prior metadata corrections remain. The two affected
shared-use test fixtures now include the corrected collection limiter pin.
Targeted tests (21 assertions), typecheck, affected TypeScript/CommonJS lint and
the complete protected preparation check have recorded exit-0 runs. The latter
includes actual supervised prepare and twelve offline checks, with no credential
loading or physical HTTP. Earlier failed evidence remains separately retained.

The Windows child-creation EPERM remains intermittent and unexplained. The exact
absolute executable, arguments, cwd, minimal environment and failing spawn are
recorded in protected offline/resume-20261010/spawn-reproduction.json. Both an
asynchronous custody-preflight candidate and an overlapped-pipe diagnostic also
failed; neither is retained as a supervisor fix. Passing unchanged prepares do
not establish an EPERM cause or reliable resolution. Module guard, executable
custody and child environment checks remain enforced.

The authorized directory repair initially passed custody. A later trusted-access
adjustment propagated an inherited-ACE reorder to 96 captured child objects,
violating the requested isolation. The repair was stopped and rolled back. Both
directory descriptors and all 102 captured direct-child entries match their
original descriptors again. The inspected ACE multisets had no grant changes.
Exact deeper-descendant descriptor restoration cannot be claimed: those original
descriptors were not inventoried. No recursive ACL rewrite, ownership takeover,
elevation or execution-policy change was used. Credential contents match the
original protected hash, and the credential owner and repaired DACL are unchanged.

The earlier launch was blocked by EPERM resolution and the restored original untrusted
DELETE grants: Authenticated Users (S-1-5-11) on both directories, and unidentified
SID S-1-5-21-4291329697-1770914851-2694322049-1912063170 on the credential directory.
That SID is different from the resolved CurrentUser SID and untrusted under the
unchanged policy. No credential loader, collection request, authorization envelope,
initialization or checkpoint commit occurred. The six existing preparation changes
and two affected test changes remain uncommitted. Protected offline/resume-20261010
retains diagnostics, failed checks, rollback descriptors and final preservation
evidence; earlier continuation evidence remains intact.

The 2026-10-10 instruction was **offline preparation only**. Further ACL repair on
C:/TSA and existing worktrees is stopped. All rollback evidence and the uncertainty
about exact deeper-descendant ACL restoration remain; complete restoration is not claimed.
During that preparation HEAD remained unchanged and all changes were left uncommitted for review.

An explicit alternative credential source is now available in the protected runtime.
Its fixed destination is `operator-credentials/coindcx-api.dpapi`, containing only
the API key and secret encrypted with Windows CurrentUser DPAPI. It is not provisioned
by that offline task. The operator subsequently reported provisioning success on 2026-10-11. The concealed-input provisioning command is retained for provenance only; do not repeat it:

```powershell
& ([scriptblock]::Create([IO.File]::ReadAllText('C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\scripts\sync-read-launch\provision-credentials.ps1'))) -RuntimeRoot 'C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07'
```

The script checks the complete snapshot, installed executables and destination
custody with the unchanged validator before either concealed prompt. It rejects
redirected input and existing stores, rechecks custody after input and uses
CreateNew and durable flush for ciphertext only. It never reads the original .env,
accepts secrets as arguments, changes ACLs or creates plaintext temporary files.
SecureString BSTRs and plaintext byte buffers are cleared; managed strings remain
subject to the Windows/.NET process-memory trust assumption. Neither DPAPI nor
the source choice establishes pipe ACLs, remote exclusion or OS peer identity.

Future authorized operator/supervisor invocations must explicitly select
`--credential-source protected-dpapi` or `--credential-source authorized-env-file`.
There is no fallback. The existing .env loader remains available only through the
explicit original-source selection and complete custody gate. Selected-source
loading is deferred until independent campaign authorization passes. Existing
protected READ/STOP keys remain separate and unchanged.

The supervisor now reports `SUPERVISOR_CHILD_STARTUP_FAILED` with nonzero exit
for synchronous/asynchronous failed spawn, waits for spawn acknowledgement before
heartbeat, and cleans up timers/listeners. A task child ignoring STOP receives
bounded child-only termination; an unconfirmed exit is reported as unresolved.
There is no automatic retry. This fixes failure handling, **not the unexplained
Windows EPERM cause**. A passing synthetic or preparation run cannot establish
that cause or reliable resolution. At that offline checkpoint, operator credential provisioning and review were pending; it did not initialize or collect.

New protected evidence is under `offline/protected-credentials-20261010`.
It records synthetic-only provisioning, user-mismatch/decryption refusal,
source selection/deferred loading, no-overwrite and supervised startup/shutdown
checks, plus focused reproduction and preservation. The existing collection
authorization remains recorded without a new authorization envelope or campaign.
Actual physical requests and real credential inputs for this task are zero.

2026-10-11 continuation: the operator reports successful concealed provisioning
and explicitly selects protected-dpapi for the already-authorized one collection.
This report is an operator statement; the provisioning time is unknown. The
original .env must not be read or used as fallback. The private runtime invocation
adds a typed sourceBinding for the fixed protected store and its ciphertext digest;
the independent authorization digest covers that completed invocation. Both the
supervisor inventory binding and the deferred loader enforce the selected source.
The pending repository input carries provenance only, without the private store digest.

The existing protected preload now records a safe endpoint/count/time event at
each native HTTPS request-creation attempt and independently refuses beyond
3 identity, 24 orders, 12 positions and 39 total. It rejects other endpoints,
origins, methods, HTTP/fetch fallbacks and all prepare/initialize HTTP. Existing
identity, INR filters, pagination, first-error, admission and supervision gates
remain in the reviewed client/host. Factory throws count as attempts; no headers,
bodies, signatures or credential values enter audit events. No retry was added.
EPERM remains unresolved; one failed startup ends this launch attempt without relaunch.
Further workspace ACL repairs remain prohibited, with deeper-descendant rollback
uncertainty retained. The existing 39-request authorization is unchanged in scope;
a new private record binds actual review results and recording time, without
an issuer-signature or new operator attestation claim.
