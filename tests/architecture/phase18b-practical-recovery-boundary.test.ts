import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentAccountContinuityCapability, requireCurrentReconciliation } from '../../src/execution/live/reconciliation/barrier';
import { PRACTICAL_TIMING_CANDIDATES } from '../../src/execution/live/practical/policy';
import { PRACTICAL_PASS_READ_PLAN } from '../../src/execution/live/practical-recovery/observation';
import { PRACTICAL_PRIVATE_BINDABLE_STATES, bindPracticalPrivateStream, practicalPrivateStreamReadiness } from '../../src/execution/live/practical-recovery/private-events';
import { PRACTICAL_RECOVERY_HARD_CEILINGS } from '../../src/execution/live/practical-recovery/timing';
import { buildImportGraph, computeReachable, extractImportSpecifiers } from './support/import-graph';

// Phase 18B Checkpoint B: the READ-ONLY practical recovery core.
//
//   - It reaches no CoinDCX module, no gateway, no mutation owner, no
//     dispatch or arm path, no Phase 17/18 repository, no strict barrier, and
//     no Prisma adapter; venue access is the read-only port only.
//   - It holds no Stage 1B2 lease operation.
//   - It is the ONE production importer of the certificate issuer; the
//     enablement and resolution issuers stay unimported.
//   - The private-stream path (tripwire + classifier) can revoke, never mint,
//     and a watch binds only to a READY stream (never RECONCILIATION_REQUIRED).
//   - One pass is the bracketed read plan identity, O1 P1 O2 P2 O3, identity.
//   - Calibration candidates are telemetry markers only; the only fail-closed
//     timing values are the named hard ceilings in timing.ts.
//   - Nothing in src/ imports it yet (not wired into any runtime).

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const RECOVERY_ROOT = 'src/execution/live/practical-recovery/';
const BARRIER = 'src/execution/live/reconciliation/barrier.ts';

const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
const recoveryFiles = files.filter((file) => file.startsWith(RECOVERY_ROOT)).sort();

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function reachOf(file: string): readonly string[] {
  return [file, ...computeReachable(graph, file)];
}

describe('module layout', () => {
  it('the recovery tree is exactly the reviewed Checkpoint B modules', () => {
    const onDisk = readdirSync(path.join(REPO_ROOT, RECOVERY_ROOT)).filter((name) => name.endsWith('.ts')).sort();
    expect(onDisk).toEqual(['observation.ts', 'ports.ts', 'private-events.ts', 'service.ts', 'telemetry.ts', 'timing.ts', 'tripwire.ts']);
    expect(recoveryFiles).toEqual(onDisk.map((name) => `${RECOVERY_ROOT}${name}`));
  });

  it('nothing in src/ imports the recovery core yet (no runtime wiring)', () => {
    const importers = files.filter((file) => !file.startsWith(RECOVERY_ROOT) && (graph.get(file) ?? []).some((dependency) => dependency.startsWith(RECOVERY_ROOT)));
    expect(importers).toEqual([]);
  });
});

describe('READ-ONLY: no route to any venue mutation, dispatch, or arm', () => {
  it('reaches no CoinDCX/integration module, gateway, mutation owner, Phase 17/18 repository or service, strict barrier, dispatch, or Prisma adapter', () => {
    for (const file of recoveryFiles) {
      const reach = reachOf(file);
      expect(reach.filter((node) => node.startsWith('src/integration/')), file).toEqual([]);
      expect(reach.filter((node) => node.startsWith('src/dispatch/') || node.startsWith('src/coin-runtime/') || node.startsWith('src/persistence/')), file).toEqual([]);
      for (const forbidden of [
        BARRIER,
        'src/execution/live/gateway.ts',
        'src/execution/live/authority.ts',
        'src/execution/live/service.ts',
        'src/execution/live/repository.ts',
        'src/execution/live/gate.ts',
        'src/execution/live/reconciliation/repository.ts',
        'src/execution/live/reconciliation/service.ts',
        'src/execution/live/reconciliation/ports.ts',
        'src/execution/live/reconciliation/gateway-orphan-cancellation.ts',
        'src/execution/live/practical-persistence/repository.ts',
      ]) {
        expect(reach.includes(forbidden), `${file} reaches ${forbidden}`).toBe(false);
      }
    }
  });

  it('names no mutation, dispatch, arm, lease, or Phase 18 write primitive', () => {
    for (const file of recoveryFiles) {
      const code = codeOf(file);
      for (const forbidden of [
        'consumeCertificateAndLease', 'releaseLease', 'placeOrder', 'createOrder', 'cancelOrder', 'cancelVenueOrder', 'closePosition',
        'armDispatchWire', 'armCancelWire', 'armOrphanCancelWire', 'claimDispatch', 'dispatch(', 'claimGeneration', 'completeRun',
        'recordSnapshot', 'persistFindings', 'applyPositionOwnership', 'OrderGateway', 'MutationTransport', 'orphanCancellation',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it('the durable dependency is exactly the Stage 1B1 subset a read-only core needs (the lease path is absent)', () => {
    const ports = codeOf(`${RECOVERY_ROOT}ports.ts`);
    const pick = ports.slice(ports.indexOf('export type PracticalRecoveryPersistence = Pick<'), ports.indexOf('>;', ports.indexOf('export type PracticalRecoveryPersistence')));
    const methods = [...pick.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]).sort();
    expect(methods).toEqual([
      'adoptForNewRuntime', 'escalateMalformedAccount', 'expireCertificate', 'failCertification', 'finishCertification',
      'initializeAccount', 'invalidate', 'loadAccount', 'recordProviderRecovered', 'startCertification',
    ]);
    expect(ports).toMatch(/export type PracticalRevocationPort = Pick<PracticalSafetyRepository, 'invalidate'>;/);
  });

  it('the venue port is read-only: exactly identity, orders, positions', () => {
    const ports = codeOf(`${RECOVERY_ROOT}ports.ts`);
    const start = ports.indexOf('export interface PracticalVenueReadPort {');
    const venue = ports.slice(start, ports.indexOf('\n}', start));
    expect([...venue.matchAll(/\n\s+(\w+)\(/g)].map((match) => match[1]).sort()).toEqual(['readAccountIdentity', 'readOrders', 'readPositions']);
  });
});

describe('no strict-continuity bridge', () => {
  it('names no strict continuity symbol; nothing claims continuity or an atomic snapshot', () => {
    for (const file of recoveryFiles) {
      const code = codeOf(file);
      for (const forbidden of [
        'requireCurrentReconciliation', 'currentAccountContinuityCapability', 'LiveAccountContinuityCapability', 'ACCOUNT_CONTINUITY_PROVEN',
        'authorizeCurrentHealthy', 'LiveReconciliationAuthorization', 'evaluateReconciliationBarrier', 'provesAccountContinuity: true',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
    expect(sourceOf(`${RECOVERY_ROOT}observation.ts`)).toContain('THIS IS NOT AN ATOMIC SNAPSHOT AND NOT CONTINUITY');
  });

  it('the strict barrier does not reach the recovery core, and keeps its semantics', () => {
    expect(reachOf(BARRIER).filter((file) => file.startsWith(RECOVERY_ROOT))).toEqual([]);
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
    expect(requireCurrentReconciliation).toHaveLength(4);
  });
});

describe('authority issuance', () => {
  it('the recovery SERVICE is the only recovery module that names the certificate issuer; the enablement and resolution issuers are never named', () => {
    const naming = recoveryFiles.filter((file) => codeOf(file).includes('issuePracticalRecoveryCertificate'));
    expect(naming).toEqual([`${RECOVERY_ROOT}service.ts`]);
    for (const file of recoveryFiles) {
      expect(codeOf(file).includes('issuePracticalLiveSafetyEnablement'), file).toBe(false);
      expect(codeOf(file).includes('mintPracticalManualReviewResolution'), file).toBe(false);
      expect(codeOf(file).includes('resolveManualReview'), file).toBe(false);
    }
    // Exactly one issuance call site, and it runs after the evidence is ACCEPTED and the final guards.
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    expect(service.match(/issuePracticalRecoveryCertificate\(/g)?.length).toBe(1);
    const issue = service.indexOf('issuePracticalRecoveryCertificate({');
    expect(service.lastIndexOf("if (evaluation.kind === 'REJECTED')", issue)).toBeGreaterThan(0);
    expect(service.lastIndexOf('this.#guardStream(run);', issue)).toBeGreaterThan(service.lastIndexOf("if (evaluation.kind === 'REJECTED')", issue));
    expect(service.lastIndexOf('await this.#guardGeneration(run);', issue)).toBeGreaterThan(service.lastIndexOf("if (evaluation.kind === 'REJECTED')", issue));
  });

  it('THE PRIVATE-STREAM PATH CAN REVOKE BUT CANNOT MINT: tripwire and classifier name no issuance, certification, or recovery operation', () => {
    for (const file of [`${RECOVERY_ROOT}tripwire.ts`, `${RECOVERY_ROOT}private-events.ts`]) {
      const code = codeOf(file);
      for (const forbidden of [
        'issuePracticalRecoveryCertificate', 'PracticalRecoveryCertificate', 'startCertification', 'finishCertification', 'failCertification',
        'recordProviderRecovered', 'adoptForNewRuntime', 'initializeAccount', 'escalateMalformedAccount', 'expireCertificate', 'PracticalSafetyRepository',
        'PracticalRecoveryPersistence', 'PracticalLiveSafetyEnablement',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
    const tripwire = codeOf(`${RECOVERY_ROOT}tripwire.ts`);
    expect(tripwire).toContain('readonly #revocation: PracticalRevocationPort;');
    expect([...tripwire.matchAll(/this\.#revocation\.(\w+)\(/g)].map((match) => match[1])).toEqual(['invalidate']);
    // The service hands the tripwire an object with invalidate and nothing else.
    expect(codeOf(`${RECOVERY_ROOT}service.ts`)).toMatch(/revocation: Object\.freeze\(\{ invalidate: \(input[^)]*\) => persistence\.invalidate\(input\) \}\)/);
  });
});

describe('the bracketed pass and stream readiness', () => {
  it('one pass is exactly identity, O1 P1 O2 P2 O3, identity', () => {
    expect(PRACTICAL_PASS_READ_PLAN.map((step) => `${step.slot}:${step.kind}`)).toEqual([
      'IDENTITY_OPEN:IDENTITY', 'O1:ORDERS', 'P1:POSITIONS', 'O2:ORDERS', 'P2:POSITIONS', 'O3:ORDERS', 'IDENTITY_CLOSE:IDENTITY',
    ]);
    expect(Object.isFrozen(PRACTICAL_PASS_READ_PLAN)).toBe(true);
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    expect(service).toContain('for (const [position, planned] of PRACTICAL_PASS_READ_PLAN.entries()) {');
    expect(service).toContain('if (read.failure !== null || practicalBracketDisagreement(reads) !== null) break;');
  });

  it('P18B-B-04: AUTH_JOIN_SENT IS NOT POSITIVE AUTHORITY READINESS (behavior)', () => {
    expect(PRACTICAL_PRIVATE_BINDABLE_STATES).toEqual(['AUTH_JOIN_SENT']);
    const joinSent = { state: 'AUTH_JOIN_SENT', generationId: 1, connected: true, authJoinSent: true, invalidEventCount: 0, reconciliationRequired: false };
    expect(practicalPrivateStreamReadiness(joinSent)).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    expect(bindPracticalPrivateStream(joinSent)).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    const proven = { ...joinSent, subscriptionConfirmation: { source: 'PROVIDER', incarnation: 1, confirmedAtMs: 0 } };
    expect(bindPracticalPrivateStream(proven).kind).toBe('BOUND');
    expect(bindPracticalPrivateStream({ ...proven, generationId: 2 })).toMatchObject({ kind: 'NOT_READY', reason: 'CONFIRMATION_FOR_OTHER_INCARNATION' });
    expect(bindPracticalPrivateStream({ ...proven, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true })).toMatchObject({ kind: 'NOT_READY', readiness: 'RECONCILIATION_REQUIRED' });
  });

  it('P18B-B-04: PROVEN_READY is constructed in exactly ONE place, only after a provider confirmation for the same incarnation (source)', () => {
    const constructions = recoveryFiles.flatMap((file) => [...codeOf(file).matchAll(/kind: 'PROVEN_READY' as const/g)].map(() => file));
    expect(constructions).toEqual([`${RECOVERY_ROOT}private-events.ts`]);
    const code = codeOf(`${RECOVERY_ROOT}private-events.ts`);
    const start = code.indexOf('export function practicalPrivateStreamReadiness(');
    const end = code.indexOf('\n}', start);
    const readiness = code.slice(start, end);
    const proven = readiness.indexOf("kind: 'PROVEN_READY' as const");
    for (const precondition of [
      "if (!health.connected) return DISCONNECTED;",
      'return RECONCILIATION_REQUIRED;',
      "if (!health.authJoinSent) return unproven('JOIN_NOT_SENT');",
      'const confirmation: unknown = health.subscriptionConfirmation;',
      "if (confirmation === undefined || confirmation === null) return unproven('NO_PROVIDER_CONFIRMATION');",
      "if (record['source'] !== 'PROVIDER'",
      "if (record['incarnation'] !== health.generationId) return unproven('CONFIRMATION_FOR_OTHER_INCARNATION');",
    ]) {
      const at = readiness.indexOf(precondition);
      expect(at, precondition).toBeGreaterThan(0);
      expect(at, precondition).toBeLessThan(proven);
    }
    // Binding and every health check go through the readiness derivation; nothing else decides readiness.
    expect(code).toMatch(/export function bindPracticalPrivateStream\(health: unknown\): PracticalStreamBindingResult \{\s+const readiness = practicalPrivateStreamReadiness\(health\);\s+if \(readiness\.kind !== 'PROVEN_READY'\)/);
    expect(code.slice(code.indexOf('export function practicalStreamHealthTrip('))).toContain('const readiness = practicalPrivateStreamReadiness(health);');
    // The engine and the tripwire never construct or inspect readiness evidence themselves.
    for (const file of [`${RECOVERY_ROOT}service.ts`, `${RECOVERY_ROOT}tripwire.ts`]) {
      expect(codeOf(file).includes('subscriptionConfirmation'), file).toBe(false);
      expect(codeOf(file).includes("'PROVEN_READY'"), file).toBe(false);
    }
  });

  it('P18B-B-04: nothing in src/ outside the recovery core can report a subscription confirmation (the real CoinDCX adapter is UNPROVEN)', () => {
    const naming = files.filter((file) => !file.startsWith(RECOVERY_ROOT) && codeOf(file).includes('subscriptionConfirmation'));
    expect(naming).toEqual([]);
    const adapter = codeOf('src/integration/coindcx/websocket/private-stream.ts');
    // The adapter listens for data and lifecycle events only: no join/subscription acknowledgement exists to report.
    expect([...adapter.matchAll(/socket\.on\('([\w-]+)'/g)].map((match) => match[1]).sort()).toEqual([
      'balance-update', 'connect', 'connect_error', 'df-order-update', 'df-position-update', 'disconnect', 'error',
    ]);
  });
});

/** The body of a class member (from its signature to the next member at the same indentation). */
function memberBody(code: string, signature: string): string {
  const start = code.indexOf(signature);
  expect(start, signature).toBeGreaterThan(0);
  const end = code.indexOf('\n  }\n', start);
  return code.slice(start, end);
}

describe('P18B-B-05 / B-06: async boundaries and the sticky trip', () => {
  it('arm() CANNOT blindly erase a prior sticky trip: the trip is cleared in exactly one place, after a durable safety proof', () => {
    const tripwire = codeOf(`${RECOVERY_ROOT}tripwire.ts`);
    expect(tripwire.match(/this\.#trip = null/g)).toHaveLength(1);
    const arm = memberBody(tripwire, 'public arm(): PracticalTripwireArmResult {');
    expect(arm).not.toContain('#trip = ');
    // The standing-trip refusal comes before anything else (before disarm and before binding).
    expect(arm.indexOf("if (standing !== null) return Object.freeze({ kind: 'TRIPPED' as const, trip: standing });")).toBeGreaterThan(0);
    expect(arm.indexOf('if (standing !== null)')).toBeLessThan(arm.indexOf('this.disarm();'));
    expect(memberBody(tripwire, 'public disarm(): void {')).not.toContain('#trip');
    const release = memberBody(tripwire, 'public releaseTrip(trip: PracticalTrip, durableLoad: unknown): PracticalTripReleaseResult {');
    expect(release).toContain('this.#trip = null;');
    for (const precondition of ["if (this.#trip === null || this.#trip !== trip) return keep('NOT_THE_CURRENT_TRIP');", "if (this.#revocationsInFlight !== 0) return keep('REVOCATION_IN_FLIGHT');", 'problem = practicalDurableSafetyProblem(durableLoad);', 'if (problem !== null) return keep(problem);']) {
      expect(release.indexOf(precondition), precondition).toBeGreaterThan(0);
      expect(release.indexOf(precondition), precondition).toBeLessThan(release.indexOf('this.#trip = null;'));
    }
  });

  it('the service releases a trip only in resetAfterRevocation, after its own durable safety check; startWatch never clears one', () => {
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    expect(service.match(/releaseTrip\(/g)).toHaveLength(1);
    const reset = memberBody(service, 'public async resetAfterRevocation(): Promise<PracticalResetOutcome> {');
    expect(reset.indexOf('const problem = practicalDurableSafetyProblem(load);')).toBeGreaterThan(0);
    expect(reset.indexOf('const problem = practicalDurableSafetyProblem(load);')).toBeLessThan(reset.indexOf('this.#tripwire.releaseTrip(trip, load)'));
    expect(service.match(/this\.#hold = null;/g)).toHaveLength(1);
    expect(reset).toContain('this.#hold = null;');
    const startWatch = memberBody(service, 'public async startWatch(): Promise<PracticalWatchOutcome> {');
    expect(startWatch).not.toContain('releaseTrip');
    expect(startWatch).not.toContain('#hold = ');
  });

  it('after the certificate commit: stream, THEN the generation await, THEN the stream AGAIN, before CERTIFIED', () => {
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    const post = memberBody(service, 'async #postPersistenceProblem(run: CertificationRun)');
    const first = post.indexOf('const streamBefore = this.#streamProblem(run);');
    const generation = post.indexOf('const generation = await this.#generationProblem(run);');
    const second = post.indexOf('const streamAfter = this.#streamProblem(run);');
    expect(first).toBeGreaterThan(0);
    expect(generation).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(generation);
    const persist = memberBody(service, 'async #persistIssued(');
    const commit = persist.indexOf('await this.#persistence.finishCertification({');
    const revalidate = persist.indexOf('const problem = await this.#postPersistenceProblem(run);');
    expect(commit).toBeGreaterThan(0);
    expect(revalidate).toBeGreaterThan(commit);
    expect(persist.indexOf("kind: 'CERTIFIED' as const")).toBeGreaterThan(revalidate);
    expect(persist.indexOf('await this.#ensureRevoked(certificate.certificateId, problem.reason);')).toBeGreaterThan(revalidate);
  });

  it('monitorAuthority re-derives the stream AFTER the Phase 18 await, before CERTIFICATE_STILL_VALID', () => {
    const monitor = memberBody(codeOf(`${RECOVERY_ROOT}service.ts`), 'public async monitorAuthority(): Promise<PracticalAuthorityCheck> {');
    const read = monitor.indexOf('await this.#readReconciliation();');
    const recheck = monitor.indexOf('if (reason === null) reason = this.#authorityProblem(certificate, this.#clock.nowMs());');
    expect(read).toBeGreaterThan(0);
    expect(recheck).toBeGreaterThan(read);
    expect(monitor.indexOf("kind: 'CERTIFICATE_STILL_VALID' as const")).toBeGreaterThan(recheck);
    expect(monitor.match(/CERTIFICATE_STILL_VALID/g)).toHaveLength(1);
  });

  it('P18B-B-08: startup revokes a SAME-epoch certificate and returns READY only after a fresh read proves the account non-authoritative', () => {
    const startup = memberBody(codeOf(`${RECOVERY_ROOT}service.ts`), 'public async recoverAtStartup(): Promise<PracticalStartupOutcome> {');
    const sameEpoch = startup.indexOf("if (!(await this.#ensureRevoked(account.currentCertificate.certificateId, 'EVIDENCE_STALE'))) return blocked('REVOCATION_UNCONFIRMED');");
    const finalRead = startup.indexOf('const final = await this.#persistence.loadAccount(this.#accountId);');
    const finalGate = startup.indexOf("if (final.account.currentCertificate !== null || final.account.state === 'CERTIFIED_IDLE') return blocked('CERTIFICATE_OUTSTANDING');");
    expect(sameEpoch).toBeGreaterThan(0);
    expect(finalRead).toBeGreaterThan(sameEpoch);
    expect(finalGate).toBeGreaterThan(finalRead);
    expect(startup.match(/kind: 'READY' as const/g)).toHaveLength(1);
    expect(startup.indexOf("kind: 'READY' as const")).toBeGreaterThan(finalGate);
    // Any thrown failure is blocked, never READY.
    expect(startup).toMatch(/\} catch \{\s+return blocked\('PERSISTENCE_UNREADABLE'\);\s+\}/);
  });

  it('P18B-B-07: stopWatch refuses MALFORMED and NOT_FOUND before it can disarm; monitorAuthority reports NO_OUTSTANDING only from a FOUND read', () => {
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    const stop = memberBody(service, 'public async stopWatch(): Promise<PracticalStopWatchOutcome> {');
    const disarm = stop.indexOf('this.#tripwire.disarm();');
    for (const refusal of ["return refuse('DURABLE_STATE_MALFORMED');", "return refuse('DURABLE_STATE_NOT_FOUND');"]) {
      expect(stop.indexOf(refusal), refusal).toBeGreaterThan(0);
      expect(stop.indexOf(refusal), refusal).toBeLessThan(disarm);
    }
    const monitor = memberBody(service, 'public async monitorAuthority(): Promise<PracticalAuthorityCheck> {');
    const notFound = monitor.indexOf("if (load.kind !== 'FOUND') {");
    expect(monitor.indexOf("if (load.kind === 'MALFORMED') return this.#authorityUnconfirmed(")).toBeGreaterThan(0);
    expect(notFound).toBeGreaterThan(0);
    const notFoundBlock = monitor.slice(notFound, monitor.indexOf('\n    }\n', notFound));
    expect(notFoundBlock).not.toContain('NO_OUTSTANDING_CERTIFICATE');
    expect(monitor.indexOf('NO_OUTSTANDING_CERTIFICATE')).toBeGreaterThan(notFound);
  });

  it('P18B-B-11: the final pre-issuance sequence is stream, generation await, stream AGAIN, then issuance', () => {
    const run = memberBody(codeOf(`${RECOVERY_ROOT}service.ts`), 'async #runCertification(run: CertificationRun)');
    const issue = run.indexOf('issuePracticalRecoveryCertificate({');
    const generation = run.lastIndexOf('await this.#guardGeneration(run);', issue);
    const streamBefore = run.lastIndexOf('this.#guardStream(run);', generation);
    const streamAfter = run.indexOf('this.#guardStream(run);', generation);
    const issuedAt = run.indexOf('const issuedAtMs = this.#tick(run);', generation);
    expect(generation).toBeGreaterThan(run.lastIndexOf("if (evaluation.kind === 'REJECTED')", issue));
    expect(streamBefore).toBeGreaterThan(0);
    expect(streamAfter).toBeGreaterThan(generation);
    expect(streamAfter).toBeLessThan(issuedAt);
    expect(issuedAt).toBeLessThan(issue);
    // Nothing else awaits between the post-generation stream guard and the issuance.
    expect(run.slice(streamAfter, issue)).not.toContain('await ');
  });

  it('P18B-B-10: startup blocks ANY lease before the epoch branch, blocks a same-epoch CERTIFYING, and re-checks both at the final gate', () => {
    const startup = memberBody(codeOf(`${RECOVERY_ROOT}service.ts`), 'public async recoverAtStartup(): Promise<PracticalStartupOutcome> {');
    const lease = startup.indexOf("if (practicalDurableSafetyProblem(load) === 'MUTATION_LEASE_HELD') return Object.freeze({ kind: 'BLOCKED_MUTATION_LEASE_HELD' as const, account });");
    const epochBranch = startup.indexOf('if (account.fence.runtimeEpoch !== this.#runtimeEpoch) {');
    const certifying = startup.indexOf("} else if (account.state === 'CERTIFYING' || account.fence.mode.kind === 'CERTIFYING') {");
    expect(lease).toBeGreaterThan(0);
    expect(epochBranch).toBeGreaterThan(lease);
    expect(certifying).toBeGreaterThan(epochBranch);
    expect(startup.indexOf("return blocked('CERTIFICATION_IN_PROGRESS');", certifying)).toBeGreaterThan(certifying);
    const finalProblem = startup.indexOf('const finalProblem = practicalDurableSafetyProblem(final);');
    expect(finalProblem).toBeGreaterThan(0);
    expect(startup.indexOf("kind: 'READY' as const")).toBeGreaterThan(finalProblem);
  });

  it('P18B-B-09: stopWatch decides with practicalDurableSafetyProblem (CERTIFYING and leases refuse) before it can disarm', () => {
    const stop = memberBody(codeOf(`${RECOVERY_ROOT}service.ts`), 'public async stopWatch(): Promise<PracticalStopWatchOutcome> {');
    const decision = stop.indexOf('switch (practicalDurableSafetyProblem(current)) {');
    expect(decision).toBeGreaterThan(0);
    expect(stop).toMatch(/case 'CERTIFYING':\s+return refuse\('CERTIFICATION_IN_PROGRESS'\);/);
    expect(stop).toMatch(/case 'MUTATION_LEASE_HELD':\s+return refuse\('MUTATION_LEASE_HELD'\);/);
    expect(stop.indexOf('this.#tripwire.disarm();')).toBeGreaterThan(decision);
  });

  it('P18B-B-12: the startWatch baseline must be EXACTLY this account\'s row before it is stored', () => {
    const start = memberBody(codeOf(`${RECOVERY_ROOT}service.ts`), 'public async startWatch(): Promise<PracticalWatchOutcome> {');
    const binding = start.indexOf('if (state.accountId !== this.#accountId) {');
    expect(binding).toBeGreaterThan(0);
    expect(start.indexOf("return Object.freeze({ kind: 'NOT_READY' as const, reason: 'RECONCILIATION_ACCOUNT_MISMATCH' });", binding)).toBeGreaterThan(binding);
    expect(start.indexOf('this.#watch = Object.freeze({ watch: armed.watch, reconciliationGenerationAtArm: state.currentGeneration });')).toBeGreaterThan(binding);
  });

  it('stopWatch disarms only after any ISSUED certificate is confirmed revoked', () => {
    const stop = memberBody(codeOf(`${RECOVERY_ROOT}service.ts`), 'public async stopWatch(): Promise<PracticalStopWatchOutcome> {');
    const revoke = stop.indexOf("if (!(await this.#ensureRevoked(load.account.currentCertificate.certificateId, 'STREAM_INCARNATION_CHANGED'))) {");
    expect(revoke).toBeGreaterThan(0);
    expect(stop.indexOf('this.#tripwire.disarm();')).toBeGreaterThan(revoke);
    expect(stop.match(/this\.#tripwire\.disarm\(\);/g)).toHaveLength(1);
  });
});

describe('time and thresholds', () => {
  it('reads no clock, timer, environment, or network primitive directly (all injected)', () => {
    for (const file of recoveryFiles) {
      const code = codeOf(file);
      for (const forbidden of ['Date.now', 'new Date(', 'performance.now', 'process.env', 'setInterval(', 'fetch(', 'axios', 'socket.io', 'Prisma', '@prisma', 'HmacSha256Signer', 'X-AUTH']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
      // Only the injected scheduler's timers; never the global ones. (ports.ts DECLARES the injected scheduler's shape.)
      const withoutSchedulerPort = file === `${RECOVERY_ROOT}ports.ts`
        ? code.replace(/export interface PracticalRecoveryScheduler \{[\s\S]*?\n\}/, '')
        : code;
      expect(withoutSchedulerPort, file).not.toMatch(/(^|[^.#\w])(set|clear)Timeout\(/m);
    }
    expect(codeOf(`${RECOVERY_ROOT}ports.ts`)).toMatch(/export interface PracticalRecoveryScheduler \{\s+setTimeout\(callback: \(\) => void, delayMs: number\): unknown;\s+clearTimeout\(handle: unknown\): void;\s+\}/);
  });

  it('timing values come only from the Stage 1A SHADOW-CALIBRATION CANDIDATES; no candidate value is hard-coded', () => {
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    expect(service).toContain('dependencies.timing ?? PRACTICAL_TIMING_CANDIDATES');
    expect(service).toContain("candidate['status'] === 'SHADOW_CALIBRATION_CANDIDATE' && candidate['providerGuarantee'] === false");
    for (const file of recoveryFiles) {
      expect(codeOf(file), file).not.toMatch(/\b(3_?000|15_?000|2_?000|10_?000|30_?000|120_?000)\b/);
    }
  });

  it('CALIBRATION CANDIDATES ARE TELEMETRY MARKERS ONLY: the service reads a candidate nowhere but in practicalCandidateExceeded(...)', () => {
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    const uses = [...service.matchAll(/this\.#timing\.\w+/g)].map((match) => match.index);
    expect(uses).toHaveLength(3);
    for (const index of uses) {
      expect(service.lastIndexOf('practicalCandidateExceeded(', index!), 'a candidate used outside the marker helper').toBeGreaterThan(service.lastIndexOf(';', index!));
    }
    // No candidate value is ever compared or used as a bound (only the validator reads candidate['valueMs']).
    expect(service).not.toMatch(/\.valueMs\b/);
    expect(codeOf(`${RECOVERY_ROOT}timing.ts`)).toMatch(/export function practicalCandidateExceeded\(measuredMs: number, candidate: PracticalTimingCandidate\): boolean \{\s+return measuredMs > candidate\.valueMs;\s+\}/);
  });

  it('HARD CEILINGS are separately named, live only in timing.ts, and are the only bounds that fail closed', () => {
    expect(PRACTICAL_RECOVERY_HARD_CEILINGS).toEqual({
      kind: 'HARD_OPERATIONAL_CEILING', status: 'PROVISIONAL_UNCALIBRATED_PRE_SHADOW', readTimeoutMs: 20_000, passDurationMs: 60_000, providerGuarantee: false,
    });
    expect(sourceOf(`${RECOVERY_ROOT}timing.ts`)).toContain('PROVISIONAL, UNCALIBRATED, PRE-SHADOW');
    expect(PRACTICAL_RECOVERY_HARD_CEILINGS.readTimeoutMs).toBeGreaterThan(PRACTICAL_TIMING_CANDIDATES.readDuration.valueMs);
    expect(PRACTICAL_RECOVERY_HARD_CEILINGS.passDurationMs).toBeGreaterThan(PRACTICAL_TIMING_CANDIDATES.passWindow.valueMs);
    for (const file of recoveryFiles.filter((name) => name !== `${RECOVERY_ROOT}timing.ts`)) {
      expect(codeOf(file), file).not.toMatch(/\b\d+_\d{3}\b/);
    }
    const service = codeOf(`${RECOVERY_ROOT}service.ts`);
    expect(service).toContain('readonly #hard: PracticalRecoveryHardCeilings = PRACTICAL_RECOVERY_HARD_CEILINGS;');
    // Every bounded read uses the HARD read timeout.
    const bounded = [...service.matchAll(/this\.#withTimeout\(([\s\S]*?)\);/g)].map((match) => match[1]!.replace(/[\s,)]+$/, ''));
    expect(bounded).toHaveLength(2);
    for (const call of bounded) expect(call.endsWith('this.#hard.readTimeoutMs'), call).toBe(true);
    expect(service).toContain('const hardCeilingExceeded = pass.durationMs > this.#hard.passDurationMs;');
  });

  it('the only external packages in the whole recovery reach are hashing, logging, and decimals', () => {
    const external = new Set<string>();
    for (const file of recoveryFiles) {
      for (const node of reachOf(file)) {
        for (const specifier of extractImportSpecifiers(sourceOf(node), node)) if (!specifier.startsWith('.')) external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual(['decimal.js', 'node:crypto', 'pino']);
  });
});
