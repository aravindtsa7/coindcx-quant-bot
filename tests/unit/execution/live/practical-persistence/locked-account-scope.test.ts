import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { issuePracticalRecoveryCertificate, PracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement } from '../../../../../src/execution/live/practical/policy';
import {
  PrismaPracticalSafetyRepository,
  withLockedPracticalAccountWithinCallerTransaction,
  type PracticalArmableCancelExpectation,
  type PracticalLockedAccountScope,
} from '../../../../../src/execution/live/practical-persistence/repository';
import { providerAccountFingerprint } from '../../../../../src/execution/live/reconciliation/account-identity';

// [P18B Stage 1B2 Wave 2B1] The caller-owned Stage 1B1 scope, with no database: a recording transaction
// double serves the account's rows. It proves (1) every statement goes through the SUPPLIED `tx` (the
// repository's own root client throws on any use), (2) no nested transaction, and (3) the scope lifecycle:
// use-after-close, overlapping calls, foreign preparations, and one terminal change per scope.

const ACCOUNT = 'acct-w2b1-scope';
const EPOCH = 'epoch-w2b1';
const T0 = 1_000_000;
const NOW = T0 + 60_000;

function newCertificate(): PracticalRecoveryCertificate {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT });
  if (resolution.status !== 'ENABLED') throw new Error('fixture');
  return issuePracticalRecoveryCertificate({
    enablement: resolution.enablement,
    bindings: { accountId: ACCOUNT, providerAccountFingerprint: providerAccountFingerprint('scope-account'), runtimeEpoch: EPOCH, reconciliationGeneration: 3, streamIncarnation: 1 },
    evidence: { evidenceDigest: 'e'.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs: T0,
  });
}

const certificate = newCertificate();
const CERT = PracticalRecoveryCertificate.read(certificate)!;
const BINDING = Object.freeze({ intentId: 'a'.repeat(64), clientOrderId: `p17-${'b'.repeat(32)}`, cancelGeneration: 1 });

function certificateRow(status: 'ISSUED' | 'CONSUMED', overrides: Record<string, unknown> = {}) {
  return {
    certificateId: CERT.certificateId, accountId: ACCOUNT, providerAccountFingerprint: CERT.providerAccountFingerprint, runtimeEpoch: EPOCH,
    reconciliationGeneration: 3, streamIncarnation: 1, evidenceDigest: CERT.evidenceDigest, issuedAtMs: BigInt(CERT.issuedAtMs), expiresAtMs: BigInt(CERT.expiresAtMs),
    status, terminalAtMs: status === 'ISSUED' ? null : BigInt(NOW), terminalReason: null, ...overrides,
  };
}

interface Rows {
  state: Record<string, unknown>;
  fence: Record<string, unknown>;
  certificates: Record<string, unknown>[][];
  lease: Record<string, unknown> | null;
  leasesByCertificate: Record<string, unknown>[];
}

function certifiedIdle(): Rows {
  return {
    state: { accountId: ACCOUNT, state: 'CERTIFIED_IDLE', currentRecoveryEpisodeId: null, currentReviewEpisodeId: null, currentCertificateId: CERT.certificateId, revision: 3n },
    fence: { accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: 3, revision: 2n, mode: 'IDLE', runId: null, leaseId: null, certificateId: null, leaseAction: null },
    certificates: [[certificateRow('ISSUED')]],
    lease: null,
    leasesByCertificate: [],
  };
}

const LEASE_ROW = {
  leaseId: 'lease-w2b1', accountId: ACCOUNT, certificateId: CERT.certificateId, action: 'CANCEL', intentId: BINDING.intentId, clientOrderId: BINDING.clientOrderId,
  cancelGeneration: BINDING.cancelGeneration, runtimeEpoch: EPOCH, reconciliationGeneration: 3, createdAtMs: BigInt(NOW), armedAtMs: null, completedAtMs: null, status: 'LEASED', outcome: null,
};

function mutating(): Rows {
  return {
    state: { accountId: ACCOUNT, state: 'MUTATING', currentRecoveryEpisodeId: null, currentReviewEpisodeId: null, currentCertificateId: null, revision: 4n },
    fence: { accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: 3, revision: 3n, mode: 'MUTATION_LEASED', runId: null, leaseId: 'lease-w2b1', certificateId: CERT.certificateId, leaseAction: 'CANCEL' },
    certificates: [[certificateRow('CONSUMED')]],
    lease: { ...LEASE_ROW },
    leasesByCertificate: [{ leaseId: 'lease-w2b1', certificateId: CERT.certificateId }],
  };
}

let rows: Rows;
let statements: string[];

function nextCertificate(): Record<string, unknown>[] {
  return rows.certificates.length > 1 ? rows.certificates.shift()! : rows.certificates[0]!;
}

function transaction(): Prisma.TransactionClient {
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      const table = /FROM (live_practical_\w+)/.exec(query.sql)![1]!;
      const key = table === 'live_practical_mutation_lease' && query.sql.includes('WHERE certificate_id') ? `${table} by certificate` : table;
      statements.push(`tx.$queryRaw ${key}${query.sql.includes('FOR UPDATE') ? ' FOR UPDATE' : ''}`);
      switch (key) {
        case 'live_practical_malformed_latch': return [];
        case 'live_practical_account_state': return [rows.state];
        case 'live_practical_account_fence': return [rows.fence];
        case 'live_practical_certificate': return nextCertificate();
        case 'live_practical_mutation_lease': return rows.lease === null ? [] : [rows.lease];
        case 'live_practical_mutation_lease by certificate': return rows.leasesByCertificate;
        default: throw new Error(`unexpected ${key}`);
      }
    },
    livePracticalMutationLease: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        statements.push('tx.livePracticalMutationLease.updateMany');
        lastUpdate = args;
        return { count: 0 };
      },
    },
    $transaction: async () => {
      statements.push('NESTED $transaction');
      throw new Error('a nested transaction was opened');
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}
let lastUpdate: { where: Record<string, unknown>; data: Record<string, unknown> } | null;

/** The repository's ROOT client: any use at all throws (the scope must use only the caller's `tx`). */
const ROOT = new Proxy({}, { get: (_target, property) => { throw new Error(`the repository root client was used: ${String(property)}`); } }) as unknown as PrismaClient;
const repository = new PrismaPracticalSafetyRepository(ROOT, () => 'lease-generated');

beforeEach(() => {
  rows = certifiedIdle();
  statements = [];
  lastUpdate = null;
});

const EXPECTED = { accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: 3, revision: 2 };

function armable(overrides: Partial<PracticalArmableCancelExpectation['certificate']> = {}): PracticalArmableCancelExpectation {
  return {
    leaseId: 'lease-w2b1', runtimeEpoch: EPOCH, reconciliationGeneration: 3, leaseCreatedAtMs: NOW, binding: BINDING,
    certificate: {
      certificateId: CERT.certificateId, accountId: ACCOUNT, providerAccountFingerprint: CERT.providerAccountFingerprint, runtimeEpoch: EPOCH, reconciliationGeneration: 3,
      streamIncarnation: 1, evidenceDigest: CERT.evidenceDigest, issuedAtMs: CERT.issuedAtMs, expiresAtMs: CERT.expiresAtMs, consumedAtMs: NOW, ...overrides,
    },
  };
}

describe('every statement goes through the SUPPLIED tx; no root client, no nested transaction', () => {
  it('opening the scope locks the account through tx, in the Stage 1B1 order', async () => {
    const tx = transaction();
    await withLockedPracticalAccountWithinCallerTransaction(repository, tx, ACCOUNT, async (scope) => {
      expect(scope.account).toMatchObject({ accountId: ACCOUNT, state: 'CERTIFIED_IDLE' });
      expect(Object.isFrozen(scope)).toBe(true);
    });
    expect(statements).toEqual([
      'tx.$queryRaw live_practical_malformed_latch FOR UPDATE',
      'tx.$queryRaw live_practical_account_state FOR UPDATE',
      'tx.$queryRaw live_practical_account_fence FOR UPDATE',
      'tx.$queryRaw live_practical_certificate FOR UPDATE',
    ]);
  });

  it('prepareCancelConsumption reads through tx only, generates a validated lease id, and returns an opaque preparation exposing only the certificate', async () => {
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      const prepared = await scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      if (prepared.kind !== 'READY') throw new Error(prepared.kind);
      expect(Object.keys(prepared.preparation)).toEqual(['certificate']);
      expect(prepared.preparation.certificate).toMatchObject({ certificateId: CERT.certificateId, status: 'ISSUED' });
      expect(Object.isFrozen(prepared.preparation)).toBe(true);
    });
    expect(statements.every((statement) => statement.startsWith('tx.'))).toBe(true);
    expect(statements.at(-1)).toBe('tx.$queryRaw live_practical_certificate FOR UPDATE');
  });

  it('requireArmableOrderBoundCancelLease re-proves the certificate on a fresh locked read, checks the single lease resting on it, all through tx', async () => {
    rows = mutating();
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      const checked = await scope.requireArmableOrderBoundCancelLease(armable());
      expect(checked.lease).toMatchObject({ leaseId: 'lease-w2b1', orderBinding: BINDING, armedAtMs: null });
      expect(checked.certificate).toMatchObject({ status: 'CONSUMED', terminalAtMs: NOW });
    });
    expect(statements.slice(-2)).toEqual(['tx.$queryRaw live_practical_certificate FOR UPDATE', 'tx.$queryRaw live_practical_mutation_lease by certificate FOR UPDATE']);
    expect(statements).not.toContain('NESTED $transaction');
  });

  it('the arm CAS is conditioned on the COMPLETE binding and armedAtMs IS NULL; a lost race (count 0) is a conflict', async () => {
    rows = mutating();
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      await scope.requireArmableOrderBoundCancelLease(armable());
      await scope.armOrderBoundCancelLease(NOW + 1_000);
    })).rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT.*armed or changed concurrently/);
    expect(lastUpdate).toEqual({
      where: {
        leaseId: 'lease-w2b1', accountId: ACCOUNT, certificateId: CERT.certificateId, action: 'CANCEL', runtimeEpoch: EPOCH, reconciliationGeneration: 3,
        intentId: BINDING.intentId, clientOrderId: BINDING.clientOrderId, cancelGeneration: 1, status: 'LEASED', armedAtMs: null, completedAtMs: null,
      },
      data: { armedAtMs: BigInt(NOW + 1_000) },
    });
  });

  it('refuses a non-genuine repository, a missing tx, or a malformed account id BEFORE any statement', async () => {
    const work = async () => undefined;
    await expect(withLockedPracticalAccountWithinCallerTransaction({} as never, transaction(), ACCOUNT, work)).rejects.toThrow(/PRACTICAL_PERSISTENCE_INVALID_INPUT/);
    await expect(withLockedPracticalAccountWithinCallerTransaction(Object.create(PrismaPracticalSafetyRepository.prototype), transaction(), ACCOUNT, work)).rejects.toThrow(/INVALID_INPUT/);
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, null as never, ACCOUNT, work)).rejects.toThrow(/INVALID_INPUT/);
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ` ${ACCOUNT}`, work)).rejects.toThrow(/INVALID_INPUT/);
    expect(statements).toEqual([]);
  });

  it('a MALFORMED account is refused (fail closed) before the work runs', async () => {
    rows.fence = { ...rows.fence, mode: 'CERTIFYING', runId: ' padded' };
    let ran = false;
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async () => { ran = true; })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    expect(ran).toBe(false);
  });
});

describe('the scope lifecycle', () => {
  it('use after the work completed is refused BEFORE touching tx', async () => {
    let leaked!: PracticalLockedAccountScope;
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => { leaked = scope; });
    const before = statements.length;
    await expect(leaked.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW })).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT.*closed/);
    await expect(leaked.armOrderBoundCancelLease(NOW)).rejects.toThrow(/closed/);
    expect(statements.length).toBe(before);
  });

  it('the scope is also closed when the work throws', async () => {
    let leaked!: PracticalLockedAccountScope;
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => { leaked = scope; throw new Error('work failed'); }))
      .rejects.toThrow('work failed');
    await expect(leaked.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW })).rejects.toThrow(/closed/);
  });

  it('overlapping calls are refused', async () => {
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      const first = scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      await expect(scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW })).rejects.toThrow(/overlapping/);
      await first;
    });
  });

  it('a scope prepares at most once, and never mixes an acquire preparation with an arm check', async () => {
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      await scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      await expect(scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW })).rejects.toThrow(/at most one consumption/);
      await expect(scope.requireArmableOrderBoundCancelLease(armable())).rejects.toThrow(/at most one arm/);
    });
  });

  it('a preparation from ANOTHER scope, or a structural look-alike, is refused', async () => {
    let foreign: unknown;
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      const prepared = await scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      if (prepared.kind === 'READY') foreign = prepared.preparation;
    });
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      await scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      await expect(scope.consumeIntoOrderBoundCancelLease(foreign as never, BINDING)).rejects.toThrow(/does not belong to this scope/);
    });
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      const prepared = await scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      if (prepared.kind !== 'READY') throw new Error(prepared.kind);
      await expect(scope.invalidateBeforeConsumption({ ...prepared.preparation }, 'PREFLIGHT_MISMATCH')).rejects.toThrow(/does not belong to this scope/);
    });
  });

  it('exactly ONE terminal change per scope: even a failed terminal attempt finishes it', async () => {
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      const prepared = await scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      if (prepared.kind !== 'READY') throw new Error(prepared.kind);
      // An invalid binding is refused before any write, but the terminal attempt is final.
      await expect(scope.consumeIntoOrderBoundCancelLease(prepared.preparation, { ...BINDING, cancelGeneration: 0 })).rejects.toThrow(/INVALID_INPUT/);
      await expect(scope.invalidateBeforeConsumption(prepared.preparation, 'PREFLIGHT_MISMATCH')).rejects.toThrow(/already performed its one terminal change/);
    });
    expect(statements.some((statement) => !statement.startsWith('tx.$queryRaw'))).toBe(false);
  });

  it('only the four reviewed pre-consumption reasons are accepted', async () => {
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      const prepared = await scope.prepareCancelConsumption({ expected: EXPECTED, certificate, trustedNowMs: NOW });
      if (prepared.kind !== 'READY') throw new Error(prepared.kind);
      await expect(scope.invalidateBeforeConsumption(prepared.preparation, 'WS_DISCONNECTED' as never)).rejects.toThrow(/INVALID_INPUT/);
    });
  });

  it('the arm requires a prior exact arm check in the same scope', async () => {
    rows = mutating();
    await withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, async (scope) => {
      await expect(scope.armOrderBoundCancelLease(NOW)).rejects.toThrow(/prior exact arm check/);
    });
    expect(statements).not.toContain('tx.livePracticalMutationLease.updateMany');
  });
});

describe('the FULL certificate re-proof refuses any drift from the acquired snapshot (exact JavaScript equality)', () => {
  it.each([
    ['streamIncarnation', { streamIncarnation: 2 }],
    ['providerAccountFingerprint', { providerAccountFingerprint: 'f'.repeat(64) }],
    ['evidenceDigest', { evidenceDigest: 'd'.repeat(64) }],
    ['issuedAtMs', { issuedAtMs: T0 - 1 }],
    ['expiresAtMs', { expiresAtMs: CERT.expiresAtMs + 1 }],
    ['consumedAtMs', { consumedAtMs: NOW + 1 }],
    ['runtimeEpoch', { runtimeEpoch: 'epoch-other' }],
  ] as const)('an expectation that differs on %s is refused with zero writes', async (field, change) => {
    rows = mutating();
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, (scope) => scope.requireArmableOrderBoundCancelLease(armable(change))))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT/);
    expect(statements).not.toContain('tx.livePracticalMutationLease.updateMany');
    expect(field).toBeTruthy();
  });

  it.each([
    ['status REVOKED', { status: 'REVOKED', terminalReason: 'PREFLIGHT_MISMATCH' }],
    ['a different stream incarnation', { streamIncarnation: 5 }],
    ['a different evidence digest', { evidenceDigest: 'd'.repeat(64) }],
  ] as const)('a durable row whose fresh locked re-read shows %s is refused (the two locked reads must agree too)', async (_name, change) => {
    rows = mutating();
    rows.certificates = [[certificateRow('CONSUMED')], [certificateRow('CONSUMED', change)]];
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, (scope) => scope.requireArmableOrderBoundCancelLease(armable())))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_(CONFLICT|MALFORMED)/);
  });

  it('a case-variant certificate id in the expectation never reaches the collation (strict digest input)', async () => {
    rows = mutating();
    await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, (scope) => scope.requireArmableOrderBoundCancelLease(armable({ certificateId: CERT.certificateId.toUpperCase() }))))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_INVALID_INPUT/);
  });

  it('a second lease resting on the certificate, or another lease id, is refused', async () => {
    for (const leases of [[], [{ leaseId: 'lease-w2b1', certificateId: CERT.certificateId }, { leaseId: 'lease-x', certificateId: CERT.certificateId }], [{ leaseId: 'LEASE-W2B1', certificateId: CERT.certificateId }]]) {
      rows = mutating();
      rows.leasesByCertificate = leases;
      await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, (scope) => scope.requireArmableOrderBoundCancelLease(armable())), JSON.stringify(leases))
        .rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT/);
    }
  });

  it('an armed, unbound, or differently bound lease is not armable', async () => {
    for (const change of [{ armedAtMs: BigInt(NOW + 5) }, { cancelGeneration: 2 }, { clientOrderId: `p17-${'c'.repeat(32)}` }, { createdAtMs: BigInt(NOW - 1) }]) {
      rows = mutating();
      rows.lease = { ...LEASE_ROW, ...change };
      await expect(withLockedPracticalAccountWithinCallerTransaction(repository, transaction(), ACCOUNT, (scope) => scope.requireArmableOrderBoundCancelLease(armable())), JSON.stringify(change, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
        .rejects.toThrow(/PRACTICAL_PERSISTENCE_(CONFLICT|MALFORMED)/);
    }
  });
});
