import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { RiskAdmissionCoordinator } from '../../../../src/dispatch/admission';
import {
  LiveExecutionAuthority,
  mintLiveCloseExecutionAuthority,
  mintLiveOpenExecutionAuthority,
  readLiveAuthorityForIntent,
  type LiveClosePositionBinding,
} from '../../../../src/execution/live/authority';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import { LiveExecutionIntent } from '../../../../src/execution/live/intent';
import { PaperOpenExecutionAuthority, mintPaperOpenExecutionAuthority } from '../../../../src/execution/open-authority';
import { PaperCloseExecutionAuthority } from '../../../../src/execution/close-authority';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, policyFor, PAIR } from '../../dispatch/helpers';
import {
  constraintsFor,
  enabledLiveConfig,
  genuineEnablement,
  limitShape,
  livePolicy,
  LIVE_ACCOUNT,
  MARKET_SHAPE,
  mintGenuineLiveOpen,
  OTHER_ACCOUNT,
  T0,
} from './helpers';
import type { RiskEvaluationContext } from '../../../../src/risk';
import { resolveLiveExecutionGate } from '../../../../src/execution/live/gate';
import { seal } from '../../risk/helpers';

function evidenceFrom(context: RiskEvaluationContext): Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'> {
  const { strategyOrigin: _strategyOrigin, candidate: _candidate, ...evidence } = context;
  const ownership = evidence.pairSnapshot.ownership.status === 'RECONCILED'
    ? { ...evidence.pairSnapshot.ownership, accountId: LIVE_ACCOUNT }
    : evidence.pairSnapshot.ownership;
  return {
    ...evidence,
    accountSnapshot: evidence.accountSnapshot === null ? null : seal({ ...evidence.accountSnapshot, accountId: LIVE_ACCOUNT }),
    exposureSnapshot: evidence.exposureSnapshot === null ? null : seal({ ...evidence.exposureSnapshot, accountId: LIVE_ACCOUNT }),
    pairSnapshot: seal({ ...evidence.pairSnapshot, ownership }),
  };
}

const TIMEOUT = 60_000;

describe('P17-I01/I02 the live authority chain requires genuine upstream approval', () => {
  it('a plain fake coordinator cannot mint live authority', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision);
    const fake = { admit: async () => ({ status: 'ADMITTED', decision: { approved: { approvedQuantity: '999', approvedLeverage: '99' } }, admission: { admissionId: 'forged' } }) };
    await expect(mintLiveOpenExecutionAuthority({
      enablement: genuineEnablement(), coordinator: fake as never, accountId: LIVE_ACCOUNT, kernel, decision,
      instrumentSpecSnapshotId: 'instrument-1', planResult: result, riskPolicy: policyFor(), evidence: evidenceFrom(context),
      livePolicy: livePolicy(), constraints: constraintsFor(), shape: limitShape('100'),
    })).rejects.toThrow(/genuine coordinator/i);
  }, TIMEOUT);

  it('a genuine coordinator subclass cannot substitute a fabricated admission DTO', async () => {
    let overrideCalled = false;
    class ForgingCoordinator extends RiskAdmissionCoordinator {
      public override async admit(): Promise<never> {
        overrideCalled = true;
        return { status: 'ADMITTED', decision: { approved: { approvedQuantity: '999' } }, admission: { admissionId: 'forged' } } as never;
      }
    }
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision);
    const minted = await mintLiveOpenExecutionAuthority({
      enablement: genuineEnablement(), coordinator: new ForgingCoordinator(), accountId: LIVE_ACCOUNT, kernel, decision,
      instrumentSpecSnapshotId: 'instrument-1', planResult: result, riskPolicy: policyFor(), evidence: evidenceFrom(context),
      livePolicy: livePolicy(), constraints: constraintsFor(), shape: limitShape('100'),
    });
    expect(overrideCalled).toBe(false);
    expect(minted).not.toBeNull();
    expect(LiveExecutionIntent.read(minted?.intent)?.content.quantity).not.toBe('999');
  }, TIMEOUT);
  it('mints when research approval, kernel origin, and admission all genuinely succeed', async () => {
    const minted = await mintGenuineLiveOpen();
    const record = LiveExecutionAuthority.read(minted.authority);
    expect(record).not.toBeNull();
    expect(record?.action).toBe('OPEN');
    expect(record?.accountId).toBe(LIVE_ACCOUNT);
    expect(record?.pair).toBe(PAIR);
    expect(record?.decision.status).toBe('ACCEPTED');
    expect(record?.decision.action).toBe('OPEN');
    expect(record?.admission?.status).toBe('ADMITTED');
    expect(record?.researchApproval).not.toBeNull();
  }, TIMEOUT);

  it('derives quantity and leverage from the accepted risk decision, never from a caller DTO', async () => {
    const minted = await mintGenuineLiveOpen();
    const authority = LiveExecutionAuthority.read(minted.authority);
    const intent = LiveExecutionIntent.read(minted.intent);
    if (authority === null || intent === null || authority.decision.action !== 'OPEN') throw new Error('fixture');
    expect(intent.content.quantity).toBe(authority.decision.approved.approvedQuantity);
    expect(intent.content.leverage).toBe(authority.decision.approved.approvedLeverage);
    expect(intent.content.riskDecisionId).toBe(authority.decision.riskDecisionId);
    expect(intent.content.admissionId).toBe(authority.admission?.admissionId);
  }, TIMEOUT);

  it('carries genuine Phase12 research lineage on the intent as audit-only evidence', async () => {
    const minted = await mintGenuineLiveOpen();
    const intent = LiveExecutionIntent.read(minted.intent);
    expect(intent?.lineage.researchApproval).not.toBeNull();
    expect(intent?.lineage.researchApproval?.validationPlanId).toBeTruthy();
    expect(intent?.lineage.sourceStrategyDecisionId).toBeTruthy();
  }, TIMEOUT);

  it('returns null — never a weaker authority — when no genuine research approval exists', async () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision);
    const minted = await mintLiveOpenExecutionAuthority({
      enablement: genuineEnablement(),
      coordinator: new RiskAdmissionCoordinator(),
      accountId: LIVE_ACCOUNT,
      kernel,
      decision,
      instrumentSpecSnapshotId: 'instrument-1',
      planResult: { validationPlanId: 'fake-plan', subjectResults: [] } as never,
      riskPolicy: policyFor(),
      evidence: evidenceFrom(context),
      livePolicy: livePolicy(),
      constraints: constraintsFor(),
      shape: MARKET_SHAPE,
    });
    expect(minted).toBeNull();
  });

  it('returns null when the genuine approval belongs to a different pair', async () => {
    const { result } = await genuineResearchApproval();
    const otherKernel = makeKernel('B-ETH_USDT');
    const decision = evaluateDecision(otherKernel, T0);
    const context = buildContext(otherKernel, decision);
    const minted = await mintLiveOpenExecutionAuthority({
      enablement: genuineEnablement(),
      coordinator: new RiskAdmissionCoordinator(),
      accountId: LIVE_ACCOUNT,
      kernel: otherKernel,
      decision,
      instrumentSpecSnapshotId: 'instrument-1',
      planResult: result,
      riskPolicy: policyFor('B-ETH_USDT'),
      evidence: evidenceFrom(context),
      livePolicy: livePolicy(),
      constraints: constraintsFor('B-ETH_USDT'),
      shape: MARKET_SHAPE,
    });
    expect(minted).toBeNull();
  }, TIMEOUT);

  it('returns null when the coordinator genuinely refuses admission', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision);
    const minted = await mintLiveOpenExecutionAuthority({
      enablement: genuineEnablement(),
      coordinator: new RiskAdmissionCoordinator(),
      accountId: LIVE_ACCOUNT,
      kernel,
      decision,
      instrumentSpecSnapshotId: 'instrument-1',
      planResult: result,
      // A cap far below any admissible notional forces a genuine rejection.
      riskPolicy: policyFor(PAIR, '1'),
      evidence: evidenceFrom(context),
      livePolicy: livePolicy(),
      constraints: constraintsFor(),
      shape: MARKET_SHAPE,
    });
    expect(minted).toBeNull();
  }, TIMEOUT);

  it('rejects execution account, pair, instrument snapshot, and instrument economics mismatches', async () => {
    await expect(mintGenuineLiveOpen({ accountId: OTHER_ACCOUNT })).rejects.toThrow(/configured owner/);
    await expect(mintGenuineLiveOpen({ constraints: constraintsFor('B-ETH_USDT') })).rejects.toThrow(/Pair identity/);
    await expect(mintGenuineLiveOpen({ constraints: constraintsFor(PAIR, { instrumentSpecSnapshotId: 'different-spec' }) }))
      .rejects.toThrow(/Instrument snapshot identity/);
    await expect(mintGenuineLiveOpen({ constraints: constraintsFor(PAIR, { contractMultiplier: '2' }) }))
      .rejects.toThrow(/instrument economics/);
  }, TIMEOUT);

  it('rejects risk-account, exposure-account, and instrument-ownership account mismatches independently', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const evidence = evidenceFrom(buildContext(kernel, decision));
    const common = {
      enablement: genuineEnablement(), accountId: LIVE_ACCOUNT, kernel, decision, coordinator: new RiskAdmissionCoordinator(),
      instrumentSpecSnapshotId: 'instrument-1', planResult: result, riskPolicy: policyFor(), livePolicy: livePolicy(),
      constraints: constraintsFor(), shape: limitShape('100'),
    };
    await expect(mintLiveOpenExecutionAuthority({ ...common, evidence: {
      ...evidence, accountSnapshot: seal({ ...evidence.accountSnapshot!, accountId: OTHER_ACCOUNT }),
    } })).rejects.toThrow(/Account, exposure, and instrument ownership/);
    await expect(mintLiveOpenExecutionAuthority({ ...common, coordinator: new RiskAdmissionCoordinator(), evidence: {
      ...evidence, exposureSnapshot: seal({ ...evidence.exposureSnapshot!, accountId: OTHER_ACCOUNT }),
    } })).rejects.toThrow(/Account, exposure, and instrument ownership/);
    const ownership = evidence.pairSnapshot.ownership;
    if (ownership.status !== 'RECONCILED') throw new Error('fixture');
    await expect(mintLiveOpenExecutionAuthority({ ...common, coordinator: new RiskAdmissionCoordinator(), evidence: {
      ...evidence, pairSnapshot: seal({ ...evidence.pairSnapshot, ownership: { ...ownership, accountId: OTHER_ACCOUNT } }),
    } })).rejects.toThrow(/Account, exposure, and instrument ownership/);
  }, TIMEOUT);

  it('fails MARKET closed and rejects a limit price above the risk-approved INR envelope', async () => {
    await expect(mintGenuineLiveOpen({ shape: MARKET_SHAPE })).rejects.toThrow(/MARKET live execution is unsupported/);
    await expect(mintGenuineLiveOpen({ shape: limitShape('101') })).rejects.toThrow(/Order notional exceeds/);
    const exact = await mintGenuineLiveOpen({ shape: limitShape('100') });
    expect(LiveExecutionIntent.read(exact.intent)?.content.price).toBe('100');
  }, TIMEOUT);

  it('refuses to mint a CLOSE for a position owned by a different strategy tuple', async () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0, 'FLAT');
    const context = buildContext(kernel, decision);
    const position: LiveClosePositionBinding = {
      positionInstanceId: 'position-1',
      positionRevision: 3,
      side: 'LONG',
      ownedQuantity: '0.5',
      ownerStrategyInstanceId: 'someone-else',
      ownerStrategyId: decision.strategyId,
      ownerStrategyVersion: decision.strategyVersion,
      ownerParameterHash: decision.parameterHash,
    };
    const minted = await mintLiveCloseExecutionAuthority({
      enablement: genuineEnablement(),
      coordinator: new RiskAdmissionCoordinator(),
      accountId: LIVE_ACCOUNT,
      kernel,
      decision,
      instrumentSpecSnapshotId: 'instrument-1',
      riskPolicy: policyFor(),
      evidence: evidenceFrom(context),
      position,
      livePolicy: livePolicy(),
      constraints: constraintsFor(),
      shape: MARKET_SHAPE,
    });
    expect(minted).toBeNull();
  });

  it('derives CLOSE quantity and direction from the accepted owned position, blocking the 10-to-999 exploit', async () => {
    for (const side of ['LONG', 'SHORT'] as const) {
      const kernel = makeKernel();
      const decision = evaluateDecision(kernel, T0, 'FLAT');
      const base = buildContext(kernel, decision);
      const pairSnapshot = seal({
        ...base.pairSnapshot,
        position: {
          state: 'OPEN' as const, positionId: `position-${side}`, positionDirection: side, quantityMagnitude: '10',
          valuation: {
            valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1' as const,
            valuationPriceField: 'markPriceUsdt' as const, valuationPriceUsdt: '100', valuationPriceSourceId: 'pair-source',
            valuationPriceSourceTimeMs: T0, valuationPriceObservedAtMs: T0, contractMultiplier: '0.001',
            conversionMarket: 'USDT_INR', conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source',
            unitValuationInrPerQty: '8', aggregateCurrentNotionalInr: '80',
          },
        },
        ownership: {
          status: 'RECONCILED' as const, positionState: 'OPEN' as const, accountId: 'account-1', pair: PAIR,
          positionId: `position-${side}`, instanceOwnership: [{
            strategyInstanceId: decision.strategyInstanceId, strategyId: decision.strategyId, strategyVersion: decision.strategyVersion,
            parameterHash: decision.parameterHash, currentQuantity: '10', currentNotionalInr: '80',
          }],
        },
      });
      const context = buildContext(kernel, decision, { pairSnapshot });
      const common = {
        enablement: genuineEnablement(), coordinator: new RiskAdmissionCoordinator(), accountId: LIVE_ACCOUNT, kernel, decision,
        instrumentSpecSnapshotId: 'instrument-1', riskPolicy: policyFor(), evidence: evidenceFrom(context), livePolicy: livePolicy(),
        constraints: constraintsFor(), shape: limitShape('100'),
      };
      const forged = await mintLiveCloseExecutionAuthority({ ...common, position: {
        positionInstanceId: `position-${side}`, positionRevision: 7, side, ownedQuantity: '999',
        ownerStrategyInstanceId: decision.strategyInstanceId, ownerStrategyId: decision.strategyId,
        ownerStrategyVersion: decision.strategyVersion, ownerParameterHash: decision.parameterHash,
      } });
      expect(forged).toBeNull();

      const exact = await mintLiveCloseExecutionAuthority({ ...common, coordinator: new RiskAdmissionCoordinator(), position: {
        positionInstanceId: `position-${side}`, positionRevision: 7, side, ownedQuantity: '10',
        ownerStrategyInstanceId: decision.strategyInstanceId, ownerStrategyId: decision.strategyId,
        ownerStrategyVersion: decision.strategyVersion, ownerParameterHash: decision.parameterHash,
      } });
      const intent = LiveExecutionIntent.read(exact?.intent);
      expect(intent?.content.quantity).toBe('10');
      expect(intent?.content.reduceOnlyQuantity).toBe('10');
      expect(intent?.content.positionInstanceId).toBe(`position-${side}`);
      expect(intent?.content.positionRevision).toBe(7);
      expect(intent?.content.side).toBe(side === 'LONG' ? 'SELL' : 'BUY');
    }
  }, TIMEOUT);
});

describe('P17-I04 the mint itself is gated by configuration', () => {
  it('refuses to mint when the enablement is a fabricated literal', async () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision);
    const { result } = await genuineResearchApproval();
    await expect(mintLiveOpenExecutionAuthority({
      enablement: { permitsAccount: () => true, permitsPair: () => true, maxOrderNotionalInr: '1' } as never,
      coordinator: new RiskAdmissionCoordinator(),
      accountId: LIVE_ACCOUNT,
      kernel,
      decision,
      instrumentSpecSnapshotId: 'instrument-1',
      planResult: result,
      riskPolicy: policyFor(),
      evidence: evidenceFrom(context),
      livePolicy: livePolicy(),
      constraints: constraintsFor(),
      shape: MARKET_SHAPE,
    })).rejects.toThrow(/LIVE_EXECUTION_DISABLED/);
  }, TIMEOUT);

  it('refuses an account that is not on the allowlist', async () => {
    await expect(mintGenuineLiveOpen({ accountId: 'account-not-allowed' })).rejects.toThrow(/LIVE_EXECUTION_DISABLED/);
  }, TIMEOUT);

  it('refuses a pair that is not on the allowlist', async () => {
    const resolution = resolveLiveExecutionGate(enabledLiveConfig({ LIVE_EXECUTION_PAIR_ALLOWLIST: 'B-ETH_USDT' }));
    if (resolution.status !== 'ENABLED') throw new Error('fixture');
    await expect(mintGenuineLiveOpen({ enablement: resolution.enablement })).rejects.toThrow(/LIVE_EXECUTION_DISABLED/);
  }, TIMEOUT);
});

describe('P17-I03 live and paper authority are structurally non-interchangeable', () => {
  it('a genuine PAPER authority is not readable as LIVE authority', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision);
    const paper = await mintPaperOpenExecutionAuthority({
      coordinator: new RiskAdmissionCoordinator(),
      accountId: LIVE_ACCOUNT,
      kernel,
      decision,
      instrumentSpecSnapshotId: 'instrument-1',
      planResult: result,
      policy: policyFor(),
      evidence: evidenceFrom(context),
    });
    expect(PaperOpenExecutionAuthority.read(paper)).not.toBeNull();
    expect(LiveExecutionAuthority.read(paper)).toBeNull();
  }, TIMEOUT);

  it('a genuine LIVE authority is not readable as PAPER authority, in either direction', async () => {
    const minted = await mintGenuineLiveOpen();
    expect(PaperOpenExecutionAuthority.read(minted.authority)).toBeNull();
    expect(PaperCloseExecutionAuthority.read(minted.authority)).toBeNull();
    expect(LiveExecutionAuthority.read(minted.authority)).not.toBeNull();
  }, TIMEOUT);

  it('paper authority presented to the live consumption boundary fails closed', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision);
    const paper = await mintPaperOpenExecutionAuthority({
      coordinator: new RiskAdmissionCoordinator(),
      accountId: LIVE_ACCOUNT,
      kernel,
      decision,
      instrumentSpecSnapshotId: 'instrument-1',
      planResult: result,
      policy: policyFor(),
      evidence: evidenceFrom(context),
    });
    const minted = await mintGenuineLiveOpen();
    expect(() => readLiveAuthorityForIntent(paper, minted.intent)).toThrow(/LIVE_AUTHORITY_INVALID/);
  }, TIMEOUT);
});

describe('P17 §6 adversarial forgery attempts all fail closed', () => {
  it('compiled CommonJS export replacement cannot replace the authority reader used by execution', () => {
    const output = execFileSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
      const assert = require('node:assert/strict');
      const authority = require('./src/execution/live/authority.ts');
      const service = require('./src/execution/live/service.ts');
      const original = authority.readLiveAuthorityForIntent;
      assert.equal(Reflect.set(authority, 'readLiveAuthorityForIntent', () => ({ forged: true })), false);
      assert.equal(authority.readLiveAuthorityForIntent, original);
      assert.equal(typeof service.LiveExecutionService, 'function');
      console.log('COMMONJS_AUTHORITY_READER_PINNED');
    `], { cwd: process.cwd(), encoding: 'utf8' });
    expect(output.trim()).toBe('COMMONJS_AUTHORITY_READER_PINNED');
  });
  it('rejects direct construction with a foreign issuer symbol', () => {
    expect(() => new LiveExecutionAuthority(Symbol('forged'), {
      action: 'OPEN',
      accountId: 'x',
      pair: 'y',
      intentId: 'z',
      clientOrderId: 'c',
      intent: {} as never,
      decision: {} as never,
      researchApproval: null,
      strategyOrigin: {} as never,
      admission: null,
      coordinator: new RiskAdmissionCoordinator(),
    })).toThrow(LiveExecutionError);
  });

  it('rejects a plain object literal shaped like an authority record', () => {
    expect(LiveExecutionAuthority.read({
      action: 'OPEN',
      accountId: 'account-live-1',
      pair: 'B-BTC_USDT',
      intentId: 'i',
      clientOrderId: 'c',
    })).toBeNull();
  });

  it('rejects an object-spread reconstruction of a genuine record', async () => {
    const minted = await mintGenuineLiveOpen();
    const genuine = LiveExecutionAuthority.read(minted.authority);
    expect(genuine).not.toBeNull();
    expect(LiveExecutionAuthority.read({ ...genuine })).toBeNull();
  }, TIMEOUT);

  it('rejects a prototype-forged impostor', async () => {
    const minted = await mintGenuineLiveOpen();
    const impostor = Object.create(LiveExecutionAuthority.prototype) as object;
    expect(LiveExecutionAuthority.read(impostor)).toBeNull();
    expect(() => readLiveAuthorityForIntent(impostor, minted.intent)).toThrow(/LIVE_AUTHORITY_INVALID/);
  }, TIMEOUT);

  it('rejects a subclass instance that never passed through the genuine mint', () => {
    class Impostor {
      public readonly action = 'OPEN';
    }
    expect(LiveExecutionAuthority.read(new Impostor())).toBeNull();
  });

  it('cannot be enabled by mutating the exported namespace: the class and prototype are frozen', () => {
    expect(Object.isFrozen(LiveExecutionAuthority)).toBe(true);
    expect(Object.isFrozen(LiveExecutionAuthority.prototype)).toBe(true);
    const before = LiveExecutionAuthority.read;
    try {
      (LiveExecutionAuthority as unknown as { read: unknown }).read = () => ({ forged: true });
    } catch {
      // Strict-mode assignment to a frozen object throws; either outcome is a pass.
    }
    expect(LiveExecutionAuthority.read).toBe(before);
  });

  it('a genuine authority instance itself is frozen', async () => {
    const minted = await mintGenuineLiveOpen();
    expect(Object.isFrozen(minted.authority)).toBe(true);
  }, TIMEOUT);

  it('a raw accepted risk decision is never itself live authority', async () => {
    const minted = await mintGenuineLiveOpen();
    const record = LiveExecutionAuthority.read(minted.authority);
    expect(LiveExecutionAuthority.read(record?.decision)).toBeNull();
    expect(LiveExecutionAuthority.read(record?.admission)).toBeNull();
  }, TIMEOUT);
});

describe('P17 §6 an authority is usable for exactly one intent', () => {
  it('accepts the exact intent it was minted for', async () => {
    const minted = await mintGenuineLiveOpen();
    const record = readLiveAuthorityForIntent(minted.authority, minted.intent);
    expect(record.intentId).toBe(LiveExecutionIntent.read(minted.intent)?.intentId);
  }, TIMEOUT);

  it('refuses an authority minted for a different economic intent (different limit price)', async () => {
    const first = await mintGenuineLiveOpen({ shape: limitShape('100') });
    const second = await mintGenuineLiveOpen({ shape: limitShape('99') });
    expect(LiveExecutionIntent.read(first.intent)?.intentId).not.toBe(LiveExecutionIntent.read(second.intent)?.intentId);
    expect(() => readLiveAuthorityForIntent(first.authority, second.intent)).toThrow(/LIVE_AUTHORITY_INVALID/);
    expect(() => readLiveAuthorityForIntent(second.authority, first.intent)).toThrow(/LIVE_AUTHORITY_INVALID/);
  }, TIMEOUT);

  it('refuses reuse against another account', async () => {
    const first = await mintGenuineLiveOpen({ accountId: LIVE_ACCOUNT });
    const second = await mintGenuineLiveOpen({ accountId: OTHER_ACCOUNT, enablement: genuineEnablement({ COINDCX_LIVE_ACCOUNT_ID: OTHER_ACCOUNT }) });
    expect(() => readLiveAuthorityForIntent(first.authority, second.intent)).toThrow(/LIVE_AUTHORITY_INVALID/);
  }, TIMEOUT);

  it('refuses reuse against another pair', async () => {
    const btc = await mintGenuineLiveOpen({ pair: 'B-BTC_USDT' });
    const eth = await mintGenuineLiveOpen({ pair: 'B-ETH_USDT' });
    expect(() => readLiveAuthorityForIntent(btc.authority, eth.intent)).toThrow(/LIVE_AUTHORITY_INVALID/);
  }, TIMEOUT);

  it('refuses a hand-built intent object even when its fields copy a genuine one', async () => {
    const minted = await mintGenuineLiveOpen();
    const genuine = LiveExecutionIntent.read(minted.intent);
    expect(() => readLiveAuthorityForIntent(minted.authority, { ...genuine })).toThrow(/LIVE_INTENT_INVALID/);
  }, TIMEOUT);

  it('refuses a stale authority whose intent content was mutated in place', async () => {
    const minted = await mintGenuineLiveOpen();
    const intentRecord = LiveExecutionIntent.read(minted.intent);
    if (intentRecord === null) throw new Error('fixture');
    // The record and its content are frozen, so mutation is impossible; a
    // mutated COPY is then not a genuine intent at all.
    expect(Object.isFrozen(intentRecord)).toBe(true);
    expect(Object.isFrozen(intentRecord.content)).toBe(true);
    const mutated = { ...intentRecord, content: { ...intentRecord.content, quantity: '999' } };
    expect(() => readLiveAuthorityForIntent(minted.authority, mutated)).toThrow(/LIVE_INTENT_INVALID/);
  }, TIMEOUT);
});
