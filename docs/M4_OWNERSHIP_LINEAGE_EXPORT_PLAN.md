# M4 ownership-lineage export plan (restricted offline candidate; nothing executed)

**Status: offline implementation, no real execution.** The diagnostic, snapshot, package and explicit operator
composition exist. No database, credential, provider or runtime was accessed for this implementation. The record
is an **offline diagnostic, not ownership proof**. It sets no lineage input
and changes no gate, grant, AS1, D4c or formal M3/M4 decision. The candidate scope in §0 is recorded; the
underlying contracts stay unresolved (§6). References re-checked against
`2414417333dc0586ee49e7c198506544db2d0d2d` (source inspection only).

Sources inspected:
- `prisma/schema.prisma` (MySQL datasource; frozen migrations unchanged, including the `dispatch_wire_armed`
  backfill in `20260921010000_phase18_wave_a2_crash_recovery`);
- `src/execution/live/{repository,state-machine,service,identity}.ts`;
- `src/execution/live/reconciliation/{repository,service,order-reconciliation,findings}.ts`;
- `src/execution/live/practical-synchronization/engine.ts` (`SyncLineage`, `classifyOrders`, `classifyPositions`,
  cycle reasons);
- `src/integration/coindcx/live/sync-read-campaign{,-preflight}.ts` (identity check, lineage limitation);
- `docs/M4_SYNCHRONIZATION_CANDIDATE.md` (Ownership, C2);
- `docs/PHASE17_LIVE_EXECUTION.md` and `docs/PHASE18_RECONCILIATION.md` (account identity, §8.0).

## 0. Recorded candidate scope (implementation choices, not policy)

| Decision | Candidate scope | Not decided by it |
| --- | --- | --- |
| D1 | Reconciliation-resolved orders are **not** mapped into `ambiguousCreates`. They stay in the diagnostic output with their exclusion reason and finding code | Whether a confirmed tag contract could ever admit them |
| D2 | `closedIntentTags` is **empty by policy**. Neither a local terminal state nor `RECONCILIATION_REQUIRED` establishes the undefined M4 meaning of "closed" | The meaning of "closed" for this M4 input |
| D3 | `ownedPositions` is **empty by policy**. No attribution from ids, quantities or share counts | A position contract binding proven quantity and generation |
| D4 | Elimination-based provenance is **rejected**; `ownedOrders` is **empty by policy**. Absent findings, `COMPLETED_*` runs and writer-source review are not promoted into create-response evidence | Whether direct create-response evidence can ever be recorded |

These choices do not resolve any missing provider or account evidence. They do not establish the absence of
bot-owned records, change ownership policy or approve formal acceptance.

## 1. Target input, and why this record is not an engine input

`SyncLineage` in `src/execution/live/practical-synchronization/engine.ts`. Its fields have these engine effects:

| Field | Engine effect (`classifyOrders` / `classifyPositions`) | This candidate |
| --- | --- | --- |
| `ownedOrders` | A listed exchange id is OWNED (`BOT_CREATE_RESPONSE`), before every tag rule | Empty by policy (D4) |
| `ambiguousCreates` | Unresolved (`TAG_CONTRACT_UNCONFIRMED`) while C2 is unconfirmed. Under a confirmed contract, an exact field match is the engine's existing scenario-2 rule | Durable-state candidates (§3) |
| `closedIntentTags` | A venue order carrying one is unresolved (`TAG_CONFLICT`), checked before the candidate match | Empty by policy (D2) |
| `ownedPositions` | A listed id is OWNED regardless of quantity | Empty by policy (D3) |
| `botTagNamespace` | Correlation only (`TAG_WITHOUT_DURABLE_INTENT` stays unresolved) | `p17-` |

The engine cannot distinguish "empty by policy" from "no records found". Supplying any `SyncLineage` object
removes the cycle reason `OWNERSHIP_LINEAGE_UNAVAILABLE`. That reason is added only for `{ kind: 'UNAVAILABLE' }`,
and the campaign preflight records it as `PREVENTS_CONVERGENCE`. Feeding this record to the engine would therefore
assert an empty durable inventory that it does not prove.

A label alone is not a boundary. The record is therefore a distinct result type (`kind: 'OFFLINE_LINEAGE_DIAGNOSTIC'`)
that contains no `SyncLineage`-shaped object, and no conversion helper exists. The engine's own config validation
rejects the record, and every part of it, as a lineage input. **M4 runs keep `{ kind: 'UNAVAILABLE' }`.** Converting
the record into an engine input is outside this candidate.

## 2. Durable sources (actual tables and columns)

| Table | Columns used | Meaning (from schema/source) |
| --- | --- | --- |
| `live_execution_intent` | `intent_id` (PK, identity hash), `client_order_id` (unique), `account_id`, `pair`, `side`, `quantity`, `price`, `leverage`, `wire_order_type`, `content_sha256` | Immutable bot intent. Integrity is re-verified by the repository on read |
| `live_order` | `intent_id` (PK, FK to intent), `client_order_id` (unique), `account_id`, `state`, `exchange_order_id` (nullable, indexed, **not unique**), `dispatch_wire_armed` | One order per intent. `exchange_order_id` is "present only once CoinDCX genuinely supplied one" |
| `live_order_event` | (not read) | Append-only applied observations. **No column records whether a row came from a create response or from reconciliation** |
| `live_reconciliation_finding` | `account_id`, `code`, `intent_id`, `exchange_order_id` | Durable, never deleted. Codes `RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID` and `RECON_AMBIGUOUS_CREATE_RESOLVED` record reconciliation-assigned exchange ids |
| `live_reconciliation_state` | `account_id`, `current_generation`, `healthy_generation`, `status` | Current reconciliation generation |
| `live_position_ownership_share` | row count only | Reported as a count, never as ids or quantities (D3) |
| `live_practical_certificate` | `account_id`, `provider_account_fingerprint` | 64-hex digest of the provider account identity (`coindcx_id`), recorded at each certificate's issuance (Phase 18B) |

Supported joins (actual keys):
- `live_order.intent_id = live_execution_intent.intent_id` (FK).
- Findings name `intent_id` and `exchange_order_id` without an FK. They are evaluated as **per-intent and
  per-exchange-id sets, never a row join**: a row join would multiply orders, and an inner join would drop findings
  that name no local order.
- Every read is filtered by the same `account_id`.

## 3. Read path and derivation rules

The existing public calls do not form one snapshot:
- `PrismaLiveExecutionRepository.listAccountOrderViews(accountId)` runs its own REPEATABLE READ transaction and
  re-verifies every intent's content hash and order projection.
- `PrismaLiveReconciliationRepository.loadState` is a standalone read outside it.

A consistent export therefore needs **one new reviewed read-only method** that runs every read in a single explicit
REPEATABLE READ transaction, applying the same integrity checks as the listing.

**Implemented as `PrismaLiveExecutionRepository.readLineageDiagnosticSnapshot(accountId)`:**
- one Prisma interactive transaction with `isolationLevel: RepeatableRead`;
- the orders go through the private verified listing `#listAccountOrderViewsWithin`;
- the other four reads are Prisma delegate reads on the same transaction client, with explicit `select` and
  `accountId` filters, equivalent to the SQL below;
- certificate rows are made distinct by exact value in code.

It is read-only by construction (no write delegate, no locking read), not a database-enforced READ ONLY
transaction. Prisma's interactive transactions expose no access-mode option, and a `SET TRANSACTION` issued inside
one would not apply. A read, integrity or commit failure rejects the call, so no partial snapshot is returned.

Equivalent read-only SQL (text only; MySQL `?` placeholders; account-scoped):

```sql
SELECT account_id, intent_id, exchange_order_id, code
FROM live_reconciliation_finding
WHERE account_id = ? AND (intent_id IS NOT NULL OR exchange_order_id IS NOT NULL);

SELECT DISTINCT account_id, provider_account_fingerprint FROM live_practical_certificate WHERE account_id = ?;

SELECT COUNT(*) AS share_count FROM live_position_ownership_share WHERE account_id = ?;
```

Limits of the SQL as written:
- `account_id` is selected so the diagnostic can re-check each row's scope.
- `evidence_json`, `resolved_by` and strategy or position columns are never selected.
- Findings that name only a pair, a position or a strategy are not read.
- Under D4 only finding codes are used. The `category`, `blocking`, `last_seen_generation` and `resolved_at_ms`
  columns are not needed and are not selected.

| Durable row | Candidate output | Diagnostic entry (kept, never discarded) |
| --- | --- | --- |
| Order with an `exchange_order_id` | none (`ownedOrders` empty by policy, D4) | `excluded`, reason `OWNED_ORDERS_DISABLED` |
| …that a `RECON_AMBIGUOUS_CREATE_RESOLVED*` finding names | none (D1) | Same entry, also reason `RECONCILIATION_RESOLVED` with the finding code |
| Null id; `SUBMISSION_AMBIGUOUS`, or `DISPATCH_RESERVED` with `dispatch_wire_armed = true` | `ambiguousCreates` entry from the verified intent (`client_order_id` as `tag`; canonical decimal strings) | Finding codes naming the intent, if any |
| Null id; `CREATED` | none | `omitted`, reason `CLAIM_RELEASED_UNSENT` (the gateway proved it unsent) |
| Null id; `DISPATCH_RESERVED`, unarmed | none | `omitted`, reason `RESERVATION_UNARMED` (the arm precedes the HTTP call) |
| Null id; `REJECTED` | none | `omitted`, reason `VENUE_REFUSED_WITHOUT_SNAPSHOT` (`markRejected`; relies on that gateway classification) |
| Null id in any other state | none | `conflicts`, reason `UNEXPECTED_STATE_WITHOUT_EXCHANGE_ID` |
| Two intents with the same exchange id; a finding naming an intent absent from `live_order`; a finding naming an exchange id held by a different intent | none | `conflicts` with the reason |
| Share rows | none (D3) | Count only |

`closedIntentTags` and `ownedPositions` are empty by policy (D2, D3). `botTagNamespace` is
`LIVE_CLIENT_ORDER_ID_PREFIX` (`p17-`, `src/execution/live/identity.ts`), for correlation only.

Never used for ownership:
- tag or `client_order_id` similarity;
- symbol, side, quantity or price matches;
- an intent without an order;
- a finding's economics;
- `live_orphan_venue_order` rows (explicitly "no proven local lineage");
- `live_position` or share rows.

## 4. Exact missing links and limitations

1. **Create-response provenance is not recorded positively.**
   - A Phase 18 resolution writes the same `live_order_event` shape as a create response.
   - Elimination also has a demonstrated gap. The `RESOLVE_AMBIGUOUS_CREATE` effect is committed
     (`commitReconciledState`) before its finding is persisted (`persistFindings` in `#completeWithFindings`). A
     run interrupted between those two writes leaves a reconciliation-assigned id with no resolution finding.
   - This is why `ownedOrders` is disabled (D4). Only a direct durable record of create-response provenance could
     change that; no such record exists.
2. **Reconciliation-resolved orders do not fit an M4 field.**
   - They have an exchange id.
   - Their identity rests on exact `client_order_id` (Phase 18 §8.0, `ORDER_IDENTITY_ONLY`). M4 accepts that only
     under a confirmed C2 tag contract, which is unconfirmed. They are retained as diagnostics (D1).
3. **Position ownership cannot be bound to current venue state.**
   - A share is proven for an exact quantity at `last_proven_generation`, and `venue_position_id` may be null.
   - The engine marks any listed id OWNED regardless of quantity (D3).
4. **Order-time account identity is not durable.**
   - `account_id` is the configured `COINDCX_LIVE_ACCOUNT_ID` label.
   - `live_reconciliation_run` does not persist the verified fingerprint, and certificates record it only at
     issuance.
5. **Source coverage is not durably recorded.**
   - No table records which databases the bot runtimes used for these credentials.
   - The same provider account under another label, or in another database, is invisible to an account-filtered
     read.
6. **Null-id omissions rely on state semantics.**
   - The `omitted` reasons follow this checkout's state machine and the wave A2 backfill, which armed every
     outstanding `DISPATCH_RESERVED` row.
   - Rows written under different semantics would be misclassified, which is why omitted rows are kept in the
     diagnostic output rather than dropped.

## 5. Export record, provenance and binding checks

Record shape, as implemented by the offline transformer `src/execution/live/ownership-lineage-diagnostic.ts`:
- `kind: 'OFFLINE_LINEAGE_DIAGNOSTIC'`, `use: 'OFFLINE_DIAGNOSTIC_ONLY'`, `engineInput: 'NOT_PERMITTED'`,
  `ownershipProof: 'NONE'`;
- `policyEmpty`: a status per disabled output, each `EMPTY_BY_POLICY` with its decision (D4, D2, D3). These are
  statuses, never arrays;
- `ambiguousCreateCandidates`:
  - `ENTRIES_FOUND` or `NONE_FOUND_IN_SNAPSHOT`, always with `scope: SUPPLIED_SNAPSHOT_ONLY` and
    `accountWideAbsence: NOT_ESTABLISHED` (§4.5);
  - entries carry the plan §1 fields and their finding codes, as diagnostic evidence only;
- `diagnostics`:
  - `excluded`, `omitted` and `conflicts`: each entry is intent ids with a reason and finding codes only;
  - `excluded` entries also carry `exchangeIdCorrelatedFindingCodes`. These come from findings that name only the
    order's exchange id. They are correlation only and never classify an order (for example, never
    `RECONCILIATION_RESOLVED`);
  - unlinked finding codes with counts (no exchange ids);
  - the share count.
- `provenance` and `recordSha256`.

Reported finding codes are those of the persisted Phase 18 taxonomy (`LiveReconciliationFindingCode`, pinned by a
compile-time test). A well-formed code outside the taxonomy is reported as `UNRECOGNIZED_FINDING_CODE` and never
echoed.

Order rows must match the repository's persisted shapes:
- the Phase 17 `client_order_id` format;
- positive `DECIMAL(36,18)` ordered quantity, price and leverage.

Every supplied field is read once before it is validated and used.

A refusal is `kind: 'OFFLINE_LINEAGE_DIAGNOSTIC_REFUSED'` with a fixed reason code and nothing else. It covers:
- malformed rows;
- a row of another account;
- duplicate intent or client order ids;
- a wire arm outside `DISPATCH_RESERVED`;
- disagreeing fingerprint statements;
- a certificate mismatch.

No partial diagnostic is returned.

Provenance separates three kinds:
- **Checked on the supplied rows:**
  - row formats and account scope;
  - uniqueness;
  - wire-arm consistency;
  - finding associations;
  - the account label against the campaign statement;
  - the certificate fingerprints against the statement;
  - row counts and the supplied generations.

  These checks cover rows as supplied. Synthetic rows prove nothing about a database.
- **Caller statements:**
  - the source commit;
  - the checkout's migration directory names and `migration_lock.toml` hash;
  - the expected fingerprint (12-character prefix only);
  - the agreement of the two fingerprint statements, labelled as binding nothing;
  - the coverage attestation, labelled unverified.
- **Not established without a real database read:**
  - transaction consistency;
  - snapshot isolation and time;
  - intent content-hash integrity (verified by the repository on a real read);
  - database identity and applied migrations;
  - source coverage;
  - order-time account identity;
  - create-response provenance;
  - account-wide absence.

The checkout's migration identity describes the code, not which migrations the database has applied.

Storage, implemented by `src/execution/live/ownership-lineage-export.ts`:
- **The flow.** Snapshot port, then the diagnostic, then a package write, then a readback.
  - The snapshot comes through an injected structural port; the module imports no repository or Prisma.
  - Filesystem work starts only after the snapshot call has returned, i.e. after its transaction committed.
  - A read failure, a malformed or foreign snapshot, or a diagnostic refusal writes nothing.
- **The package.** A new directory, created exclusively (an existing one, even empty, is refused). It holds exactly:
  - `lineage-diagnostic.json`, the allowlisted diagnostic only, never snapshot rows;
  - `SHA256SUMS`, written last as the completion marker.

  Files are opened with `wx` and flushed. The intended location is under the ignored `.local/`; the caller supplies
  the path.
- **Readback** rejects:
  - a missing manifest (incomplete), and missing or extra files;
  - non-regular or oversized files;
  - a malformed manifest or a digest mismatch;
  - a malformed or lineage-shaped diagnostic;
  - a `recordSha256` mismatch.

  The digests detect corruption and incomplete writes. They do not authenticate the package against a writer able
  to recompute both.
- **A failed write** leaves the directory in place, reported as `INCOMPLETE_OR_UNVERIFIED`. Readback never accepts
  it, and a retry needs a new path.
- **Limits:** directory sync and OS ownership/ACL are not established. The requested modes (0700 and 0600) are not
  enforced on Windows.
- **Fingerprint:** the package holds only the expected fingerprint's 12-character prefix, as the M4 campaign
  reports do (`observedFingerprintPrefix`).

| Binding check | Kind | What it does not prove |
| --- | --- | --- |
| Operator fingerprint equals the M4 plan's `account.expectedProviderAccountFingerprint` | Statement compared with statement | Nothing about the database |
| Every certificate fingerprint for the `account_id` equals it (a mismatch blocks) | Durable record, checked by the export | Only the identity at each issuance; with zero certificate rows the binding is statement-only |
| Local `account_id` equals the M4 plan's `account.accountId` | Checked by the export | That the label always meant the same provider account (§4.4) |
| Source coverage | Operator statement only (§4.5) | Without it, `NONE_FOUND_IN_SNAPSHOT` says nothing about the account |
| Every intent passes the repository's integrity verification | Checked by the export | Any failure aborts the export rather than skipping a row |

Missing, conflicting or incomplete lineage is never filled in. An integrity failure or a failed read aborts the
whole export.

Sensitive fields excluded:
- credentials and configuration values;
- the raw `coindcx_id`;
- `evidence_json`;
- operator `note` and `resolved_by`;
- share rows other than the count;
- strategy, research, validation and risk identifiers;
- notional and settlement fields;
- fill quantities, average prices and exchange status lexemes;
- any raw provider payload.

## 6. Unresolved contracts (not decided by §0)

- **Closed intents:** the M4 meaning of a "closed" intent for `closedIntentTags`.
- **Position contract:** one that binds proven quantity and generation to current venue state.
- **Create-response provenance:** a durable record of create-response provenance, which does not exist.
- **Tag contract C2:** the provider confirmation, which governs any use of `ambiguousCreates` and of
  reconciliation-resolved orders.
- **Account identity:** a durable order-time binding to the provider account, and source coverage across
  databases.

## 7. Prerequisites, by activity (none satisfied by this document)

- **Writing offline code:** done.
  - The diagnostic, the repository snapshot method and the export/package module exist.
  - They are verified with synthetic rows: the real repository method over a fake transaction client, and a real
    filesystem in isolated temporary directories.
  - Fake tests verify routing and failure handling only. They prove nothing about MySQL isolation, locking or
    deployment suitability.
- **Executing DB reads:**
  - separate authorization for read-only access to the identified database;
  - confirmation that its applied migrations match the checkout;
  - no execution against the original worktree's store.
  - The explicit composition root `scripts/m4-lineage-export.ts` constructs its own Prisma client after local
    validation, and its repository after metadata preflight. The operator root and the explicit synthetic acceptance
    adapter are the two pinned scripts importers; existing src importer allowlists remain unchanged. See §8 and
    [the prepared synthetic harness](M4_SYNTHETIC_MYSQL_ACCEPTANCE.md). No MySQL acceptance has been executed.
- **Using the output as account evidence:**
  - the operator-supplied expected fingerprint and source-coverage attestation;
  - the certificate check;
  - resolution of the §6 contracts relevant to the use.

  The record is never an M4 engine input under this candidate (§1).

No ownership is inferred meanwhile:
- lineage stays `UNAVAILABLE`;
- the account remains manually and shared used;
- no exclusivity is claimed.

## 8. Explicit operator composition (offline verified; real execution NOT authorized or performed)

`scripts/m4-lineage-export.ts` composes only:

explicit `--input` → strict operator input validation → protected-store inventory verification → clean source and
fresh ignored output checks → explicit URL validation → owned DB client → DB identity → applied migrations →
existing repository snapshot/export/package/readback → owned client disconnect.

No account-data read or repository construction is reachable on failed preflight. Importing the root performs no
I/O, client construction, environment lookup, startup or invocation. Prisma and the repository are loaded only
inside the owned factory. Before loading them, the factory checks generated Prisma source `relativeEnvPaths`;
configured env-file discovery or an unrecognized format refuses. There is no `.env` loader or `DATABASE_URL`
fallback. The root's explicit URL override and disabled Prisma logging keep dependency errors out of its output.

All these inputs are required; there are no supplied real values or defaults:

- `kind`: `M4_OFFLINE_LINEAGE_EXPORT`.
- `target`: independently reviewed `serverUuid` (lowercase MySQL UUID) and `databaseName` (ASCII letters/digits/underscore).
- `protectedStore`: `version: 2`, a nonempty `identities` array in the target identity shape, `inventorySha256`
  (SHA-256 of the exact inventory file bytes), and `review: OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITIES`.
  Every entry must validate; duplicate UUID/schema pairs (schema compared case-insensitively) are refused.
- `databaseUrlEnvironmentVariable`: exactly `M4_LINEAGE_DATABASE_URL`. The operator must supply this variable
  securely to the process; no URL or credential belongs in JSON, command arguments or retained stdout.
- `accountId`, `campaignAccountId`: matching explicit local labels.
- `expectedProviderAccountFingerprint`, `campaignExpectedProviderAccountFingerprint`: matching lowercase 64-hex
  operator/campaign statements. They are not a DB identity or a fresh provider identity observation.
- `sourceCoverage`: explicitly `ATTESTED` or `NOT_ATTESTED`; either remains an unverified operator statement.
- `sourceCommit`: exact clean checkout HEAD, including the reviewed composition changes.
- `outputName`: a fresh lowercase ASCII alphanumeric/hyphen basename, at most 80 characters, beginning alphanumeric.
  Windows reserved device names are refused as well.

The non-secret input JSON must be directly under the **already existing**
`C:\TSA\coindcx-m2-w1\.local\m4-lineage-exports`. That directory and `.local` must be real directories, without
symlinks/junctions. The checkout must have a canonical path. The output is precisely this parent plus `outputName`;
it must be absent, ignored by the effective Git rules and untracked. Existing paths, including incomplete packages,
are never reused or deleted. The package writer still creates the directory exclusively and verifies its readback.
The root rechecks the approved parent and fresh output at the writer's first filesystem action, after the snapshot.
These path checks do not establish OS custody against an adversarial concurrent rename between checking and opening;
the already approved local directory must remain under the operator's control throughout the invocation.

The same parent must contain `protected-store-inventory.json` with exactly:

```json
{
  "kind": "M4_PROTECTED_ORIGINAL_STORE_INVENTORY",
  "version": 2,
  "identities": [
    { "serverUuid": "<reviewed protected server UUID>", "databaseName": "<reviewed protected schema>" }
  ],
  "review": "OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITIES"
}
```

Placeholders above are intentionally invalid. No inventory was created during this task. Missing inventory, missing
review, bad digest or a different identity collection refuses **before URL lookup/client construction**. File and
invocation must contain exactly the same UUID/schema pairs; list order does not matter, exact entry values do.
Legacy single-entry, absent/unsupported version, empty, duplicate, malformed and extra-field formats are refused;
`PROTECTED_INVENTORY_INVALID` includes a fixed message directing the operator to review a version-2 list in both
files and recompute the digest. There is no automatic conversion or completeness claim for old input.

Both `coindcx_shadow` and `coindcx_quant` are unconditionally excluded as known protected operational schema names,
pinned to `tests/helpers/p18b-disposable-mysql.ts`; neither exclusion depends on the operator listing either name.
Every operator-listed protected schema is also excluded case-insensitively on every server. Changing host or UUID
cannot bypass a schema-name exclusion. A server hosting protected schemas is not rejected wholesale: an unrelated
schema on that same UUID may pass, provided `DATABASE()` and `@@server_uuid` together match its explicit target.
This is exclusion against a required **operator-verified inventory**, not automatic discovery of the original store,
authentication of the inventory issuer, historical exhaustiveness, or proof against a false/incomplete inventory.
The two built-in names are a minimum denylist, not a claim that all historical stores are known. If the operator
cannot establish the required protected identities from authorized non-secret evidence, execution must stay blocked;
do not inspect their credentials/store to manufacture the missing input.

The explicit MySQL URL must select the exact target schema. Its only query parameters are `connection_limit=1`,
`connect_timeout` and `pool_timeout`; both timeout values must be operator-chosen integer seconds from 1 to 99.
Duplicate parameters, alternate socket/schema selectors and additional parameters refuse. No URL is printed.
Nonempty `DEBUG`, `RUST_LOG` or `PRISMA_LOG_LEVEL` refuses before client loading, because dependency traces can bypass
ordinary Prisma logging. Use an operator-controlled process environment without tracing or injected preload hooks.
One connection reduces pool ambiguity; it is not a proof against failover, a misrouting proxy or concurrent DDL.

Applied migration metadata must have exactly one completed, non-rolled-back row per checkout migration, no extra
rows, and matching `migration.sql` SHA-256 checksums over **working-copy bytes**, without newline normalization.
Git blob and reviewed LF freeze hashes are separate bases; see [target readiness](M4_LINEAGE_TARGET_READINESS.md).
An LF-only match is not automatically accepted, and neither migrations nor DB records are repaired.
The lock-file hash remains separate checkout provenance.
No migration runs. Matching migration history is not an independent schema-drift audit. The existing snapshot's
single RepeatableRead transaction, integrity checks, timeout and classification rules are unchanged.

The launcher result separates its metadata-preflight status from the existing diagnostic's conservative
`notEstablished` list. In particular the diagnostic is not rewritten to claim DB identity, provider account identity
or source coverage. The package still contains only the existing diagnostic and manifest, with the fingerprint prefix.
The caller retains the non-secret reviewed invocation, inventory and safe launcher result separately if needed.
Failures report fixed stages; no dependency message, URL, full fingerprint or raw account row is echoed.
Cleanup always attempts to disconnect exactly the created client, including preflight/snapshot/write/readback
failures. A cleanup failure makes the invocation fail even if a package was written; no automatic retry or deletion.

Exact future invocation from this worktree (documented only, **NOT EXECUTED**):

```powershell
node .\node_modules\tsx\dist\cli.mjs .\scripts\m4-lineage-export.ts --input C:\TSA\coindcx-m2-w1\.local\m4-lineage-exports\invocation.json
```

### Two future activities — neither executed or authorized here

**A. Controlled synthetic MySQL validation.** Reviewed synthetic account identities and fingerprints are legitimate
for a genuinely synthetic fixture database. Label the fixture account, input, retained verification record and package
context explicitly `SYNTHETIC`; they are not historical or real-account evidence. Synthetic fingerprints are not
globally banned. Existing fake tests remain synthetic. Fresh MySQL setup and validation require separate authorization;
the minimum setup and boundaries are recorded in [target readiness](M4_LINEAGE_TARGET_READINESS.md).

**B. Historical-candidate diagnostic export.** `p18b_practical_test_50272508801d` remains a candidate only. Its name
matches a test generator, but reviewed instance-specific provenance has not been established. Do not substitute
synthetic fixture labels/fingerprints for its actual account/provenance inputs. Metadata results and the actual
reviewed account inputs remain outstanding; do not execute the launcher merely because the inventory format is fixed.

### Bounded diagnostic execution proposal — NOT EXECUTED

After separate explicit authorization: use one already provisioned, independently identified **non-original**
database with an existing SELECT-only principal. Do not create a database/user, apply migrations, alter ACLs or copy
the original store as part of this invocation. Review original-store inventory, target UUID/schema, account/campaign
fingerprint statements, coverage choice, clean source commit and a new output name before supplying the URL.
The URL must point directly to the reviewed server, without a load-balancing/failover endpoint. Keep schema/migration
changes paused by the owner for this read; this launcher does not enforce that host condition.

Run the command once under an external operator-controlled 120-second process deadline, with explicit connection
and pool timeouts each no more than 10 seconds. Successful execution issues two metadata SELECTs and exactly one
existing account-scoped RepeatableRead snapshot transaction (existing 30-second transaction timeout), writes one
fresh diagnostic package, verifies readback, then disconnects. Identity failure stops before migration metadata;
migration failure stops before any account read. No provider requests, stream, collection, campaign, engine or trading
path is composed. Unexpected failure/deadline/cleanup leaves any output untouched and requires review before a new
invocation/name; a forced process termination cannot promise successful resource cleanup or a complete package.

For activity B, current blockers include candidate-instance provenance, metadata compatibility, a reviewed protected
identity inventory, export authorization, a SELECT-only connection and actual account/operator statements. For
activity A, independently reviewed synthetic fixture statements are appropriate after authorized fresh setup.
Offline tests establish routing/failure/privacy behavior only; they do not establish real MySQL behavior, inventory authenticity, source
coverage or ownership. The known parallel architecture timeout remains unresolved; no timeout setting was changed.

D1–D4, actual M4 lineage `UNAVAILABLE`, false authority grants, gates, `authorityEligible`, Invariant 28, AS1/D4c and
formal M3/M4 acceptance remain unchanged.

## 9. Offline verification record (19 October 2026)

Starting HEAD: `6bc8f3e35366f0585aaf8d7a6360752fafc276bc`, clean index/worktree. The operator confirmed no other
session was editing this worktree. No completed pipeline source, frozen migration or producing launcher was changed.

- Final affected run: **91/91 passed** — 74 synthetic invocation tests; the invocation/export/diagnostic architecture
  boundaries (10 tests); and the unchanged cancel-transport provenance boundary (7 tests). Command:
  `node node_modules/vitest/vitest.mjs run tests/unit/scripts/m4-lineage-export.test.ts tests/architecture/m4-lineage-invocation-boundary.test.ts tests/architecture/m4-ownership-lineage-export-boundary.test.ts tests/architecture/m4-ownership-lineage-diagnostic-boundary.test.ts tests/architecture/phase18b-practical-cancel-transport-provenance-boundary.test.ts --maxWorkers=1 --no-file-parallelism`.
- Wider offline run: **988 passed, 1 timeout**, across 39 files, using the same single-worker flags with
  `tests/architecture` and invocation/export/diagnostic/durable-integrity unit suites. The unchanged timeout was
  `phase18b-practical-cancel-transport-provenance-boundary.test.ts`, test
  `pins neutral importers and privileged operations to exact modules`, at the existing 5000 ms limit. It passed
  subsequently at 4920 ms in the final affected run. This is timing-sensitive evidence, not closure of the known
  parallel architecture timeout. No timeout setting changed. The final output-parent recheck was added after the
  wider run and covered by the final affected run; unchanged source-bound checks were reused.
- Existing export (16), diagnostic (40), and durable-integrity (75) tests all passed in that wider run; their pipeline
  source remains identical to the starting HEAD. No classification or integrity implementation was duplicated.
- Final `npm.cmd run typecheck`: passed. Final `npm.cmd run lint`: passed with 10 existing `no-explicit-any` warnings
  in unchanged `session-fault-recovery.test.ts`. Explicit ESLint on the new launcher and affected tests: no warnings/errors.
- Focused final source/importer review and `git diff --check`: passed. The sole new script importer is pinned by exact
  filename; no src importer list, engine/campaign/startup boundary, gate or authority rule was relaxed.

Tests used injected factories/DB ports, mocked Prisma construction, synthetic filesystem/Git data and the unchanged
fake-transaction pipeline suites. They covered import behavior, input/identity/migration refusals before account reads,
existing export/readback, malformed/foreign/certificate failures, safe errors, tracing refusal, write/readback failure,
fresh ignored storage/junction checks, caller mutation, and cleanup including double failures. No real credential,
env-file contents, DB connection (including disposable DBs), provider call or runtime startup was used.
