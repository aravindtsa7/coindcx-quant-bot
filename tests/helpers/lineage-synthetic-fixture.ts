/** SYNTHETIC ONLY. Same structural fixture facility as the reviewed offline export and real-DB persistence suites. */
import { createHash } from 'node:crypto';
import type { LiveExecutionIntentRecord } from '../../src/execution/live/intent';

export const SYNTHETIC_ACCOUNT = 'SYNTHETIC-M4-LINEAGE';
export const SYNTHETIC_FINGERPRINT = createHash('sha256').update('SYNTHETIC-M4-NOT-A-PROVIDER-ACCOUNT').digest('hex');
export const SYNTHETIC_QUANTITY = '0.123456789012345678';
export const SYNTHETIC_PRICE = '64000.000000000000000001';
export const SYNTHETIC_LEVERAGE = '3.000000000000000001';
export function syntheticLineageIntent(): LiveExecutionIntentRecord {
  return {
    intentId: 'a1'.repeat(32), clientOrderId: `p17-${'a1'.repeat(16)}`, wireOrderType: 'limit_order',
    quantityAdjusted: false, priceAdjusted: false,
    content: {
      accountId: SYNTHETIC_ACCOUNT, pair: 'B-BTC_USDT', side: 'BUY', action: 'OPEN', quantity: SYNTHETIC_QUANTITY,
      orderType: 'LIMIT', price: SYNTHETIC_PRICE, timeInForce: 'UNSPECIFIED', leverage: SYNTHETIC_LEVERAGE,
      riskDecisionId: 'SYNTHETIC-risk', admissionId: 'SYNTHETIC-admission', strategyInstanceId: 'SYNTHETIC-instance',
      strategyId: 'SYNTHETIC-strategy', strategyVersion: '1.0.0', parameterHash: 'b2'.repeat(32),
      liveExecutionPolicyId: 'SYNTHETIC-policy', instrumentSpecSnapshotId: 'SYNTHETIC-spec',
      authorizedNotionalInr: '2560020', settlementRateInrPerQuote: '80', positionInstanceId: null,
      positionRevision: null, reduceOnlyQuantity: null,
    },
    lineage: { researchApproval: null, sourceStrategyDecisionId: 'SYNTHETIC-decision' },
  };
}
