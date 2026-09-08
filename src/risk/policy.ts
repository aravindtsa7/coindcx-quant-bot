import { sha256CanonicalJson } from './canonical';
import { canonicalDecimalString, riskDecimal } from './decimal';
import { RiskConfigError, RiskEngineError } from './errors';
import { freezeRiskRuntime } from './immutable';
import { computePositionSizingPolicyId, computeRiskPolicyId } from './identity';
import { assertRejectionPrecedenceIntegrity } from './reason-codes';
import type {
  GlobalRiskConfig, PairRiskConfig, RiskFreshnessPolicy, RiskModeConfig, RiskOverride,
  RiskPolicy, RiskPolicyDraft, RiskSourceAuthorityPolicy, RiskValuationPolicy,
} from './types';

function fail(message: string): never { throw new RiskConfigError('RISK_CONFIG_INVALID', message); }
function configKeys(value: unknown, expected: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(`${label} has invalid keys`);
}
function configDecimal(value: unknown, label: string, allowZero = false): string {
  try {
    const normalized = canonicalDecimalString(value, label);
    if (allowZero ? riskDecimal(normalized).lt(0) : riskDecimal(normalized).lte(0)) fail(`${label} must be ${allowZero ? 'non-negative' : 'positive'}`);
    return normalized;
  } catch (error) {
    if (error instanceof RiskConfigError) throw error;
    if (error instanceof RiskEngineError) fail(error.message);
    fail(`${label} is invalid`);
  }
}
function optionalDecimal(value: unknown, label: string): string | null { return value === null ? null : configDecimal(value, label); }
function count(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive safe integer`);
  return value as number;
}
function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(`${label} must be a non-empty exact string`);
  return value;
}

export function createRiskPolicy(draft: RiskPolicyDraft): RiskPolicy {
  if (draft === null || typeof draft !== 'object') fail('Risk policy draft must be an object');
  configKeys(draft, ['globalConfig', 'pairConfig', 'modeConfig', 'sourceAuthorityPolicy', 'freshnessPolicy', 'valuationPolicy'], 'RiskPolicyDraft');
  configKeys(draft.globalConfig, ['globalMaxLeverage', 'globalMaxOpenNotionalInr', 'globalMaxConcurrentPositions', 'globalMaxDailyLossInr', 'globalDailyLossLimitPercent', 'globalMaxDrawdownPercent'], 'GlobalRiskConfig');
  configKeys(draft.pairConfig, ['pair', 'pairMaxLeverage', 'pairMaxExposureInr', 'pairMaxConcurrentPositions'], 'PairRiskConfig');
  configKeys(draft.modeConfig, ['mode', 'riskPerTradePercent', 'maxNotionalPerTradeInr', 'leverageRecommendation', 'maxConcurrentExposureInr', 'maxCoinExposureInr', 'maxStrategyExposureInr', 'maxConcurrentPositions', 'maxDailyLossInr', 'dailyLossLimitPercent', 'maxDrawdownPercent', 'consecutiveLossLimit', 'cooldownMs'], 'RiskModeConfig');
  configKeys(draft.sourceAuthorityPolicy, ['accountRiskSourceId', 'pairRiskSourceId', 'exposureSourceId', 'leverageTierSourceId', 'conversionSourceId'], 'RiskSourceAuthorityPolicy');
  configKeys(draft.freshnessPolicy, ['maxAccountSnapshotAgeMs', 'maxPairSnapshotAgeMs', 'maxExposureSnapshotAgeMs', 'maxLeverageTierSnapshotAgeMs', 'maxSettlementRateSnapshotAgeMs'], 'RiskFreshnessPolicy');
  configKeys(draft.valuationPolicy, ['valuationMethodVersion', 'valuationPriceField', 'valuationUnitScale', 'valuationUnitRounding'], 'RiskValuationPolicy');
  assertRejectionPrecedenceIntegrity();
  const globalBody = {
    globalMaxLeverage: configDecimal(draft.globalConfig.globalMaxLeverage, 'globalMaxLeverage'),
    globalMaxOpenNotionalInr: configDecimal(draft.globalConfig.globalMaxOpenNotionalInr, 'globalMaxOpenNotionalInr'),
    globalMaxConcurrentPositions: count(draft.globalConfig.globalMaxConcurrentPositions, 'globalMaxConcurrentPositions') as number,
    globalMaxDailyLossInr: configDecimal(draft.globalConfig.globalMaxDailyLossInr, 'globalMaxDailyLossInr'),
    globalDailyLossLimitPercent: optionalDecimal(draft.globalConfig.globalDailyLossLimitPercent, 'globalDailyLossLimitPercent'),
    globalMaxDrawdownPercent: configDecimal(draft.globalConfig.globalMaxDrawdownPercent, 'globalMaxDrawdownPercent'),
  };
  const globalConfig: GlobalRiskConfig = { ...globalBody, globalRiskConfigId: sha256CanonicalJson(globalBody) };
  const pairBody = {
    pair: exactString(draft.pairConfig.pair, 'pair'),
    pairMaxLeverage: configDecimal(draft.pairConfig.pairMaxLeverage, 'pairMaxLeverage'),
    pairMaxExposureInr: configDecimal(draft.pairConfig.pairMaxExposureInr, 'pairMaxExposureInr'),
    pairMaxConcurrentPositions: count(draft.pairConfig.pairMaxConcurrentPositions, 'pairMaxConcurrentPositions', true),
  };
  const pairConfig: PairRiskConfig = { ...pairBody, pairRiskConfigId: sha256CanonicalJson(pairBody) };
  const supported = ['SAFE', 'NORMAL', 'HIGH', 'CUSTOM'];
  if (!supported.includes(draft.modeConfig.mode)) throw new RiskConfigError('UNSUPPORTED_RISK_MODE', 'Unsupported risk mode');
  const modeBody = {
    mode: draft.modeConfig.mode,
    riskPerTradePercent: configDecimal(draft.modeConfig.riskPerTradePercent, 'riskPerTradePercent'),
    maxNotionalPerTradeInr: configDecimal(draft.modeConfig.maxNotionalPerTradeInr, 'maxNotionalPerTradeInr'),
    leverageRecommendation: configDecimal(draft.modeConfig.leverageRecommendation, 'leverageRecommendation'),
    maxConcurrentExposureInr: configDecimal(draft.modeConfig.maxConcurrentExposureInr, 'maxConcurrentExposureInr'),
    maxCoinExposureInr: configDecimal(draft.modeConfig.maxCoinExposureInr, 'maxCoinExposureInr'),
    maxStrategyExposureInr: configDecimal(draft.modeConfig.maxStrategyExposureInr, 'maxStrategyExposureInr'),
    maxConcurrentPositions: count(draft.modeConfig.maxConcurrentPositions, 'maxConcurrentPositions') as number,
    maxDailyLossInr: configDecimal(draft.modeConfig.maxDailyLossInr, 'maxDailyLossInr'),
    dailyLossLimitPercent: optionalDecimal(draft.modeConfig.dailyLossLimitPercent, 'dailyLossLimitPercent'),
    maxDrawdownPercent: configDecimal(draft.modeConfig.maxDrawdownPercent, 'maxDrawdownPercent'),
    consecutiveLossLimit: count(draft.modeConfig.consecutiveLossLimit, 'consecutiveLossLimit', true),
    cooldownMs: count(draft.modeConfig.cooldownMs, 'cooldownMs', true),
  };
  const modeConfig: RiskModeConfig = { ...modeBody, riskModeConfigId: sha256CanonicalJson(modeBody) };
  const sourceBody = {
    accountRiskSourceId: exactString(draft.sourceAuthorityPolicy.accountRiskSourceId, 'accountRiskSourceId'),
    pairRiskSourceId: exactString(draft.sourceAuthorityPolicy.pairRiskSourceId, 'pairRiskSourceId'),
    exposureSourceId: exactString(draft.sourceAuthorityPolicy.exposureSourceId, 'exposureSourceId'),
    leverageTierSourceId: exactString(draft.sourceAuthorityPolicy.leverageTierSourceId, 'leverageTierSourceId'),
    conversionSourceId: exactString(draft.sourceAuthorityPolicy.conversionSourceId, 'conversionSourceId'),
  };
  const sourceAuthorityPolicy: RiskSourceAuthorityPolicy = { ...sourceBody, riskSourceAuthorityPolicyId: sha256CanonicalJson(sourceBody) };
  const freshnessBody = {
    maxAccountSnapshotAgeMs: freshness(draft.freshnessPolicy.maxAccountSnapshotAgeMs, 'maxAccountSnapshotAgeMs'),
    maxPairSnapshotAgeMs: freshness(draft.freshnessPolicy.maxPairSnapshotAgeMs, 'maxPairSnapshotAgeMs'),
    maxExposureSnapshotAgeMs: freshness(draft.freshnessPolicy.maxExposureSnapshotAgeMs, 'maxExposureSnapshotAgeMs'),
    maxLeverageTierSnapshotAgeMs: freshness(draft.freshnessPolicy.maxLeverageTierSnapshotAgeMs, 'maxLeverageTierSnapshotAgeMs'),
    maxSettlementRateSnapshotAgeMs: freshness(draft.freshnessPolicy.maxSettlementRateSnapshotAgeMs, 'maxSettlementRateSnapshotAgeMs'),
  };
  const freshnessPolicy: RiskFreshnessPolicy = { ...freshnessBody, riskFreshnessPolicyId: sha256CanonicalJson(freshnessBody) };
  if (draft.valuationPolicy.valuationMethodVersion !== 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1' ||
      draft.valuationPolicy.valuationPriceField !== 'markPriceUsdt' || draft.valuationPolicy.valuationUnitRounding !== 'ROUND_HALF_UP' ||
      !Number.isSafeInteger(draft.valuationPolicy.valuationUnitScale) || draft.valuationPolicy.valuationUnitScale < 0 || draft.valuationPolicy.valuationUnitScale > 128) {
    fail('Risk valuation policy is invalid');
  }
  const valuationBody = { ...draft.valuationPolicy };
  const valuationPolicy: RiskValuationPolicy = { ...valuationBody, riskValuationPolicyId: sha256CanonicalJson(valuationBody) };
  validateAuthority(globalConfig, pairConfig, modeConfig);
  const withoutId = { globalConfig, pairConfig, modeConfig, sourceAuthorityPolicy, freshnessPolicy, valuationPolicy, positionSizingPolicyId: computePositionSizingPolicyId() };
  return freezeRiskRuntime({ ...withoutId, riskPolicyId: computeRiskPolicyId(withoutId) });
}

function freshness(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative safe integer`);
  return value as number;
}

function validateAuthority(global: GlobalRiskConfig, pair: PairRiskConfig, mode: RiskModeConfig): void {
  if (riskDecimal(pair.pairMaxLeverage).gt(global.globalMaxLeverage)) fail('pairMaxLeverage widens globalMaxLeverage');
  if (riskDecimal(pair.pairMaxExposureInr).gt(global.globalMaxOpenNotionalInr)) fail('pairMaxExposureInr widens global exposure');
  if (pair.pairMaxConcurrentPositions !== null && pair.pairMaxConcurrentPositions > global.globalMaxConcurrentPositions) fail('pair concurrency widens global concurrency');
  if (riskDecimal(mode.leverageRecommendation).gt(pair.pairMaxLeverage)) fail('mode leverage widens pair leverage');
  if (riskDecimal(mode.maxConcurrentExposureInr).gt(global.globalMaxOpenNotionalInr)) fail('mode global exposure widens global cap');
  if (riskDecimal(mode.maxCoinExposureInr).gt(pair.pairMaxExposureInr)) fail('mode pair exposure widens pair cap');
  if (mode.maxConcurrentPositions > global.globalMaxConcurrentPositions) fail('mode concurrency widens global cap');
  if (riskDecimal(mode.maxDailyLossInr).gt(global.globalMaxDailyLossInr)) fail('mode daily loss widens global cap');
  if (mode.dailyLossLimitPercent !== null && global.globalDailyLossLimitPercent !== null && riskDecimal(mode.dailyLossLimitPercent).gt(global.globalDailyLossLimitPercent)) fail('mode daily loss percent widens global cap');
  if (riskDecimal(mode.maxDrawdownPercent).gt(global.globalMaxDrawdownPercent)) fail('mode drawdown widens global cap');
  if ((mode.consecutiveLossLimit === null) !== (mode.cooldownMs === null)) fail('consecutiveLossLimit and cooldownMs must be configured together');
}

export function normalizeRiskOverride(policy: RiskPolicy, override: RiskOverride | null): RiskOverride | null {
  if (override === null) return null;
  try {
    configKeys(override, ['overrideId', 'overrideRiskPerTradePercent', 'overrideMaxLeverage', 'overrideMaxNotionalInr'], 'RiskOverride');
    const normalized = {
      overrideId: exactString(override.overrideId, 'overrideId'),
      overrideRiskPerTradePercent: optionalDecimal(override.overrideRiskPerTradePercent, 'overrideRiskPerTradePercent'),
      overrideMaxLeverage: optionalDecimal(override.overrideMaxLeverage, 'overrideMaxLeverage'),
      overrideMaxNotionalInr: optionalDecimal(override.overrideMaxNotionalInr, 'overrideMaxNotionalInr'),
    };
    if (normalized.overrideRiskPerTradePercent !== null && riskDecimal(normalized.overrideRiskPerTradePercent).gt(policy.modeConfig.riskPerTradePercent)) throw new Error('risk percent widens mode');
    if (normalized.overrideMaxLeverage !== null && riskDecimal(normalized.overrideMaxLeverage).gt(policy.modeConfig.leverageRecommendation)) throw new Error('leverage widens mode');
    if (normalized.overrideMaxNotionalInr !== null && riskDecimal(normalized.overrideMaxNotionalInr).gt(policy.modeConfig.maxNotionalPerTradeInr)) throw new Error('notional widens mode');
    return freezeRiskRuntime(normalized);
  } catch (error) {
    if (error instanceof RiskConfigError && error.code === 'UNSUPPORTED_RISK_MODE') throw error;
    throw new RiskConfigError('RISK_OVERRIDE_INVALID', error instanceof Error ? error.message : 'Invalid risk override');
  }
}
