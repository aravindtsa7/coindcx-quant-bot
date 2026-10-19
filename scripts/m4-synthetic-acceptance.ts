/** Explicit, opt-in synthetic MySQL acceptance. Importing performs no I/O, credential lookup or client construction. */
import path from 'node:path';
import { z } from 'zod';
import { assertDisposableDatabaseName, assertLocalMysqlDatabaseUrl } from '../tests/helpers/p18b-disposable-mysql';
import { SYNTHETIC_ACCOUNT, SYNTHETIC_FINGERPRINT } from '../tests/helpers/lineage-synthetic-fixture';
import { lineageEntry, validateLineageInvocation, type LineageEntryDependencies, type CheckoutFacts,
  type LineageInvocation, type LineageInvocationResult } from './m4-lineage-export';

const configSchema = z.object({
  kind: z.literal('SYNTHETIC_M4_MYSQL_ACCEPTANCE'),
  runId: z.string().regex(/^[0-9a-f]{12}$/), sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  serverUuid: z.literal('b6a4df59-954b-11f1-9408-f43bd84d24a1'),
  host: z.literal('KANI'), port: z.literal(3306), deadlineMs: z.number().int().min(60000).max(300000),
  invocationFile: z.string().refine(path.isAbsolute),
  authorization: z.literal('AUTHORIZE_FRESH_SYNTHETIC_SETUP_SELECT_EXPORT_AND_OWNED_CLEANUP'),
}).strict();
export type SyntheticAcceptanceConfig = z.infer<typeof configSchema>;
export interface SyntheticResources { readonly schema: string; readonly user: string; readonly userHost: 'localhost'; readonly runId: string }
export interface SyntheticMysqlPort {
  identity(): Promise<Readonly<{ host: string; port: number; serverUuid: string; mandatoryRoles: string }>>;
  assertAbsent(): Promise<void>;
  createSchema(): Promise<void>;
  markSchema(): Promise<void>;
  migrateExactBytes(checkout: CheckoutFacts): Promise<void>;
  requireTables(): Promise<void>;
  seedFixtures(): Promise<void>;
  checkDecimalRollbackAndSnapshot(): Promise<void>;
  createReader(): Promise<void>;
  grantAndVerifySelectOnly(): Promise<void>;
  checkLauncherMetadataPreflight(): Promise<void>;
  launcherDependencies(): LineageEntryDependencies;
  assertPackage(result: LineageInvocationResult): Promise<void>;
  dropOwnedReader(): Promise<void>;
  dropOwnedSchema(): Promise<void>;
  close(): Promise<void>;
}
export interface SyntheticAcceptanceDependencies {
  readonly evidence: 'OFFLINE_FAKE_ORCHESTRATION' | 'MYSQL_EXECUTION';
  readonly launcher: LineageEntryDependencies;
  now(): number;
  stopRequested?(): boolean;
  readAdminUrl(): string | undefined;
  readReaderPassword(): string | undefined;
  createMysql(config: SyntheticAcceptanceConfig, resources: SyntheticResources, url: string, password: string): Promise<SyntheticMysqlPort>;
}
export interface SyntheticAcceptanceResult {
  readonly evidence: SyntheticAcceptanceDependencies['evidence'];
  readonly kind: 'SYNTHETIC_ACCEPTANCE_PASSED' | 'SYNTHETIC_ACCEPTANCE_FAILED';
  readonly stage: string;
  readonly cleanup: 'NOT_CREATED' | 'CLOSED' | 'REQUIRES_REVIEW';
  readonly checks: readonly string[];
  readonly resources: SyntheticResources | null;
  readonly launcher: LineageInvocationResult | null;
}
export function syntheticResourceNames(runId: string): SyntheticResources {
  if (!/^[0-9a-f]{12}$/.test(runId)) throw new Error('SYNTHETIC_RUN_ID_INVALID');
  return Object.freeze({ schema: `p18b_cancel_store_test_${runId}`, user: `m4_lineage_${runId}`, userHost: 'localhost', runId });
}

/** Stage order is executable. No timeout race abandons an in-flight create and then destroys its resources. */
export async function runSyntheticAcceptance(raw: unknown, deps: SyntheticAcceptanceDependencies): Promise<SyntheticAcceptanceResult> {
  let stage = 'INPUT_INVALID', port: SyntheticMysqlPort | undefined, resources: SyntheticResources | null = null;
  let schemaCreated = false, readerCreated = false, cleanup: SyntheticAcceptanceResult['cleanup'] = 'NOT_CREATED';
  let launcher: LineageInvocationResult | null = null;
  const checks: string[] = [];
  try {
    const config = configSchema.parse(raw), started = deps.now();
    resources = syntheticResourceNames(config.runId);
    const step = async (name: string, action: () => Promise<void>) => {
      stage = name;
      if (deps.stopRequested?.() || deps.now() - started >= config.deadlineMs) throw new Error();
      await action(); checks.push(name);
    };
    stage = 'SYNTHETIC_INVOCATION_INVALID';
    const parsed = validateLineageInvocation(await deps.launcher.readInput(config.invocationFile));
    if (!parsed.success) throw new Error();
    const invocation: LineageInvocation = parsed.data;
    if (invocation.accountId !== SYNTHETIC_ACCOUNT || invocation.campaignAccountId !== SYNTHETIC_ACCOUNT
      || invocation.expectedProviderAccountFingerprint !== SYNTHETIC_FINGERPRINT
      || invocation.campaignExpectedProviderAccountFingerprint !== SYNTHETIC_FINGERPRINT
      || invocation.sourceCoverage !== 'NOT_ATTESTED' || invocation.sourceCommit !== config.sourceCommit
      || invocation.target.serverUuid !== config.serverUuid || invocation.target.databaseName !== resources.schema
      || invocation.outputName !== `synthetic-${config.runId}`
      || invocation.protectedStore.identities.some(entry => entry.databaseName.toLowerCase() === resources!.schema)) throw new Error();
    stage = 'LOCAL_PREFLIGHT';
    if (!await deps.launcher.verifyProtectedStoreInventory(invocation.protectedStore)) throw new Error();
    const checkout = await deps.launcher.readCheckout();
    if (!checkout.clean || checkout.sourceCommit !== config.sourceCommit) throw new Error();
    await deps.launcher.validateOutput(invocation.outputName);
    const url = assertLocalMysqlDatabaseUrl(deps.readAdminUrl());
    if ((url.port || '3306') !== '3306' || [...url.searchParams].length !== 0) throw new Error();
    assertDisposableDatabaseName(resources.schema, url);
    const password = deps.readReaderPassword();
    if (!password || !/^[0-9a-f]{64}$/.test(password)) throw new Error();
    stage = 'CREATE_OWNED_CLIENT';
    port = await deps.createMysql(config, resources, url.toString(), password);
    const mysql = port;
    await step('SERVER_IDENTITY', async () => {
      const observed = await mysql.identity();
      if (observed.host !== config.host || observed.port !== config.port || observed.serverUuid !== config.serverUuid
        || observed.mandatoryRoles !== '') throw new Error();
    });
    await step('RESOURCE_COLLISION_CHECK', () => mysql.assertAbsent());
    await step('CREATE_SCHEMA', async () => { await mysql.createSchema(); schemaCreated = true; });
    await step('FROZEN_MIGRATIONS', () => mysql.migrateExactBytes(checkout));
    await step('OWNERSHIP_MARKER', () => mysql.markSchema());
    await step('REQUIRED_TABLES', () => mysql.requireTables());
    await step('CREATE_READER', async () => { await mysql.createReader(); readerCreated = true; });
    await step('SELECT_ONLY_GRANTS', () => mysql.grantAndVerifySelectOnly());
    await step('LAUNCHER_METADATA_PREFLIGHT', () => mysql.checkLauncherMetadataPreflight());
    await step('SYNTHETIC_FIXTURES', () => mysql.seedFixtures());
    await step('DECIMAL_ROLLBACK_TWO_SESSION_SNAPSHOT', () => mysql.checkDecimalRollbackAndSnapshot());
    await step('ACTUAL_LAUNCHER', async () => {
      launcher = await lineageEntry(['--input', config.invocationFile], mysql.launcherDependencies());
      if (launcher.kind !== 'COMPLETED') throw new Error();
    });
    await step('PACKAGE_READBACK_ASSERTIONS', () => mysql.assertPackage(launcher!));
    stage = 'PASSED';
  } catch { /* Fixed stage only, never a DB/CLI message, URL, password or row. */ }
  finally {
    if (port) {
      let failed = (stage === 'CREATE_SCHEMA' && !schemaCreated) || (stage === 'CREATE_READER' && !readerCreated);
      // Both drop methods independently verify the current server and their exact run ownership markers.
      if (readerCreated) try { await port.dropOwnedReader(); } catch { failed = true; }
      if (schemaCreated) try { await port.dropOwnedSchema(); } catch { failed = true; }
      try { await port.close(); } catch { failed = true; }
      cleanup = failed ? 'REQUIRES_REVIEW' : 'CLOSED';
      if (failed && stage === 'PASSED') stage = 'CLEANUP_FAILED';
    }
  }
  return Object.freeze({ evidence: deps.evidence, kind: stage === 'PASSED' && cleanup === 'CLOSED' ? 'SYNTHETIC_ACCEPTANCE_PASSED' : 'SYNTHETIC_ACCEPTANCE_FAILED',
    stage, cleanup, checks: Object.freeze(checks), resources, launcher });
}

if (require.main === module) {
  void (async () => {
    if (process.argv.length !== 4 || process.argv[2] !== '--input' || !path.isAbsolute(process.argv[3]!)) throw new Error();
    const { syntheticNodeDependencies, readSyntheticConfig } = await import('./m4-synthetic-mysql');
    const root = path.resolve(__dirname, '..');
    let stopped = false; const stop = () => { stopped = true; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const result = await runSyntheticAcceptance(await readSyntheticConfig(root, process.argv[3]!),
        { ...syntheticNodeDependencies(root), stopRequested: () => stopped });
      console.log(JSON.stringify(result)); process.exitCode = result.kind === 'SYNTHETIC_ACCEPTANCE_PASSED' ? 0 : 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  })().catch(() => { console.error('SYNTHETIC_ACCEPTANCE_REFUSED_OR_FAILED'); process.exitCode = 1; });
}
