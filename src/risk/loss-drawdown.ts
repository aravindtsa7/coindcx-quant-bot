import { checkedProduct, riskDecimal, ValuationNumericContextError } from './decimal';
import type { RiskRejectionCode } from './reason-codes';
import type { AccountRiskSnapshot, RiskPolicy } from './types';

export function lossDrawdownReasons(account: AccountRiskSnapshot | null, policy: RiskPolicy, evaluationTimeMs: number): readonly RiskRejectionCode[] {
  if (account === null || !account.accountStateKnown) return ['ACCOUNT_STATE_UNAVAILABLE'];
  const reasons: RiskRejectionCode[] = [];
  const pnl = account.dailyPnl;
  const recomputed = riskDecimal(pnl.realizedTradingPnlInr).plus(pnl.fundingPnlInr).minus(pnl.feesInr).plus(pnl.otherAccountAdjustmentsInr);
  if (!recomputed.eq(pnl.netDailyPnlInr)) reasons.push('ACCOUNT_STATE_UNAVAILABLE');
  const dailyLoss = recomputed.isNegative() ? recomputed.negated() : riskDecimal('0');
  const globalDaily = riskDecimal(policy.globalConfig.globalMaxDailyLossInr); const modeDaily = riskDecimal(policy.modeConfig.maxDailyLossInr);
  const inrCap = globalDaily.lt(modeDaily) ? globalDaily : modeDaily;
  if (dailyLoss.gte(inrCap)) reasons.push('DAILY_LOSS_LIMIT');
  const percentCaps = [policy.globalConfig.globalDailyLossLimitPercent, policy.modeConfig.dailyLossLimitPercent].filter((value): value is string => value !== null);
  if (percentCaps.length > 0 && riskDecimal(account.currentEquityInr).gt(0)) {
    const cap = percentCaps.map(riskDecimal).reduce((left, right) => left.lt(right) ? left : right);
    try {
      if (checkedProduct(dailyLoss, riskDecimal('100')).gte(checkedProduct(riskDecimal(account.currentEquityInr), cap))) reasons.push('DAILY_LOSS_PERCENT_LIMIT');
    } catch (error) {
      if (error instanceof ValuationNumericContextError) reasons.push('VALUATION_NUMERIC_CONTEXT_EXCEEDED'); else throw error;
    }
  }
  if (riskDecimal(account.peakEquityInr).lte(0) || riskDecimal(account.currentEquityInr).lte(0)) reasons.push('ACCOUNT_STATE_UNAVAILABLE');
  else {
    const decline = riskDecimal(account.peakEquityInr).minus(account.currentEquityInr);
    const globalDrawdown = riskDecimal(policy.globalConfig.globalMaxDrawdownPercent); const modeDrawdown = riskDecimal(policy.modeConfig.maxDrawdownPercent);
    const cap = globalDrawdown.lt(modeDrawdown) ? globalDrawdown : modeDrawdown;
    try {
      if (checkedProduct(decline, riskDecimal('100')).gte(checkedProduct(riskDecimal(account.peakEquityInr), cap))) reasons.push('DRAWDOWN_LIMIT');
    } catch (error) {
      if (error instanceof ValuationNumericContextError) reasons.push('VALUATION_NUMERIC_CONTEXT_EXCEEDED'); else throw error;
    }
  }
  if (policy.modeConfig.consecutiveLossLimit !== null && account.consecutiveLossCount >= policy.modeConfig.consecutiveLossLimit &&
      account.cooldownActiveUntilMs !== null && evaluationTimeMs < account.cooldownActiveUntilMs) reasons.push('CONSECUTIVE_LOSS_COOLDOWN_ACTIVE');
  return reasons;
}
