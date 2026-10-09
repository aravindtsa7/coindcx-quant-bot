# Local preparation for the manual/shared account

Provider-invocation checkpoint: `0d2751c20b4840dec2709868d509b0db00e91675` (24 reviewed files matched sealed evidence).
This preparation is uncommitted. All campaign and host numeric values remain **PROPOSED_NOT_APPROVED**.
No real campaign initialization, provider request, production budget binding or collection authorization is performed.

The operator stated on 2026-10-09: one account, no subaccount, this key created for that account, manual trading,
and four reported open manual trades. The account is not bot-exclusive. The count is an operator statement,
not current venue evidence. Account identity does not establish ownership of any manual trade. Durable bot-order
lineage is explicitly UNAVAILABLE. D4c and AS1 remain pending; every authority grant remains false.

The local pending input is
`C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\campaign-input.pending.json`.
The factual sidecar is `operator-facts.json` in the same directory. Neither contains credentials.
The local account label `coindcx-primary-manual-shared` is proposed for this campaign; it is not a venue identifier.
`proposal.configuration.accountScope` is `{assumption: SHARED_USE_POSSIBLE, attestation: NONE}`.
The numeric/filter proposal is unchanged. Its separately pinned shared-use variant has parameter digest
`e1e3b79858ab32fc512fa4a322f668d829f3ed806eb4b132ede19a5cec225244`.
The entire invocation, including its account-scope assumption, must still be bound by any later authorization.

The expected fingerprint is taken from the existing historical report:
`C:\TSA\coindcx-quant-bot-clean\.local\provider-probe\2026-09-24T13-12-33-026Z\report.md`,
whose run started **2026-09-24T13:11:41.439Z**. The earlier 11:18:23.388Z run reports the same fingerprint.
This is an independent historical reference, not a fresh identity check or proof about today's key.
`accountMapping.verifiedAt` retains the historical run date. It is never replaced with today's preparation date.
`accountMapping.independentlyEstablished` is deliberately null: the operator must review the reference and confirm
its association with this account before explicitly setting that field to true. If it cannot be associated,
replace the mapping's fingerprint, sourceReference and verifiedAt using an independently established account
reference; do not learn the expected value from the campaign's first unknown response. Do not provide API secrets.
The existing identity read must later match this mapping before each evaluation's account scans.

## Credential custody and commands

The dedicated `operator-local-secrets.ts` loader streams the explicitly authorized
`C:\TSA\coindcx-quant-bot-clean\.env`, selects only literal single-line `COINDCX_API_KEY` and
`COINDCX_API_SECRET` assignments and maps them in memory to `COINDCX_CAMPAIGN_API_KEY` and
`COINDCX_CAMPAIGN_API_SECRET`. It performs no expansion, dotenv loading, operational-setting lookup,
ambient credential fallback or original-file modification. Missing, duplicate or unsupported literal syntax refuses.
Credentials are not persisted, printed, placed in argv/JSON/logs or sent through IPC. Imports and tests do not
invoke this loader. The source file is streamed for a before/after digest comparison without copying it.

`prepare-local --ipc-key-file <absolute-new-file>` explicitly loads those two values and generates independent
256-bit READ and STOP keys with Node's cryptographic RNG. Only their Windows **CurrentUser DPAPI ciphertext**
is stored in the untracked `ipc-keys.dpapi` file. Existing files are never overwritten. Provider credentials are
not stored in that file or reused as IPC keys. The wrapper passes a lazy environment callback to the existing
entry; future initialization/run validates separate authorization before calling that callback. It does not mutate
the ambient process environment. Decrypted keys and provider values stay in process memory; managed-runtime
strings cannot be guaranteed erased. DPAPI does not establish pipe ACLs, remote exclusion or OS process identity.

After input completion, access/supervision/budget review and separate recorded authorization, the exact future argv
from `C:\TSA\coindcx-m2-w1` is:

```powershell
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-bootstrap.ts prepare --input C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\campaign-input.pending.json
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-operator.ts initialize-campaign --ipc-key-file C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\ipc-keys.dpapi --input C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\campaign-input.pending.json --authorization C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\collection-authorization.json --confirm NEW_READ_ONLY_CAMPAIGN
node --import .\node_modules\tsx\dist\loader.mjs .\scripts\coindcx-sync-read-operator.ts run-provider --ipc-key-file C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\ipc-keys.dpapi --input C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\campaign-input.pending.json --authorization C:\TSA\coindcx-m2-w1\.local\m4-operator-preparation-20261009\collection-authorization.json
```

The initialization and run commands have **not** been executed. The run command requires an independently reviewed
supervisor to launch it with piped stdin and send HEARTBEAT within the proposed 15-second lease; STOP, EOF or lease
loss stops new reads. This document does not supply or approve a supervisor. No authorization JSON is supplied.
The pending input intentionally fails validation until the historical account association is explicitly confirmed.

## Remaining actions before a real launch

1. Confirm the historical reference's association with the only account/key and the proposed local label; complete
   `accountMapping.independentlyEstablished` without changing the historical observation date or inventing fresh evidence.
2. Supply and review an actual supervised launch/STOP arrangement, operator identity, key custody and recovery policy.
   READ possession grants reads only; STOP possession grants STOP only. Neither grants RESET or UNKNOWN recovery.
3. Review restrictive input/authorization/code/state/report access and durability on this host. Preparation-directory
   access checks are recorded locally. The newly created preparation directory was protected from inherited broad
   access and its directory/input/facts/key-file ACLs were verified to allow only the current user, SYSTEM and
   Administrators; the encrypted IPC file remains untracked. The initial inherited ACL included Users and
   Authenticated Users and was not accepted as restricted access. No existing repository or credential-source
   ACL was modified. This local directory check does not establish secure executable/code custody, future report
   access or a deployed supervisor. Owner equality alone does not prove secure ACLs. Campaign named-pipe ACL,
   remote exclusion and process-identity enforcement remain absent and require an explicit deployment security decision.
4. Confirm the known managed-consumer inventory and aggregate limiter allocation. Manual trading is known; other
   account/API/public-IP traffic is unknown and uncontrolled. Do not attest exclusive use or global quota control.
   No production coordinator is started or bound by preparation.
5. Review implementation and the exact proposed values, then separately authorize the named account, complete input
   digest, isolated new namespace and bounded collection. Only then deliberately initialize the new campaign directory.
   No completed authorization is created by this task.

Later permission would permit only identity plus bounded INR orders/positions information collection: buy/sell,
the existing seven statuses in one combined filter, page size 25, at most two pages per segment, two passes,
one cycle per evaluation, at most three evaluations within proposed 900000 ms. Maximum requests are
`3 × [1 + 2 × (2 × 2 + 2)] = 39` (3 identity, 24 order, 12 position); there are no retries.
The combined filter is client-validated, not confirmed accepted by CoinDCX. Proposed pacing remains 2/1000 ms,
20/60000 ms, P1 13/60000 ms, concurrency 3 with one P0 reserve for managed traffic only.
Missing stream evidence stays UNKNOWN; transactions stay CLIENT_ADAPTER_UNSUPPORTED. Ownership, provider-contract
gaps, D4c/AS1 and formal M3/M4 acceptance are separate limitations, never execution authorization.
