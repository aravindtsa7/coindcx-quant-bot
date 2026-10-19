# M4 lineage target readiness and checksum bases

Update after operator metadata was supplied: the completed offline comparison and the prepared executable
synthetic harness are recorded in [M4_SYNTHETIC_MYSQL_ACCEPTANCE.md](M4_SYNTHETIC_MYSQL_ACCEPTANCE.md).
The original readiness/verification record below is retained as its earlier source-bound checkpoint. Its
"no candidate migration results" and unprepared synthetic-execution status are superseded by that update;
its raw-byte comparison policy and hash bases remain unchanged. No real DB action has been performed.

Offline source inspection only, 19 October 2026. Starting source: `8a353c260737ff5ce50ac22f1e3cc3f7b47b216b`.
No real inventory or operator review statement has been created. No DB connection/query, credential/env-file read,
provider call, launcher execution or producing-runtime operation occurred. Frozen migrations and old evidence are unchanged.

## Protected identities and candidate status

The source minimum denylist is `coindcx_shadow` and `coindcx_quant`, as recorded by
`tests/helpers/p18b-disposable-mysql.ts`. Version 2 of the invocation/inventory validates a nonempty collection;
all entries are checked before URL lookup or client creation. Both known schema names are refused even if omitted
from a valid but incomplete operator list. Operator-listed names are also refused case-insensitively across servers.
Target verification still compares the exact UUID/schema pair. Sharing the server UUID with a protected schema is
permitted for an unrelated target schema. Hash/shape validation is not issuer authenticity or historical exhaustiveness.

Historical candidate: `p18b_practical_test_50272508801d`. The operator observed KANI:3306,
UUID `b6a4df59-954b-11f1-9408-f43bd84d24a1`, MySQL 8.0.46 and 39 tables. These are operator observations,
not agent-verified DB results. `live-practical-persistence.integration.test.ts` generates the matching name pattern,
applies migrations, uses fake account fixtures and attempts cleanup. That does not identify this exact instance's
creation/run/source history or establish that it has remained exclusively synthetic. No reviewed instance-specific
provenance was found in the non-secret source/records inspected. Do not select a different schema merely by name/count.

## Exact migration hash bases

Expectations below were generated from actual local source files and Git blobs, not copied from DB records.
All fourteen working-copy migration files are CRLF; their HEAD Git blobs are LF (`git ls-files --eol`).
Every Git blob SHA-256 below equals the corresponding existing reviewed LF pin in
`tests/architecture/phase18-migration-freeze.test.ts`, and SHA-256 of working-copy UTF-8 text with CRLF replaced by
LF also equals that pin. The table's final column represents two independently compared, equal bases: raw Git blob
bytes and the pre-existing reviewed LF baseline. The working-copy column hashes unmodified file bytes.

The launcher `readLineageCheckout` hashes working-copy buffers and `migrationsMatch` requires exact recorded
checksum equality with those hashes, exactly one finished/non-rolled-back row per directory and no extras.
No LF-normalized fallback has been added. An LF-only match must be reported as such and remains a launcher refusal;
never edit frozen files, change checkout line endings, repair DB checksums or redefine acceptance to force success.

Installed Prisma CLI and engines package version: **6.19.3** (package metadata read only; no CLI/engine executed).
Inspection of installed `prisma/build/index.js` shows `sc` reads migration SQL as UTF-8 and passes the unmodified
text in `migrationsList` to the engine's `applyMigrations`/`diagnoseMigrationHistory`. That JS path does not
normalize SQL newlines. The engine's internal checksum lenience was not established by inspecting the compiled
engine and must not be assumed to override the launcher's explicit byte comparison.
The existing freeze verifier explicitly normalizes CRLF to LF **for source-freeze checking**; it is not DB migration
compatibility evidence. The existing Phase17/18 parity scripts delegate deploy/diff to Prisma against a newly created
DB and perform cleanup; they are not pure checksum comparators and were not executed under this task's boundaries.

| Migration directory | Working-copy SHA-256 (CRLF bytes) | Git blob SHA-256 = existing reviewed LF baseline |
| --- | --- | --- |
| 20260902000000_init | `a01f7d66584c0b4966544d9b05233cadafac08fe22c755d1f0fa2f2feadfbd4a` | `26fd8a8cf22c190760f1aa7a7dc2b030d21410ab4ce6fec81ee5dc09459fc4dc` |
| 20260904000000_add_candles_1m | `efe7e1f96cf2fd7384119a6755dbed12d4f003e1b7942ed49d79bf81d3d041dd` | `ae1ee1185245abd0f1a3006a4b1a7d41b7f1b8f9d05f67ecb512baeaa2317fe6` |
| 20260906000000_add_historical_datasets | `0b13f36301756c86210854bdf624fe8ec8a2c5d31b1017ebd5c354868728d443` | `9008c92cb1ab8886dcec27d20bd85f9de455a6b3c7fbf5a0db2911be3cffdd1f` |
| 20260910050818_phase14_paper_persistence | `151003e2aa493cde3b76cfb180ca1173fef11a20e4ee05208e65aa120ff34130` | `d8b423d4d63592c11a5778a50e33456d3efe34cba53079e82459f81b79ba9dd9` |
| 20260915000000_phase14_wave3b_instrument_economics | `0de81a2a98653b991b0f30c0c69ace45f79e02d110fff10e7d5cf0a2d6a1ec27` | `f419314d7bd3483187d1097f5d29b001d389a67860241e544a1b0b28c02694fb` |
| 20260916000000_phase14_account_mutation_order | `030e539e20e9b5181604b325e8be1f4c214abd8df646dab359f5313569b92847` | `8dbf905a01983a65944a37b6a036efb276f24ed9b55d46b813157c6bb445a522` |
| 20260916120000_phase15_strategy_ranking | `130806f9c85e8ed9947d3a500016c0f968b8a07fe0aab0ad4940c14259f69b7a` | `9f7a6d9e0a0f0ff592da74ace98e0e300778182747b790caca0b553f7fe77b6b` |
| 20260920000000_phase17_live_execution | `3cb04da0c52b802eb9e666b5280be43a6c0e4db913e6d2b2cd53a1dc88838182` | `3a1e8e4669921b4e0928f03270dea4e6479a67f3a3dca5c49dcb96493c7ebc22` |
| 20260921000000_phase18_reconciliation | `d99999b6f8b9b192dd024689e08aa454e727281d966e14559468b0f30443f99a` | `159d60b2314532a285e942b260300468285be19083166e2a123b6cf73761c0ab` |
| 20260921010000_phase18_wave_a2_crash_recovery | `5cee32a89d8526d345df7666736e92deec1c98c7f8400a50fa22bef8c6d6b4d0` | `8387511487309150f7df64ee7bc822677c2774c695cb3d35d03dee2209a0c50a` |
| 20260922000000_phase18_wave_c1_orphan_resolution | `ac6517c4047db43027ca1391a622bdbca4597ce12c53fa8b375444fd04c0cfbf` | `14272259dc91d1a1c63325f47bf073b75e6a85583f3907de3c11b935e86cebf7` |
| 20260925000000_phase18b_practical_persistence | `6507960a40121aa29345ab5340d6f09d291554774d8a92c72c89159af96e7296` | `734e3d01758667cf652c1a57745fc3c2bca9476599459b820f752a20eb054f99` |
| 20260926000000_phase18b_practical_shadow_calibration | `4342c6208adee80835da450f4f0fc8d5a627019ad40853cfeb579d7ec7136f5d` | `6cf2095f5d05be54c248fe43e113e67156af9f783ce4fb21948722fcaa6811e9` |
| 20260927000000_phase18b_practical_mutation_safety | `b07eb64a823ac97c91c2483cd7b8e95a5f0fb1c3bba8a11aa82ed29a4112c4db` | `02f9d0112f3a3287e1f7dae37afd326026e550f5aed21d143e6f4f6f69ea243b` |

The lock-file hash remains checkout provenance, not an applied migration. No candidate migration results have been
returned, so there is no verified DB/working-copy/Git/LF match yet.

## One operator metadata batch (not executed)

Use an already authorized connection to KANI. Confirm the first result matches the identified UUID/port. This batch
reads only server identity, metadata for the seven tables reached by the snapshot (including conditional practical
cancel bindings), the migration table's metadata and its four allowlisted record fields. It reads no account rows,
migration logs or credentials. Missing metadata may mean missing privileges; it is not proof of table absence.

```sql
SELECT @@hostname AS host, @@port AS port, @@server_uuid AS server_uuid, VERSION() AS version;

SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'p18b_practical_test_50272508801d'
  AND TABLE_NAME IN ('live_execution_intent','live_order','live_reconciliation_finding',
    'live_practical_certificate','live_position_ownership_share','live_reconciliation_state',
    'live_practical_mutation_lease','_prisma_migrations')
  AND @@server_uuid = 'b6a4df59-954b-11f1-9408-f43bd84d24a1' AND @@port = 3306
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
       COLUMN_DEFAULT, COLLATION_NAME, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'p18b_practical_test_50272508801d'
  AND TABLE_NAME IN ('live_execution_intent','live_order','live_reconciliation_finding',
    'live_practical_certificate','live_position_ownership_share','live_reconciliation_state',
    'live_practical_mutation_lease','_prisma_migrations')
  AND @@server_uuid = 'b6a4df59-954b-11f1-9408-f43bd84d24a1' AND @@port = 3306
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT migration_name, checksum, finished_at, rolled_back_at
FROM p18b_practical_test_50272508801d._prisma_migrations
WHERE @@server_uuid = 'b6a4df59-954b-11f1-9408-f43bd84d24a1' AND @@port = 3306
ORDER BY migration_name, finished_at, rolled_back_at, checksum;
```

When returned, compare these results offline against source-generated expectations: exact directory-name sets and
raw-byte checksums from the migration files (report Git/LF comparisons separately); completion/rollback/duplicate
status; required base tables with InnoDB engines; and columns/types/nullability from the actual Prisma models and
snapshot read selections in `live/repository.ts`. Include all scalar order/intent columns because the repository
fetches complete models, plus the eight selected/filtered practical lease fields. Do not substitute a table count,
freeze-test pass or a plausible schema name for this comparison. No hand-maintained hash CTE is needed in SQL.

## Separate future activities (not authorized or executed)

**A. Fresh controlled synthetic MySQL validation.** The minimum alternative is a new operator-chosen schema with
reviewed creation/run/source provenance on an independently identified server, frozen migrations applied through an
explicitly authorized provisioning step, and only reviewed deterministic synthetic account/intent/certificate fixtures.
Use a SELECT-only connection for subsequent validation. Any creation, fixture writes, migration execution or required
principal/grant provisioning needs separate explicit authorization; no such setup is part of this task. An operator
must also supply the reviewed version-2 protected inventory, explicit target, fresh output and source commit. Keep
fixture identities, fingerprints, account labels and all retained validation/package context explicitly SYNTHETIC.
A fixture fingerprint is legitimate here and establishes no fact about the historical account. Setup/fixture writers
must be quiescent during the controlled snapshot. The existing external 120-second invocation bound, connection/pool
bounds and 30-second snapshot transaction apply only after authorization. A cleanup/drop is a separate authorized
activity; no automatic cleanup is proposed here.

**B. Historical-candidate diagnostic export.** Historical provenance remains a blocker. In addition to metadata
compatibility, obtain the exact candidate's creator/test-run/source record, current usage/retention confirmation,
reviewed protected-store bindings, actual account/campaign labels and fingerprint statements, explicit coverage choice,
SELECT-only connection and separate export authorization. Do not replace missing historical inputs with synthetic
fixtures or call a synthetic result real-account evidence. Neither A nor B resolves M4 lineage or ownership.

D1–D4, actual lineage UNAVAILABLE, false grants, gates, authorityEligible, Invariant 28, AS1/D4c and formal M3/M4
acceptance remain unchanged. The known architecture timing limitation is not addressed; no timeout setting changed.

## Offline verification of the inventory fix

118 invocation unit cases passed using fake DB dependencies/mocked Prisma and synthetic temporary filesystem data.
They include both built-in names and case variants across UUIDs; protection and malformed entries in all list
positions; missing/legacy/unsupported/empty/duplicate formats; exact file/list binding including reordered entries;
multiple protections sharing a UUID; an unrelated candidate on that UUID; foreign observed UUID/schema;
refusals before account reads/package creation; import behavior, safe errors and owned cleanup. Synthetic fixture
fingerprints continue to pass in the explicit synthetic success cases. An LF-only migration checksum is explicitly
refused when it differs from the working-copy byte checksum.

The four applicable architecture suites passed separately: invocation (3), exporter (4), diagnostic (4), migration
freeze (26), **37 tests**. Final typecheck passed. Full lint passed with the same ten pre-existing no-explicit-any
warnings in unchanged session-fault-recovery tests; explicit ESLint on the changed launcher/tests had no warnings
or errors. Focused final source review and diff checks passed. No src/pipeline source, migration, existing freeze
pin, original launcher, protected helper, runtime or old evidence was changed; unchanged pipeline evidence was reused.
No real inventory or DB output was generated. Historical provenance/compatibility and future authorizations remain pending.
