/** Real adapter for an explicitly authorized FUTURE synthetic run. No invocation or environment loading on import. */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient, Prisma } from '@prisma/client';
import { assertDisposableDatabaseName, assertLocalMysqlDatabaseUrl } from '../tests/helpers/p18b-disposable-mysql';
import { lineageEntry, nodeLineageDependencies, requireNoPrismaEnvDiscovery, type CheckoutFacts,
  type LineageEntryDependencies, type LineageInvocationResult } from './m4-lineage-export';
import { readLineageDiagnosticPackage } from '../src/execution/live/ownership-lineage-export';
import { syntheticLineageIntent, SYNTHETIC_ACCOUNT, SYNTHETIC_QUANTITY, SYNTHETIC_PRICE, SYNTHETIC_LEVERAGE } from '../tests/helpers/lineage-synthetic-fixture';
import type { SyntheticAcceptanceConfig, SyntheticAcceptanceDependencies, SyntheticMysqlPort, SyntheticResources } from './m4-synthetic-acceptance';

const TABLES = ['live_execution_intent', 'live_order', 'live_reconciliation_finding', 'live_practical_certificate',
  'live_position_ownership_share', 'live_reconciliation_state', 'live_practical_mutation_lease', '_prisma_migrations'];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function requireTrue(value: unknown): asserts value { if (!value) throw new Error('SYNTHETIC_ASSERTION_FAILED'); }
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => { requireTrue(Array.isArray(value)); return value as Row[]; };
const q = async (db: PrismaClient, sql: string, ...values: unknown[]) => rows(await db.$queryRawUnsafe(sql, ...values));

export async function readSyntheticConfig(root: string, file: string): Promise<unknown> {
  return nodeLineageDependencies(root).readInput(file);
}
export function syntheticNodeDependencies(root: string): SyntheticAcceptanceDependencies {
  return {
    evidence: 'MYSQL_EXECUTION', launcher: nodeLineageDependencies(root), now: () => performance.now(),
    readAdminUrl() {
      if (process.env['DEBUG'] || process.env['RUST_LOG'] || process.env['PRISMA_LOG_LEVEL']) throw new Error();
      return process.env['M4_SYNTHETIC_ADMIN_URL'];
    },
    readReaderPassword: () => process.env['M4_SYNTHETIC_EXPORT_PASSWORD'],
    createMysql: (config, resources, url, password) => createSyntheticMysql(root, config, resources, url, password),
  };
}

export async function createSyntheticMysql(root: string, config: SyntheticAcceptanceConfig, resource: SyntheticResources,
  adminUrl: string, password: string): Promise<SyntheticMysqlPort> {
  assertDisposableDatabaseName(resource.schema, assertLocalMysqlDatabaseUrl(adminUrl));
  requireTrue(/^[0-9a-f]{12}$/.test(resource.runId) && resource.schema === `p18b_cancel_store_test_${resource.runId}`
    && resource.user === `m4_lineage_${resource.runId}` && resource.userHost === 'localhost' && /^[0-9a-f]{64}$/.test(password));
  requireNoPrismaEnvDiscovery(await readFile(require.resolve('.prisma/client/index.js'), 'utf8'));
  const { PrismaClient: Client, Prisma: P } = await import('@prisma/client');
  const { PrismaLiveExecutionRepository } = await import('../src/execution/live/repository');
  const { buildFinding, findingSha256 } = await import('../src/execution/live/reconciliation/findings');
  const boundedAdminUrl = new URL(adminUrl);
  boundedAdminUrl.search = '?connection_limit=1&connect_timeout=5&pool_timeout=5';
  const admin = new Client({ datasourceUrl: boundedAdminUrl.toString(), log: [], errorFormat: 'minimal' });
  const clients: PrismaClient[] = [admin];
  const ownedReaders: { close(): Promise<void> }[] = [];
  const schema = resource.schema, user = resource.user, marker = `SYNTHETIC-${resource.runId}-${randomBytes(16).toString('hex')}`;
  let fixture: PrismaClient | undefined, writer: PrismaClient | undefined;
  let schemaAcknowledged = false, migrationsApplied = false, readerAcknowledged = false;
  let expectedDirectory = '';
  const local = nodeLineageDependencies(root);
  const dbUrl = (username?: string) => {
    const url = new URL(adminUrl); url.pathname = `/${schema}`; url.search = '';
    url.searchParams.set('connection_limit', '1'); url.searchParams.set('connect_timeout', '5'); url.searchParams.set('pool_timeout', '5');
    if (username) { url.username = username; url.password = password; }
    return url.toString();
  };
  const identity = async () => {
    const r = (await q(admin, 'SELECT @@hostname AS host, @@port AS port, @@server_uuid AS serverUuid, @@mandatory_roles AS mandatoryRoles'));
    requireTrue(r.length === 1);
    return { host: String(r[0]!['host']), port: Number(r[0]!['port']), serverUuid: String(r[0]!['serverUuid']), mandatoryRoles: String(r[0]!['mandatoryRoles']) };
  };
  const requireServer = async () => {
    const r = await identity(); requireTrue(r.host === config.host && r.port === config.port && r.serverUuid === config.serverUuid);
  };
  const requireMarker = async () => {
    requireTrue(schemaAcknowledged && migrationsApplied);
    await requireServer();
    const r = await q(admin, `SELECT token FROM \`${schema}\`.m4_synthetic_ownership`);
    requireTrue(r.length === 1 && r[0]!['token'] === marker);
  };
  const requireReaderMarker = async () => {
    requireTrue(readerAcknowledged);
    await requireServer();
    const attributes = await q(admin, "SELECT JSON_UNQUOTE(JSON_EXTRACT(ATTRIBUTE, '$.m4_synthetic_run')) AS marker FROM information_schema.USER_ATTRIBUTES WHERE USER = ? AND HOST = ?", user, 'localhost');
    requireTrue(attributes.length === 1 && attributes[0]!['marker'] === marker);
  };
  const requireFixture = () => { requireTrue(fixture); return fixture; };
  const repository = () => new PrismaLiveExecutionRepository(requireFixture());
  const freshClient = () => {
    const db = new Client({ datasourceUrl: dbUrl(), log: [], errorFormat: 'minimal' }); clients.push(db); return db;
  };
  const launcherDependencies = (): LineageEntryDependencies => ({
    ...local, readDatabaseUrl: () => dbUrl(user),
    async createOwnedDatabase(url) {
      const owned = await local.createOwnedDatabase(url); ownedReaders.push(owned); return owned;
    },
    async validateOutput(name) { const directory = await local.validateOutput(name); expectedDirectory = directory; return directory; },
  });
  return {
    identity,
    async assertAbsent() {
      requireTrue((await q(admin, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', schema)).length === 0);
      // Any host variant collides; never adopt or alter an existing account.
      requireTrue((await q(admin, 'SELECT User FROM mysql.user WHERE User = ?', user)).length === 0);
    },
    async createSchema() { await requireServer(); await admin.$executeRawUnsafe(`CREATE DATABASE \`${schema}\``); schemaAcknowledged = true; },
    async markSchema() {
      await requireServer(); requireTrue(schemaAcknowledged && migrationsApplied);
      await admin.$executeRawUnsafe(`CREATE TABLE \`${schema}\`.m4_synthetic_ownership (token VARCHAR(64) NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
      await admin.$executeRawUnsafe(`INSERT INTO \`${schema}\`.m4_synthetic_ownership (token) VALUES (?)`, marker);
      await requireMarker();
    },
    async migrateExactBytes(checkout: CheckoutFacts) {
      // Prisma refuses a nonempty unbaselined schema: the marker table is created only AFTER successful deploy.
      // Before that, any failure leaves the schema unmarked and cleanup refuses DROP (requires operator review).
      await requireServer(); requireTrue(schemaAcknowledged);
      const stage = await local.validateOutput(`synthetic-setup-${resource.runId}`);
      await mkdir(stage, { mode: 0o700 }); // Exclusive; no resume, no existing directory adoption.
      const migrations = path.join(stage, 'migrations'); await mkdir(migrations, { mode: 0o700 });
      const freeze = await readFile(path.join(root, 'tests/architecture/phase18-migration-freeze.test.ts'), 'utf8');
      const pins = new Map([...freeze.matchAll(/'([0-9]{14}_[a-z0-9_]+)': '([0-9a-f]{64})'/g)].map(m => [m[1]!, m[2]!]));
      requireTrue(checkout.migrations.length === pins.size);
      const bases: { name: string; workingCopySha256: string; gitBlobSha256: string; reviewedLfSha256: string }[] = [];
      for (const entry of checkout.migrations) {
        const bytes = await readFile(path.join(root, 'prisma/migrations', entry.name, 'migration.sql'));
        requireTrue(sha(bytes) === entry.checksum && sha(bytes.toString('utf8').replace(/\r\n/g, '\n')) === pins.get(entry.name));
        const blob = execFileSync('git', ['show', `${checkout.sourceCommit}:prisma/migrations/${entry.name}/migration.sql`], { cwd: root, stdio: 'pipe', timeout: 5000 });
        requireTrue(sha(blob) === pins.get(entry.name));
        bases.push({ name: entry.name, workingCopySha256: entry.checksum, gitBlobSha256: sha(blob), reviewedLfSha256: pins.get(entry.name)! });
        await mkdir(path.join(migrations, entry.name), { mode: 0o700 });
        const file = path.join(migrations, entry.name, 'migration.sql');
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); requireTrue(sha(await readFile(file)) === entry.checksum);
      }
      const lock = await readFile(path.join(root, 'prisma/migrations/migration_lock.toml'));
      requireTrue(sha(lock) === checkout.lockSha256);
      await writeFile(path.join(migrations, 'migration_lock.toml'), lock, { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(stage, 'schema.prisma'), 'datasource db {\n provider = "mysql"\n url = env("M4_SYNTHETIC_SETUP_URL")\n}\n', { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(stage, 'SYNTHETIC-MIGRATION-BYTES.json'), JSON.stringify({ kind: 'SYNTHETIC_SOURCE_BYTES',
        checksumBasis: 'SHA256_WORKING_COPY_BYTES', checkout, bases }, null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(stage, 'SYNTHETIC-OWNERSHIP.json'), JSON.stringify({ ...resource, marker, serverUuid: config.serverUuid }), { flag: 'wx', mode: 0o600 });
      // Isolated cwd, explicit schema/env, no inherited credential/debug/preload environment. Guard denies env-file reads/HTTP.
      execFileSync(process.execPath, ['--require', path.join(root, 'scripts/m4-synthetic-cli-guard.cjs'),
        require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', path.join(stage, 'schema.prisma')], {
        cwd: stage, stdio: 'pipe', timeout: 60000,
        env: { SystemRoot: process.env['SystemRoot'], PATH: process.env['PATH'],
          M4_SYNTHETIC_SETUP_URL: dbUrl(), PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      });
      for (const entry of checkout.migrations) {
        requireTrue(sha(await readFile(path.join(migrations, entry.name, 'migration.sql'))) === entry.checksum);
        requireTrue(sha(await readFile(path.join(root, 'prisma/migrations', entry.name, 'migration.sql'))) === entry.checksum);
      }
      migrationsApplied = true; fixture = freshClient(); writer = freshClient();
    },
    async requireTables() {
      await requireMarker();
      const metadata = await q(admin, 'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', schema);
      for (const name of [...TABLES, 'live_reconciliation_run']) requireTrue(metadata.some(r => r['name'] === name && r['type'] === 'BASE TABLE' && r['engine'] === 'InnoDB'));
    },
    async seedFixtures() {
      await requireMarker(); const db = requireFixture();
      // The existing repository writes and verifies the intent content hash; no local hash implementation.
      const intent = syntheticLineageIntent(); await repository().ensureIntent(intent);
      await db.$transaction(async tx => {
        await tx.liveOrder.update({ where: { intentId: intent.intentId }, data: { state: 'SUBMISSION_AMBIGUOUS', revision: 1 } });
        await tx.liveReconciliationState.create({ data: { accountId: SYNTHETIC_ACCOUNT, currentGeneration: 1, currentRunId: 'SYNTHETIC-run-1' } });
        await tx.liveReconciliationRun.create({ data: { runId: 'SYNTHETIC-run-1', accountId: SYNTHETIC_ACCOUNT, generation: 1,
          runtimeEpoch: 'SYNTHETIC-epoch', snapshotStartedAtMs: 1000n } });
      });
    },
    async checkDecimalRollbackAndSnapshot() {
      await requireMarker(); const db = requireFixture(); requireTrue(writer);
      // A zero-row write must be denied for the newly created reader; a network/auth failure is not a denial proof.
      const restricted = new Client({ datasourceUrl: dbUrl(user), log: [], errorFormat: 'minimal' }); clients.push(restricted);
      let writeDenied = false;
      try { await restricted.$executeRawUnsafe('UPDATE live_order SET revision = revision WHERE 1 = 0'); }
      catch (error) {
        const e = error as { code?: unknown; meta?: { code?: unknown } };
        writeDenied = e?.code === 'P2010' && String(e.meta?.code) === '1142';
      }
      requireTrue(writeDenied); await restricted.$disconnect();
      const first = await repository().readLineageDiagnosticSnapshot(SYNTHETIC_ACCOUNT);
      requireTrue(first.orders.length === 1 && first.orders[0]!.orderedQuantity === SYNTHETIC_QUANTITY
        && first.orders[0]!.price === SYNTHETIC_PRICE && first.orders[0]!.leverage === SYNTHETIC_LEVERAGE);
      const rollback = new Error('SYNTHETIC_ROLLBACK');
      let observedRollback = false;
      try { await db.$transaction(async tx => {
        await tx.liveReconciliationState.update({ where: { accountId: SYNTHETIC_ACCOUNT }, data: { currentGeneration: 999 } }); throw rollback;
      }); } catch (error) { requireTrue(error === rollback); observedRollback = true; }
      requireTrue(observedRollback && (await db.liveReconciliationState.findUniqueOrThrow({ where: { accountId: SYNTHETIC_ACCOUNT } })).currentGeneration === 1);
      let committed = false;
      // Same reviewed two-session seam as the existing consistent-listing integration suite: writer commits AFTER
      // the first real consistent read and BEFORE the repository's remaining reads. No sleeps/timing guesses.
      const paused = new Proxy(db, { get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { isolationLevel?: string; timeout?: number }) => {
          requireTrue(options.isolationLevel === P.TransactionIsolationLevel.RepeatableRead);
          return target.$transaction(async tx => callback(new Proxy(tx, { get(transaction, property) {
            if (property !== 'liveOrder') return Reflect.get(transaction, property);
            return new Proxy(transaction.liveOrder, { get(delegate, operation) {
              if (operation !== 'findMany') return Reflect.get(delegate, operation);
              return async (args: Prisma.LiveOrderFindManyArgs) => {
                const result = await delegate.findMany(args); requireTrue(!committed);
                const finding = buildFinding({ category: 'AMBIGUOUS', code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
                  subject: { intentId: syntheticLineageIntent().intentId }, evidence: { kind: 'SYNTHETIC' } });
                await writer!.$transaction(async other => {
                  await other.liveReconciliationRun.create({ data: { runId: 'SYNTHETIC-run-2', accountId: SYNTHETIC_ACCOUNT,
                    generation: 2, runtimeEpoch: 'SYNTHETIC-epoch', snapshotStartedAtMs: 2000n } });
                  await other.liveReconciliationState.update({ where: { accountId: SYNTHETIC_ACCOUNT }, data: { currentGeneration: 2, currentRunId: 'SYNTHETIC-run-2' } });
                  await other.liveReconciliationFinding.create({ data: { findingId: 'SYNTHETIC-finding', accountId: SYNTHETIC_ACCOUNT,
                    findingSha256: findingSha256(SYNTHETIC_ACCOUNT, finding), category: finding.category, code: finding.code,
                    ...finding.subject, evidenceJson: JSON.stringify(finding.evidence), firstSeenRunId: 'SYNTHETIC-run-2',
                    firstSeenGeneration: 2, lastSeenGeneration: 2, firstSeenAtMs: 2000n, lastSeenAtMs: 2000n } });
                });
                committed = true; return result;
              };
            } });
          } })), { isolationLevel: P.TransactionIsolationLevel.RepeatableRead, timeout: 30000 });
        };
      } });
      const during = await new PrismaLiveExecutionRepository(paused).readLineageDiagnosticSnapshot(SYNTHETIC_ACCOUNT);
      const after = await repository().readLineageDiagnosticSnapshot(SYNTHETIC_ACCOUNT);
      requireTrue(committed && during.reconciliationState?.currentGeneration === 1 && during.findings.length === 0
        && after.reconciliationState?.currentGeneration === 2 && after.findings.length === 1);
    },
    async createReader() {
      await requireMarker();
      // Names/password are constrained before this factory; no existing account is adopted, ALTERed or reset.
      await admin.$executeRawUnsafe(`CREATE USER '${user}'@'localhost' IDENTIFIED BY '${password}' ATTRIBUTE '{"m4_synthetic_run":"${marker}"}'`);
      readerAcknowledged = true;
    },
    async grantAndVerifySelectOnly() {
      await requireMarker(); await requireReaderMarker();
      // Exact table grants avoid database-pattern wildcard semantics for underscores in schema names.
      for (const table of TABLES) await admin.$executeRawUnsafe(`GRANT SELECT ON \`${schema}\`.\`${table}\` TO '${user}'@'localhost'`);
      const grantee = `'${user}'@'localhost'`;
      const global = await q(admin, 'SELECT PRIVILEGE_TYPE AS privilege FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?', grantee);
      requireTrue(global.every(r => r['privilege'] === 'USAGE'));
      requireTrue((await q(admin, 'SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ?', grantee)).length === 0);
      const grants = await q(admin, 'SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ?', grantee);
      requireTrue(grants.length === TABLES.length && TABLES.every(table => grants.some(r => r['db'] === schema && r['name'] === table && r['privilege'] === 'SELECT' && r['grantable'] === 'NO')));
      requireTrue((await q(admin, 'SELECT COLUMN_NAME FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ?', grantee)).length === 0);
      requireTrue((await q(admin, 'SELECT FROM_USER FROM mysql.role_edges WHERE TO_USER = ? AND TO_HOST = ?', user, 'localhost')).length === 0);
      requireTrue((await q(admin, 'SELECT PRIV FROM mysql.global_grants WHERE USER = ? AND HOST = ?', user, 'localhost')).length === 0);
      requireTrue((await q(admin, 'SELECT Routine_name FROM mysql.procs_priv WHERE User = ? AND Host = ?', user, 'localhost')).length === 0);
    },
    async checkLauncherMetadataPreflight() {
      const dependencies = launcherDependencies();
      const result = await lineageEntry(['--input', config.invocationFile], { ...dependencies,
        async createOwnedDatabase(url) {
          const owned = await dependencies.createOwnedDatabase(url);
          return { ...owned, snapshots() { throw new Error('SYNTHETIC_PREFLIGHT_STOP_BEFORE_ACCOUNT_READS'); } };
        },
      });
      requireTrue(result.preflight === 'MATCHED_TARGET_AND_MIGRATIONS_EXCLUDED_OPERATOR_INVENTORY'
        && result.failure === 'PIPELINE_FAILED' && result.export === null && result.cleanup === 'CLOSED');
    },
    launcherDependencies,
    async assertPackage(result: LineageInvocationResult) {
      requireTrue(result.kind === 'COMPLETED' && result.cleanup === 'CLOSED' && result.export?.kind === 'EXPORTED');
      requireTrue(result.export.directory === expectedDirectory);
      const readback = await readLineageDiagnosticPackage(expectedDirectory); requireTrue(readback.kind === 'VERIFIED');
      const d = readback.diagnostic, entry = d.ambiguousCreateCandidates.entries[0];
      requireTrue(d.accountId === SYNTHETIC_ACCOUNT && d.ownershipProof === 'NONE' && d.engineInput === 'NOT_PERMITTED'
        && d.ambiguousCreateCandidates.entries.length === 1 && entry?.orderedQuantity === SYNTHETIC_QUANTITY
        && entry.price === SYNTHETIC_PRICE && entry.leverage === SYNTHETIC_LEVERAGE
        && entry.findingCodes.includes('RECON_AMBIGUOUS_CREATE_UNRESOLVED')
        && d.provenance.checkedOnSuppliedRows.certificateBinding === 'NO_CERTIFICATE_ROWS_STATEMENT_ONLY'
        && d.provenance.callerStatements.sourceCoverage === 'NOT_ATTESTED');
    },
    async dropOwnedReader() {
      for (const reader of ownedReaders.splice(0)) await reader.close();
      await requireReaderMarker();
      await admin.$executeRawUnsafe(`DROP USER '${user}'@'localhost'`);
    },
    async dropOwnedSchema() { await requireMarker(); await admin.$executeRawUnsafe(`DROP DATABASE \`${schema}\``); },
    async close() {
      const results = await Promise.allSettled(clients.map(client => client.$disconnect()));
      requireTrue(results.every(result => result.status === 'fulfilled'));
    },
  };
}
