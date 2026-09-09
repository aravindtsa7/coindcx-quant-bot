import { describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import {
  mintPaperCloseExecutionAuthority, PaperCloseExecutionAuthority, type PaperClosePositionBinding, type PaperCloseRiskEvidence,
} from '../../../src/execution/close-authority';
import { PaperOpenExecutionAuthority } from '../../../src/execution/open-authority';
import { PaperEngineError } from '../../../src/execution/errors';
import { buildContext, evaluateDecision, makeKernel, policyFor, PAIR } from '../dispatch/helpers';
import { makePair, seal } from '../risk/helpers';
import type { CanonicalPositionValuation, PairRiskSnapshot, RiskEvaluationContext } from '../../../src/risk';
import type { StrategyKernel } from '../../../src/strategies';

// Must match `makeAccount()`'s default `accountId` — RiskEngine's
// PAIR_ACCOUNT_INSTRUMENT_IDENTITY check requires `pairSnapshot.ownership.accountId`
// to agree with the account snapshot's accountId.
const ACCOUNT = 'account-1';
const T0 = 1_200_000;
const POSITION_INSTANCE_ID = 'p'.repeat(64);
const OWNED_QUANTITY = '10';

function evidenceFrom(context: RiskEvaluationContext): PaperCloseRiskEvidence {
  const { strategyOrigin: _strategyOrigin, candidate: _candidate, ...evidence } = context;
  return evidence;
}

function valuation(): CanonicalPositionValuation {
  return {
    valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt',
    valuationPriceUsdt: '100', valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: T0,
    valuationPriceObservedAtMs: T0, contractMultiplier: '0.001', conversionMarket: 'USDT_INR',
    conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source', unitValuationInrPerQty: '8',
    aggregateCurrentNotionalInr: '80',
  };
}

function openPairSnapshotFor(kernel: StrategyKernel): PairRiskSnapshot {
  return seal({
    ...makePair(),
    pair: kernel.pair,
    position: { state: 'OPEN', positionId: 'exchange-position-1', positionDirection: 'LONG', quantityMagnitude: OWNED_QUANTITY, valuation: valuation() },
    ownership: {
      status: 'RECONCILED', positionState: 'OPEN', accountId: ACCOUNT, pair: kernel.pair, positionId: 'exchange-position-1',
      instanceOwnership: [{
        strategyInstanceId: kernel.strategyInstanceId, strategyId: kernel.strategyId, strategyVersion: kernel.strategyVersion,
        parameterHash: kernel.parameterHash, currentQuantity: OWNED_QUANTITY, currentNotionalInr: '80',
      }],
    },
  });
}

function positionBindingFor(kernel: StrategyKernel): PaperClosePositionBinding {
  return {
    positionInstanceId: POSITION_INSTANCE_ID, positionRevision: 1,
    ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
    ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash, ownedQuantity: OWNED_QUANTITY,
  };
}

function closeContextFor(kernel: StrategyKernel) {
  const decision = evaluateDecision(kernel, T0, 'FLAT');
  const context = buildContext(kernel, decision, { pairSnapshot: openPairSnapshotFor(kernel) });
  return { decision, context };
}

describe('P14-A PaperCloseExecutionAuthority — genuine, research-exempt composition', () => {
  it('mints a genuine authority for a reconciled-owner CLOSE decision with zero research approval plumbed in', async () => {
    const kernel = makeKernel(PAIR);
    const { decision, context } = closeContextFor(kernel);
    const coordinator = new RiskAdmissionCoordinator();
    const authority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      policy: policyFor(), evidence: evidenceFrom(context), position: positionBindingFor(kernel),
    });
    expect(authority).not.toBeNull();
    const record = PaperCloseExecutionAuthority.read(authority);
    expect(record).not.toBeNull();
    expect(record?.accountId).toBe(ACCOUNT);
    expect(record?.decision.action).toBe('CLOSE');
    expect(record?.position.positionInstanceId).toBe(POSITION_INSTANCE_ID);
    expect(record?.reduceOnlyQuantity).toBe(OWNED_QUANTITY);
  });

  it('rejects when the caller-supplied position binding does not match the decision\'s owning strategy identity', async () => {
    const kernel = makeKernel(PAIR);
    const { decision, context } = closeContextFor(kernel);
    const coordinator = new RiskAdmissionCoordinator();
    const wrongBinding: PaperClosePositionBinding = { ...positionBindingFor(kernel), ownerStrategyInstanceId: 'someone-elses-instance' };
    const authority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      policy: policyFor(), evidence: evidenceFrom(context), position: wrongBinding,
    });
    expect(authority).toBeNull();
  });

  it('reduceOnlyQuantity is always the position\'s owned quantity — there is no input path for a caller-desired target quantity', async () => {
    const kernel = makeKernel(PAIR);
    const { decision, context } = closeContextFor(kernel);
    const coordinator = new RiskAdmissionCoordinator();
    const binding = positionBindingFor(kernel);
    const authority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      policy: policyFor(), evidence: evidenceFrom(context), position: binding,
    });
    const record = PaperCloseExecutionAuthority.read(authority);
    expect(record?.reduceOnlyQuantity).toBe(binding.ownedQuantity);
  });

  it('returns null when the RiskEngine/coordinator path does not accept the decision as CLOSE (e.g. the pair is actually FLAT)', async () => {
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0, 'FLAT');
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision); // default pairSnapshot is FLAT — target FLAT + position FLAT => NO_CHANGE, never CLOSE
    const authority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      policy: policyFor(), evidence: evidenceFrom(context), position: positionBindingFor(kernel),
    });
    expect(authority).toBeNull();
  });
});

describe('P14-A PaperCloseExecutionAuthority — forgery and lifecycle protection', () => {
  it('rejects direct construction with a foreign issuer symbol (forged capability)', () => {
    const forged = () => new PaperCloseExecutionAuthority(Symbol('forged'), {
      accountId: 'x', decision: {} as never, strategyOrigin: {} as never, position: {} as never, reduceOnlyQuantity: '1',
    });
    expect(forged).toThrow(PaperEngineError);
  });

  it('.read() rejects a caller-shaped lookalike object', async () => {
    const kernel = makeKernel(PAIR);
    const { decision, context } = closeContextFor(kernel);
    const coordinator = new RiskAdmissionCoordinator();
    const authority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      policy: policyFor(), evidence: evidenceFrom(context), position: positionBindingFor(kernel),
    });
    const genuine = PaperCloseExecutionAuthority.read(authority);
    expect(genuine).not.toBeNull();
    expect(PaperCloseExecutionAuthority.read({ ...genuine })).toBeNull();
  });

  it('a genuine CLOSE authority is never itself readable as an OPEN authority', async () => {
    const kernel = makeKernel(PAIR);
    const { decision, context } = closeContextFor(kernel);
    const coordinator = new RiskAdmissionCoordinator();
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      policy: policyFor(), evidence: evidenceFrom(context), position: positionBindingFor(kernel),
    });
    expect(PaperOpenExecutionAuthority.read(closeAuthority)).toBeNull();
  });

  it('structurally cannot represent OPEN or a reversal — decision.action is always CLOSE', async () => {
    const kernel = makeKernel(PAIR);
    const { decision, context } = closeContextFor(kernel);
    const coordinator = new RiskAdmissionCoordinator();
    const authority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      policy: policyFor(), evidence: evidenceFrom(context), position: positionBindingFor(kernel),
    });
    const record = PaperCloseExecutionAuthority.read(authority);
    expect(record?.decision.action).toBe('CLOSE');
  });
});
