import { describe, expect, it } from 'vitest';
import {
  assertValidLifecycleTransition,
  CoinLifecycleState,
  isValidLifecycleTransition,
} from '../../../src/coin-runtime';
import { CoinLifecycleError } from '../../../src/core/errors/app-error';

describe('Coin Lifecycle State Machine Invariants', () => {
  it('accepts valid sequential transitions according to docs/COIN_ONBOARDING.md', () => {
    // Normal sequential promotion pipeline
    expect(isValidLifecycleTransition('DISCOVERED', 'DATA_LOADING')).toBe(true);
    expect(isValidLifecycleTransition('DATA_LOADING', 'DATA_READY')).toBe(true);
    expect(isValidLifecycleTransition('DATA_READY', 'BACKTESTING')).toBe(true);
    expect(isValidLifecycleTransition('BACKTESTING', 'RESEARCH_APPROVED')).toBe(true);
    expect(isValidLifecycleTransition('RESEARCH_APPROVED', 'PAPER')).toBe(true);
    expect(isValidLifecycleTransition('PAPER', 'PAPER_APPROVED')).toBe(true);
    expect(isValidLifecycleTransition('PAPER_APPROVED', 'SHADOW')).toBe(true);
    expect(isValidLifecycleTransition('SHADOW', 'LIVE_CANDIDATE')).toBe(true);
    expect(isValidLifecycleTransition('LIVE_CANDIDATE', 'LIVE', true)).toBe(true);

    // Emergency or deliberate deactivation to DISABLED from any active state
    const statesBeforeDisabled: CoinLifecycleState[] = [
      'DISCOVERED',
      'DATA_LOADING',
      'DATA_READY',
      'BACKTESTING',
      'RESEARCH_APPROVED',
      'PAPER',
      'PAPER_APPROVED',
      'SHADOW',
      'LIVE_CANDIDATE',
      'LIVE',
    ];
    for (const state of statesBeforeDisabled) {
      expect(isValidLifecycleTransition(state, 'DISABLED')).toBe(true);
    }
  });

  it('6. REACTIVATION: ordinary transition from DISABLED to DISCOVERED is strictly rejected', () => {
    // Ordinary lifecycle transitions cannot exit DISABLED; real network rediscovery is required
    expect(isValidLifecycleTransition('DISABLED', 'DISCOVERED')).toBe(false);
    expect(() => assertValidLifecycleTransition('DISABLED', 'DISCOVERED', 'XRP')).toThrow(
      CoinLifecycleError
    );
    expect(() => assertValidLifecycleTransition('DISABLED', 'DISCOVERED', 'XRP')).toThrow(
      /Illegal coin lifecycle transition from 'DISABLED' to 'DISCOVERED'/
    );
  });

  it('10. LIVE CONFIG: liveEnabled=false strictly prevents transition to LIVE', () => {
    expect(isValidLifecycleTransition('LIVE_CANDIDATE', 'LIVE', false)).toBe(false);
    expect(() =>
      assertValidLifecycleTransition('LIVE_CANDIDATE', 'LIVE', 'BTC', false)
    ).toThrow(CoinLifecycleError);
    expect(() =>
      assertValidLifecycleTransition('LIVE_CANDIDATE', 'LIVE', 'BTC', false)
    ).toThrow(/profile.liveEnabled is false/);
  });

  it('11. LIVE CONFIG: liveEnabled=true allows transition only from valid prior state (LIVE_CANDIDATE)', () => {
    expect(isValidLifecycleTransition('LIVE_CANDIDATE', 'LIVE', true)).toBe(true);
    expect(() =>
      assertValidLifecycleTransition('LIVE_CANDIDATE', 'LIVE', 'BTC', true)
    ).not.toThrow();
  });

  it('12. LIVE CONFIG: liveEnabled=true alone does NOT bypass prior states (cannot jump to LIVE)', () => {
    expect(isValidLifecycleTransition('DISCOVERED', 'LIVE', true)).toBe(false);
    expect(isValidLifecycleTransition('DATA_READY', 'LIVE', true)).toBe(false);
    expect(isValidLifecycleTransition('PAPER', 'LIVE', true)).toBe(false);
    expect(isValidLifecycleTransition('DISABLED', 'LIVE', true)).toBe(false);

    expect(() =>
      assertValidLifecycleTransition('DISCOVERED', 'LIVE', 'BTC', true)
    ).toThrow(CoinLifecycleError);
  });

  it('rejects invalid or backwards arbitrary state jumps', () => {
    expect(isValidLifecycleTransition('DISCOVERED', 'PAPER')).toBe(false);
    expect(isValidLifecycleTransition('DATA_LOADING', 'LIVE')).toBe(false);
    expect(isValidLifecycleTransition('DATA_READY', 'SHADOW')).toBe(false);
    expect(isValidLifecycleTransition('RESEARCH_APPROVED', 'LIVE')).toBe(false);
    expect(isValidLifecycleTransition('PAPER', 'LIVE')).toBe(false);
    expect(isValidLifecycleTransition('LIVE', 'DISCOVERED')).toBe(false);

    // Self-transition rejected
    expect(isValidLifecycleTransition('DISCOVERED', 'DISCOVERED')).toBe(false);
    expect(isValidLifecycleTransition('LIVE', 'LIVE')).toBe(false);
  });

  it('asserts throw CoinLifecycleError with safe structured details', () => {
    try {
      assertValidLifecycleTransition('DATA_LOADING', 'LIVE', 'SOL');
      expect.unreachable('Should have thrown CoinLifecycleError');
    } catch (err) {
      expect(err).toBeInstanceOf(CoinLifecycleError);
      const lifecycleErr = err as CoinLifecycleError;
      expect(lifecycleErr.statusCode).toBe(400);
      expect(lifecycleErr.details?.['underlying']).toBe('SOL');
      expect(lifecycleErr.details?.['currentLifecycle']).toBe('DATA_LOADING');
      expect(lifecycleErr.details?.['targetLifecycle']).toBe('LIVE');
    }
  });
});
