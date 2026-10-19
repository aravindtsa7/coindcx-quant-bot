# M4 metadata comparison and prepared synthetic MySQL harness

19 October 2026. Starting checkout: `edca7aeac104f4ec296c648c9b792d3a798beae6`.
This records offline comparison and executable preparation. **No MySQL connection, provisioning, migration,
fixture write or real export was performed.** The attached console text is evidence supplied by the operator,
not instructions or authorization. No historical account inputs or real protected inventory were created.

## Historical metadata comparison (finished offline)

Input: `Pasted text(20261019-101715).txt`, exact file SHA-256
`8ef130ffe53bc25444a54499b2327159362f7e545a0d18bb798e5693adeb22c7`.
The supplied identity is KANI:3306, UUID `b6a4df59-954b-11f1-9408-f43bd84d24a1`, MySQL 8.0.46;
the query targets `p18b_practical_test_50272508801d`. This is not a fresh independent identity observation.

Expectations were generated from the actual checkout's `prisma/schema.prisma` scalar fields, `@map`/`@@map`,
native types, optionality and complete enum declarations. Relation fields are excluded. Full order/intent models
are required because the snapshot loads complete models; all scalar fields of the other six returned tables
were also compared, exceeding the snapshot's selected-column minimum. `_prisma_migrations` uses its eight
standard engine metadata fields rather than a Prisma application model.

| Table | Exact columns compared | Nullable columns | Missing / extra / type / nullability differences |
| --- | ---: | ---: | --- |
| live_execution_intent | 31 | 10 | none |
| live_order | 23 | 8 | none |
| live_position_ownership_share | 17 | 1 | none |
| live_practical_certificate | 13 | 2 | none |
| live_practical_mutation_lease | 15 | 6 | none |
| live_reconciliation_finding | 21 | 7 | none |
| live_reconciliation_state | 11 | 4 | none |
| _prisma_migrations | 8 | 3 | none |

All **139** column names, exact `COLUMN_TYPE` values and `IS_NULLABLE` values match, without duplicates.
This includes VARCHAR widths, signed/unsigned integers, tinyint(1), text/longtext and the entire ordered enum
value lists. All eleven DECIMAL columns are `decimal(36,18)` with precision 36 and scale 18. Every returned
DateTime column is `datetime(3)` with datetime precision 3. All eight tables are BASE TABLE / InnoDB with
`utf8mb4_unicode_ci` collation. This is metadata compatibility for these tables; it is not a 39-table schema proof.
Defaults, indexes, foreign keys, CHECK constraints, grants, row integrity, actual decimal transport and transaction
isolation have not been established by this comparison. No additional historical query is needed for its conclusion.

All fourteen expected migration names occur exactly once, with non-NULL `finished_at` and NULL `rolled_back_at`;
there are no extra or missing records. The exact hash bases are already enumerated in
[M4_LINEAGE_TARGET_READINESS.md](M4_LINEAGE_TARGET_READINESS.md#exact-migration-hash-bases):

| Migration directories in source order | Recorded checksum vs working-copy bytes | vs Git blob / reviewed LF pin |
| --- | --- | --- |
| First thirteen: `20260902000000_init` through `20260926000000_phase18b_practical_shadow_calibration` | all thirteen match | all thirteen differ |
| `20260927000000_phase18b_practical_mutation_safety` | differs | matches both |

The last recorded checksum is `02f9d0112f3a3287e1f7dae37afd326026e550f5aed21d143e6f4f6f69ea243b`.
The last working-copy SHA-256 is `b07eb64a823ac97c91c2483cd7b8e95a5f0fb1c3bba8a11aa82ed29a4112c4db`.
All fourteen working files have CRLF; Git blobs have LF and equal the pre-existing reviewed LF pins. Hashes were
computed separately from raw working buffers, `git show HEAD:<path>` buffers and existing freeze pins. The freeze
verifier's CRLF-to-LF conversion is only a source-freeze audit. Installed Prisma CLI/engines are 6.19.3; its JS
reader passes unmodified UTF-8 migration text to the engine. Native checksum lenience is not assumed.

**The unchanged launcher therefore refuses this historical candidate at migration preflight** if earlier
validations pass. No normalization fallback, migration rewrite or checksum repair is permitted. Its historical
provenance remains unverified independently of this checksum failure. A synthetic success cannot replace it.

## Prepared executable harness

`scripts/m4-synthetic-acceptance.ts` is the explicit composition root. Its real adapter is
`scripts/m4-synthetic-mysql.ts`; imports do no I/O, environment lookup or client creation. The existing disposable
URL/name guards are reused. It accepts only loopback MySQL, port 3306 and the exact identified server UUID/hostname.
It never discovers credentials or loads `.env`. Only explicitly supplied dedicated environment variables are read
after local validation. The generated Prisma env-discovery guard is reused before loading the client.

Executable dependency order:

1. Strict config and actual launcher input validation; exact SYNTHETIC account/fingerprint, NOT_ATTESTED coverage,
   clean reviewed HEAD, real version-2 protected inventory and fresh ignored output checks.
2. Server UUID/hostname/port and empty mandatory roles; check that the proposed schema and username at **every**
   host are absent. Refuse collisions. CREATE has no IF NOT EXISTS and never adopts an existing object.
3. Create only the proposed schema. Exclusively stage exact working-copy migration buffers, unchanged lock file
   and a minimal explicit Prisma datasource under the approved ignored parent. Record raw-byte, Git-blob and
   reviewed LF hash bases. Invoke installed Prisma migrate deploy in an isolated child and rehash the files.
   The child preload refuses env-file reads and Node HTTP/fetch; no inherited credential/debug/preload environment.
4. Only after successful migration, create the nonce-bearing ownership-marker table. Creating it before deploy
   would make an empty schema nonempty and can cause Prisma's unbaselined-schema refusal. Require the nine setup/
   snapshot tables as InnoDB before fixtures or table grants. The marker is separate from frozen migration files.
5. Create a new reader at localhost with a per-run random ownership attribute. Grant only SELECT on the eight
   exact snapshot/migration tables. There are no database-pattern grants (underscore wildcards), global, column,
   routine or dynamic privileges, grant option or role edges; metadata verifies that restriction.
6. Run the **actual launcher** with its snapshot constructor replaced by a deliberate stop. Identity/migration
   preflight must pass, the pipeline must stop before any account read and its owned client must close. A native
   migration checksum differing from exact working bytes stops here, before fixtures. No bypass is available.
7. Write one deterministic SYNTHETIC intent/order through existing `ensureIntent` (the repository seals the
   existing integrity hash), and synthetic reconciliation state/run. Status remains RECONCILIATION_REQUIRED.
8. Require an actual reader write denial (MySQL 1142, zero-row UPDATE), exact high-scale decimal roundtrip through
   the real repository, and rollback of a deliberate transaction failure. For the deterministic two-session test,
   pause after the first real order/intent consistent read in the repository's RepeatableRead transaction; a
   second connection commits generation 2 and a SYNTHETIC finding (using the existing finding builder/canonical
   identity hash), then the first transaction finishes. It must
   retain generation 1/no finding; a later snapshot must see generation 2/the finding. There is no sleep race.
9. Invoke the ordinary actual launcher with its new SELECT-only reader, then assert the existing diagnostic,
   package and verified readback: one exact-decimal ambiguous candidate/finding, NOT_ATTESTED coverage,
   statement-only certificate binding (no certificate fixtures), no ownership proof or engine input.
10. Close owned readers, check server identity plus the exact random user/schema markers, and drop only acknowledged
    resources created by this invocation. Independently close every owned client. Retain setup/package evidence.

Stages stop at the first failure; errors contain fixed stage/status values, no DB/CLI messages, URLs, passwords
or raw rows. The stage budget and SIGINT/SIGTERM are checked before each next operation. In-flight operations
settle before cleanup; the implementation never races a pending CREATE against DROP. Connections/pools have
5-second bounds, the migration child has a 60-second bound and the snapshot transaction has a 30-second bound.
The stage budget is **cooperative**, not a guarantee that a hung native/network operation terminates at that instant.
Forced termination can leave resources; do not claim cleanup succeeded.

Failure before the post-migration schema marker (including ambiguous CREATE acknowledgement or failed deploy)
means ownership cannot be reverified for DROP: leave it and return REQUIRES_REVIEW. The same applies to a missing
or replaced user/schema marker. A successful migration followed by normal later failure cleans verified owned
resources. There is no resume, account reset, existing-user alteration or cleanup of old local files/evidence.

## One future execution proposal — NOT EXECUTED

One invocation on the operator-observed KANI:3306, UUID `b6a4df59-954b-11f1-9408-f43bd84d24a1`, via an explicitly
authorized loopback connection. Proposed names were generated locally, **not checked or created on MySQL**:

- run ID: `c89436b01384`
- schema: `p18b_cancel_store_test_c89436b01384`
- reader: `m4_lineage_c89436b01384` at `localhost`
- setup evidence: `.local/m4-lineage-exports/synthetic-setup-c89436b01384`
- package: `.local/m4-lineage-exports/synthetic-c89436b01384`

Authorize only server/privilege/collision metadata reads, creation and unchanged migrations in this fresh schema,
the ownership marker and deterministic synthetic fixture/rollback/snapshot writes there, one new reader with the
eight exact-table SELECT grants, its schema-scoped reads, the zero-row denied write assertion, and cleanup of
verified resources created by this run. No existing account table is read or changed. No historical export,
provider access, runtime, gate/authority or operational-state mutation is included.

Use `deadlineMs: 240000` (four-minute stage budget), then owned cleanup; reserve one further minute for cleanup
review. At five minutes, report an overrun/in-flight operation and require operator review rather than launching
more work or issuing a competing DROP. Stop on identity/inventory/source/collision/byte/grant/preflight/fixture/
decimal/rollback/snapshot/package failure. Uncertain ownership or cleanup is a failure, never a successful run.

Required operator inputs, together:

1. Explicit authorization for exactly this fresh synthetic setup, validation and owned cleanup, and the five-minute
   operational window. The config literal below records scope; it does not itself authenticate authorization.
2. A reviewed clean final commit (after this harness commit), config and invocation JSON directly under the already
   approved `.local/m4-lineage-exports`, with absent proposed output/setup paths. No other editor during the run.
3. Genuine reviewed version-2 `protected-store-inventory.json`, its exact-byte SHA-256 and matching invocation list/
   plural review statement. Both built-in protected names remain excluded even if omitted; hashes do not establish
   inventory authenticity/exhaustiveness. This task has not fabricated an inventory or review statement.
4. Secure explicit `M4_SYNTHETIC_ADMIN_URL`: authorized loopback MySQL URL, explicit username/password and a
   non-target base schema (for example information_schema), port 3306, no query parameters. No automatic lookup,
   guessing or alternate credentials. It needs the scoped setup/cleanup and named privilege metadata access above.
5. Secure per-run `M4_SYNTHETIC_EXPORT_PASSWORD`: operator-generated 64 lowercase hex characters, never retained
   in JSON or stdout. Disable DEBUG/RUST_LOG/PRISMA_LOG_LEVEL. No URL/secret is placed in command arguments.
6. Review the checked-in SYNTHETIC fixture: account `SYNTHETIC-M4-LINEAGE`, fingerprint
   `c0f1b6a922c901c85f4b507ef2e8321ab00dd2894ed3c4214d6a04d823720b7a`, quantity
   `0.123456789012345678`, price `64000.000000000000000001`, leverage `3.000000000000000001`.
   These are synthetic-only assertions and no actual-provider evidence. No historical account input is needed here.

Config shape (the commit placeholder is intentionally invalid until supplied):

```json
{
  "kind": "SYNTHETIC_M4_MYSQL_ACCEPTANCE",
  "runId": "c89436b01384",
  "sourceCommit": "<reviewed clean final HEAD>",
  "host": "KANI",
  "port": 3306,
  "serverUuid": "b6a4df59-954b-11f1-9408-f43bd84d24a1",
  "deadlineMs": 240000,
  "invocationFile": "C:\\TSA\\coindcx-m2-w1\\.local\\m4-lineage-exports\\synthetic-invocation-c89436b01384.json",
  "authorization": "AUTHORIZE_FRESH_SYNTHETIC_SETUP_SELECT_EXPORT_AND_OWNED_CLEANUP"
}
```

The ordinary launcher JSON uses the exact §8 fields in
[M4_OWNERSHIP_LINEAGE_EXPORT_PLAN.md](M4_OWNERSHIP_LINEAGE_EXPORT_PLAN.md#8-explicit-operator-composition-offline-verified-real-execution-not-authorized-or-performed).
Use the proposed UUID/schema; both account fields and both fingerprint fields equal the explicitly synthetic
values above; coverage is NOT_ATTESTED; outputName is `synthetic-c89436b01384`; sourceCommit matches the config.
`databaseUrlEnvironmentVariable` stays `M4_LINEAGE_DATABASE_URL` for the launcher's existing input schema; the harness
injects the newly created reader URL directly, so that environment variable is not loaded or needed by this harness.

After all inputs and separate execution authorization, the prepared command from this checkout is:

```powershell
node --import tsx scripts/m4-synthetic-acceptance.ts --input C:\TSA\coindcx-m2-w1\.local\m4-lineage-exports\synthetic-config-c89436b01384.json
```

This command has **not** been run. Fake tests exercise orchestration, actual launcher composition and temporary
filesystem package/readback only. They do not demonstrate MySQL decimal, privileges, DDL, migration deployment,
rollback or snapshot isolation. A native checksum discrepancy in the fresh run remains a stop condition.

## Offline verification of this change

199 affected tests passed: existing launcher 118 (its pure input validator is now shared), new orchestration 37,
new adapter 6 with mocked Prisma/child processes, invocation boundary 4, export boundary 4, diagnostic boundary 4
and frozen migrations 26. Suites ran serially; the known parallel architecture timeout was not adjusted or claimed
resolved. The fake adapter tests exercise actual staging over synthetic files: raw CRLF bytes survive copying,
Git/LF bases stay distinct, no marker table precedes deploy, failed deploy cannot be marked/dropped, and changed
markers/server identity refuse cleanup. Fake success is labelled OFFLINE_FAKE_ORCHESTRATION in its result.

Final typecheck, full lint, explicit changed-script/test lint, child-preload syntax/lint and diff checks passed.
Full lint retains ten pre-existing no-explicit-any warnings in unchanged session-fault-recovery tests. No src,
Prisma schema/migration, freeze pin, existing disposable helper, old package or private evidence was changed.
Unchanged pipeline source-bound evidence was reused. The only launcher code change exposes/reuses its existing
pure input validator; target/inventory/migration comparison policy remains identical. Importer guards add exactly
the two explicit harness paths, without widening any src importer allowlist.

D1–D4, actual M4 lineage UNAVAILABLE, false authority grants, gates, authorityEligible, Invariant 28, AS1/D4c and
formal acceptance remain unchanged. The known parallel architecture timeout remains unresolved and unchanged.
