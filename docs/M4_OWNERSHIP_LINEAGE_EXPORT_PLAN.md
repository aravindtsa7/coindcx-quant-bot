# M4 ownership-lineage export plan (review draft; nothing executed)

**Status: plan only.** No database, credential, provider or runtime was accessed. No query was run and no exporter
exists. This plan proves no ownership, sets no lineage input and changes no gate, grant, AS1, D4c or formal M3/M4
decision. Every §6 decision is OPEN. Base checkpoint: `9cc00364c6d3a397d3d9144c1c7f368e7d4b1f71`; references
re-checked against that source (inspection only).

Sources inspected: `prisma/schema.prisma` (MySQL datasource; frozen migrations unchanged),
`src/execution/live/{repository,state-machine,service,identity}.ts`,
`src/execution/live/reconciliation/{repository,service,order-reconciliation,findings}.ts`,
`src/execution/live/practical-synchronization/engine.ts` (`SyncLineage`, `classifyOrders`, `classifyPositions`),
`src/integration/coindcx/live/sync-read-campaign.ts` (identity check), `docs/M4_SYNCHRONIZATION_CANDIDATE.md`
(Ownership, C2), `docs/PHASE17_LIVE_EXECUTION.md` and `docs/PHASE18_RECONCILIATION.md` (account identity, §8.0).

## 1. Target input and how the engine uses it

`SyncLineage` in `src/execution/live/practical-synchronization/engine.ts`. `{ kind: 'UNAVAILABLE' }` remains the
input until an export passes review. An exported object with empty arrays **asserts an empty durable inventory**
(the type's own comment), so it needs the coverage binding in §5; otherwise the input stays `UNAVAILABLE`.

| Field | Engine effect (`classifyOrders` / `classifyPositions`) |
| --- | --- |
| `ownedOrders { exchangeOrderId, intentId }` | A venue order with a listed exchange id is OWNED (`BOT_CREATE_RESPONSE`), checked before every tag rule. A wrong entry therefore creates a false OWNED |
| `ambiguousCreates { intentId, accountId, tag, pair, side, orderedQuantity, price, wireOrderType, leverage }` | A venue order with that tag stays unresolved (`TAG_CONTRACT_UNCONFIRMED`) while the C2 tag contract is unconfirmed. Only under a confirmed contract does an exact field match give OWNED; that is the engine's existing scenario-2 rule, not an exporter inference |
| `closedIntentTags` | A venue order carrying one is unresolved (`TAG_CONFLICT`). This check runs before the `ambiguousCreates` match |
| `ownedPositions` (venue position ids) | A listed id is OWNED regardless of quantity. A false entry creates a false OWNED |
| `botTagNamespace` | Correlation only: a namespaced tag without durable lineage stays unresolved (`TAG_WITHOUT_DURABLE_INTENT`) |

## 2. Durable sources (actual tables and columns)

| Table | Columns used | Meaning (from schema/source) |
| --- | --- | --- |
| `live_execution_intent` | `intent_id` (PK, identity hash), `client_order_id` (unique), `account_id`, `pair`, `side`, `quantity`, `price`, `leverage`, `wire_order_type`, `content_sha256` | Immutable bot intent. Integrity is re-verified by the repository on read |
| `live_order` | `intent_id` (PK, FK to intent), `client_order_id` (unique), `account_id`, `state`, `exchange_order_id` (nullable, indexed, **not unique**), `dispatch_wire_armed`, `revision` | One order per intent. `exchange_order_id` is "present only once CoinDCX genuinely supplied one" |
| `live_order_event` | (not read) | Append-only applied observations. **No column records whether a row came from a create response or from reconciliation** |
| `live_reconciliation_finding` | `account_id`, `category`, `code`, `intent_id`, `exchange_order_id`, `blocking`, `last_seen_generation`, `resolved_at_ms` | Durable, never deleted. Codes `RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID` and `RECON_AMBIGUOUS_CREATE_RESOLVED` record reconciliation-assigned exchange ids |
| `live_reconciliation_state` | `account_id`, `current_generation`, `healthy_generation`, `status` | Current reconciliation generation |
| `live_reconciliation_run` | `account_id`, `status` | Run completion (`COMPLETED_*`, `RUNNING`, `ABANDONED`); needed by §4.1 |
| `live_position_ownership_share` | row count only | Written only where exact accepted-fill lineage proved strategy ownership at one generation. Not exported while `ownedPositions` stays empty (§4.3) |
| `live_practical_certificate` | `account_id`, `provider_account_fingerprint` | 64-hex digest of the provider account identity (`coindcx_id`), recorded at each certificate's issuance (Phase 18B) |

Supported joins (actual keys): `live_order.intent_id = live_execution_intent.intent_id` (FK). Findings name
`intent_id` and `exchange_order_id` without an FK, so they are evaluated as **per-intent and per-exchange-id
sets, never as a row join**. A row join would multiply an order by its findings, and an inner join would drop
findings that name no local order. Every read is filtered by the same `account_id`. There is **no** key from
`live_position` or a share to a venue position except the nullable `venue_position_id`.

## 3. Read path and derivation rules

The existing public calls do not form one snapshot. `PrismaLiveExecutionRepository.listAccountOrderViews(accountId)`
runs its own REPEATABLE READ transaction and re-verifies every intent's content hash and order projection.
`PrismaLiveReconciliationRepository.loadState` and `loadOwnershipShares` are standalone reads outside it.
A consistent export therefore needs **one new reviewed read-only method** that runs every read below in a single
explicit REPEATABLE READ transaction, applying the same integrity checks as the listing.

New read-only SQL to review (text only; MySQL `?` placeholders; account-scoped). No repository lists findings by
code or runs by status today:

```sql
SELECT intent_id, exchange_order_id, category, code, blocking, last_seen_generation, resolved_at_ms
FROM live_reconciliation_finding
WHERE account_id = ? AND (intent_id IS NOT NULL OR exchange_order_id IS NOT NULL);

SELECT status, COUNT(*) AS run_count
FROM live_reconciliation_run
WHERE account_id = ?
GROUP BY status;
```

Limits of the SQL as written:
- `evidence_json`, `resolved_by` and strategy or position columns are never selected.
- Findings that name only a pair, a position or a strategy are not read; they do not bear on order lineage.
- A finding is "current" exactly as `completeRun` counts it: `last_seen_generation = current_generation`
  and `resolved_at_ms IS NULL`, plus `blocking`. The SQL returns the raw columns, and the exporter applies that rule.
- A finding naming an `intent_id` absent from `live_order` is a conflict, listed in `excluded`. So is one naming
  an exchange id that a different intent holds. Neither is dropped.

| Output | Include only if | Otherwise |
| --- | --- | --- |
| `ownedOrders` | `exchange_order_id` is non-null; the §4.1 precondition holds; no `RECON_AMBIGUOUS_CREATE_RESOLVED*` finding of any generation names the intent; no current blocking finding names the intent or the exchange id; no other intent of the account carries the same exchange id | Listed in `excluded` with the reason; never owned |
| `ambiguousCreates` | `exchange_order_id` is null and the create may have reached the wire: state `SUBMISSION_AMBIGUOUS`, or `DISPATCH_RESERVED` with `dispatch_wire_armed = true`. Fields come from the verified intent (`client_order_id` as `tag`; canonical decimal strings) | Omitted: `CREATED` (a released claim the gateway proved unsent) and unarmed `DISPATCH_RESERVED` (the arm precedes the HTTP call). Also omitted: `REJECTED` without an id, which Phase 17 records through `markRejected` as a venue refusal carrying no order snapshot; the omission relies on that gateway classification. Any other state without an exchange id is listed in `excluded` as a conflict |
| `closedIntentTags` | OPEN (§6). Whatever the rule, it must never contain a tag listed in `ambiguousCreates` (the engine checks closed tags first) | — |
| `ownedPositions` | **Empty** (§4.3) | — |
| `botTagNamespace` | `LIVE_CLIENT_ORDER_ID_PREFIX` (`p17-`, `src/execution/live/identity.ts`) | Correlation only; a manual order can carry it |

Never used for ownership:
- tag or `client_order_id` similarity;
- symbol, side, quantity or price matches;
- an intent without an order;
- a finding's economics;
- `live_orphan_venue_order` rows (explicitly "no proven local lineage");
- `live_position` or share rows alone.

## 4. Exact missing links

1. **Create-response provenance is not recorded positively, and elimination has a demonstrated gap.**
   - **What is not recorded.** A Phase 18 resolution writes the same `live_order_event` shape as a create
     response. Nothing durable marks which path set the first exchange id.
   - **The two paths.** In this checkout, only two paths set a first id:
     - create-response ingest (`LiveExecutionService` → `applyObservationAtomically`);
     - the reconciliation `RESOLVE_AMBIGUOUS_CREATE` effect (`buildResolvedOrderState`).

     The sync, cancel and reconciliation-advance paths require an existing id. The public
     `LiveExecutionService.applyObservation` does not, but nothing in `src` or `scripts` calls it.
   - **The gap.** The resolution effect is committed in its own write (`commitReconciledState`, in the service's
     effect loop). Its finding is persisted later, by `persistFindings` in `#completeWithFindings`. A run that is
     fenced, fails or crashes between those two writes leaves a reconciliation-assigned exchange id with no
     resolution finding. Later runs take the identified-order path and never recreate that finding.
   - **Necessary, not sufficient.** Every `live_reconciliation_run` row for the account must have a `COMPLETED_*`
     status. Any `RUNNING` or `ABANDONED` run makes elimination unproven, and `ownedOrders` is then withheld.
   - **Writer source.** The path analysis covers this checkout's source only. If the database was written by
     runtimes built from other commits, their source must be shown to have the same paths.
   - Even with all of these conditions, `ownedOrders` remains an inference by elimination and must be labelled so.
2. **Reconciliation-resolved orders do not fit an M4 field.**
   - They have an exchange id, so they are not "no exchange id known" ambiguous creates.
   - Their identity rests on exact `client_order_id` (Phase 18 §8.0, `ORDER_IDENTITY_ONLY`). M4 accepts that only
     under a confirmed tag contract (C2, still unconfirmed).
   - Default: excluded, so their venue orders stay unresolved.
3. **Position ownership cannot be bound to current venue state.**
   - A share is proven for an exact quantity at `last_proven_generation`, and `venue_position_id` may be null.
   - The M4 input carries only position ids, and the engine marks any listed id OWNED regardless of quantity.
   - On a manually shared account, a later manual change to that position would go undetected.
4. **Order-time account identity is not durable.**
   - `account_id` is the configured `COINDCX_LIVE_ACCOUNT_ID` label.
   - Phase 18 runs verify the provider fingerprint at run time, but `live_reconciliation_run` does not persist it.
   - `live_practical_certificate` records it only at certificate issuance. No record ties each order's dispatch to
     a verified provider account.
5. **Source coverage is not durably recorded.**
   - No table records which databases the bot runtimes used for these credentials.
   - The same provider account under another `account_id` label, or in another database, is invisible to an
     account-filtered read.
   - Coverage can therefore only be an operator statement (§5).

## 5. Export record, provenance and binding checks

Minimum fields per entry: the `SyncLineage` fields above only, plus a per-entry `basis`
(`CREATE_RESPONSE_BY_ELIMINATION` or `AMBIGUOUS_CREATE_DURABLE_STATE`). Exclusions also carry a `reason` and the
finding code.

The export header labels every item as one of two kinds:
- **VERIFIED_BY_EXPORT**, read from the snapshot:
  - row counts per table and run counts by status;
  - `current_generation` and `healthy_generation`;
  - the certificate fingerprints for the `account_id`;
  - the snapshot's isolation level and local time;
  - the source commit and the checkout's migration directory names plus the `migration_lock.toml` hash;
  - a SHA-256 over the canonical export.
- **OPERATOR_STATEMENT**:
  - the expected provider-account fingerprint (never the raw `coindcx_id`);
  - that this is the identified database;
  - the source-coverage attestation.

The checkout's migration identity describes the code. Whether the database has exactly those migrations applied is
not verified by this plan (§7). The export is written once (no overwrite) to an ignored `.local/` package with
`SHA256SUMS`. The full fingerprint stays inside that package. Any shareable summary uses the 12-character prefix,
as the M4 campaign reports do (`observedFingerprintPrefix`).

| Binding check | Kind | What it does not prove |
| --- | --- | --- |
| Operator fingerprint equals the M4 plan's `account.expectedProviderAccountFingerprint` | Statement compared with statement | Nothing about the database; both values are operator-supplied |
| Every `live_practical_certificate` fingerprint for the `account_id` equals it (a mismatch blocks) | Durable record, checked by the export | Only the identity at each issuance; with zero certificate rows the binding is statement-only |
| Local `account_id` equals the M4 plan's `account.accountId` (engine `accountId`) | Checked by the export | That the label always meant the same provider account (§4.4) |
| Source coverage: this database is the only durable store any bot runtime used for these credentials | Operator statement only (§4.5) | Without it, empty arrays are not an inventory and the input stays `UNAVAILABLE` |
| Every included intent passes the repository's integrity verification | Checked by the export | A failure aborts the export rather than skipping a row |
| All runs `COMPLETED_*` (§4.1) | Checked by the export | Necessary for elimination, not sufficient |

Missing, conflicting or incomplete lineage is never filled in. The following are reported in `excluded` and their
records stay unresolved:
- duplicate exchange ids;
- current blocking findings;
- findings without a local order;
- unexpected states without an id.

An integrity failure or a failed read aborts the whole export.

Sensitive fields excluded:
- credentials and configuration values;
- the raw `coindcx_id`;
- `evidence_json`;
- operator `note` and `resolved_by`;
- share rows (owner strategy fields, `lineage_json`, quantities);
- strategy, research, validation and risk identifiers from the intent;
- notional and settlement fields;
- fill quantities, average prices and exchange status lexemes;
- any raw provider payload.

## 6. Decisions needed before implementation (all OPEN)

1. **Reconciliation-resolved orders.** May they appear in `ambiguousCreates`? Proposed default: excluded.
2. **Closed intents.** What M4 meaning does a "closed" intent have for `closedIntentTags`? The source terminal set
   is `FILLED`, `CANCELLED`, `REJECTED`, `SUBMISSION_AMBIGUOUS` and `RECONCILIATION_REQUIRED`. Ambiguous-create
   tags must be excluded.
3. **Position contract.** It must bind proven quantity and generation. Until then `ownedPositions` is empty.
4. **Elimination-based provenance.** Is it acceptable for `ownedOrders` under the §4.1 conditions? If so, should
   any blocking finding, not only a current one, also exclude an intent?

## 7. Prerequisites for executing this plan (none satisfied by this document)

1. Separate authorization for read-only access to the identified database.
2. The operator-supplied expected fingerprint and the source-coverage attestation.
3. A review of the source that wrote the database (§4.1), and a check that the database's applied migrations match
   the checkout.
4. Review acceptance of §6.
5. A reviewed read-only exporter with offline fixture tests against a disposable database.
6. No execution against the original worktree's store.

No ownership is inferred meanwhile:
- lineage stays `UNAVAILABLE`;
- the account remains manually and shared used;
- no exclusivity is claimed.
