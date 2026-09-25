import { describe, expect, it, vi } from 'vitest';
import {
  LiveReconciliationService,
  buildFinding,
  findingSha256,
  requireCurrentReconciliation,
  resolveAccountStatus,
  sortFindings,
} from '../../../../../src/execution/live/reconciliation';
import { LiveExecutionError } from '../../../../../src/execution/live/errors';
import { InMemoryLiveExecutionRepository } from '../helpers';
import { InMemoryReconciliationRepository } from './in-memory-repository';
import {
  EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
  ACCOUNT,
  RUNTIME_IDENTITY,
  FakeEvidenceProvider,
  FixedClock,
  evidenceSet,
  venueOrder,
} from './helpers';

const SECRET = 'sk-live-super-secret-value';
const SIGNATURE = 'deadbeefcafe0123456789abcdef';

describe('P18 §21 reconciliation findings refuse credential material at construction', () => {
  it.each([
    'apiKey', 'apiSecret', 'secret', 'password', 'token', 'signature', 'authorization', 'Authorization', 'X-AUTH-SIGNATURE',
  ])('refuses a finding whose evidence carries the key %s', (key) => {
    expect(() => buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_STATE_CONFLICT',
      evidence: { [key]: SECRET },
    })).toThrow(/may not carry credential-bearing key/);
  });

  it('refuses a credential-bearing key at ANY depth', () => {
    expect(() => buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_STATE_CONFLICT',
      evidence: { provider: { request: { headers: { apiSecret: SECRET } } } },
    })).toThrow(/may not carry credential-bearing key/);
  });

  it('accepts ordinary sanitized structured metadata', () => {
    const finding = buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_ECONOMICS_CONFLICT',
      subject: { pair: 'B-ANY_USDT', exchangeOrderId: 'venue-1' },
      evidence: { localOrderedQuantity: '0.5', venueOrderedQuantity: '0.9', localState: 'ACKNOWLEDGED' },
    });
    expect(finding.evidence['localOrderedQuantity']).toBe('0.5');
    expect(Object.isFrozen(finding.evidence)).toBe(true);
    expect(Object.isFrozen(finding.subject)).toBe(true);
  });
});

describe('P18 §21 no reconciliation output leaks a credential', () => {
  it('a barrier refusal carries only identity, status, and counts', async () => {
    const repository = new InMemoryReconciliationRepository();
    let captured: LiveExecutionError | null = null;
    try {
      await requireCurrentReconciliation(repository, ACCOUNT, RUNTIME_IDENTITY, 'CREATE');
    } catch (error) {
      captured = error as LiveExecutionError;
    }
    expect(captured).not.toBeNull();
    const serialized = JSON.stringify(captured!.toJSON()).toLowerCase();
    for (const forbidden of ['secret', 'apikey', 'signature', 'authorization', 'password', 'token']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(captured!.details).toMatchObject({ accountId: ACCOUNT, mutation: 'CREATE' });
  });

  it('a run against hostile provider data emits no log line containing credential material', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      }));

    try {
      // Hostile shapes: venue records whose free-text fields try to smuggle
      // credential-looking values into whatever the reconciler logs or persists.
      const evidence = evidenceSet({
        orders: [
          venueOrder({ exchangeOrderId: SIGNATURE, venueStatus: 'open' }),
          venueOrder({ exchangeOrderId: 'venue-2', wireOrderType: SECRET, venueStatus: 'open' }),
        ],
      });
      const reconciliation = new InMemoryReconciliationRepository();
      const service = new LiveReconciliationService({
        repository: reconciliation,
        executionRepository: new InMemoryLiveExecutionRepository(),
        evidenceProvider: new FakeEvidenceProvider(evidence),
        runtimeIdentity: RUNTIME_IDENTITY,
        credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
        clock: new FixedClock(),
      });
      const outcome = await service.reconcileAccount(ACCOUNT);
      // It still fails closed rather than declaring health.
      expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const joined = lines.join('\n').toLowerCase();
    for (const forbidden of ['x-auth', 'authorization:', 'apikey', 'apisecret', 'password']) {
      expect(joined).not.toContain(forbidden);
    }
  });
});

describe('P18 §16 finding identity is deterministic and generation-independent', () => {
  const finding = buildFinding({
    category: 'ORPHAN',
    code: 'RECON_ORPHAN_VENUE_ORDER',
    subject: { pair: 'B-ANY_USDT', exchangeOrderId: 'venue-1' },
    evidence: { venueStatus: 'open' },
  });

  it('is stable across repeated construction', () => {
    const again = buildFinding({
      category: 'ORPHAN',
      code: 'RECON_ORPHAN_VENUE_ORDER',
      subject: { pair: 'B-ANY_USDT', exchangeOrderId: 'venue-1' },
      evidence: { venueStatus: 'open' },
    });
    expect(findingSha256(ACCOUNT, finding)).toBe(findingSha256(ACCOUNT, again));
  });

  it('differs per account, so one account cannot dedup another account fault', () => {
    expect(findingSha256(ACCOUNT, finding)).not.toBe(findingSha256('another-account', finding));
  });

  it('changes when the evidence changes', () => {
    const changed = buildFinding({
      category: 'ORPHAN',
      code: 'RECON_ORPHAN_VENUE_ORDER',
      subject: { pair: 'B-ANY_USDT', exchangeOrderId: 'venue-1' },
      evidence: { venueStatus: 'partially_filled' },
    });
    expect(findingSha256(ACCOUNT, finding)).not.toBe(findingSha256(ACCOUNT, changed));
  });

  it('orders findings deterministically regardless of discovery order', () => {
    const a = buildFinding({ category: 'CONFLICT', code: 'RECON_ORDER_STATE_CONFLICT', evidence: { n: 1 } });
    const b = buildFinding({ category: 'ORPHAN', code: 'RECON_ORPHAN_VENUE_ORDER', evidence: { n: 2 } });
    expect(sortFindings(ACCOUNT, [a, b])).toEqual(sortFindings(ACCOUNT, [b, a]));
  });
});

describe('P18 §12 only the three safe categories permit health', () => {
  it('treats a clean result as healthy', () => {
    expect(resolveAccountStatus([
      buildFinding({ category: 'VERIFIED_MATCH', code: 'RECON_ORDER_VERIFIED_MATCH' }),
      buildFinding({ category: 'SAFE_AUTHORITATIVE_ADVANCE', code: 'RECON_ORDER_ADVANCED_FROM_VENUE' }),
      buildFinding({ category: 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE', code: 'RECON_POSITION_OWNERSHIP_ESTABLISHED' }),
    ])).toBe('HEALTHY');
  });

  it.each([
    ['CONFLICT', 'UNHEALTHY'],
    ['ORPHAN', 'UNHEALTHY'],
    ['AMBIGUOUS', 'MANUAL_REVIEW_REQUIRED'],
    ['MANUAL_REVIEW_REQUIRED', 'MANUAL_REVIEW_REQUIRED'],
  ] as const)('treats a %s finding as %s', (category, expected) => {
    expect(resolveAccountStatus([
      buildFinding({ category: 'VERIFIED_MATCH', code: 'RECON_ORDER_VERIFIED_MATCH' }),
      buildFinding({ category, code: 'RECON_ORDER_STATE_CONFLICT' }),
    ])).toBe(expected);
  });

  it('lets an unresolvable category outrank a merely unhealthy one', () => {
    expect(resolveAccountStatus([
      buildFinding({ category: 'CONFLICT', code: 'RECON_ORDER_STATE_CONFLICT' }),
      buildFinding({ category: 'AMBIGUOUS', code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED' }),
    ])).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('treats an empty result as healthy only because nothing contradicted anything', () => {
    expect(resolveAccountStatus([])).toBe('HEALTHY');
  });
});
