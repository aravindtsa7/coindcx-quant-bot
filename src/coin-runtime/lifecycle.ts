import { CoinLifecycleError } from '../core/errors/app-error';
import { PAPER_FUNDING_CAPABILITY, isPaperFundingProductionPromotionEvidence } from '../execution/funding-capability';
import { CoinLifecycleState } from './types';

/**
 * Valid state transitions mapping for coin onboarding lifecycle.
 * Enforces the strict sequential promotion pipeline defined in docs/COIN_ONBOARDING.md.
 *
 * Guaranteed Invariants:
 * - Direct jumps (e.g. DISCOVERED -> LIVE, DISABLED -> LIVE) are strictly forbidden.
 * - Emergency/deliberate deactivation to DISABLED is supported from every active state.
 * - DISABLED is a terminal suspension state for ordinary lifecycle transitions.
 *   Re-enabling / reactivating requires real network rediscovery via CoinRuntimeBootstrapService.
 * - Transition to LIVE strictly requires profile.liveEnabled === true.
 */
const ALLOWED_LIFECYCLE_TRANSITIONS: Readonly<Record<CoinLifecycleState, readonly CoinLifecycleState[]>> =
  Object.freeze({
    DISCOVERED: Object.freeze<CoinLifecycleState[]>(['DATA_LOADING', 'DISABLED']),
    DATA_LOADING: Object.freeze<CoinLifecycleState[]>(['DATA_READY', 'DISABLED']),
    DATA_READY: Object.freeze<CoinLifecycleState[]>(['BACKTESTING', 'DATA_LOADING', 'DISABLED']),
    BACKTESTING: Object.freeze<CoinLifecycleState[]>(['RESEARCH_APPROVED', 'DATA_READY', 'DISABLED']),
    RESEARCH_APPROVED: Object.freeze<CoinLifecycleState[]>(['PAPER', 'BACKTESTING', 'DISABLED']),
    PAPER: Object.freeze<CoinLifecycleState[]>(['PAPER_APPROVED', 'RESEARCH_APPROVED', 'DISABLED']),
    PAPER_APPROVED: Object.freeze<CoinLifecycleState[]>(['SHADOW', 'PAPER', 'DISABLED']),
    SHADOW: Object.freeze<CoinLifecycleState[]>(['LIVE_CANDIDATE', 'PAPER_APPROVED', 'DISABLED']),
    LIVE_CANDIDATE: Object.freeze<CoinLifecycleState[]>(['LIVE', 'SHADOW', 'DISABLED']),
    LIVE: Object.freeze<CoinLifecycleState[]>(['DISABLED']),
    DISABLED: Object.freeze<CoinLifecycleState[]>([]), // No direct transition; requires rediscovery
  });

/**
 * Returns true if transitioning from current state to target state is legally permitted.
 * If target is LIVE, liveEnabled must be explicitly true.
 */
export function isValidLifecycleTransition(
  current: CoinLifecycleState,
  target: CoinLifecycleState,
  liveEnabled = true
): boolean {
  if (current === target) {
    return false;
  }
  if (target === 'LIVE' && !liveEnabled) {
    return false;
  }
  const allowed = ALLOWED_LIFECYCLE_TRANSITIONS[current];
  return allowed ? allowed.includes(target) : false;
}

/**
 * Validates a lifecycle transition, throwing CoinLifecycleError if the transition is prohibited.
 * Enforces both the sequential transition table and the liveEnabled configuration gate.
 */
export function assertValidLifecycleTransition(
  current: CoinLifecycleState,
  target: CoinLifecycleState,
  underlying = 'UNKNOWN',
  liveEnabled = true
): void {
  if (target === 'LIVE' && !liveEnabled) {
    throw new CoinLifecycleError(
      `Cannot transition coin '${underlying}' to 'LIVE': profile.liveEnabled is false`,
      {
        underlying,
        currentLifecycle: current,
        targetLifecycle: target,
        liveEnabled,
      }
    );
  }

  if (!isValidLifecycleTransition(current, target, liveEnabled)) {
    throw new CoinLifecycleError(
      `Illegal coin lifecycle transition from '${current}' to '${target}' for coin '${underlying}'`,
      {
        underlying,
        currentLifecycle: current,
        targetLifecycle: target,
        allowedTransitions: ALLOWED_LIFECYCLE_TRANSITIONS[current] ?? [],
      }
    );
  }
}

const FUNDING_BLOCKED_PROMOTION_TARGETS: readonly CoinLifecycleState[] = Object.freeze([
  'PAPER_APPROVED',
  'SHADOW',
  'LIVE_CANDIDATE',
  'LIVE',
]);

/**
 * Central production authorization layered on top of the abstract lifecycle
 * graph. The graph remains independently testable, while normal registry
 * transitions cannot promote funding-excluded paper evidence beyond PAPER.
 */
export function assertProductionLifecycleTransitionAuthorized(
  current: CoinLifecycleState,
  target: CoinLifecycleState,
  underlying = 'UNKNOWN',
  liveEnabled = true,
): void {
  assertValidLifecycleTransition(current, target, underlying, liveEnabled);
  if (
    !isPaperFundingProductionPromotionEvidence()
    && FUNDING_BLOCKED_PROMOTION_TARGETS.includes(target)
  ) {
    throw new CoinLifecycleError(
      `[FUNDING_UNSUPPORTED] Cannot promote coin '${underlying}' from '${current}' to '${target}': paper economics exclude CoinDCX funding`,
      {
        underlying,
        currentLifecycle: current,
        targetLifecycle: target,
        reason: PAPER_FUNDING_CAPABILITY.fundingCapability,
        providerReason: PAPER_FUNDING_CAPABILITY.reason,
        economicCompleteness: PAPER_FUNDING_CAPABILITY.economicCompleteness,
        maximumLifecycle: 'PAPER',
      },
    );
  }
}
