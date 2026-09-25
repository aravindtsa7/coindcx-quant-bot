import { describe, expect, it } from 'vitest';
import * as practical from '../../../../../src/execution/live/practical';
import {
  PRACTICAL_ROLLOUT_STAGES,
  PRACTICAL_SAFETY_CEILINGS,
  PRACTICAL_TIMING_CANDIDATES,
  PracticalLiveSafetyEnablement,
  VERIFIED_REDUCE_ONLY_CAPABILITY,
  evaluatePracticalLiveSafetyConfig,
  isAtLeastAsStrictAsCeilings,
  isPracticalRolloutStage,
  practicalActionPermission,
  requirePracticalLiveSafetyEnablement,
  type PracticalLiveSafetyConfigInput,
} from '../../../../../src/execution/live/practical';
// Internal issuance boundary, imported directly by tests only (no production importer).
import { issuePracticalLiveSafetyEnablement } from '../../../../../src/execution/live/practical/policy';

// Pure: the configuration record is passed in; nothing reads process state.

const ACCOUNT = 'account-live-1';
const BASE: PracticalLiveSafetyConfigInput = { LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT };

function enabled(config: PracticalLiveSafetyConfigInput = BASE): PracticalLiveSafetyEnablement {
  const resolution = issuePracticalLiveSafetyEnablement(config);
  if (resolution.status !== 'ENABLED') throw new Error(`expected ENABLED, got ${resolution.reason}`);
  return resolution.enablement;
}

/** The parser's verdict, cross-checked against the issuer's (they must always agree). */
function disabledReason(config: PracticalLiveSafetyConfigInput): string {
  const evaluation = evaluatePracticalLiveSafetyConfig(config);
  const issued = issuePracticalLiveSafetyEnablement(config);
  const fromEvaluation = evaluation.status === 'DISABLED' ? evaluation.reason : 'ENABLED';
  expect(issued.status === 'DISABLED' ? issued.reason : 'ENABLED').toBe(fromEvaluation);
  return fromEvaluation;
}

describe('implementation-owned safety ceilings (Stage-5 candidates)', () => {
  it('pins the reviewed values and is frozen', () => {
    expect(PRACTICAL_SAFETY_CEILINGS).toEqual({
      certificateLifetimeMs: 120_000,
      minimumPasses: 3,
      minimumCertificationSpanMs: 30_000,
      minimumPassSpacingMs: 10_000,
      firstMutationDwellMs: 60_000,
      postIssuanceDwellMs: 15_000,
    });
    expect(Object.isFrozen(PRACTICAL_SAFETY_CEILINGS)).toBe(true);
  });

  it('an absent ceiling configuration uses the implementation ceilings', () => {
    expect(enabled().ceilings).toEqual(PRACTICAL_SAFETY_CEILINGS);
  });

  it.each([
    ['LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS', '60000', 'certificateLifetimeMs', 60_000],
    ['LIVE_PRACTICAL_MIN_PASSES', '5', 'minimumPasses', 5],
    ['LIVE_PRACTICAL_MIN_CERTIFICATION_SPAN_MS', '45000', 'minimumCertificationSpanMs', 45_000],
    ['LIVE_PRACTICAL_MIN_PASS_SPACING_MS', '15000', 'minimumPassSpacingMs', 15_000],
    ['LIVE_PRACTICAL_FIRST_MUTATION_DWELL_MS', '90000', 'firstMutationDwellMs', 90_000],
    ['LIVE_PRACTICAL_POST_ISSUANCE_DWELL_MS', '20000', 'postIssuanceDwellMs', 20_000],
  ] as const)('%s may TIGHTEN (%s)', (key, raw, field, value) => {
    expect(enabled({ ...BASE, [key]: raw }).ceilings[field]).toBe(value);
  });

  it.each([
    ['LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS', '120001'],
    ['LIVE_PRACTICAL_MIN_PASSES', '2'],
    ['LIVE_PRACTICAL_MIN_CERTIFICATION_SPAN_MS', '29999'],
    ['LIVE_PRACTICAL_MIN_PASS_SPACING_MS', '9999'],
    ['LIVE_PRACTICAL_FIRST_MUTATION_DWELL_MS', '59999'],
    ['LIVE_PRACTICAL_POST_ISSUANCE_DWELL_MS', '14999'],
  ])('%s=%s would LOOSEN and disables Tier B entirely (never clamped)', (key, raw) => {
    expect(disabledReason({ ...BASE, [key]: raw })).toBe('CEILING_WOULD_LOOSEN');
  });

  it.each(['0', '-1', '1e5', '030000', ' 60000', '60000.5', 'abc', '9'.repeat(400), '99999999999'])('malformed ceiling %s disables Tier B', (raw) => {
    expect(disabledReason({ ...BASE, LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS: raw })).toBe('MALFORMED_CEILING');
  });

  it('a value beyond the tightening limit is malformed, not a silent never-certify', () => {
    expect(disabledReason({ ...BASE, LIVE_PRACTICAL_MIN_PASSES: '21' })).toBe('MALFORMED_CEILING');
  });

  it('the enablement constructor itself refuses loosened ceilings', () => {
    expect(isAtLeastAsStrictAsCeilings({ ...PRACTICAL_SAFETY_CEILINGS, certificateLifetimeMs: 600_000 })).toBe(false);
    expect(isAtLeastAsStrictAsCeilings({ ...PRACTICAL_SAFETY_CEILINGS, minimumPasses: 1 })).toBe(false);
    expect(isAtLeastAsStrictAsCeilings(PRACTICAL_SAFETY_CEILINGS)).toBe(true);
  });
});

describe('timing values are shadow-calibration candidates, not provider guarantees', () => {
  it('each is labelled SHADOW_CALIBRATION_CANDIDATE with providerGuarantee false', () => {
    expect(PRACTICAL_TIMING_CANDIDATES).toEqual({
      readDuration: { valueMs: 3_000, status: 'SHADOW_CALIBRATION_CANDIDATE', providerGuarantee: false },
      passWindow: { valueMs: 15_000, status: 'SHADOW_CALIBRATION_CANDIDATE', providerGuarantee: false },
      interReadGap: { valueMs: 2_000, status: 'SHADOW_CALIBRATION_CANDIDATE', providerGuarantee: false },
    });
    expect(Object.isFrozen(PRACTICAL_TIMING_CANDIDATES.passWindow)).toBe(true);
  });

  it('no configuration key can set them (they are not part of the configuration input)', () => {
    const keys: readonly (keyof PracticalLiveSafetyConfigInput)[] = [
      'LIVE_PRACTICAL_SAFETY_ENABLED', 'LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST', 'LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS',
      'LIVE_PRACTICAL_MIN_PASSES', 'LIVE_PRACTICAL_MIN_CERTIFICATION_SPAN_MS', 'LIVE_PRACTICAL_MIN_PASS_SPACING_MS',
      'LIVE_PRACTICAL_FIRST_MUTATION_DWELL_MS', 'LIVE_PRACTICAL_POST_ISSUANCE_DWELL_MS',
    ];
    expect(keys.filter((key) => /READ_DURATION|PASS_WINDOW|GAP|STAGE|REDUCE|GATE|STRICT/.test(key))).toEqual([]);
    const withJunk = enabled({ ...BASE, ...({ LIVE_PRACTICAL_PASS_WINDOW_MS: '999999', LIVE_PRACTICAL_STAGE: 'STAGE_6' } as Record<string, string>) });
    expect(withJunk.stage).toBe('STAGE_5A_CANCEL_ONLY');
  });
});

describe('action permission: Stage 5a is cancel-only', () => {
  it('CANCEL is the only permitted action', () => {
    const enablement = enabled();
    expect(enablement.actionPermission('CANCEL')).toEqual({ permitted: true });
  });

  it('CLOSE is disabled without a verified reduce-only capability (and none exists)', () => {
    expect(VERIFIED_REDUCE_ONLY_CAPABILITY).toBe(false);
    expect(enabled().actionPermission('CLOSE')).toEqual({ permitted: false, reason: 'CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY' });
  });

  it('OPEN is disabled in Stage 5a', () => {
    expect(enabled().actionPermission('OPEN')).toEqual({ permitted: false, reason: 'OPEN_DISABLED_UNTIL_STAGE_5B' });
  });

  it('an unknown action fails closed', () => {
    expect(practicalActionPermission('STAGE_5A_CANCEL_ONLY', 'MODIFY' as never)).toEqual({ permitted: false, reason: 'UNKNOWN_MUTATION_ACTION' });
  });
});

describe('P18B-1A-07: the rollout stage is validated before the action', () => {
  it.each([
    ['CANCEL', { permitted: true }],
    ['OPEN', { permitted: false, reason: 'OPEN_DISABLED_UNTIL_STAGE_5B' }],
    ['CLOSE', { permitted: false, reason: 'CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY' }],
  ] as const)('STAGE_5A_CANCEL_ONLY + %s', (action, expected) => {
    expect(practicalActionPermission('STAGE_5A_CANCEL_ONLY', action)).toEqual(expected);
  });

  it.each(['OPEN', 'CANCEL', 'CLOSE'] as const)('BROKEN_STAGE + %s -> refused', (action) => {
    expect(practicalActionPermission('BROKEN_STAGE' as never, action)).toEqual({ permitted: false, reason: 'UNKNOWN_ROLLOUT_STAGE' });
  });

  it.each([
    'STAGE_5B', 'stage_5a_cancel_only', ' STAGE_5A_CANCEL_ONLY', 'STAGE_5A_CANCEL_ONLY ', '', undefined, null, 5, {}, ['STAGE_5A_CANCEL_ONLY'],
  ])('malformed or future stage %o is refused for every action, never mapped to Stage 5a', (stage) => {
    for (const action of ['OPEN', 'CANCEL', 'CLOSE', 'MODIFY'] as const) {
      expect(practicalActionPermission(stage as never, action as never)).toEqual({ permitted: false, reason: 'UNKNOWN_ROLLOUT_STAGE' });
    }
  });

  it.each(['MODIFY', 'cancel', ' CANCEL', '', undefined, null, 1, {}])('a malformed or unknown action %o is refused', (action) => {
    expect(practicalActionPermission('STAGE_5A_CANCEL_ONLY', action as never)).toEqual({ permitted: false, reason: 'UNKNOWN_MUTATION_ACTION' });
  });

  it('only STAGE_5A_CANCEL_ONLY is a recognized stage', () => {
    expect(PRACTICAL_ROLLOUT_STAGES).toEqual(['STAGE_5A_CANCEL_ONLY']);
    expect(Object.isFrozen(PRACTICAL_ROLLOUT_STAGES)).toBe(true);
    expect(isPracticalRolloutStage('STAGE_5A_CANCEL_ONLY')).toBe(true);
    expect(isPracticalRolloutStage('STAGE_5B')).toBe(false);
  });
});

describe('P18B-1A-01: parsing configuration is separate from issuing authority', () => {
  it('the practical barrel cannot mint an enablement: no issuer or resolver is exported', () => {
    expect('issuePracticalLiveSafetyEnablement' in practical).toBe(false);
    expect('resolvePracticalLiveSafetyPolicy' in practical).toBe(false);
    // Every barrel function that accepts configuration returns data, never an enablement.
    const evaluation = practical.evaluatePracticalLiveSafetyConfig(BASE);
    expect(evaluation.status).toBe('ELIGIBLE');
    expect(evaluation).not.toHaveProperty('enablement');
    for (const value of Object.values(evaluation)) expect(value).not.toBeInstanceOf(PracticalLiveSafetyEnablement);
    // The class constructor is exported but needs the module-private issuer.
    expect(() => new practical.PracticalLiveSafetyEnablement(Symbol('P18B practical live safety enablement issuer'), {
      accountAllowlist: [ACCOUNT], ceilings: PRACTICAL_SAFETY_CEILINGS, stage: 'STAGE_5A_CANCEL_ONLY',
    })).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
  });

  it('an ELIGIBLE evaluation is plain frozen data, and is refused as authority', () => {
    const evaluation = evaluatePracticalLiveSafetyConfig(BASE);
    expect(evaluation).toEqual({ status: 'ELIGIBLE', accountAllowlist: [ACCOUNT], ceilings: PRACTICAL_SAFETY_CEILINGS, stage: 'STAGE_5A_CANCEL_ONLY' });
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(PracticalLiveSafetyEnablement.read(evaluation)).toBeNull();
    expect(() => requirePracticalLiveSafetyEnablement(evaluation)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
  });

  it('arbitrary structural config or policy data is not authority', () => {
    const genuineRecord = requirePracticalLiveSafetyEnablement(enabled());
    for (const structural of [
      BASE,
      { ...BASE, status: 'ENABLED' },
      genuineRecord,
      { ...genuineRecord },
      { status: 'ENABLED', enablement: genuineRecord },
      { accountAllowlist: [ACCOUNT], ceilings: PRACTICAL_SAFETY_CEILINGS, stage: 'STAGE_5A_CANCEL_ONLY', permitsAccount: () => true },
      Object.setPrototypeOf({ accountAllowlist: [ACCOUNT] }, PracticalLiveSafetyEnablement.prototype),
    ]) {
      expect(PracticalLiveSafetyEnablement.read(structural)).toBeNull();
      expect(() => requirePracticalLiveSafetyEnablement(structural)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    }
  });

  it('the internal issuer re-parses and never accepts a pre-evaluated record', () => {
    const evaluation = evaluatePracticalLiveSafetyConfig(BASE);
    expect(issuePracticalLiveSafetyEnablement(evaluation as never)).toEqual({ status: 'DISABLED', reason: 'NOT_EXPLICITLY_ENABLED' });
  });
});

describe('Tier-B enablement is a non-forgeable capability minted only by the internal issuer', () => {
  it.each([
    [{}, 'NOT_EXPLICITLY_ENABLED'],
    [{ LIVE_PRACTICAL_SAFETY_ENABLED: 'false', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT }, 'NOT_EXPLICITLY_ENABLED'],
    [{ LIVE_PRACTICAL_SAFETY_ENABLED: 'TRUE', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT }, 'MALFORMED_ENABLE_FLAG'],
    [{ LIVE_PRACTICAL_SAFETY_ENABLED: ' true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT }, 'MALFORMED_ENABLE_FLAG'],
    [{ LIVE_PRACTICAL_SAFETY_ENABLED: '1', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT }, 'MALFORMED_ENABLE_FLAG'],
    [{ LIVE_PRACTICAL_SAFETY_ENABLED: 'true' }, 'EMPTY_ACCOUNT_ALLOWLIST'],
    [{ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ' , ' }, 'EMPTY_ACCOUNT_ALLOWLIST'],
  ])('%o -> DISABLED(%s)', (config, reason) => {
    expect(disabledReason(config)).toBe(reason);
  });

  it('only the genuine gate constructs it; forged, cloned, and structural values are refused', () => {
    const genuine = enabled();
    expect(() => new PracticalLiveSafetyEnablement(Symbol('forged'), { accountAllowlist: [ACCOUNT], ceilings: PRACTICAL_SAFETY_CEILINGS, stage: 'STAGE_5A_CANCEL_ONLY' }))
      .toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    for (const forged of [{ ...genuine }, { accountAllowlist: [ACCOUNT] }, Object.create(PracticalLiveSafetyEnablement.prototype)]) {
      expect(PracticalLiveSafetyEnablement.read(forged)).toBeNull();
      expect(() => requirePracticalLiveSafetyEnablement(forged)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    }
    expect(requirePracticalLiveSafetyEnablement(genuine).accountAllowlist).toEqual([ACCOUNT]);
    expect(Object.isFrozen(PracticalLiveSafetyEnablement)).toBe(true);
    expect(Object.isFrozen(PracticalLiveSafetyEnablement.prototype)).toBe(true);
    expect(Object.isFrozen(genuine)).toBe(true);
  });

  it('permits only allowlisted accounts, exactly', () => {
    const enablement = enabled({ ...BASE, LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: `${ACCOUNT}, account-live-3` });
    expect(enablement.permitsAccount(ACCOUNT)).toBe(true);
    expect(enablement.permitsAccount('account-live-3')).toBe(true);
    expect(enablement.permitsAccount('account-live-2')).toBe(false);
    expect(enablement.permitsAccount(` ${ACCOUNT}`)).toBe(false);
  });
});
