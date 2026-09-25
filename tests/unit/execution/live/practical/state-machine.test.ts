import { describe, expect, it } from 'vitest';
import * as practical from '../../../../../src/execution/live/practical';
import {
  PRACTICAL_ACCOUNT_STATES,
  PRACTICAL_ALLOWED_TRANSITIONS,
  PRACTICAL_INVALIDATION_REASONS,
  PRACTICAL_MUTATION_OUTCOMES,
  classifyPracticalInvalidation,
  isPracticalAccountStateName,
  practicalAccountStateOnStartup,
  practicalStateAfterTransitionFailure,
  transitionPracticalAccountState,
  type PracticalAccountStateName,
  type PracticalTransitionEvent,
} from '../../../../../src/execution/live/practical';
// Internal mint boundary, imported directly by tests only (no production importer).
import { PracticalManualReviewResolution, mintPracticalManualReviewResolution } from '../../../../../src/execution/live/practical/state-machine';

// Pure domain: no persistence, provider, stream, or clock.

const ACCOUNT = 'account-live-1';
const EPISODE = 'review-episode-1';

function resolution(accountId = ACCOUNT, reviewEpisodeId = EPISODE, resolutionId = 'resolution-1') {
  return mintPracticalManualReviewResolution({ accountId, reviewEpisodeId, resolutionId, assertedBy: 'operator-label', note: 'reviewed' });
}

const SIMPLE_EVENTS: readonly PracticalTransitionEvent[] = [
  { kind: 'CERTIFICATION_STARTED' },
  { kind: 'CERTIFICATION_SUCCEEDED' },
  { kind: 'PROVIDER_UNAVAILABLE' },
  { kind: 'PROVIDER_RECOVERED' },
  { kind: 'MUTATION_LEASED' },
  { kind: 'MUTATION_OUTCOME_RECORDED', outcome: 'ACCEPTED' },
];

describe('startup / restart', () => {
  it.each([null, 'QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE', 'CERTIFIED_IDLE', 'MUTATING'] as const)(
    'durable %s starts QUARANTINED (a restart never resumes certified or mutating)',
    (durable) => {
      expect(practicalAccountStateOnStartup(durable)).toBe('QUARANTINED');
    },
  );

  it('a restart never clears MANUAL_REVIEW_REQUIRED', () => {
    expect(practicalAccountStateOnStartup('MANUAL_REVIEW_REQUIRED')).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('has no strict-continuity state', () => {
    expect(PRACTICAL_ACCOUNT_STATES).toEqual(['QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE', 'CERTIFIED_IDLE', 'MUTATING', 'MANUAL_REVIEW_REQUIRED']);
    expect(JSON.stringify(PRACTICAL_ALLOWED_TRANSITIONS)).not.toMatch(/STRICT|CONTINUITY/);
  });
});

// Unknown, malformed, corrupt, and future values, as untrusted durable or runtime data.
const MALFORMED_STATES: readonly unknown[] = [
  undefined, '', 'quarantined', 'manual_review_required', ' QUARANTINED', 'QUARANTINED ', 'STRICT_HEALTHY', 'HEALTHY',
  'SUSPENDED_FUTURE_STATE', 'toString', '__proto__', 'constructor', 0, 1, Number.NaN, true, {}, { state: 'QUARANTINED' },
  ['QUARANTINED'], Symbol('QUARANTINED'), () => 'QUARANTINED',
];
const NON_REVIEW_STATES = ['QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE', 'CERTIFIED_IDLE', 'MUTATING'] as const;

describe('P18B-1A-09: unknown durable state and transition failures fail closed, never downgrading manual review', () => {
  it('isPracticalAccountStateName accepts exactly the six states and nothing else', () => {
    for (const state of PRACTICAL_ACCOUNT_STATES) expect(isPracticalAccountStateName(state)).toBe(true);
    for (const value of [...MALFORMED_STATES, null]) expect(isPracticalAccountStateName(value), String(value)).toBe(false);
  });

  it('1. startup with no prior row (null) -> QUARANTINED', () => {
    expect(practicalAccountStateOnStartup(null)).toBe('QUARANTINED');
  });

  it.each(NON_REVIEW_STATES)('2. startup %s -> QUARANTINED', (durable) => {
    expect(practicalAccountStateOnStartup(durable)).toBe('QUARANTINED');
  });

  it('3. startup MANUAL_REVIEW_REQUIRED -> MANUAL_REVIEW_REQUIRED', () => {
    expect(practicalAccountStateOnStartup('MANUAL_REVIEW_REQUIRED')).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it.each(['STRICT_HEALTHY', 'SUSPENDED_FUTURE_STATE', 'HEALTHY', 'toString', '__proto__'])('4. startup unknown string %s -> MANUAL_REVIEW_REQUIRED', (durable) => {
    expect(practicalAccountStateOnStartup(durable)).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it.each([undefined, '', 'quarantined', 'certified_idle', {}, { state: 'QUARANTINED' }, 0, 7, Number.NaN])(
    '5. startup malformed %o -> MANUAL_REVIEW_REQUIRED (never normalized to QUARANTINED)',
    (durable) => {
      expect(practicalAccountStateOnStartup(durable)).toBe('MANUAL_REVIEW_REQUIRED');
    },
  );

  it('an unknown startup state cannot start certification: only the operator path leaves it', () => {
    const state = practicalAccountStateOnStartup('SUSPENDED_FUTURE_STATE');
    expect(() => transitionPracticalAccountState(state, { kind: 'CERTIFICATION_STARTED' })).toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
  });

  it('6. fail-closed fallback: MANUAL_REVIEW_REQUIRED -> MANUAL_REVIEW_REQUIRED', () => {
    expect(practicalStateAfterTransitionFailure('MANUAL_REVIEW_REQUIRED')).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it.each(NON_REVIEW_STATES)('7. fail-closed fallback: %s -> QUARANTINED', (current) => {
    expect(practicalStateAfterTransitionFailure(current)).toBe('QUARANTINED');
  });

  it('8. fail-closed fallback: an unknown or malformed current state -> MANUAL_REVIEW_REQUIRED', () => {
    for (const current of [...MALFORMED_STATES, null]) {
      expect(practicalStateAfterTransitionFailure(current), String(current)).toBe('MANUAL_REVIEW_REQUIRED');
    }
  });

  it('the fallback grants no authority: it only ever yields QUARANTINED or MANUAL_REVIEW_REQUIRED', () => {
    for (const current of [...PRACTICAL_ACCOUNT_STATES, ...MALFORMED_STATES, null]) {
      expect(['QUARANTINED', 'MANUAL_REVIEW_REQUIRED']).toContain(practicalStateAfterTransitionFailure(current));
    }
  });

  /** Apply an event exactly as a Stage-1B caller must: on ANY failure, adopt the fail-closed fallback. */
  function applyWithFallback(current: PracticalAccountStateName, event: unknown): PracticalAccountStateName {
    try {
      return transitionPracticalAccountState(current, event as PracticalTransitionEvent);
    } catch {
      return practicalStateAfterTransitionFailure(current);
    }
  }

  it('9. no illegal, malformed, or refused event can turn MANUAL_REVIEW_REQUIRED into QUARANTINED', () => {
    const used = resolution(ACCOUNT, EPISODE, 'resolution-used');
    transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: used });
    const failingEvents: unknown[] = [
      ...SIMPLE_EVENTS,
      ...PRACTICAL_INVALIDATION_REASONS.map((reason) => ({ kind: 'INVALIDATED', reason })),
      { kind: 'INVALIDATED', reason: 'NOT_A_REASON' },
      { kind: 'MUTATION_OUTCOME_RECORDED', outcome: 'SUCCESS' },
      { kind: 'GRANT_CONTINUITY' },
      { kind: 'QUARANTINE' },
      { kind: 'RESET' },
      {},
      null,
      undefined,
      'OPERATOR_RESOLUTION',
      // Every refused operator resolution:
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: used },
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: resolution('account-live-2') },
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: resolution(ACCOUNT, 'review-episode-other') },
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: { accountId: ACCOUNT, reviewEpisodeId: EPISODE } },
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: Object.create(PracticalManualReviewResolution.prototype) },
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: null },
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: '', resolution: resolution() },
      { kind: 'OPERATOR_RESOLUTION', accountId: '', reviewEpisodeId: EPISODE, resolution: resolution() },
      { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, resolution: resolution() },
    ];
    for (const event of failingEvents) {
      expect(applyWithFallback('MANUAL_REVIEW_REQUIRED', event), JSON.stringify(event) ?? String(event)).toBe('MANUAL_REVIEW_REQUIRED');
    }
  });

  it('10. the ONLY path from MANUAL_REVIEW_REQUIRED to QUARANTINED is a genuine, account+episode-bound, one-shot OPERATOR_RESOLUTION', () => {
    expect(PRACTICAL_ALLOWED_TRANSITIONS.MANUAL_REVIEW_REQUIRED).toEqual(['MANUAL_REVIEW_REQUIRED', 'QUARANTINED']);
    const genuine = resolution(ACCOUNT, EPISODE, 'resolution-final');
    expect(applyWithFallback('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: genuine })).toBe('QUARANTINED');
    // One-shot: the same resolution, replayed through the fallback path, stays in review.
    expect(applyWithFallback('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: genuine })).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('a transition failure from an unknown current state also lands on MANUAL_REVIEW_REQUIRED', () => {
    for (const current of MALFORMED_STATES) {
      expect(applyWithFallback(current as never, { kind: 'CERTIFICATION_STARTED' })).toBe('MANUAL_REVIEW_REQUIRED');
    }
  });
});

describe('every required allowed transition', () => {
  it.each([
    ['QUARANTINED', { kind: 'CERTIFICATION_STARTED' }, 'CERTIFYING'],
    ['CERTIFYING', { kind: 'CERTIFICATION_SUCCEEDED' }, 'CERTIFIED_IDLE'],
    ['CERTIFYING', { kind: 'PROVIDER_UNAVAILABLE' }, 'PROVIDER_UNAVAILABLE'],
    ['CERTIFYING', { kind: 'INVALIDATED', reason: 'ORPHAN_ORDER' }, 'MANUAL_REVIEW_REQUIRED'],
    ['CERTIFYING', { kind: 'INVALIDATED', reason: 'INCOMPLETE_PAGINATION' }, 'QUARANTINED'],
    ['PROVIDER_UNAVAILABLE', { kind: 'PROVIDER_RECOVERED' }, 'QUARANTINED'],
    ['PROVIDER_UNAVAILABLE', { kind: 'INVALIDATED', reason: 'RECOVERY_ESCALATION_THRESHOLD' }, 'MANUAL_REVIEW_REQUIRED'],
    ['CERTIFIED_IDLE', { kind: 'MUTATION_LEASED' }, 'MUTATING'],
    ['CERTIFIED_IDLE', { kind: 'INVALIDATED', reason: 'CERTIFICATE_EXPIRED' }, 'QUARANTINED'],
    ['CERTIFIED_IDLE', { kind: 'INVALIDATED', reason: 'PRIVATE_STATE_EVENT' }, 'QUARANTINED'],
    ['QUARANTINED', { kind: 'INVALIDATED', reason: 'ACCOUNT_IDENTITY_MISMATCH' }, 'MANUAL_REVIEW_REQUIRED'],
  ] as const)('%s --%o--> %s', (from, event, to) => {
    expect(transitionPracticalAccountState(from, event as PracticalTransitionEvent)).toBe(to);
  });

  it.each(PRACTICAL_MUTATION_OUTCOMES)('MUTATING -> QUARANTINED after outcome %s', (outcome) => {
    expect(transitionPracticalAccountState('MUTATING', { kind: 'MUTATION_OUTCOME_RECORDED', outcome })).toBe('QUARANTINED');
  });

  it.each(PRACTICAL_INVALIDATION_REASONS)('invalidation %s from every state (MUTATING included) lands on its severity immediately (MANUAL_REVIEW stays sticky)', (reason) => {
    const expected = classifyPracticalInvalidation(reason) === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW_REQUIRED' : 'QUARANTINED';
    for (const from of ['QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE', 'CERTIFIED_IDLE', 'MUTATING'] as const) {
      expect(transitionPracticalAccountState(from, { kind: 'INVALIDATED', reason })).toBe(expected);
    }
    expect(transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'INVALIDATED', reason })).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('a malformed mutation outcome is escalated, never passed', () => {
    for (const from of ['MUTATING', 'QUARANTINED', 'MANUAL_REVIEW_REQUIRED'] as const) {
      expect(transitionPracticalAccountState(from, { kind: 'MUTATION_OUTCOME_RECORDED', outcome: 'SUCCESS' as never })).toBe('MANUAL_REVIEW_REQUIRED');
    }
  });
});

describe('P18B-1A-03: an invalidation while MUTATING changes the safety state immediately', () => {
  it('MUTATING + ACCOUNT_IDENTITY_MISMATCH -> MANUAL_REVIEW_REQUIRED immediately', () => {
    expect(transitionPracticalAccountState('MUTATING', { kind: 'INVALIDATED', reason: 'ACCOUNT_IDENTITY_MISMATCH' })).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('MUTATING + ORPHAN_ORDER -> MANUAL_REVIEW_REQUIRED immediately', () => {
    expect(transitionPracticalAccountState('MUTATING', { kind: 'INVALIDATED', reason: 'ORPHAN_ORDER' })).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('MUTATING + WS_DISCONNECTED -> QUARANTINED immediately', () => {
    expect(transitionPracticalAccountState('MUTATING', { kind: 'INVALIDATED', reason: 'WS_DISCONNECTED' })).toBe('QUARANTINED');
  });

  it.each(PRACTICAL_MUTATION_OUTCOMES)('a later outcome %s cannot downgrade MANUAL_REVIEW_REQUIRED', (outcome) => {
    const reviewed = transitionPracticalAccountState('MUTATING', { kind: 'INVALIDATED', reason: 'ACCOUNT_IDENTITY_MISMATCH' });
    expect(transitionPracticalAccountState(reviewed, { kind: 'MUTATION_OUTCOME_RECORDED', outcome })).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it.each(PRACTICAL_MUTATION_OUTCOMES)('a later outcome %s cannot restore CERTIFIED_IDLE (or MUTATING)', (outcome) => {
    const quarantined = transitionPracticalAccountState('MUTATING', { kind: 'INVALIDATED', reason: 'WS_DISCONNECTED' });
    expect(transitionPracticalAccountState(quarantined, { kind: 'MUTATION_OUTCOME_RECORDED', outcome })).toBe('QUARANTINED');
    // And no outcome from any state ever lands on a live state.
    for (const from of PRACTICAL_ACCOUNT_STATES) {
      let to: PracticalAccountStateName | 'REFUSED';
      try {
        to = transitionPracticalAccountState(from, { kind: 'MUTATION_OUTCOME_RECORDED', outcome });
      } catch {
        to = 'REFUSED';
      }
      expect(['CERTIFIED_IDLE', 'MUTATING', 'CERTIFYING'], `${from} + ${outcome}`).not.toContain(to);
    }
  });

  it('the outcome no longer needs, or accepts, a replay of earlier invalidations', () => {
    // A caller that "forgets" the invalidation cannot launder it: the state already moved.
    const reviewed = transitionPracticalAccountState('MUTATING', { kind: 'INVALIDATED', reason: 'POST_MUTATION_MISMATCH' });
    expect(transitionPracticalAccountState(reviewed, { kind: 'MUTATION_OUTCOME_RECORDED', outcome: 'ACCEPTED', invalidations: [] } as never))
      .toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('a restart cannot clear a manual-review invalidation observed during mutation', () => {
    const durable = transitionPracticalAccountState('MUTATING', { kind: 'INVALIDATED', reason: 'ACCOUNT_IDENTITY_MISMATCH' });
    // Crash before the outcome is recorded: the durable state is already MANUAL_REVIEW_REQUIRED.
    expect(practicalAccountStateOnStartup(durable)).toBe('MANUAL_REVIEW_REQUIRED');
    // The only way out is still an explicit operator resolution.
    expect(() => transitionPracticalAccountState(practicalAccountStateOnStartup(durable), { kind: 'CERTIFICATION_STARTED' })).toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
  });

  it('MUTATING no longer has a self-transition: nothing keeps an invalidated account in MUTATING', () => {
    expect(PRACTICAL_ALLOWED_TRANSITIONS.MUTATING).toEqual(['QUARANTINED', 'MANUAL_REVIEW_REQUIRED']);
  });
});

describe('every illegal transition fails closed', () => {
  const allowedSimple: Readonly<Record<string, PracticalAccountStateName>> = {
    'QUARANTINED:CERTIFICATION_STARTED': 'CERTIFYING',
    'CERTIFYING:CERTIFICATION_SUCCEEDED': 'CERTIFIED_IDLE',
    'CERTIFYING:PROVIDER_UNAVAILABLE': 'PROVIDER_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE:PROVIDER_RECOVERED': 'QUARANTINED',
    'CERTIFIED_IDLE:MUTATION_LEASED': 'MUTATING',
    'MUTATING:MUTATION_OUTCOME_RECORDED': 'QUARANTINED',
    // Monotone outcome bookkeeping after an invalidation already moved the state.
    'QUARANTINED:MUTATION_OUTCOME_RECORDED': 'QUARANTINED',
    'MANUAL_REVIEW_REQUIRED:MUTATION_OUTCOME_RECORDED': 'MANUAL_REVIEW_REQUIRED',
  };

  it('the monotone outcome entries keep their state', () => {
    for (const [key, to] of Object.entries(allowedSimple)) {
      const [from, kind] = key.split(':') as [PracticalAccountStateName, string];
      const event = SIMPLE_EVENTS.find((candidate) => candidate.kind === kind)!;
      expect(transitionPracticalAccountState(from, event), key).toBe(to);
    }
  });

  for (const from of PRACTICAL_ACCOUNT_STATES) {
    for (const event of SIMPLE_EVENTS) {
      const key = `${from}:${event.kind}`;
      if (key in allowedSimple) continue;
      it(`${from} refuses ${event.kind}`, () => {
        expect(() => transitionPracticalAccountState(from, event)).toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
      });
    }
  }

  it('an unknown state or event kind is refused', () => {
    expect(() => transitionPracticalAccountState('STRICT_HEALTHY' as never, { kind: 'CERTIFICATION_STARTED' })).toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
    expect(() => transitionPracticalAccountState('QUARANTINED', { kind: 'GRANT_CONTINUITY' } as never)).toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
  });

  it('no transition from a degraded state reaches MUTATING or CERTIFIED_IDLE except the two defined edges', () => {
    const reaching = (state: PracticalAccountStateName) =>
      Object.entries(PRACTICAL_ALLOWED_TRANSITIONS).filter(([, targets]) => targets.includes(state)).map(([from]) => from);
    expect(reaching('MUTATING')).toEqual(['CERTIFIED_IDLE']);
    expect(reaching('CERTIFIED_IDLE')).toEqual(['CERTIFYING']);
  });
});

describe('MANUAL_REVIEW_REQUIRED exits only through an explicit operator resolution', () => {
  it('a genuine resolution for the account moves it to QUARANTINED (never to a live state)', () => {
    expect(transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: resolution() }))
      .toBe('QUARANTINED');
  });

  it('every other event is refused or keeps it in review', () => {
    for (const event of SIMPLE_EVENTS) {
      if (event.kind === 'MUTATION_OUTCOME_RECORDED') {
        expect(transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', event)).toBe('MANUAL_REVIEW_REQUIRED');
        continue;
      }
      expect(() => transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', event)).toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
    }
  });

  it('a structural or cloned resolution is refused', () => {
    const genuine = resolution();
    const structural = { accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolutionId: 'resolution-1', assertedBy: 'x', note: 'y' };
    for (const forged of [structural, { ...genuine }, Object.create(PracticalManualReviewResolution.prototype)]) {
      expect(() => transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', {
        kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: forged as PracticalManualReviewResolution,
      })).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    }
  });

  it('a resolution for another account is refused', () => {
    expect(() => transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: resolution('account-live-2') }))
      .toThrow(/PRACTICAL_AUTHORITY_INVALID/);
  });

  it('a resolution is one-shot (no replay)', () => {
    const once = resolution();
    transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: once });
    expect(() => transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: once }))
      .toThrow(/already used/);
  });

  it('a resolution is refused outside MANUAL_REVIEW_REQUIRED', () => {
    for (const from of PRACTICAL_ACCOUNT_STATES.filter((state) => state !== 'MANUAL_REVIEW_REQUIRED')) {
      expect(() => transitionPracticalAccountState(from, { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: resolution() }))
        .toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
    }
  });

  it('minting requires every field as a non-empty exact string', () => {
    const valid = { accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolutionId: 'r', assertedBy: 'a', note: 'n' };
    for (const field of Object.keys(valid) as (keyof typeof valid)[]) {
      for (const bad of ['', ' padded', 'padded ', undefined, 7]) {
        expect(() => mintPracticalManualReviewResolution({ ...valid, [field]: bad as never }), `${field}=${String(bad)}`).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
      }
    }
    expect(() => new PracticalManualReviewResolution({}, { accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolutionId: 'r', assertedBy: 'a', note: 'n' })).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    expect(() => new PracticalManualReviewResolution({ purpose: 'p18b-manual-review-resolution' }, { accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolutionId: 'r', assertedBy: 'a', note: 'n' }))
      .toThrow(/PRACTICAL_AUTHORITY_INVALID/);
  });
});

describe('P18B-1A-08: a resolution is bound to one account AND one review episode', () => {
  const OTHER_ACCOUNT = 'account-live-2';
  const EPISODE_A = 'review-episode-a';
  const EPISODE_B = 'review-episode-b';

  function resolve(accountId: string, reviewEpisodeId: string, value: PracticalManualReviewResolution) {
    return transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId, reviewEpisodeId, resolution: value });
  }

  it('1. a resolution for account A / episode A clears exactly account A / episode A to QUARANTINED', () => {
    expect(resolve(ACCOUNT, EPISODE_A, resolution(ACCOUNT, EPISODE_A))).toBe('QUARANTINED');
  });

  it('2. a resolution for another account is refused (and is not consumed)', () => {
    const forOther = resolution(OTHER_ACCOUNT, EPISODE_A);
    expect(() => resolve(ACCOUNT, EPISODE_A, forOther)).toThrow(expect.objectContaining({ code: 'PRACTICAL_AUTHORITY_INVALID', message: expect.stringMatching(/different account/) }));
    expect(resolve(OTHER_ACCOUNT, EPISODE_A, forOther)).toBe('QUARANTINED');
  });

  it('3. a resolution for another episode on the same account is refused (and is not consumed)', () => {
    const forB = resolution(ACCOUNT, EPISODE_B);
    expect(() => resolve(ACCOUNT, EPISODE_A, forB)).toThrow(expect.objectContaining({ code: 'PRACTICAL_AUTHORITY_INVALID', message: expect.stringMatching(/different manual-review episode/) }));
    expect(resolve(ACCOUNT, EPISODE_B, forB)).toBe('QUARANTINED');
  });

  it('4. an unused resolution from old episode A cannot clear a later episode B', () => {
    // Episode A: two resolutions were minted; one clears it, one is left unused.
    const used = resolution(ACCOUNT, EPISODE_A, 'resolution-a-1');
    const leftover = resolution(ACCOUNT, EPISODE_A, 'resolution-a-2');
    let state = resolve(ACCOUNT, EPISODE_A, used);
    expect(state).toBe('QUARANTINED');
    // A new review episode B begins on the same account.
    state = transitionPracticalAccountState(state, { kind: 'INVALIDATED', reason: 'ORPHAN_ORDER' });
    expect(state).toBe('MANUAL_REVIEW_REQUIRED');
    expect(() => resolve(ACCOUNT, EPISODE_B, leftover)).toThrow(/different manual-review episode/);
    // Only a resolution for episode B clears it.
    expect(resolve(ACCOUNT, EPISODE_B, resolution(ACCOUNT, EPISODE_B, 'resolution-b-1'))).toBe('QUARANTINED');
  });

  it('5. a structural or cloned resolution is still refused, even with the right account and episode', () => {
    const genuine = resolution(ACCOUNT, EPISODE_A);
    for (const forged of [
      { accountId: ACCOUNT, reviewEpisodeId: EPISODE_A, resolutionId: 'resolution-1', assertedBy: 'a', note: 'n' },
      { ...genuine },
      Object.create(PracticalManualReviewResolution.prototype),
      structuredClone(PracticalManualReviewResolution.read(genuine)),
    ]) {
      expect(() => resolve(ACCOUNT, EPISODE_A, forged as PracticalManualReviewResolution)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    }
  });

  it('6. a resolution remains one-shot for its episode', () => {
    const once = resolution(ACCOUNT, EPISODE_A);
    expect(resolve(ACCOUNT, EPISODE_A, once)).toBe('QUARANTINED');
    expect(() => resolve(ACCOUNT, EPISODE_A, once)).toThrow(/already used/);
  });

  it('7. a resolution is refused outside MANUAL_REVIEW_REQUIRED, even for the matching account and episode', () => {
    for (const from of PRACTICAL_ACCOUNT_STATES.filter((state) => state !== 'MANUAL_REVIEW_REQUIRED')) {
      const value = resolution(ACCOUNT, EPISODE_A);
      expect(() => transitionPracticalAccountState(from, { kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE_A, resolution: value }))
        .toThrow(/PRACTICAL_ILLEGAL_TRANSITION/);
      // Refusal consumed nothing: the same resolution still clears its episode.
      expect(resolve(ACCOUNT, EPISODE_A, value)).toBe('QUARANTINED');
    }
  });

  it('a missing or malformed current episode is refused', () => {
    for (const bad of ['', ' review-episode-a', undefined, null, 1]) {
      expect(() => resolve(ACCOUNT, bad as never, resolution(ACCOUNT, EPISODE_A))).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    }
  });
});

describe('P18B-1A-02: the practical barrel cannot mint a manual-review resolution', () => {
  it('neither the mint nor the resolution class (and so its constructor) is exported from the barrel', () => {
    expect('mintPracticalManualReviewResolution' in practical).toBe(false);
    expect('PracticalManualReviewResolution' in practical).toBe(false);
    expect(Object.keys(practical).filter((name) => /mint|resolution|resolve/i.test(name))).toEqual([]);
  });

  it('a barrel-only caller cannot leave MANUAL_REVIEW_REQUIRED with anything it can build', () => {
    for (const forged of [
      { accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolutionId: 'r', assertedBy: 'a', note: 'n' },
      { purpose: 'p18b-manual-review-resolution' },
      null,
      undefined,
    ]) {
      expect(() => practical.transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', {
        kind: 'OPERATOR_RESOLUTION', accountId: ACCOUNT, reviewEpisodeId: EPISODE, resolution: forged as never,
      })).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    }
  });
});
