import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineageEntry, type LineageEntryDependencies, type LineageInvocation } from '../../../scripts/m4-lineage-export';
import { runSyntheticAcceptance, syntheticResourceNames, type SyntheticAcceptanceConfig,
  type SyntheticAcceptanceDependencies, type SyntheticMysqlPort } from '../../../scripts/m4-synthetic-acceptance';
import { createSyntheticMysql } from '../../../scripts/m4-synthetic-mysql';
import { SYNTHETIC_ACCOUNT, SYNTHETIC_FINGERPRINT, syntheticLineageIntent } from '../../helpers/lineage-synthetic-fixture';
import { readLineageDiagnosticPackage } from '../../../src/execution/live/ownership-lineage-export';

const UUID = 'b6a4df59-954b-11f1-9408-f43bd84d24a1';
const COMMIT = 'ab'.repeat(20), MIGRATION = '20260920000000_phase17_live_execution', SHA = 'cd'.repeat(32);
const CANARY = 'mysql://SYNTHETIC:DO_NOT_ECHO@127.0.0.1/information_schema';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-acceptance-SYNTHETIC-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fake() {
  const config: SyntheticAcceptanceConfig = { kind: 'SYNTHETIC_M4_MYSQL_ACCEPTANCE', runId: '0123456789ab', sourceCommit: COMMIT,
    serverUuid: UUID, host: 'KANI', port: 3306, deadlineMs: 300000, invocationFile: path.join(root, 'SYNTHETIC.json'),
    authorization: 'AUTHORIZE_FRESH_SYNTHETIC_SETUP_SELECT_EXPORT_AND_OWNED_CLEANUP' };
  const resource = syntheticResourceNames(config.runId), directory = path.join(root, 'synthetic-package');
  const invocation: LineageInvocation = { kind: 'M4_OFFLINE_LINEAGE_EXPORT', target: { serverUuid: UUID, databaseName: resource.schema },
    protectedStore: { version: 2, identities: [{ serverUuid: UUID, databaseName: 'coindcx_shadow' }, { serverUuid: UUID, databaseName: 'coindcx_quant' }],
      review: 'OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITIES', inventorySha256: SHA },
    databaseUrlEnvironmentVariable: 'M4_LINEAGE_DATABASE_URL', accountId: SYNTHETIC_ACCOUNT, campaignAccountId: SYNTHETIC_ACCOUNT,
    expectedProviderAccountFingerprint: SYNTHETIC_FINGERPRINT, campaignExpectedProviderAccountFingerprint: SYNTHETIC_FINGERPRINT,
    sourceCoverage: 'NOT_ATTESTED', sourceCommit: COMMIT, outputName: `synthetic-${config.runId}` };
  let schema = false, marked = false, migrated = false, tables = false, seeded = false, reader = false, grants = false, preflight = false;
  let accountReads = 0, snapshotsConstructed = 0, userDrops = 0, schemaDrops = 0, closes = 0, now = 0;
  let fail = '', badIdentity = false, badMigration = false, stopped = false;
  const calls: string[] = [];
  const step = (name: string) => { calls.push(name); if (fail === name) throw new Error(`${CANARY} SYNTHETIC_RAW_ROW`); };
  const check = (condition: boolean) => { if (!condition) throw new Error('FAKE_DEPENDENCY_STAGE_VIOLATION'); };
  const launcher: LineageEntryDependencies = {
    root, readInput: async () => structuredClone(invocation), verifyProtectedStoreInventory: async () => true,
    readCheckout: async () => ({ sourceCommit: COMMIT, clean: true, migrations: [{ name: MIGRATION, checksum: SHA }], lockSha256: SHA }),
    validateOutput: async () => directory,
    readDatabaseUrl: () => `mysql://${resource.user}:SYNTHETIC@127.0.0.1/${resource.schema}?connection_limit=1&connect_timeout=5&pool_timeout=5`,
    createOwnedDatabase: () => ({
      readIdentity: async () => [{ ...invocation.target, serverUuid: badIdentity ? '11111111-1111-1111-1111-111111111111' : UUID }],
      readAppliedMigrations: async () => [{ migrationName: MIGRATION, checksum: badMigration ? '00'.repeat(32) : SHA, finishedAt: new Date(0), rolledBackAt: null }],
      snapshots() {
        snapshotsConstructed++; check(seeded && preflight && grants);
        return { readLineageDiagnosticSnapshot: async () => {
          accountReads++; const intent = syntheticLineageIntent();
          return { accountId: SYNTHETIC_ACCOUNT, findings: [], certificates: [], ownershipShareCount: 0, reconciliationState: null,
            orders: [{ intentId: intent.intentId, clientOrderId: intent.clientOrderId, accountId: SYNTHETIC_ACCOUNT, pair: intent.content.pair,
              state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, dispatchWireArmed: false, side: 'BUY', wireOrderType: intent.wireOrderType,
              orderedQuantity: intent.content.quantity, price: intent.content.price, leverage: intent.content.leverage }] };
        } };
      },
      close: async () => { calls.push('launcher-close'); },
    }),
  };
  const port: SyntheticMysqlPort = {
    identity: async () => { step('identity'); return { host: 'KANI', port: 3306, serverUuid: UUID, mandatoryRoles: '' }; },
    assertAbsent: async () => { step('collision'); check(!schema && !reader); },
    createSchema: async () => { step('schema'); schema = true; },
    markSchema: async () => { step('marker'); check(schema && migrated); marked = true; },
    migrateExactBytes: async checkout => { step('migrations'); check(schema && !marked && checkout.migrations[0]!.checksum === SHA); migrated = true; },
    requireTables: async () => { step('tables'); check(migrated && marked); tables = true; },
    createReader: async () => { step('reader'); check(tables); reader = true; },
    grantAndVerifySelectOnly: async () => { step('grants'); check(reader && tables); grants = true; },
    async checkLauncherMetadataPreflight() {
      step('preflight'); check(grants && !seeded);
      const result = await lineageEntry(['--input', config.invocationFile], { ...launcher,
        async createOwnedDatabase(url) {
          const owned = await launcher.createOwnedDatabase(url);
          return { ...owned, snapshots() { throw new Error('SYNTHETIC_STOP'); } };
        },
      });
      check(result.preflight === 'MATCHED_TARGET_AND_MIGRATIONS_EXCLUDED_OPERATOR_INVENTORY' && result.cleanup === 'CLOSED'); preflight = true;
    },
    seedFixtures: async () => { step('fixtures'); check(tables && preflight); seeded = true; },
    checkDecimalRollbackAndSnapshot: async () => { step('transaction'); check(seeded && preflight); },
    launcherDependencies: () => { step('launcher'); check(seeded && preflight && grants); return launcher; },
    assertPackage: async result => {
      step('package'); check(result.kind === 'COMPLETED');
      check((await readLineageDiagnosticPackage(directory)).kind === 'VERIFIED');
    },
    dropOwnedReader: async () => { step('drop-user'); check(reader); reader = false; userDrops++; },
    dropOwnedSchema: async () => { step('drop-schema'); check(schema && marked); schema = false; schemaDrops++; },
    close: async () => { step('close'); closes++; },
  };
  const deps: SyntheticAcceptanceDependencies = { evidence: 'OFFLINE_FAKE_ORCHESTRATION', launcher, now: () => now,
    stopRequested: () => stopped, readAdminUrl: () => CANARY, readReaderPassword: () => 'ef'.repeat(32),
    createMysql: async () => { step('factory'); return port; } };
  return { config, deps, port, invocation, calls, directory,
    fail: (name: string) => { fail = name; }, badIdentity: () => { badIdentity = true; }, badMigration: () => { badMigration = true; },
    stop: () => { stopped = true; }, expire: () => { now = 300001; },
    counts: () => ({ accountReads, snapshotsConstructed, userDrops, schemaDrops, closes }) };
}

describe('SYNTHETIC acceptance orchestration, never a real MySQL acceptance result', () => {
  it('imports both executable modules without client construction, setup or environment reads', () => {
    expect(typeof runSyntheticAcceptance).toBe('function'); expect(typeof createSyntheticMysql).toBe('function');
  });
  it('runs every stage in dependency order through the actual launcher and synthetic package/readback', async () => {
    const f = fake(), result = await runSyntheticAcceptance(f.config, f.deps);
    expect(result).toMatchObject({ evidence: 'OFFLINE_FAKE_ORCHESTRATION', kind: 'SYNTHETIC_ACCEPTANCE_PASSED', cleanup: 'CLOSED' });
    expect(f.calls).toEqual(['factory', 'identity', 'collision', 'schema', 'migrations', 'marker', 'tables', 'reader', 'grants',
      'preflight', 'launcher-close', 'fixtures', 'transaction', 'launcher', 'launcher-close', 'package', 'drop-user', 'drop-schema', 'close']);
    expect(f.counts()).toEqual({ accountReads: 1, snapshotsConstructed: 1, userDrops: 1, schemaDrops: 1, closes: 1 });
  });
  it.each(['identity', 'collision', 'schema', 'marker', 'migrations', 'tables', 'reader', 'grants', 'preflight', 'fixtures', 'transaction', 'launcher', 'package', 'drop-user', 'drop-schema', 'close'])(
    'handles %s failure without leaking errors or dropping unowned resources', async stage => {
      const f = fake(); f.fail(stage); const result = await runSyntheticAcceptance(f.config, f.deps);
      expect(result.kind).toBe('SYNTHETIC_ACCEPTANCE_FAILED');
      expect(JSON.stringify(result)).not.toMatch(/DO_NOT_ECHO|mysql:|SYNTHETIC_RAW_ROW/);
      const calls = f.calls;
      if (!calls.includes('schema') || stage === 'schema') expect(calls).not.toContain('drop-schema');
      if (!calls.includes('reader') || stage === 'reader') expect(calls).not.toContain('drop-user');
      if (['schema', 'reader'].includes(stage)) expect(result.cleanup).toBe('REQUIRES_REVIEW');
      if (['identity', 'collision', 'schema', 'marker', 'migrations', 'tables', 'reader', 'grants', 'preflight'].includes(stage)) {
        expect(f.counts().accountReads).toBe(0); expect(fs.existsSync(f.directory)).toBe(false);
        expect(calls).not.toContain('fixtures');
      }
      expect(calls).toContain('close');
    });
  it.each(['identity', 'migration'])('actual launcher %s preflight failure prevents all fixture/account reads and output', async failure => {
    const f = fake(); if (failure === 'identity') f.badIdentity(); else f.badMigration();
    const result = await runSyntheticAcceptance(f.config, f.deps);
    expect(result).toMatchObject({ kind: 'SYNTHETIC_ACCEPTANCE_FAILED', stage: 'LAUNCHER_METADATA_PREFLIGHT', cleanup: 'CLOSED' });
    expect(f.counts().accountReads).toBe(0); expect(f.counts().snapshotsConstructed).toBe(0);
    expect(f.calls).not.toContain('fixtures'); expect(fs.existsSync(f.directory)).toBe(false);
  });
  it.each(['marker', 'migrations', 'tables', 'grants', 'fixtures'])('stop/deadline at %s waits for the stage to settle then cleans only created resources', async at => {
    const f = fake();
    const stopAfter = async (action: () => Promise<void>) => { await action(); f.stop(); f.expire(); };
    if (at === 'marker') { const original = f.port.markSchema; f.port.markSchema = () => stopAfter(original); }
    if (at === 'migrations') { const original = f.port.migrateExactBytes; f.port.migrateExactBytes = checkout => stopAfter(() => original(checkout)); }
    if (at === 'tables') { const original = f.port.requireTables; f.port.requireTables = () => stopAfter(original); }
    if (at === 'grants') { const original = f.port.grantAndVerifySelectOnly; f.port.grantAndVerifySelectOnly = () => stopAfter(original); }
    if (at === 'fixtures') { const original = f.port.seedFixtures; f.port.seedFixtures = () => stopAfter(original); }
    const result = await runSyntheticAcceptance(f.config, f.deps);
    expect(result.kind).toBe('SYNTHETIC_ACCEPTANCE_FAILED'); expect(f.calls).toContain('drop-schema'); expect(f.calls).toContain('close');
    expect(fs.existsSync(f.directory)).toBe(false);
  });
  it.each(['legacy', 'protected-target', 'real-account', 'real-fingerprint', 'bad-admin', 'bad-password', 'dirty-source', 'no-authorization', 'bad-runid'])(
    'refuses %s before constructing any MySQL dependency', async kind => {
      const f = fake(); let raw: unknown = f.config;
      if (kind === 'legacy') f.deps.launcher.readInput = async () => ({ ...f.invocation, protectedStore: { identity: f.invocation.target } });
      if (kind === 'protected-target') f.invocation.protectedStore.identities.push(f.invocation.target);
      if (kind === 'real-account') f.invocation.accountId = 'historical-account';
      if (kind === 'real-fingerprint') f.invocation.expectedProviderAccountFingerprint = '00'.repeat(32);
      if (kind === 'bad-admin') f.deps.readAdminUrl = () => 'mysql://SYNTHETIC:secret@remote.invalid/other';
      if (kind === 'bad-password') f.deps.readReaderPassword = () => '';
      if (kind === 'dirty-source') f.deps.launcher.readCheckout = async () => ({ sourceCommit: COMMIT, clean: false, migrations: [], lockSha256: SHA });
      if (kind === 'no-authorization') raw = { ...f.config, authorization: undefined };
      if (kind === 'bad-runid') raw = { ...f.config, runId: '../existing' };
      expect((await runSyntheticAcceptance(raw, f.deps)).kind).toBe('SYNTHETIC_ACCEPTANCE_FAILED');
      expect(f.calls).toEqual([]); expect(f.counts().accountReads).toBe(0);
    });
  it('does not adopt existing schemas/users after a collision', async () => {
    const f = fake(); f.port.assertAbsent = async () => { throw new Error('EXISTS'); };
    expect((await runSyntheticAcceptance(f.config, f.deps)).kind).toBe('SYNTHETIC_ACCEPTANCE_FAILED');
    expect(f.counts()).toEqual({ accountReads: 0, snapshotsConstructed: 0, userDrops: 0, schemaDrops: 0, closes: 1 });
  });
  it('leaves an unmarked schema for review after a deploy failure instead of claiming cleanup', async () => {
    const f = fake(); f.fail('migrations');
    const result = await runSyntheticAcceptance(f.config, f.deps);
    expect(result).toMatchObject({ kind: 'SYNTHETIC_ACCEPTANCE_FAILED', stage: 'FROZEN_MIGRATIONS', cleanup: 'REQUIRES_REVIEW' });
    expect(f.calls).not.toContain('marker'); expect(f.calls).not.toContain('fixtures');
    expect(f.counts().schemaDrops).toBe(0); expect(f.counts().closes).toBe(1);
  });
  it('preload refuses env paths (including URL/Buffer) before reads and blocks provider HTTP without sending anything', () => {
    const guard = path.resolve(__dirname, '../../../scripts/m4-synthetic-cli-guard.cjs');
    const code = `const fs=require('node:fs');const u=require('node:url');let n=0;for(const p of ['${path.join(root, '.env').replaceAll('\\', '\\\\')}',Buffer.from('.env.synthetic'),u.pathToFileURL('/SYNTHETIC/.env')]){try{fs.readFileSync(p)}catch(e){if(e.message==='SYNTHETIC_ENV_FILE_READ_REFUSED')n++}}try{require('node:https').request('https://synthetic.invalid')}catch(e){if(e.message==='SYNTHETIC_PROVIDER_HTTP_REFUSED')n++}if(n!==4)process.exitCode=1;`;
    execFileSync(process.execPath, ['--require', guard, '-e', code], { stdio: 'pipe' });
  });
});
