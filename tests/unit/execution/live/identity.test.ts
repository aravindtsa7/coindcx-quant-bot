import { describe, expect, it } from 'vitest';
import {
  computeLiveExecutionIntentId,
  deriveLiveClientOrderId,
  isLiveClientOrderId,
  LIVE_CLIENT_ORDER_ID_LENGTH,
  LIVE_CLIENT_ORDER_ID_PATTERN,
} from '../../../../src/execution/live/identity';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import type { LiveExecutionIntentContent } from '../../../../src/execution/live/types';

const BASE: LiveExecutionIntentContent = Object.freeze({
  accountId: 'account-live-1',
  pair: 'B-BTC_USDT',
  side: 'BUY',
  action: 'OPEN',
  quantity: '0.5',
  orderType: 'LIMIT',
  price: '64000.50',
  timeInForce: 'UNSPECIFIED',
  leverage: '5',
  riskDecisionId: 'risk-decision-1',
  admissionId: 'admission-1',
  strategyInstanceId: 'instance-1',
  strategyId: 'EMA_TREND',
  strategyVersion: '1.0.0',
  parameterHash: 'p'.repeat(64),
  liveExecutionPolicyId: 'policy-1',
  instrumentSpecSnapshotId: 'spec-1',
  authorizedNotionalInr: '2560020',
  settlementRateInrPerQuote: '80',
  positionInstanceId: null,
  positionRevision: null,
  reduceOnlyQuantity: null,
});

function withField<K extends keyof LiveExecutionIntentContent>(key: K, value: LiveExecutionIntentContent[K]): LiveExecutionIntentContent {
  return Object.freeze({ ...BASE, [key]: value });
}

describe('P17 live execution intent identity — determinism', () => {
  it('is a pure function of economic content: the same content always hashes the same', () => {
    expect(computeLiveExecutionIntentId(BASE)).toBe(computeLiveExecutionIntentId({ ...BASE }));
  });

  it('is independent of property insertion order', () => {
    const reordered: LiveExecutionIntentContent = {
      reduceOnlyQuantity: BASE.reduceOnlyQuantity,
      positionRevision: BASE.positionRevision,
      positionInstanceId: BASE.positionInstanceId,
      settlementRateInrPerQuote: BASE.settlementRateInrPerQuote,
      authorizedNotionalInr: BASE.authorizedNotionalInr,
      instrumentSpecSnapshotId: BASE.instrumentSpecSnapshotId,
      liveExecutionPolicyId: BASE.liveExecutionPolicyId,
      parameterHash: BASE.parameterHash,
      strategyVersion: BASE.strategyVersion,
      strategyId: BASE.strategyId,
      strategyInstanceId: BASE.strategyInstanceId,
      admissionId: BASE.admissionId,
      riskDecisionId: BASE.riskDecisionId,
      leverage: BASE.leverage,
      timeInForce: BASE.timeInForce,
      price: BASE.price,
      orderType: BASE.orderType,
      quantity: BASE.quantity,
      action: BASE.action,
      side: BASE.side,
      pair: BASE.pair,
      accountId: BASE.accountId,
    };
    expect(computeLiveExecutionIntentId(reordered)).toBe(computeLiveExecutionIntentId(BASE));
  });

  it('canonicalizes numerically equivalent decimals to one identity', () => {
    expect(computeLiveExecutionIntentId(withField('quantity', '0.500'))).toBe(computeLiveExecutionIntentId(BASE));
    expect(computeLiveExecutionIntentId(withField('price', '64000.5000'))).toBe(computeLiveExecutionIntentId(BASE));
  });

  it('never consults a clock, a random source, or process state', () => {
    const first = computeLiveExecutionIntentId(BASE);
    const clientOrderId = deriveLiveClientOrderId(BASE);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect(computeLiveExecutionIntentId(BASE)).toBe(first);
      expect(deriveLiveClientOrderId(BASE)).toBe(clientOrderId);
    }
  });
});

describe('P17 live execution intent identity — collision resistance across economic fields', () => {
  const variants: ReadonlyArray<readonly [string, LiveExecutionIntentContent]> = [
    ['accountId', withField('accountId', 'account-live-2')],
    ['pair', withField('pair', 'B-ETH_USDT')],
    ['side', withField('side', 'SELL')],
    ['action', withField('action', 'CLOSE')],
    ['quantity', withField('quantity', '0.6')],
    ['orderType', withField('orderType', 'MARKET')],
    ['price', withField('price', '64000.51')],
    ['timeInForce', withField('timeInForce', 'IMMEDIATE_OR_CANCEL')],
    ['leverage', withField('leverage', '6')],
    ['riskDecisionId', withField('riskDecisionId', 'risk-decision-2')],
    ['admissionId', withField('admissionId', 'admission-2')],
    ['strategyInstanceId', withField('strategyInstanceId', 'instance-2')],
    ['strategyId', withField('strategyId', 'OTHER')],
    ['strategyVersion', withField('strategyVersion', '1.0.1')],
    ['parameterHash', withField('parameterHash', 'q'.repeat(64))],
    ['liveExecutionPolicyId', withField('liveExecutionPolicyId', 'policy-2')],
    ['instrumentSpecSnapshotId', withField('instrumentSpecSnapshotId', 'spec-2')],
  ];

  it.each(variants.map(([field, content]) => [field, content] as const))(
    'changing %s produces a different intent id and a different client order id',
    (_field, content) => {
      expect(computeLiveExecutionIntentId(content)).not.toBe(computeLiveExecutionIntentId(BASE));
      expect(deriveLiveClientOrderId(content)).not.toBe(deriveLiveClientOrderId(BASE));
    },
  );

  it('produces 17 distinct identities plus the base, with no pairwise collision', () => {
    const ids = new Set([BASE, ...variants.map(([, content]) => content)].map(computeLiveExecutionIntentId));
    expect(ids.size).toBe(variants.length + 1);
  });

  it('a price change alone still changes identity even when quantity is unchanged', () => {
    expect(computeLiveExecutionIntentId(withField('price', '1'))).not.toBe(computeLiveExecutionIntentId(BASE));
  });
});

describe('P17 deterministic client order id — documented adapter policy', () => {
  it('matches the frozen format: p17- prefix, 32 lowercase hex characters, 36 total', () => {
    const clientOrderId = deriveLiveClientOrderId(BASE);
    expect(clientOrderId).toMatch(LIVE_CLIENT_ORDER_ID_PATTERN);
    expect(clientOrderId).toHaveLength(LIVE_CLIENT_ORDER_ID_LENGTH);
    expect(clientOrderId).toHaveLength(36);
    expect(clientOrderId.startsWith('p17-')).toBe(true);
  });

  it('uses only characters every documented venue constraint permits', () => {
    for (const content of [BASE, withField('pair', 'B-SOL_USDT'), withField('side', 'SELL')]) {
      expect(deriveLiveClientOrderId(content)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('is derived in a hash domain distinct from the intent id (one can never be mistaken for the other)', () => {
    const intentId = computeLiveExecutionIntentId(BASE);
    const clientOrderId = deriveLiveClientOrderId(BASE);
    expect(clientOrderId.slice(4)).not.toBe(intentId.slice(0, 32));
    expect(intentId.includes(clientOrderId.slice(4))).toBe(false);
  });

  it('recognizes its own format and rejects foreign identifiers', () => {
    expect(isLiveClientOrderId(deriveLiveClientOrderId(BASE))).toBe(true);
    expect(isLiveClientOrderId('p17-NOTHEX')).toBe(false);
    expect(isLiveClientOrderId('order-123')).toBe(false);
    expect(isLiveClientOrderId(42)).toBe(false);
    expect(isLiveClientOrderId(null)).toBe(false);
  });
});

describe('P17 identity input validation fails closed', () => {
  it('rejects a non-fixed-point quantity', () => {
    expect(() => computeLiveExecutionIntentId(withField('quantity', '1e-3'))).toThrow(LiveExecutionError);
  });

  it('rejects an empty or padded account id', () => {
    expect(() => computeLiveExecutionIntentId(withField('accountId', ''))).toThrow(LiveExecutionError);
    expect(() => computeLiveExecutionIntentId(withField('accountId', ' account '))).toThrow(LiveExecutionError);
  });

  it('rejects an unknown side, action, order type, or time in force', () => {
    expect(() => computeLiveExecutionIntentId(withField('side', 'LONG' as never))).toThrow(LiveExecutionError);
    expect(() => computeLiveExecutionIntentId(withField('action', 'REVERSE' as never))).toThrow(LiveExecutionError);
    expect(() => computeLiveExecutionIntentId(withField('orderType', 'STOP' as never))).toThrow(LiveExecutionError);
    expect(() => computeLiveExecutionIntentId(withField('timeInForce', 'GTC' as never))).toThrow(LiveExecutionError);
  });
});
