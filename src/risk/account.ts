import { riskDecimal } from './decimal';
import type { RiskRejectionCode } from './reason-codes';
import type { AccountRiskSnapshot } from './types';

// [C-F03] Only fields that are unquestionably non-negative under every documented account
// model (docs/RISK_LEVERAGE_ENGINE.md §15.1) are checked here. No available+locked<=equity
// decomposition is enforced: the provider contract does not guarantee that relationship.
export function accountStateReasons(account: AccountRiskSnapshot | null): readonly RiskRejectionCode[] {
  if (account === null || !account.accountStateKnown) return ['ACCOUNT_STATE_UNAVAILABLE'];
  if (riskDecimal(account.availableMarginInr).isNegative() || riskDecimal(account.lockedMarginInr).isNegative() ||
      riskDecimal(account.currentEquityInr).isNegative()) {
    return ['ACCOUNT_STATE_UNAVAILABLE'];
  }
  return [];
}
