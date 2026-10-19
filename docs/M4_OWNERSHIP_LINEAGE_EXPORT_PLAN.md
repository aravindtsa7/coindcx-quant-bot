# M4 ownership-lineage export plan (restricted offline candidate; nothing executed)

**Status: plan only.** No database, credential, provider or runtime was accessed. No query was run and no exporter
exists. The record this plan describes is an **offline diagnostic, not ownership proof**. It sets no lineage input
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
  - A composition root, which does not exist, would have to construct a Prisma client and
    `PrismaLiveExecutionRepository` and call the export. It would be a new importer of `live/repository.ts`, so it
    needs a reviewed addition to that file's pinned importer guard and to this module's no-importer guard.
- **Using the output as account evidence:**
  - the operator-supplied expected fingerprint and source-coverage attestation;
  - the certificate check;
  - resolution of the §6 contracts relevant to the use.

  The record is never an M4 engine input under this candidate (§1).

No ownership is inferred meanwhile:
- lineage stays `UNAVAILABLE`;
- the account remains manually and shared used;
- no exclusivity is claimed.
