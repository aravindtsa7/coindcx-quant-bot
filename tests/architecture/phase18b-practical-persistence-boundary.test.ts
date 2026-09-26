import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRACTICAL_INVALIDATION_SEVERITY } from '../../src/execution/live/practical/invalidation';
import { currentAccountContinuityCapability, requireCurrentReconciliation } from '../../src/execution/live/reconciliation/barrier';
import { buildImportGraph, computeReachable, extractImportSpecifiers } from './support/import-graph';

// Phase 18B Stage 1B1: durable persistence foundation ONLY.
//
//   - Execution owns the port (Prisma-free); exactly one adapter module
//     imports Prisma, and the Stage 1A practical domain stays Prisma-free.
//   - Nothing in src/ uses the adapter yet: no runtime, gateway, dispatch, or
//     arm wiring, and so no route from "certificate consumed + lease acquired"
//     to any provider mutation. [Checkpoint B] The read-only recovery core
//     imports the Prisma-free PORT only (never the adapter, never the lease path).
//   - No strict-continuity bridge, no issuer widening.
//   - The new migration is additive, frozen after final review (pinned in
//     phase18-migration-freeze.test.ts), and stores no secret.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const PERSISTENCE_ROOT = 'src/execution/live/practical-persistence/';
const PRACTICAL_ROOT = 'src/execution/live/practical/';
const REPOSITORY = `${PERSISTENCE_ROOT}repository.ts`;
const SHADOW_RUNTIME = 'src/integration/coindcx/live/practical-shadow-runtime.ts';
const MIGRATIONS_ROOT = path.join(REPO_ROOT, 'prisma/migrations');
const STAGE_1B1_MIGRATION = '20260925000000_phase18b_practical_persistence';

const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
const persistenceFiles = files.filter((file) => file.startsWith(PERSISTENCE_ROOT)).sort();

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function reachOf(file: string): readonly string[] {
  return [file, ...computeReachable(graph, file)];
}

function externalImports(file: string): string[] {
  return extractImportSpecifiers(sourceOf(file), file).filter((specifier) => !specifier.startsWith('.'));
}

describe('module layout and the Prisma boundary', () => {
  it('the persistence tree is exactly the port, the pure row/plan modules, and one adapter', () => {
    const onDisk = readdirSync(path.join(REPO_ROOT, PERSISTENCE_ROOT)).filter((name) => name.endsWith('.ts')).sort();
    expect(onDisk).toEqual(['plan.ts', 'ports.ts', 'repository.ts', 'rows.ts']);
    expect(persistenceFiles).toEqual(onDisk.map((name) => `${PERSISTENCE_ROOT}${name}`));
  });

  it('ONLY the adapter imports Prisma; the port and the pure modules are Prisma-free, even transitively', () => {
    expect(externalImports(REPOSITORY).sort()).toEqual(['@prisma/client', 'node:crypto']);
    for (const file of persistenceFiles.filter((name) => name !== REPOSITORY)) {
      for (const node of reachOf(file)) {
        expect(externalImports(node), `${file} reaches ${node}`).not.toContain('@prisma/client');
      }
      expect(codeOf(file), file).not.toMatch(/Prisma|\$queryRaw|\$executeRaw/);
    }
  });

  it('the Stage 1A practical domain still reaches no Prisma, even transitively', () => {
    for (const file of files.filter((name) => name.startsWith(PRACTICAL_ROOT))) {
      for (const node of reachOf(file)) {
        expect(externalImports(node), `${file} reaches ${node}`).not.toContain('@prisma/client');
      }
    }
  });

  it('the whole persistence reach uses only Prisma, hashing/uuid, decimals, and logging', () => {
    const external = new Set<string>();
    for (const file of persistenceFiles) for (const node of reachOf(file)) for (const specifier of externalImports(node)) external.add(specifier);
    expect([...external].sort()).toEqual(['@prisma/client', 'decimal.js', 'node:crypto', 'pino']);
  });
});

describe('no provider, network, gateway, dispatch, or arm reachability (no new route to a mutation)', () => {
  it('reaches no integration module, gateway, mutation authority, live service, Phase 17/18 repository, or the barrier', () => {
    for (const file of persistenceFiles) {
      const reach = reachOf(file);
      expect(reach.filter((node) => node.startsWith('src/integration/')), file).toEqual([]);
      expect(reach.filter((node) => node.startsWith('src/dispatch/')), file).toEqual([]);
      for (const forbidden of [
        'src/execution/live/gateway.ts',
        'src/execution/live/authority.ts',
        'src/execution/live/service.ts',
        'src/execution/live/repository.ts',
        'src/execution/live/reconciliation/barrier.ts',
        'src/execution/live/reconciliation/repository.ts',
        'src/execution/live/reconciliation/service.ts',
        'src/execution/live/reconciliation/gateway-orphan-cancellation.ts',
        'src/persistence/prisma.ts',
      ]) {
        expect(reach.includes(forbidden), `${file} reaches ${forbidden}`).toBe(false);
      }
    }
  });

  it('names no mutation, arming, signing, or network primitive, and never writes armed_at_ms', () => {
    for (const file of persistenceFiles) {
      const code = codeOf(file);
      for (const forbidden of [
        'placeOrder', 'cancelOrder', 'armDispatchWire', 'armCancelWire', 'armOrphanCancelWire', 'createOrder',
        'fetch(', 'axios', 'socket.io', 'HmacSha256Signer', 'X-AUTH', '/exchange/v1', 'process.env', 'Date.now', 'new Date(',
        'armedAtMs:', 'armed_at_ms =', 'intentId:', 'clientOrderId:',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it('only the Checkpoint B recovery core and the Checkpoint C shadow collector import the PORT; only the shadow-only composition root imports the ADAPTER (for loadAccount)', () => {
    const importers = files.filter((file) => !file.startsWith(PERSISTENCE_ROOT) && (graph.get(file) ?? []).some((dependency) => dependency.startsWith(PERSISTENCE_ROOT)));
    // [Checkpoint B] The exact, reviewed widening: the recovery core depends on the Prisma-free PORT only.
    expect(importers.sort()).toEqual([
      'src/execution/live/practical-recovery/ports.ts',
      'src/execution/live/practical-recovery/service.ts',
      'src/execution/live/practical-recovery/tripwire.ts',
      // [Checkpoint C] the read-only shadow collector (a `loadAccount`-only Pick of the PORT).
      'src/execution/live/practical-shadow/collector.ts',
      // [Checkpoint C] the shadow-only composition root: constructs the ADAPTER and exposes loadAccount only.
      SHADOW_RUNTIME,
    ]);
    for (const importer of importers.filter((file) => file !== SHADOW_RUNTIME)) {
      expect((graph.get(importer) ?? []).filter((dependency) => dependency.startsWith(PERSISTENCE_ROOT)), importer).toEqual([`${PERSISTENCE_ROOT}ports.ts`]);
    }
    expect((graph.get(SHADOW_RUNTIME) ?? []).filter((dependency) => dependency.startsWith(PERSISTENCE_ROOT))).toEqual([REPOSITORY]);
    expect(files.filter((file) => file !== REPOSITORY && (graph.get(file) ?? []).includes(REPOSITORY))).toEqual([SHADOW_RUNTIME]);
    // The shadow runtime uses the adapter for ONE read: loadAccount.
    const runtime = sourceOf(SHADOW_RUNTIME);
    expect([...runtime.matchAll(/practicalRepository\.(\w+)/g)].map((match) => match[1])).toEqual(['loadAccount']);
  });

  it('the port and adapter state plainly that a lease is not dispatch authority and that Stage 1B2 must join the Phase 17 dispatch claim', () => {
    for (const file of [`${PERSISTENCE_ROOT}ports.ts`, REPOSITORY]) {
      const source = sourceOf(file);
      expect(source, file).toMatch(/Stage 1B2 must[\s\S]{0,80}join/);
      expect(source, file).toMatch(/Phase 17 dispatch claim/);
      expect(source, file).toMatch(/split-brain/);
    }
  });
});

describe('no strict-continuity bridge and no issuer widening', () => {
  it('names no strict continuity symbol and constructs no continuity capability', () => {
    for (const file of persistenceFiles) {
      const code = codeOf(file);
      for (const forbidden of [
        'requireCurrentReconciliation', 'currentAccountContinuityCapability', 'LiveAccountContinuityCapability',
        'ACCOUNT_CONTINUITY_PROVEN', 'authorizeCurrentHealthy', 'LiveReconciliationAuthorization', 'evaluateReconciliationBarrier',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
    // The strict barrier keeps its semantics.
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
    expect(requireCurrentReconciliation).toHaveLength(4);
  });

  it('persists authority only as created by the Stage 1A issuance boundaries: it mints nothing', () => {
    for (const file of persistenceFiles) {
      const code = codeOf(file);
      for (const issuer of ['issuePracticalLiveSafetyEnablement', 'mintPracticalManualReviewResolution', 'issuePracticalRecoveryCertificate']) {
        expect(code.includes(issuer), `${file} references ${issuer}`).toBe(false);
      }
      expect(code, file).not.toMatch(/new PracticalRecoveryCertificate\(|new PracticalManualReviewResolution\(|new PracticalLiveSafetyEnablement\(/);
    }
  });

  it('manual-review resolution is not on the port (internal, not wired, no operator endpoint)', () => {
    expect(codeOf(`${PERSISTENCE_ROOT}ports.ts`)).not.toContain('resolveManualReview(');
    expect(codeOf(REPOSITORY)).toContain('public async resolveManualReview(');
    const callers = files.filter((file) => file !== REPOSITORY && codeOf(file).includes('resolveManualReview'));
    expect(callers).toEqual([]);
  });
});

/** The source text of one public repository method, up to the next class member (public or private). */
function methodSource(name: string): string {
  const code = codeOf(REPOSITORY);
  const start = code.indexOf(`public async ${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const rest = code.slice(start + 1);
  const next = rest.search(/\n {2}(public |async #|#[a-zA-Z]+\()/);
  return code.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe('[P18B-1B1-01] malformed-state escalation never repairs, and resolution consumes last', () => {
  it('escalation writes ONLY the review episode and the latch: no state, fence, certificate, lease, or recovery-episode write', () => {
    const escalate = methodSource('escalateMalformedAccount');
    expect(escalate).toContain('tx.livePracticalReviewEpisode.create(');
    expect(escalate).toMatch(/tx\.livePracticalMalformedLatch\.(create|updateMany)\(/);
    for (const forbidden of ['livePracticalAccountState', 'livePracticalAccountFence', 'livePracticalCertificate', 'livePracticalMutationLease', 'livePracticalRecoveryEpisode', '#apply(']) {
      expect(escalate.includes(forbidden), forbidden).toBe(false);
    }
    expect(escalate).toContain('reason: PRACTICAL_DURABLE_STATE_MALFORMED');
    expect(escalate).toContain('malformedProblem: load.problem');
  });

  it('resolution consumes the Stage 1A one-shot only AFTER every durable write, in both paths', () => {
    const resolve = methodSource('resolveManualReview');
    // The consuming transition appears once, inside the final step.
    expect(resolve.match(/transitionPracticalAccountState\(/g)?.length).toBe(1);
    const lastWrite = Math.max(resolve.lastIndexOf('tx.livePracticalMalformedLatch.updateMany('), resolve.lastIndexOf('this.#apply('));
    const consumeCalls = [...resolve.matchAll(/consumeLast\(episodeId\)/g)].map((match) => match.index);
    expect(consumeCalls).toHaveLength(2);
    expect(resolve.indexOf('tx.livePracticalMalformedLatch.updateMany(')).toBeLessThan(consumeCalls[0]!);
    expect(lastWrite).toBeLessThan(consumeCalls[1]!);
    // The malformed-state latch path never writes the account rows either.
    for (const forbidden of ['livePracticalAccountFence', 'livePracticalCertificate', 'livePracticalMutationLease']) {
      expect(resolve.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('every operation reads (and locks) the latch FIRST, before the account rows', () => {
    const readAccountRows = codeOf(REPOSITORY).slice(codeOf(REPOSITORY).indexOf('async function readAccountRows('));
    expect(readAccountRows.indexOf('readLatchRow(')).toBeGreaterThan(0);
    expect(readAccountRows.indexOf('readLatchRow(')).toBeLessThan(readAccountRows.indexOf('readStateRow('));
  });
});

describe('[P18B-1B1-02] a leased fence is bound to its exact lease, in assembly AND in release', () => {
  it('account assembly reads the lease a MUTATION_LEASED fence names and requires the complete binding', () => {
    const readAccountRows = codeOf(REPOSITORY).slice(codeOf(REPOSITORY).indexOf('async function readAccountRows('));
    expect(readAccountRows.slice(0, readAccountRows.indexOf('\n}'))).toContain('const lease = leaseId === null ? null : await readLeaseRow(tx, leaseId, lock);');
    const rows = codeOf(`${PERSISTENCE_ROOT}rows.ts`);
    const assemble = rows.slice(rows.indexOf('export function assemblePracticalAccount('), rows.indexOf('function pointed<'));
    expect(assemble).toContain('isPracticalLeaseBoundToFence(lease, fence)');
    const binding = rows.slice(rows.indexOf('export function isPracticalLeaseBoundToFence('));
    for (const clause of [
      'lease.leaseId === fence.mode.leaseId', 'lease.certificateId === fence.mode.certificateId', 'lease.accountId === fence.accountId',
      'lease.action === fence.mode.action', 'lease.runtimeEpoch === fence.runtimeEpoch',
      'lease.reconciliationGeneration === fence.reconciliationGeneration', "lease.status === 'LEASED'",
    ]) {
      expect(binding.slice(0, binding.indexOf('\n}')), clause).toContain(clause);
    }
  });

  it('releaseLease independently re-checks the complete binding BEFORE any write, and completes the lease only under that binding', () => {
    const release = methodSource('releaseLease');
    expect(release).toContain('isPracticalLeaseBoundToFence(lease, current.fence)');
    expect(release.indexOf('isPracticalLeaseBoundToFence(')).toBeLessThan(release.indexOf('this.#apply('));
    const code = codeOf(REPOSITORY);
    const complete = code.slice(code.indexOf('if (extras.completeLease !== undefined)'));
    expect(complete.slice(0, complete.indexOf('exactlyOne('))).toMatch(
      /leaseId: lease\.leaseId, accountId: current\.accountId, certificateId: lease\.certificateId, action: lease\.action,\s+runtimeEpoch: lease\.runtimeEpoch, reconciliationGeneration: lease\.reconciliationGeneration, status: 'LEASED'/,
    );
  });
});

describe('[P18B-1B1-05] a held lease rests on its exact CONSUMED certificate: assembly, lock order, release, post-consume', () => {
  it('account assembly reads the certificate a leased fence names (a separate field, never currentCertificate) and requires the complete chain', () => {
    const rows = codeOf(`${PERSISTENCE_ROOT}rows.ts`);
    const assemble = rows.slice(rows.indexOf('export function assemblePracticalAccount('), rows.indexOf('function pointed<'));
    expect(assemble).toContain("pointed(rows.leasedCertificate, fence.mode.kind === 'MUTATION_LEASED' ? fence.mode.certificateId : null, parsePracticalCertificateRow)");
    expect(assemble).toContain('isPracticalCertificateBoundToLease(leasedCertificate, lease)');
    expect(assemble).toContain('leasedCertificate,');
    const binding = rows.slice(rows.indexOf('export function isPracticalCertificateBoundToLease('));
    for (const clause of [
      'certificate.certificateId === lease.certificateId', 'certificate.accountId === lease.accountId',
      'certificate.runtimeEpoch === lease.runtimeEpoch', 'certificate.reconciliationGeneration === lease.reconciliationGeneration',
      "certificate.status === 'CONSUMED'",
    ]) {
      expect(binding.slice(0, binding.indexOf('\n}')), clause).toContain(clause);
    }
  });

  it('one lock order: ... state, fence, episodes, current certificate, leased certificate, THEN lease; release re-reads certificate before lease', () => {
    const code = codeOf(REPOSITORY);
    const readAccountRows = code.slice(code.indexOf('async function readAccountRows('));
    const body = readAccountRows.slice(0, readAccountRows.indexOf('\n}'));
    const order = [
      'readLatchRow(tx, accountId, lock)', 'readReviewEpisodeRow(tx, latchEpisodeId, lock)', 'readStateRow(tx, accountId, lock)', 'readFenceRow(tx, accountId, lock)',
      'readRecoveryEpisodeRow(tx, recoveryId, lock)', 'readReviewEpisodeRow(tx, reviewId, lock)',
      'readCertificateRow(tx, certificateId, lock)', 'readCertificateRow(tx, leasedCertificateId, lock)', 'readLeaseRow(tx, leaseId, lock)',
    ].map((call) => body.indexOf(call));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const release = methodSource('releaseLease');
    expect(release.indexOf('readCertificateRow(')).toBeGreaterThan(0);
    expect(release.indexOf('readCertificateRow(')).toBeLessThan(release.indexOf('readLeaseRow('));
    expect(release.indexOf('isPracticalCertificateBoundToLease(leasedCertificate, lease)')).toBeGreaterThan(0);
    expect(release.indexOf('isPracticalCertificateBoundToLease(')).toBeLessThan(release.indexOf('this.#apply('));
  });

  it('consume self-checks the committed chain (CONSUMED certificate + exact lease + exact fence) AFTER its writes, before returning', () => {
    const consume = methodSource('consumeCertificateAndLease');
    const lastWrite = consume.lastIndexOf('this.#apply(');
    for (const check of ["leasedCertificate.status !== 'CONSUMED'", 'isPracticalLeaseBoundToFence(currentLease, account.fence)', 'isPracticalCertificateBoundToLease(leasedCertificate, currentLease)']) {
      expect(consume.lastIndexOf(check), check).toBeGreaterThan(lastWrite);
    }
  });

  it('the migration binds lease -> certificate on certificate, account, epoch, and generation (one composite FK, the only lease->certificate FK)', () => {
    const sql = migrationSql(STAGE_1B1_MIGRATION);
    const leaseCertificateForeignKeys = statementsOf(sql)
      .filter((statement) => statement.startsWith('ALTER TABLE `live_practical_mutation_lease`') && statement.includes('REFERENCES `live_practical_certificate`'));
    expect(leaseCertificateForeignKeys).toEqual([
      'ALTER TABLE `live_practical_mutation_lease` ADD CONSTRAINT `live_practical_mutation_lease_certificate_fkey` '
      + 'FOREIGN KEY (`certificate_id`, `account_id`, `runtime_epoch`, `reconciliation_generation`) '
      + 'REFERENCES `live_practical_certificate`(`certificate_id`, `account_id`, `runtime_epoch`, `reconciliation_generation`) '
      + 'ON DELETE RESTRICT ON UPDATE RESTRICT',
    ]);
    expect(sql).toContain('UNIQUE INDEX `live_practical_certificate_lease_binding_key`(`certificate_id`, `account_id`, `runtime_epoch`, `reconciliation_generation`)');
    // The one-lease-per-certificate key is kept.
    expect(sql).toContain('UNIQUE INDEX `live_practical_mutation_lease_certificate_key`(`certificate_id`)');
  });
});

describe('[P18B-1B1-03] every repository-generated durable id is validated before it is written', () => {
  it('the injected generator is called in exactly one place (#newDurableId), and every generated id goes through it', () => {
    const code = codeOf(REPOSITORY);
    expect(code.match(/this\.#newId\(\)/g)?.length).toBe(1);
    const helper = code.slice(code.indexOf('#newDurableId(name: string, maxLength: number): string {'));
    expect(helper.slice(0, helper.indexOf('\n  }'))).toMatch(/const id: unknown = this\.#newId\(\);\s+if \(!isExactId\(id\) \|\| id\.length > maxLength\)/);
    // No generator reference escapes except into the validating helper.
    expect(code.match(/this\.#newId\b/g)?.length).toBe(2);
    expect(code).toContain("planPracticalAccountChange(current, request, (kind) => this.#newDurableId(kind, 64))");
    expect(methodSource('initializeAccount')).toContain("this.#newDurableId('recoveryEpisodeId', 64)");
    expect(methodSource('escalateMalformedAccount')).toContain("this.#newDurableId('reviewEpisodeId', 64)");
  });

  it('escalation re-reads and strictly re-validates the latch after writing, inside the same transaction', () => {
    const escalate = methodSource('escalateMalformedAccount');
    const lastWrite = Math.max(escalate.lastIndexOf('tx.livePracticalMalformedLatch.create('), escalate.lastIndexOf('tx.livePracticalMalformedLatch.updateMany('));
    const reRead = escalate.indexOf('const after = await readAccountRows(tx, accountId, true);');
    expect(reRead).toBeGreaterThan(lastWrite);
    expect(escalate.indexOf('evaluatePracticalLatch(accountId, after.latch, after.latchEpisode)')).toBeGreaterThan(reRead);
  });
});

describe('the trusted-absence boundary in code', () => {
  it('no persistence module converts a failure into null or absence', () => {
    for (const file of persistenceFiles) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/catch\s*(\([^)]*\))?\s*\{[^}]*return\s+(null|undefined|\{\s*kind:\s*'NOT_FOUND')/);
      expect(code, file).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*(null|undefined)/);
    }
  });

  it('the row-parsing boundary uses no optional chaining or nullish defaults', () => {
    const code = codeOf(`${PERSISTENCE_ROOT}rows.ts`);
    expect(code).not.toMatch(/\?\.|\?\?/);
  });

  it('only a zero-row read produces absence (singleRowOrNull is the one place)', () => {
    const code = codeOf(`${PERSISTENCE_ROOT}rows.ts`);
    expect(code).toContain('if (rows.length === 0) return null;');
    expect(codeOf(REPOSITORY).match(/singleRowOrNull\(/g)?.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function migrationSql(directory: string): string {
  return readFileSync(path.join(MIGRATIONS_ROOT, directory, 'migration.sql'), 'utf8');
}

function statementsOf(sql: string): string[] {
  return sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').split(';').map((statement) => statement.trim()).filter(Boolean);
}

describe('the Stage 1B1 migration', () => {
  it('is a later-timestamped forward migration, now FROZEN: pinned in the freeze test under its exact name and accepted hash', () => {
    const directories = readdirSync(MIGRATIONS_ROOT).filter((name) => statSync(path.join(MIGRATIONS_ROOT, name)).isDirectory()).sort();
    // [Checkpoint C] exactly one later, additive forward migration follows it, itself now FROZEN.
    expect(directories.slice(directories.indexOf(STAGE_1B1_MIGRATION) + 1)).toEqual(['20260926000000_phase18b_practical_shadow_calibration']);
    expect(directories.filter((name) => name.includes('phase18b'))).toEqual([STAGE_1B1_MIGRATION, '20260926000000_phase18b_practical_shadow_calibration']);
    const freezeTest = readFileSync(path.join(REPO_ROOT, 'tests/architecture/phase18-migration-freeze.test.ts'), 'utf8');
    expect(freezeTest).toContain(`'${STAGE_1B1_MIGRATION}': '734e3d01758667cf652c1a57745fc3c2bca9476599459b820f752a20eb054f99',`);
    expect(freezeTest).toContain("'20260926000000_phase18b_practical_shadow_calibration': '6cf2095f5d05be54c248fe43e113e67156af9f783ce4fb21948722fcaa6811e9',");
    expect(readdirSync(path.join(MIGRATIONS_ROOT, STAGE_1B1_MIGRATION))).toEqual(['migration.sql']);
  });

  it('is purely additive: it creates and constrains only live_practical_* tables and references nothing else', () => {
    const statements = statementsOf(migrationSql(STAGE_1B1_MIGRATION));
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, statement).toMatch(/^(CREATE TABLE `live_practical_[a-z_]+`|ALTER TABLE `live_practical_[a-z_]+`)/);
      // Foreign-key referential clauses (ON DELETE/UPDATE RESTRICT) are not data changes.
      const withoutReferentialClauses = statement.replace(/ON (DELETE|UPDATE) RESTRICT/g, '');
      expect(withoutReferentialClauses, statement).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b|MODIFY COLUMN|CASCADE|SET NULL/i);
      for (const reference of statement.matchAll(/REFERENCES `([a-z_]+)`/g)) expect(reference[1]).toMatch(/^live_practical_/);
    }
  });

  it('enforces the Stage 1B1 invariants in the database (fence shape, pointer coupling, terminal coupling, one lease per certificate, no arming)', () => {
    const sql = migrationSql(STAGE_1B1_MIGRATION);
    for (const constraint of [
      'live_practical_account_fence_mode_chk',
      'live_practical_account_state_recovery_chk',
      'live_practical_account_state_review_chk',
      'live_practical_account_state_certificate_chk',
      'live_practical_certificate_terminal_at_chk',
      'live_practical_certificate_terminal_reason_chk',
      'live_practical_mutation_lease_not_armed_chk',
      'live_practical_review_episode_resolution_chk',
      'live_practical_review_episode_kind_reason_chk',
      'live_practical_review_episode_kind_problem_chk',
      'live_practical_malformed_latch_revision_chk',
      'live_practical_review_episode_invalidation_reason_chk',
    ]) {
      expect(sql).toContain(`\`${constraint}\` CHECK`);
    }
    expect(sql).toContain('UNIQUE INDEX `live_practical_malformed_latch_review_episode_key`(`current_review_episode_id`)');
    expect(sql).toContain('UNIQUE INDEX `live_practical_mutation_lease_certificate_key`(`certificate_id`)');
    expect(sql).toContain('UNIQUE INDEX `live_practical_review_episode_resolution_key`(`resolution_id`)');
    expect(sql).toContain('UNIQUE INDEX `live_practical_account_fence_lease_key`(`lease_id`, `certificate_id`)');
    expect((sql.match(/ADD CONSTRAINT `[a-z_]+_chk` CHECK/g) ?? []).length).toBe(28);
  });

  it('[P18B-1B1-02] a leased fence references its lease on ALL SIX binding columns (one composite FK, the only fence->lease FK)', () => {
    const sql = migrationSql(STAGE_1B1_MIGRATION);
    const fenceLeaseForeignKeys = statementsOf(sql)
      .filter((statement) => statement.startsWith('ALTER TABLE `live_practical_account_fence`') && statement.includes('REFERENCES `live_practical_mutation_lease`'));
    expect(fenceLeaseForeignKeys).toEqual([
      'ALTER TABLE `live_practical_account_fence` ADD CONSTRAINT `live_practical_account_fence_lease_fkey` '
      + 'FOREIGN KEY (`lease_id`, `certificate_id`, `account_id`, `lease_action`, `runtime_epoch`, `reconciliation_generation`) '
      + 'REFERENCES `live_practical_mutation_lease`(`lease_id`, `certificate_id`, `account_id`, `action`, `runtime_epoch`, `reconciliation_generation`) '
      + 'ON DELETE RESTRICT ON UPDATE RESTRICT',
    ]);
    expect(sql).toContain('UNIQUE INDEX `live_practical_mutation_lease_fence_binding_key`(`lease_id`, `certificate_id`, `account_id`, `action`, `runtime_epoch`, `reconciliation_generation`)');
  });

  it('the INVALIDATION review-reason CHECK lists EXACTLY the Stage 1A MANUAL_REVIEW-severity reasons', () => {
    const statement = statementsOf(migrationSql(STAGE_1B1_MIGRATION)).find((candidate) => candidate.includes('live_practical_review_episode_invalidation_reason_chk'));
    expect(statement).toBeDefined();
    const listed = [...statement!.slice(statement!.indexOf('IN (')).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort();
    const manualReview = Object.entries(PRACTICAL_INVALIDATION_SEVERITY).filter(([, severity]) => severity === 'MANUAL_REVIEW').map(([reason]) => reason).sort();
    expect(listed).toEqual(manualReview);
    expect(statement).toContain("`kind` <> 'INVALIDATION' OR `reason` IN (");
  });

  it('[P18B-1B1-01] the malformed-state latch references ONLY its review episode, never the (possibly malformed) account rows', () => {
    const latchForeignKeys = statementsOf(migrationSql(STAGE_1B1_MIGRATION))
      .filter((statement) => statement.startsWith('ALTER TABLE `live_practical_malformed_latch`') && statement.includes('FOREIGN KEY'));
    expect(latchForeignKeys).toHaveLength(1);
    expect(latchForeignKeys[0]).toContain('REFERENCES `live_practical_review_episode`(`review_episode_id`)');
  });

  it('stores no credential, signature, raw provider identity, or provider payload', () => {
    const schema = readFileSync(path.join(REPO_ROOT, 'prisma/schema.prisma'), 'utf8');
    const practicalModels = schema.slice(schema.indexOf('enum LivePracticalAccountStateName'));
    const sql = migrationSql(STAGE_1B1_MIGRATION).split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    for (const text of [practicalModels.replace(/\/\/\/.*$/gm, ''), sql]) {
      expect(text).not.toMatch(/api_?key|apiKey|secret|signature|authorization|coindcx_?id|coindcxId|payload|raw_|password|token/i);
    }
    expect(sql).toContain('`provider_account_fingerprint` CHAR(64) NOT NULL');
  });

  it('the frozen migrations are unchanged (hash pins live in phase18-migration-freeze.test.ts; this re-checks the newest Phase18 one)', () => {
    const text = migrationSql('20260922000000_phase18_wave_c1_orphan_resolution').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(text).digest('hex')).toBe('14272259dc91d1a1c63325f47bf073b75e6a85583f3907de3c11b935e86cebf7');
  });
});
