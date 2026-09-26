import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PracticalRecoveryCertificate } from '../../src/execution/live/practical/certificate';
import { requirePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../src/execution/live/practical/policy';
import { classifyPracticalShadowEvaluation, practicalPaperIntent } from '../../src/execution/live/practical-shadow/classification';
import { parsePracticalShadowEvidence } from '../../src/execution/live/practical-shadow/evidence';
import type {
  PracticalAuthorityEligibility,
  PracticalPaperIntent,
  PracticalPaperSafetyDecision,
  PracticalRestStabilityCandidate,
} from '../../src/execution/live/practical-shadow/types';
import { buildImportGraph, computeReachable, extractImportSpecifiers } from './support/import-graph';

// Phase 18B Checkpoint C: shadow calibration + paper safety simulation.
//
//   - Shadow evidence and paper decisions are NOT authority: the shadow tree
//     reaches no certificate issuer or consumer, no lease, no dispatch or arm,
//     no gateway create/cancel/close, and no strict-continuity bridge.
//   - The three concepts (REST stability candidate, authority eligibility,
//     paper decision) are distinct branded types, none assignable to a
//     practical certificate or the Tier-B enablement.
//   - CoinDCX is reached read-only, only through the shadow-only composition
//     root, and nothing in the live mutation runtime imports shadow code.
//   - Checkpoint B stays the only authority code; shadow reuses only its pure
//     read-only modules. The Checkpoint C migration is additive and FROZEN
//     (pinned in phase18-migration-freeze.test.ts after final review).

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const SHADOW_ROOT = 'src/execution/live/practical-shadow/';
const SHADOW_RUNTIME = 'src/integration/coindcx/live/practical-shadow-runtime.ts';
const CERTIFICATE = 'src/execution/live/practical/certificate.ts';
const MIGRATION = '20260926000000_phase18b_practical_shadow_calibration';
const MIGRATIONS_ROOT = path.join(REPO_ROOT, 'prisma/migrations');

const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
const shadowFiles = files.filter((file) => file.startsWith(SHADOW_ROOT)).sort();

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function reachOf(file: string): readonly string[] {
  return [file, ...computeReachable(graph, file)];
}

/** Local files this file imports with a VALUE (runtime) import. `import type` / all-`type` named imports are erased and skipped. */
function valueDependencies(file: string): readonly string[] {
  const source = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  const resolve = (specifier: string): void => {
    if (!specifier.startsWith('.')) return;
    const base = path.resolve(path.dirname(path.join(REPO_ROOT, file)), specifier);
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        dependencies.push(path.relative(REPO_ROOT, candidate).split(path.sep).join('/'));
        return;
      }
    }
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      const allTypeOnly = clause !== undefined && clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
      if (!allTypeOnly) resolve(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
      resolve(statement.moduleSpecifier.text);
    }
  }
  return dependencies;
}

/** The RUNTIME reach: files loaded when this file is loaded (type-only edges excluded). */
function valueReachOf(file: string): readonly string[] {
  const seen = new Set<string>([file]);
  const queue = [file];
  while (queue.length > 0) {
    for (const dependency of valueDependencies(queue.shift()!)) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...seen];
}

const FORBIDDEN_AUTHORITY_NAMES = [
  'issuePracticalRecoveryCertificate', 'PracticalRecoveryCertificate', 'revokePracticalRecoveryCertificate',
  'issuePracticalLiveSafetyEnablement', 'requirePracticalLiveSafetyEnablement', 'mintPracticalManualReviewResolution',
  'consumeCertificateAndLease', 'releaseLease', 'startCertification', 'finishCertification', 'failCertification', 'recordProviderRecovered',
  'adoptForNewRuntime', 'initializeAccount', 'escalateMalformedAccount', 'expireCertificate', 'resolveManualReview', '.invalidate(',
  'placeOrder', 'createOrder', 'cancelOrder', 'cancelVenueOrder', 'closePosition', 'armDispatchWire', 'armCancelWire', 'armOrphanCancelWire',
  'claimDispatch', 'dispatch(', 'OrderGateway', 'MutationTransport', 'orphanCancellation', 'claimGeneration', 'completeRun',
  'requireCurrentReconciliation', 'currentAccountContinuityCapability', 'LiveAccountContinuityCapability', 'ACCOUNT_CONTINUITY_PROVEN',
  'authorizeCurrentHealthy', 'LiveReconciliationAuthorization', 'provesAccountContinuity: true', 'PracticalRecoveryService', 'PracticalPrivateStreamTripwire',
];

describe('module layout and wiring', () => {
  it('the shadow tree is exactly the reviewed Checkpoint C modules', () => {
    const onDisk = readdirSync(path.join(REPO_ROOT, SHADOW_ROOT)).filter((name) => name.endsWith('.ts')).sort();
    expect(onDisk).toEqual(['analysis.ts', 'campaign.ts', 'classification.ts', 'collector.ts', 'config.ts', 'evidence.ts', 'integrity.ts', 'ports.ts', 'provenance.ts', 'replay.ts', 'repository.ts', 'types.ts']);
    expect(shadowFiles).toEqual(onDisk.map((name) => `${SHADOW_ROOT}${name}`));
  });

  it('only the shadow tree and the shadow-only composition root import shadow code; NOTHING imports the composition root (only scripts/practical-shadow.ts)', () => {
    const importers = files.filter((file) => !file.startsWith(SHADOW_ROOT) && (graph.get(file) ?? []).some((dependency) => dependency.startsWith(SHADOW_ROOT)));
    expect(importers).toEqual([SHADOW_RUNTIME]);
    expect(files.filter((file) => (graph.get(file) ?? []).includes(SHADOW_RUNTIME))).toEqual([]);
    expect(sourceOf('scripts/practical-shadow.ts')).toContain("from '../src/integration/coindcx/live/practical-shadow-runtime'");
  });

  it('the live mutation runtime reaches no shadow code', () => {
    for (const runtime of [
      'src/integration/coindcx/live/production-runtime.ts',
      'src/integration/coindcx/live/order-gateway.ts',
      'src/integration/coindcx/live/mutation-transport.ts',
      'src/execution/live/gateway.ts',
      'src/execution/live/service.ts',
      'src/execution/live/practical-recovery/service.ts',
      'src/index.ts',
    ]) {
      const reach = reachOf(runtime);
      expect(reach.filter((file) => file.startsWith(SHADOW_ROOT) || file === SHADOW_RUNTIME), runtime).toEqual([]);
    }
  });

  it('only repository.ts imports Prisma inside the shadow tree', () => {
    for (const file of shadowFiles) {
      const imports = extractImportSpecifiers(sourceOf(file), file);
      expect(imports.some((specifier) => specifier.startsWith('@prisma')), file).toBe(file === `${SHADOW_ROOT}repository.ts`);
    }
  });
});

describe('SHADOW IS NOT AUTHORITY: no route to a certificate, lease, dispatch, arm, gateway mutation, or strict continuity', () => {
  it('the shadow tree reaches no integration, gateway, dispatch, mutation owner, recovery engine, tripwire, Stage 1B1 adapter, or strict barrier', () => {
    for (const file of shadowFiles) {
      const reach = reachOf(file);
      expect(reach.filter((node) => node.startsWith('src/integration/')), file).toEqual([]);
      expect(reach.filter((node) => node.startsWith('src/dispatch/') || node.startsWith('src/coin-runtime/')), file).toEqual([]);
      for (const forbidden of [
        'src/execution/live/gateway.ts', 'src/execution/live/authority.ts', 'src/execution/live/service.ts', 'src/execution/live/repository.ts', 'src/execution/live/gate.ts',
        'src/execution/live/reconciliation/barrier.ts', 'src/execution/live/reconciliation/repository.ts', 'src/execution/live/reconciliation/service.ts',
        'src/execution/live/reconciliation/gateway-orphan-cancellation.ts', 'src/execution/live/practical-recovery/service.ts', 'src/execution/live/practical-recovery/tripwire.ts',
        'src/execution/live/practical-persistence/repository.ts',
      ]) {
        expect(reach.includes(forbidden), `${file} reaches ${forbidden}`).toBe(false);
      }
    }
  });

  it('AT RUNTIME the shadow core never loads the certificate module (issuer), the fence, or the state machine: every edge to them is type-only', () => {
    for (const file of shadowFiles) {
      const runtimeReach = valueReachOf(file);
      for (const forbidden of [CERTIFICATE, 'src/execution/live/practical/fence.ts', 'src/execution/live/practical/state-machine.ts', 'src/execution/live/practical-persistence/ports.ts']) {
        expect(runtimeReach.includes(forbidden), `${file} loads ${forbidden} at runtime`).toBe(false);
      }
    }
    // Positive control: the helper does see value edges (the Checkpoint B engine DOES load the issuer).
    expect(valueReachOf('src/execution/live/practical-recovery/service.ts')).toContain(CERTIFICATE);
    // The type-level edges into the certificate module are exactly these two type-only imports.
    const reach = new Set(shadowFiles.flatMap((file) => reachOf(file)));
    const importersOfCertificate = [...reach].filter((file) => (graph.get(file) ?? []).includes(CERTIFICATE)).sort();
    expect(importersOfCertificate).toEqual(['src/execution/live/practical-persistence/ports.ts', 'src/execution/live/practical-recovery/observation.ts']);
    expect(sourceOf('src/execution/live/practical-recovery/observation.ts')).toContain("import type { PracticalCertificationEvidenceSummary } from '../practical/certificate';");
    expect(sourceOf('src/execution/live/practical-persistence/ports.ts')).toContain("import type { PracticalCertificateStatus } from '../practical/certificate';");
  });

  it('the shadow tree and the composition root name no issuer, consumer, lease, durable practical write, mutation, arm, dispatch, or strict-continuity symbol', () => {
    for (const file of [...shadowFiles, SHADOW_RUNTIME]) {
      const code = codeOf(file);
      for (const forbidden of FORBIDDEN_AUTHORITY_NAMES) expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
    }
  });

  it('shadow can never manufacture stream readiness: it names no subscription confirmation and constructs no PROVEN_READY', () => {
    for (const file of [...shadowFiles, SHADOW_RUNTIME]) {
      const code = codeOf(file);
      expect(code.includes('subscriptionConfirmation'), file).toBe(false);
      expect(code, file).not.toMatch(/kind: 'PROVEN_READY'/);
    }
    // Readiness comes only from the Checkpoint B derivation.
    expect(codeOf(`${SHADOW_ROOT}collector.ts`)).toContain('const readiness = practicalPrivateStreamReadiness(health);');
  });

  it('the durable practical account is READ-ONLY to shadow: exactly Pick<PracticalSafetyRepository, "loadAccount">', () => {
    expect(codeOf(`${SHADOW_ROOT}collector.ts`)).toContain("export type PracticalShadowPracticalAccountReader = Pick<PracticalSafetyRepository, 'loadAccount'>;");
    const runtime = codeOf(SHADOW_RUNTIME);
    expect([...runtime.matchAll(/practicalRepository\.(\w+)/g)].map((match) => match[1])).toEqual(['loadAccount']);
    expect([...runtime.matchAll(/reconciliationRepository\.(\w+)/g)].map((match) => match[1])).toEqual(['loadState']);
  });

  it('the shadow store touches ONLY live_practical_shadow_* tables', () => {
    const repository = codeOf(`${SHADOW_ROOT}repository.ts`);
    const tables = new Set([...repository.matchAll(/\b(live_[a-z_]+)\b/g)].map((match) => match[1]));
    for (const table of tables) expect(table, table).toMatch(/^live_practical_shadow_/);
    const models = new Set([...repository.matchAll(/tx\.(\w+)\./g)].map((match) => match[1]));
    for (const model of models) expect(model, model).toMatch(/^livePracticalShadow/);
    expect(repository).not.toMatch(/livePractical(AccountState|AccountFence|Certificate|MutationLease|RecoveryEpisode|ReviewEpisode|MalformedLatch)\b/);
  });

  it('shadow reuses Checkpoint B only through its pure read-only modules; Checkpoint B remains the only issuer importer', () => {
    for (const file of shadowFiles) {
      for (const dependency of (graph.get(file) ?? []).filter((node) => node.startsWith('src/execution/live/practical-recovery/'))) {
        expect(['observation.ts', 'private-events.ts', 'ports.ts', 'telemetry.ts', 'timing.ts'].map((name) => `src/execution/live/practical-recovery/${name}`), `${file} -> ${dependency}`).toContain(dependency);
      }
    }
    const issuerImporters = files.filter((file) => codeOf(file).includes('issuePracticalRecoveryCertificate') && file !== CERTIFICATE);
    expect(issuerImporters).toEqual(['src/execution/live/practical-recovery/service.ts']);
  });
});

describe('the COMPOSITION ROOT is read-only with respect to CoinDCX and opt-in', () => {
  it('reaches no order gateway, mutation transport, production runtime, gateway, dispatch, recovery engine, or tripwire', () => {
    const reach = reachOf(SHADOW_RUNTIME);
    for (const forbidden of [
      'src/integration/coindcx/live/order-gateway.ts', 'src/integration/coindcx/live/mutation-transport.ts', 'src/integration/coindcx/live/production-runtime.ts',
      'src/execution/live/gateway.ts', 'src/execution/live/service.ts', 'src/execution/live/authority.ts',
      'src/execution/live/practical-recovery/service.ts', 'src/execution/live/practical-recovery/tripwire.ts', 'src/execution/live/reconciliation/gateway-orphan-cancellation.ts',
    ]) {
      expect(reach.includes(forbidden), `shadow runtime reaches ${forbidden}`).toBe(false);
    }
    expect(reach.filter((node) => node.startsWith('src/dispatch/'))).toEqual([]);
  });

  it('start is disabled unless LIVE_PRACTICAL_SHADOW_ENABLED=true, and the CoinDCX client it builds is the read-only REST client', () => {
    const runtime = codeOf(SHADOW_RUNTIME);
    expect(runtime).toContain("if (context.env['LIVE_PRACTICAL_SHADOW_ENABLED'] !== 'true') {");
    const start = runtime.slice(runtime.indexOf('async function commandStart('), runtime.indexOf('async function commandStop('));
    expect(start.indexOf("context.env['LIVE_PRACTICAL_SHADOW_ENABLED'] !== 'true'")).toBeLessThan(start.indexOf('readOnlySources('));
    const client = codeOf('src/integration/coindcx/client.ts');
    expect([...client.matchAll(/public async (\w+)\(/g)].map((match) => match[1]).every((name) => /^(get|list|find)/.test(name!))).toBe(true);
    // Credentials are never printed.
    expect(runtime).not.toMatch(/io\.(out|err)\([^)]*(apiKey|apiSecret)/);
  });
});

describe('the three concepts are distinct types, none of them authority', () => {
  function acceptCertificate(_certificate: PracticalRecoveryCertificate): void {
    // compile-time only
  }
  function acceptEnablement(_enablement: PracticalLiveSafetyEnablement): void {
    // compile-time only
  }
  function acceptCandidate(_candidate: PracticalRestStabilityCandidate): void {
    // compile-time only
  }
  function acceptEligibility(_eligibility: PracticalAuthorityEligibility): void {
    // compile-time only
  }
  function acceptPaperDecision(_decision: PracticalPaperSafetyDecision): void {
    // compile-time only
  }
  function acceptPaperIntent(_intent: PracticalPaperIntent): void {
    // compile-time only
  }

  it('type level (enforced by `npm run typecheck`): no shadow value is a certificate, an enablement, or another shadow concept', () => {
    const candidate = null as unknown as PracticalRestStabilityCandidate;
    const eligibility = null as unknown as PracticalAuthorityEligibility;
    const decision = null as unknown as PracticalPaperSafetyDecision;
    // @ts-expect-error a REST stability candidate is not a practical recovery certificate
    acceptCertificate(candidate);
    // @ts-expect-error authority eligibility is not a practical recovery certificate
    acceptCertificate(eligibility);
    // @ts-expect-error a paper decision is not a practical recovery certificate
    acceptCertificate(decision);
    // @ts-expect-error authority eligibility is not the Tier-B enablement
    acceptEnablement(eligibility);
    // @ts-expect-error a REST stability candidate is not the Tier-B enablement
    acceptEnablement(candidate);
    // @ts-expect-error a REST stability candidate is not authority eligibility
    acceptEligibility(candidate);
    // @ts-expect-error authority eligibility is not a REST stability candidate
    acceptCandidate(eligibility);
    // @ts-expect-error a REST stability candidate is not a paper decision
    acceptPaperDecision(candidate);
    // @ts-expect-error a plain look-alike object is not a REST stability candidate
    acceptCandidate({ concept: 'REST_STABILITY_CANDIDATE', result: 'PASS', failure: null, grantsAuthority: false });
    // @ts-expect-error a plain look-alike object is not authority eligibility
    acceptEligibility({ concept: 'AUTHORITY_ELIGIBILITY', authorityEligible: true, blockers: [], primaryBlocker: null, grantsAuthority: false });
    // @ts-expect-error a mutation action string is not a paper intent
    acceptPaperIntent('CANCEL');
    expect(true).toBe(true);
  });

  it('runtime: a shadow value is rejected by the certificate reader and the enablement gate, and says grantsAuthority: false', () => {
    const evidence = parsePracticalShadowEvidence({
      schemaVersion: 'P18B_SHADOW_EVIDENCE_V1', evaluationId: 'e', campaignId: 'c', accountId: 'a', expectedProviderAccountFingerprint: 'f'.repeat(64), runtimeEpoch: 'r',
      window: { minimumPasses: 3, minimumPassSpacingMs: 1, minimumCertificationSpanMs: 1 },
      timing: { readCandidateMs: 1, passCandidateMs: 1, interReadGapCandidateMs: 1, hardReadTimeoutMs: 1, hardPassDurationMs: 1 },
      startedAtMs: 0, endedAtMs: 0, clockAnomaly: false, reads: [],
      readiness: { atStart: { atMs: 0, readiness: 'PROVEN_READY', unprovenReason: null, incarnation: 1 }, samples: [], atEnd: { atMs: 0, readiness: 'PROVEN_READY', unprovenReason: null, incarnation: 1 } },
      streamHealthTrip: null, events: { total: 0, byReason: {} }, reconciliation: [], generationBaseline: null,
      practicalAccount: { readable: false, problem: 'NOT_FOUND', state: null, fenceMode: null, fenceGeneration: null, fenceRuntimeEpochMatches: null, hasCurrentCertificate: null, hasLease: null },
      tierB: { status: 'DISABLED', disabledReason: 'NOT_EXPLICITLY_ENABLED', accountAllowlisted: false },
    });
    const classification = classifyPracticalShadowEvaluation(evidence, [practicalPaperIntent('CANCEL', 'STAGE_5A_CANCEL_ONLY')]);
    for (const value of [classification.rest, classification.authority, ...classification.paperDecisions]) {
      expect(PracticalRecoveryCertificate.read(value)).toBeNull();
      expect(() => requirePracticalLiveSafetyEnablement(value)).toThrow();
      expect(value.grantsAuthority).toBe(false);
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});

describe('no automatic threshold tuning; observational configuration only', () => {
  it('the shadow core reads no environment, writes no file, and never reassigns a timing or policy value', () => {
    for (const file of shadowFiles) {
      // (repository.ts carries only its database transaction timeout, which is not a calibration value.)
      if (file === `${SHADOW_ROOT}repository.ts`) continue;
      const code = codeOf(file);
      for (const forbidden of ['process.env', 'writeFile', 'appendFile', "from 'node:fs'", 'PRACTICAL_TIMING_CANDIDATES =', 'PRACTICAL_SAFETY_CEILINGS =', 'PRACTICAL_RECOVERY_HARD_CEILINGS =', 'Date.now', 'new Date(']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
      expect(code, file).not.toMatch(/\b(3_?000|15_?000|2_?000|10_?000|30_?000|20_?000|120_?000)\b/);
    }
    const config = codeOf(`${SHADOW_ROOT}config.ts`);
    for (const source of ['PRACTICAL_TIMING_CANDIDATES.readDuration.valueMs', 'PRACTICAL_TIMING_CANDIDATES.passWindow.valueMs', 'PRACTICAL_TIMING_CANDIDATES.interReadGap.valueMs',
      'PRACTICAL_RECOVERY_HARD_CEILINGS.readTimeoutMs', 'PRACTICAL_RECOVERY_HARD_CEILINGS.passDurationMs', 'PRACTICAL_SAFETY_CEILINGS.minimumPasses']) {
      expect(config).toContain(source);
    }
    const analysis = codeOf(`${SHADOW_ROOT}analysis.ts`);
    expect(analysis).toContain("status: 'CALIBRATION_RECOMMENDATION' as const");
    expect(analysis).toContain('appliesAutomatically: false as const');
    expect(analysis).not.toMatch(/SAFE_THRESHOLD|PROVIDER_GUARANTEE/);
  });

  it('the only external packages in the shadow core reach are hashing, logging, decimals, and (repository only) Prisma', () => {
    const external = new Set<string>();
    for (const file of shadowFiles.filter((name) => name !== `${SHADOW_ROOT}repository.ts`)) {
      for (const node of reachOf(file)) {
        for (const specifier of extractImportSpecifiers(sourceOf(node), node)) if (!specifier.startsWith('.')) external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual(['decimal.js', 'node:crypto', 'pino']);
  });
});

describe('the Checkpoint C migration', () => {
  function migrationSql(): string {
    return readFileSync(path.join(MIGRATIONS_ROOT, MIGRATION, 'migration.sql'), 'utf8');
  }

  it('is the newest migration, FROZEN under its exact name and accepted hash', () => {
    const directories = readdirSync(MIGRATIONS_ROOT).filter((name) => statSync(path.join(MIGRATIONS_ROOT, name)).isDirectory()).sort();
    expect(directories.at(-1)).toBe(MIGRATION);
    expect(readdirSync(path.join(MIGRATIONS_ROOT, MIGRATION))).toEqual(['migration.sql']);
    expect(sourceOf('tests/architecture/phase18-migration-freeze.test.ts')).toContain(`'${MIGRATION}': '6cf2095f5d05be54c248fe43e113e67156af9f783ce4fb21948722fcaa6811e9',`);
  });

  it('is purely additive: it creates and constrains only live_practical_shadow_* tables and references nothing else', () => {
    const statements = migrationSql().split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').split(';').map((statement) => statement.trim()).filter((statement) => statement.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, statement).toMatch(/^(CREATE TABLE `live_practical_shadow_[a-z_]+`|ALTER TABLE `live_practical_shadow_[a-z_]+`)/);
      expect(statement, statement).not.toMatch(/\b(DROP|RENAME|MODIFY|CHANGE)\b/);
      for (const reference of statement.matchAll(/REFERENCES `([a-z_]+)`/g)) expect(reference[1]).toMatch(/^live_practical_shadow_/);
    }
  });

  it('the database enforces the safety invariants: never eligible or gate-reaching without PROVEN_READY; ABORTED never carries a result', () => {
    const sql = migrationSql();
    for (const constraint of [
      'practical_shadow_evaluation_status_chk',
      'practical_shadow_evaluation_authority_chk',
      'practical_shadow_evaluation_blocker_chk',
      'practical_shadow_evaluation_rest_chk',
      'practical_shadow_paper_decision_prerequisites_chk',
      'practical_shadow_paper_decision_gate_chk',
      'practical_shadow_campaign_end_chk',
      'practical_shadow_campaign_provenance_chk',
    ]) {
      expect(sql).toContain(`ADD CONSTRAINT \`${constraint}\` CHECK`);
    }
    expect(sql).toContain("`authority_eligible` IS NULL OR `authority_eligible` = FALSE OR (`stream_readiness` = 'PROVEN_READY' AND `rest_stability` = 'PASS')");
    expect(sql).toContain("OR (`requested_action` = 'CANCEL' AND `rollout_stage` = 'STAGE_5A_CANCEL_ONLY' AND `authority_prerequisites_met` = TRUE");
    // P18B-C-01: only an exact CLEAN lowercase 40-hex commit can be stored (case-sensitive match).
    expect(sql).toContain("`source_provenance` = 'GIT_CLEAN_COMMIT' AND REGEXP_LIKE(`software_version`, '^[0-9a-f]{40}$', 'c')");
    expect(sql).toContain("`source_provenance` ENUM('GIT_CLEAN_COMMIT') NOT NULL");
    // P18B-C-03/C-04: digest SHAPES are CHECKed (the digests themselves are recomputed by the repository), and a paper
    // decision names its evaluation AND that evaluation's campaign (composite foreign key).
    expect(sql).toContain("REGEXP_LIKE(`config_digest`, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(`provider_account_fingerprint`, '^[0-9a-f]{64}$', 'c')");
    expect(sql).toContain("`evidence_digest` IS NULL OR REGEXP_LIKE(`evidence_digest`, '^[0-9a-f]{64}$', 'c')");
    expect(sql).toContain("REGEXP_LIKE(`paper_decision_id`, '^pd-[0-9a-f]{48}$', 'c')");
    expect(sql).toContain('FOREIGN KEY (`evaluation_id`, `campaign_id`) REFERENCES `live_practical_shadow_evaluation`(`evaluation_id`, `campaign_id`)');
    expect(sql).toContain('UNIQUE INDEX `live_practical_shadow_account_active_campaign_key`(`active_campaign_id`)');
    expect(sql).toContain('UNIQUE INDEX `live_practical_shadow_evaluation_sequence_key`(`campaign_id`, `sequence`)');
    expect(sql).toContain('UNIQUE INDEX `live_practical_shadow_paper_decision_intent_key`(`evaluation_id`, `requested_action`, `rollout_stage`)');
  });

  it('stores no credential, signature, raw provider identity, or raw payload column', () => {
    const sql = migrationSql().split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/api_?key|apiKey|secret|signature|authorization|coindcx_?id|coindcxId|payload|raw_|password|token/i);
    expect(sql).toContain('`provider_account_fingerprint` CHAR(64) NOT NULL');
  });
});

describe('P18B-C-01 software provenance: a clean exact commit, no dirty/development mode', () => {
  function body(code: string, start: string, end: string): string {
    const from = code.indexOf(start);
    const to = code.indexOf(end, from + start.length);
    expect(from, start).toBeGreaterThanOrEqual(0);
    expect(to, end).toBeGreaterThan(from);
    return code.slice(from, to);
  }

  it('the runner refuses a non-CLEAN source before touching the store, and binds the clean commit', () => {
    const open = body(codeOf(`${SHADOW_ROOT}campaign.ts`), 'public async open(', 'public async runEvaluation(');
    expect(open.indexOf('practicalShadowSourceRefusal(')).toBeGreaterThanOrEqual(0);
    expect(open.indexOf('practicalShadowSourceRefusal(')).toBeLessThan(open.indexOf('this.#deps.store.'));
    const binding = body(codeOf(`${SHADOW_ROOT}campaign.ts`), '#binding(): PracticalShadowCampaignBinding | null {', '#nextId(');
    expect(binding).toContain('softwareVersion: provenance.commit,');
    expect(binding).toContain('sourceProvenance: provenance.kind,');
  });

  it('CLI start and stop resolve provenance before any database or network access; the script probes git with untracked files included and has no fallback version', () => {
    const runtime = codeOf(SHADOW_RUNTIME);
    const start = body(runtime, 'async function commandStart(', 'async function commandStop(');
    expect(start.indexOf('cleanSourceProvenance(context)')).toBeGreaterThanOrEqual(0);
    expect(start.indexOf('cleanSourceProvenance(context)')).toBeLessThan(start.indexOf('readOnlySources('));
    const stop = body(runtime, 'async function commandStop(', 'async function snapshotFor(');
    expect(stop.indexOf('cleanSourceProvenance(context)')).toBeLessThan(stop.indexOf('new PrismaPracticalShadowStore('));
    expect(runtime).not.toMatch(/softwareVersion:\s*context\./);
    const script = codeOf('scripts/practical-shadow.ts');
    expect(script).toContain("git(['rev-parse', '--verify', 'HEAD'])");
    expect(script).toContain("git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])");
    expect(script).not.toMatch(/unknown-software-version|softwareVersion/);
  });

  it('there is exactly ONE accepted provenance kind; no dirty, development, or override mode exists anywhere', () => {
    const provenance = codeOf(`${SHADOW_ROOT}provenance.ts`);
    expect(provenance).toContain("export const PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND = 'GIT_CLEAN_COMMIT';");
    expect(provenance).toContain('export const PRACTICAL_SHADOW_SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;');
    const schema = sourceOf('prisma/schema.prisma');
    expect(schema.slice(schema.indexOf('enum LivePracticalShadowSourceProvenance {')).split('}')[0]!.replace(/\s+/g, ' ').trim()).toBe('enum LivePracticalShadowSourceProvenance { GIT_CLEAN_COMMIT');
    for (const file of [...shadowFiles, SHADOW_RUNTIME, 'scripts/practical-shadow.ts']) {
      expect(codeOf(file), file).not.toMatch(/allowDirty|ALLOW_DIRTY|DIRTY_DEVELOPMENT|DEVELOPMENT_MODE|developmentMode|SOURCE_OVERRIDE|sourceOverride/);
    }
    // The analysis never marks a dataset review-eligible without a trusted clean commit.
    const analysis = codeOf(`${SHADOW_ROOT}analysis.ts`);
    expect(analysis).toMatch(/const eligibleForHumanCalibrationReview = trustedSourceProvenance\s*&&/);
  });
});

describe('P18B-C-02 the explicit operator abort is separate, exact, and shadow-only', () => {
  function body(code: string, start: string, end: string): string {
    const from = code.indexOf(start);
    const to = code.indexOf(end, from + start.length);
    expect(from, start).toBeGreaterThanOrEqual(0);
    expect(to, end).toBeGreaterThan(from);
    return code.slice(from, to);
  }

  it('start and stop never abort: the runner class and the start/stop commands never call the operator abort', () => {
    const campaign = codeOf(`${SHADOW_ROOT}campaign.ts`);
    const runnerClass = body(campaign, 'export class PracticalShadowCampaignRunner {', 'export async function abortPracticalShadowCampaign(');
    expect(runnerClass).not.toMatch(/abortCampaign\(|abortPracticalShadowCampaign\(/);
    const runtime = codeOf(SHADOW_RUNTIME);
    for (const [start, end] of [['async function commandStart(', 'async function commandStop('], ['async function commandStop(', 'async function snapshotFor(']] as const) {
      expect(body(runtime, start, end)).not.toMatch(/abortCampaign\(|abortPracticalShadowCampaign\(/);
    }
    expect([...runtime.matchAll(/abortPracticalShadowCampaign\(/g)]).toHaveLength(1);
  });

  it('the CLI abort requires exact --account/--campaign/--reason and does no read, collection, resume, or source probe', () => {
    const abort = body(codeOf(SHADOW_RUNTIME), 'async function commandAbort(', 'export async function runPracticalShadowCli(');
    for (const flag of ["argValue(argv, '--account')", "argValue(argv, '--campaign')", "argValue(argv, '--reason')"]) expect(abort).toContain(flag);
    expect(abort).not.toMatch(/context\.env|readOnlySources|CoinDcxClient|CampaignRunner|sourceProbe|resumeCampaign|\.start\(|loadActiveCampaign/);
  });

  it('the store abort locks account then campaign, is ACTIVE-only compare-and-set, creates nothing, and never re-activates a campaign', () => {
    const repository = codeOf(`${SHADOW_ROOT}repository.ts`);
    const abort = body(repository, 'public async abortCampaign(', 'public async claimEvaluation(');
    expect(abort.indexOf('readAccount(tx, input.accountId)')).toBeLessThan(abort.indexOf('readCampaign(tx, input.campaignId, true)'));
    expect(abort).toContain("if (campaign.accountId !== input.accountId) return refused('ACCOUNT_MISMATCH');");
    expect(abort).toContain("if (campaign.status !== 'ACTIVE') return Object.freeze({ kind: 'ALREADY_TERMINAL' as const, campaign });");
    expect(abort).toContain("where: { campaignId: campaign.campaignId, revision: BigInt(campaign.revision), status: 'ACTIVE' },");
    expect(abort).toContain("data: { status: 'ABORTED',");
    expect(abort).not.toMatch(/\.create\(|livePracticalShadowPaperDecision|'COMPLETED'/);
    expect(abort.match(/data: \{[^}]*status: '([A-Z]+)'/g)?.every((entry) => entry.includes("'ABORTED'"))).toBe(true);
  });
});

describe('P18B-C-03/C-04/C-05 durable-dataset integrity is enforced at the store boundary and in replay', () => {
  function body(code: string, start: string, end: string): string {
    const from = code.indexOf(start);
    const to = code.indexOf(end, from + start.length);
    expect(from, start).toBeGreaterThanOrEqual(0);
    expect(to, end).toBeGreaterThan(from);
    return code.slice(from, to);
  }

  it('C-03: the persisted config is read ONLY through the digest-checking parser (store start, completion, replay)', () => {
    for (const file of [...shadowFiles, SHADOW_RUNTIME]) {
      if (file === `${SHADOW_ROOT}config.ts`) continue;
      expect(codeOf(file), file).not.toMatch(/JSON\.parse\([^)]*configJson/);
    }
    const config = codeOf(`${SHADOW_ROOT}config.ts`);
    const parser = body(config, 'export function parsePracticalShadowConfigSnapshot(', '\n}\n');
    // The digest is compared BEFORE any version or value is read.
    expect(parser.indexOf('sha256CanonicalJson(parsed) !== expectedDigest')).toBeGreaterThan(0);
    expect(parser.indexOf('sha256CanonicalJson(parsed) !== expectedDigest')).toBeLessThan(parser.indexOf("raw['schema']"));
    const replay = body(codeOf(`${SHADOW_ROOT}replay.ts`), 'export function replayPracticalShadowSnapshot(', 'return Object.freeze({\n    analysisVersion');
    expect(replay).toContain('parsePracticalShadowConfigSnapshot(campaign.configJson, campaign.configDigest)');
    expect(replay).toContain('if (config.analysisVersion !== analysisVersion)');
    const repository = codeOf(`${SHADOW_ROOT}repository.ts`);
    const start = body(repository, 'public async startCampaign(', 'public async resumeCampaign(');
    expect(start.indexOf('parsePracticalShadowConfigSnapshot(input.configJson, input.binding.configDigest)')).toBeGreaterThan(0);
    expect(start.indexOf('parsePracticalShadowConfigSnapshot(input.configJson, input.binding.configDigest)')).toBeLessThan(start.indexOf('this.#transaction('));
  });

  it('C-04: completion is verified against its evidence inside the transaction BEFORE any write; replay binds evidence to the campaign; one shared record builder', () => {
    const complete = body(codeOf(`${SHADOW_ROOT}repository.ts`), 'public async completeEvaluation(', 'public async abortEvaluation(');
    const verify = complete.indexOf('verifyPracticalShadowCompletion({ campaign, evaluation, result, paperDecisions: input.paperDecisions })');
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(complete.indexOf('livePracticalShadowEvaluation.updateMany('));
    expect(verify).toBeLessThan(complete.indexOf('livePracticalShadowPaperDecision.create('));
    const integrity = codeOf(`${SHADOW_ROOT}integrity.ts`);
    for (const field of ["'accountId', evidence.accountId, input.campaign.accountId", "'expectedProviderAccountFingerprint', evidence.expectedProviderAccountFingerprint, input.campaign.providerAccountFingerprint",
      "'campaignId', evidence.campaignId, input.campaign.campaignId", "'evaluationId', evidence.evaluationId, input.evaluation.evaluationId", "'schemaVersion', evidence.schemaVersion, input.campaign.evidenceSchemaVersion"]) {
      expect(integrity).toContain(field);
    }
    expect(codeOf(`${SHADOW_ROOT}replay.ts`)).toContain('verifyPracticalShadowEvidenceBinding({');
    expect(codeOf(`${SHADOW_ROOT}campaign.ts`)).toContain('buildPracticalShadowCompletion(evidence, this.#deps.config.paperIntents)');
    expect(codeOf(`${SHADOW_ROOT}campaign.ts`)).not.toMatch(/classifyPracticalShadowEvaluation|practicalShadowEvidenceDigest/);
  });

  it('C-05: every lookup by a caller-supplied id is re-checked with exact equality (no normalization)', () => {
    const repository = codeOf(`${SHADOW_ROOT}repository.ts`);
    expect(repository).toContain('return row !== undefined && row[column] === requested ? row : null;');
    expect(repository.match(/exactly\(rows, 'campaignId', campaignId\)/g)).toHaveLength(2);
    expect(repository.match(/exactly\(rows, 'evaluationId', evaluationId\)/g)).toHaveLength(1);
    expect(repository).toContain("if (row['accountId'] !== accountId) conflict(");
    expect(repository).toContain('account.accountId !== accountId');
    expect(repository).not.toMatch(/toLowerCase\(|toUpperCase\(|localeCompare\(/);
    const abortEvaluation = body(repository, 'public async abortEvaluation(', 'public async loadActiveCampaign(');
    expect(abortEvaluation.indexOf('readEvaluation(tx, input.evaluationId, true)')).toBeLessThan(abortEvaluation.indexOf('updateMany('));
    expect(abortEvaluation).toContain('where: { evaluationId: evaluation.evaluationId,');
  });

  it('the provider descriptor bound into the config digest is exactly what the runtime connects to (no credential in it)', () => {
    const runtime = codeOf(SHADOW_RUNTIME);
    expect(runtime).toContain("provider: { restOrigin: context.env['COINDCX_BASE_URL']?.trim() || DEFAULT_BASE_URL, streamEndpoint: COINDCX_DEFAULT_SOCKET_ENDPOINT },");
    expect(runtime).toContain('new CoinDcxClient({ apiKey, apiSecret, baseUrl: config.provider.restOrigin })');
    expect(runtime).toContain('endpoint: config.provider.streamEndpoint,');
    expect(runtime.split("context.env['COINDCX_BASE_URL']")).toHaveLength(2);
    const config = codeOf(`${SHADOW_ROOT}config.ts`);
    expect(config).toContain("url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''");
  });
});

describe('P18B-C-06/C-07/C-08 one configured protocol, a closed evidence schema, and resume only of an intact campaign', () => {
  function body(code: string, start: string, end: string): string {
    const from = code.indexOf(start);
    const to = code.indexOf(end, from + start.length);
    expect(from, start).toBeGreaterThanOrEqual(0);
    expect(to, end).toBeGreaterThan(from);
    return code.slice(from, to);
  }

  it('C-06: evidence is bound to the LOCKED claimed evaluation (runtime epoch) and EXACTLY to the configured window + timing, before classification', () => {
    const integrity = codeOf(`${SHADOW_ROOT}integrity.ts`);
    expect(integrity).toContain("['runtimeEpoch', evidence.runtimeEpoch, input.evaluation.runtimeEpoch]");
    expect(integrity).toContain("const WINDOW_FIELDS = ['minimumPasses', 'minimumPassSpacingMs', 'minimumCertificationSpanMs'] as const;");
    expect(integrity).toContain("const TIMING_FIELDS = ['readCandidateMs', 'passCandidateMs', 'interReadGapCandidateMs', 'hardReadTimeoutMs', 'hardPassDurationMs'] as const;");
    expect(integrity).toContain('evidence.window[field] !== input.protocol.window[field]');
    expect(integrity).toContain('evidence.timing[field] !== input.protocol.timing[field]');
    const verify = body(integrity, 'export function verifyPracticalShadowCompletion(', 'return Object.freeze({ result: expected.result');
    expect(verify.indexOf('protocol: config,')).toBeLessThan(verify.indexOf('buildPracticalShadowCompletion('));
    expect(body(codeOf(`${SHADOW_ROOT}replay.ts`), 'verifyPracticalShadowEvidenceBinding({', '});')).toMatch(/evaluation: row,\s*protocol: config,/);
  });

  it('C-07: V1 evidence is a CLOSED schema; only the rebuilt canonical record is ever persisted', () => {
    const evidence = codeOf(`${SHADOW_ROOT}evidence.ts`);
    const parser = body(evidence, 'export function parsePracticalShadowEvidence(', '\n}\n');
    // Every structured object goes through the exact-field-set reader; no value is cast from an unchecked string.
    expect(parser.match(/closed\(/g)!.length).toBeGreaterThanOrEqual(6);
    expect(evidence).not.toMatch(/as PracticalReadFailure|strOrNull|function str\(/);
    for (const reader of ['readinessSample', 'read', 'reconciliationSample', 'practicalAccount']) {
      expect(body(evidence, `function ${reader}(`, '\n}\n')).toContain('closed(value, path, [');
    }
    // The builder and the store never classify, digest, or persist anything but the rebuilt record.
    expect(body(codeOf(`${SHADOW_ROOT}integrity.ts`), 'export function buildPracticalShadowCompletion(', 'const classification')).toContain('parsePracticalShadowEvidence(collected)');
    const complete = body(codeOf(`${SHADOW_ROOT}repository.ts`), 'public async completeEvaluation(', 'public async abortEvaluation(');
    expect(complete).toContain('evidenceJson: record.evidenceJson,');
    expect(complete).not.toMatch(/evidenceJson: (result|input\.result)\.evidenceJson/);
    expect(complete).toContain('for (const decision of verified.paperDecisions)');
  });

  it('C-08: resume validates the stored configuration under the lock BEFORE comparing the binding or writing; abort does not depend on it', () => {
    const repository = codeOf(`${SHADOW_ROOT}repository.ts`);
    const resume = body(repository, 'public async resumeCampaign(', 'public async stopCampaign(');
    const parse = resume.indexOf('parsePracticalShadowConfigSnapshot(campaign.configJson, campaign.configDigest)');
    expect(parse).toBeGreaterThan(resume.indexOf('readCampaign(tx, account.activeCampaignId, true)'));
    expect(parse).toBeLessThan(resume.indexOf('bindingMismatches(campaign, input.binding)'));
    expect(parse).toBeLessThan(resume.indexOf('updateMany('));
    expect(body(repository, 'public async abortCampaign(', 'public async claimEvaluation(')).not.toMatch(/parsePracticalShadowConfigSnapshot|configJson/);
  });
});
