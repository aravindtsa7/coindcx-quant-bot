import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import type { AdmissionRequest } from '../../../src/dispatch';
import {
  buildExecutionPolicySnapshot, buildInstrumentEconomicsSnapshot, EXECUTION_POLICY_VERSION, paperDecimal,
  type ExecutionPolicySnapshot, type PaperExecutionQuoteSnapshot,
} from '../../../src/execution';
import { mintPaperOpenExecutionAuthority } from '../../../src/execution/open-authority';
import { mintPaperCloseExecutionAuthority, type PaperClosePositionBinding } from '../../../src/execution/close-authority';
import { PaperAccountRepository } from '../../../src/execution/persistence/account-repository';
import { PaperAccountReconciler } from '../../../src/execution/persistence/paper-account-reconciler';
import { openPaperAccountSession } from '../../../src/execution/persistence/paper-account-session';
import {
  issueTrustedPaperExecutionEvidence, type TrustedPaperConversionEvidence, type TrustedPaperOrderbookDepth,
} from '../../../src/execution/trusted-evidence';
import { sha256CanonicalJson } from '../../../src/risk';
import type { CanonicalPositionValuation, PairRiskSnapshot, RiskEvaluationContext } from '../../../src/risk';
import type { StrategyKernel } from '../../../src/strategies';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, PAIR, policyFor } from '../../unit/dispatch/helpers';
import { makePair, seal } from '../../unit/risk/helpers';

// P14-H live-DB reconciliation/health suite — mirrors the exact P14-D/E/G
// disposable shadow-database pattern. Every test is skipped, not failed, if
// no local MySQL is reachable.

const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p14h_test_${randomBytes(6).toString('hex')}`;

function mysqlArgs(extra: readonly string[]): string[] {
  const url = new URL(BASE_DATABASE_URL!);
  const args = ['-h', url.hostname, '-P', url.port || '3306', '-u', decodeURIComponent(url.username)];
  if (url.password) args.push(`-p${decodeURIComponent(url.password)}`);
  return [...args, ...extra];
}
function shadowDatabaseUrl(): string {
  const url = new URL(BASE_DATABASE_URL!);
  url.pathname = `/${SHADOW_DB_NAME}`;
  return url.toString();
}

let dbAvailable = false;
let prisma: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) { dbAvailable = false; return; }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 60_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    prisma = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await prisma.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
}, 90_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await prisma.$disconnect();
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort cleanup only */ }
}, 30_000);

function skip(): boolean {
  if (!dbAvailable) console.warn('P14-H live-DB suite skipped: no reachable disposable MySQL environment (see beforeAll).');
  return !dbAvailable;
}

let accountCounter = 0;
function freshAccountId(): string { accountCounter += 1; return `p14h-account-${accountCounter}`; }

async function initAccount(accountId: string, capital = '1000000'): Promise<void> {
  await new PaperAccountRepository(prisma).ensureAccountInitialized(accountId, capital);
}
async function provisionPairSlot(accountId: string, pair: string): Promise<void> {
  await prisma.paperPosition.upsert({ where: { accountId_pair: { accountId, pair } }, create: { accountId, pair, status: 'EMPTY' }, update: {} });
}

const INSTRUMENT_SPEC_SNAPSHOT_ID = 'instrument-1';
const T0 = 1_200_000;
const MINUTE = 60_000;
const PRICE_INCREMENT = '1';
const QUANTITY_INCREMENT = '1';

const EXECUTION_POLICY: ExecutionPolicySnapshot = buildExecutionPolicySnapshot({
  policyVersion: EXECUTION_POLICY_VERSION,
  fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
  marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 5000, requiredHealthState: 'HEALTHY' },
  takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT', tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1',
  quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001', currencyConversionPolicy: 'P14_INR_CONVERSION_V1',
  accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
});
const INSTRUMENT_ECONOMICS = buildInstrumentEconomicsSnapshot({
  sourceId: 'TEST_COINDCX_INSTRUMENT_SOURCE', instrumentSpecIdentityPolicyId: 'TEST_INSTRUMENT_SPEC_IDENTITY_V1',
  instrumentSpecSnapshotId: 'instrument-1', pair: PAIR, contractMultiplier: EXECUTION_POLICY.content.contractMultiplier,
  priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT,
});

function evidenceFrom(context: RiskEvaluationContext) {
  const { strategyOrigin: _strategyOrigin, candidate: _candidate, ...evidence } = context;
  return evidence;
}
function buildQuote(pair: string, bid: string, ask: string, providerEventTimeMs: number): PaperExecutionQuoteSnapshot {
  const contentSha256 = sha256CanonicalJson({ contentPolicyId: 'TEST_ORDERBOOK_CONTENT_V1', pair, bid, ask, providerEventTimeMs });
  return Object.freeze({
    pair, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID, bid, ask, availableExecutableQuantity: null,
    providerEventId: `evt-${providerEventTimeMs}`, providerEventTimeMs, firstObservedAtMs: providerEventTimeMs,
    sourceSessionId: 'test-session-1', generationId: 1, healthState: 'HEALTHY' as const, contentSha256, evidencePolicyVersion: 'TEST_EVIDENCE_POLICY_V1',
  });
}
function buildDepth(quote: PaperExecutionQuoteSnapshot, bidQty: string, askQty: string): TrustedPaperOrderbookDepth {
  return Object.freeze({
    pair: quote.pair, bestBid: quote.bid, bestBidQuantity: bidQty, bestAsk: quote.ask, bestAskQuantity: askQty,
    providerEventTimeMs: quote.providerEventTimeMs, observedAtMs: quote.firstObservedAtMs,
    sourceSessionId: quote.sourceSessionId, generationId: quote.generationId, contentSha256: quote.contentSha256,
  });
}
function buildConversion(rate: string, observedAtMs: number, providerEventTimeMs = observedAtMs): TrustedPaperConversionEvidence {
  return Object.freeze({
    conversionPriceInrPerUsdt: rate, observedAtMs, providerEventTimeMs,
    sourceId: 'COINDCX_USDTINR_CONVERSION_REST_V1', contentSha256: sha256CanonicalJson({ rate, providerEventTimeMs }),
  });
}
function trust(quote: PaperExecutionQuoteSnapshot, depth: TrustedPaperOrderbookDepth, conversion: TrustedPaperConversionEvidence, conversionLocalPollFreshnessMs = 60_000) {
  return issueTrustedPaperExecutionEvidence({ quote, orderbookDepth: depth, conversion, conversionLocalPollFreshnessMs });
}

const UNIT_VALUATION_INR_PER_QTY = '8';
function notionalFor(quantity: string): string {
  return paperDecimal(quantity).times(UNIT_VALUATION_INR_PER_QTY).toFixed();
}
function valuation(evaluationTimeMs: number, quantity: string): CanonicalPositionValuation {
  return {
    valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt',
    valuationPriceUsdt: '100', valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: evaluationTimeMs,
    valuationPriceObservedAtMs: evaluationTimeMs, contractMultiplier: '0.001', conversionMarket: 'USDT_INR',
    conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source', unitValuationInrPerQty: UNIT_VALUATION_INR_PER_QTY,
    aggregateCurrentNotionalInr: notionalFor(quantity),
  };
}
function openPairSnapshotFor(kernel: StrategyKernel, ownedQuantity: string, evaluationTimeMs: number, side: 'LONG' | 'SHORT' = 'LONG'): PairRiskSnapshot {
  const base = makePair();
  return seal({
    ...base, pair: kernel.pair, provenance: { ...base.provenance, sourceTimeMs: evaluationTimeMs, observedAtMs: evaluationTimeMs },
    position: { state: 'OPEN', positionId: 'exchange-position-1', positionDirection: side, quantityMagnitude: ownedQuantity, valuation: valuation(evaluationTimeMs, ownedQuantity) },
    ownership: {
      status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: kernel.pair, positionId: 'exchange-position-1',
      instanceOwnership: [{
        strategyInstanceId: kernel.strategyInstanceId, strategyId: kernel.strategyId, strategyVersion: kernel.strategyVersion,
        parameterHash: kernel.parameterHash, currentQuantity: ownedQuantity, currentNotionalInr: notionalFor(ownedQuantity),
      }],
    },
  });
}

async function setupGenuineOpen(accountId: string, pair: string) {
  const { result: planResult } = await genuineResearchApproval();
  const kernel = makeKernel(pair);
  const openDecision = evaluateDecision(kernel, T0);
  const coordinator = new RiskAdmissionCoordinator();
  const openContext = buildContext(kernel, openDecision);
  const session = await openPaperAccountSession({ accountId, coordinator, prisma });
  const request: AdmissionRequest = { accountId, policy: policyFor(pair), context: openContext };
  const admitted = await session.admitAndPersist(pair, request, coordinator);
  if (admitted.outcome !== 'ADMITTED') throw new Error(`setup: admission failed (${admitted.outcome})`);
  const openAuthority = await mintPaperOpenExecutionAuthority({
    coordinator, accountId, kernel, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
    planResult, policy: policyFor(pair), evidence: evidenceFrom(openContext),
  });
  if (openAuthority === null) throw new Error('setup: open authority null');
  const openNowMs = T0 + 500;
  const openQuote = buildQuote(pair, '99', '99.5', openNowMs - 100);
  const openDepth = buildDepth(openQuote, '1000000', '1000000');
  const conversion = buildConversion('80', openNowMs);
  const openResult = await session.executeOpen(openAuthority, {
    evidence: trust(openQuote, openDepth, conversion), instrumentEconomics: INSTRUMENT_ECONOMICS,
    executionPolicy: EXECUTION_POLICY, nowMs: openNowMs,
  }, coordinator);
  if (openResult.outcome !== 'FILLED') throw new Error(`setup: open execution failed (${openResult.outcome})`);
  return { session, coordinator, kernel, admitted, openResult };
}

async function setupGenuineClosed(accountId: string, pair: string) {
  const opened = await setupGenuineOpen(accountId, pair);
  const positionAfterOpen = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair } } });
  const closeDecision = evaluateDecision(opened.kernel, T0 + MINUTE, 'FLAT');
  const closeContext = buildContext(opened.kernel, closeDecision, { pairSnapshot: openPairSnapshotFor(opened.kernel, opened.openResult.quantity, closeDecision.evaluationTimeMs) });
  const positionBinding: PaperClosePositionBinding = {
    positionInstanceId: opened.openResult.positionInstanceId, positionRevision: positionAfterOpen.revision,
    ownerStrategyInstanceId: opened.kernel.strategyInstanceId, ownerStrategyId: opened.kernel.strategyId,
    ownerStrategyVersion: opened.kernel.strategyVersion, ownerParameterHash: opened.kernel.parameterHash, ownedQuantity: opened.openResult.quantity,
  };
  const closeAuthority = await mintPaperCloseExecutionAuthority({
    coordinator: opened.coordinator, accountId, kernel: opened.kernel, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
    policy: policyFor(pair), evidence: evidenceFrom(closeContext), position: positionBinding,
  });
  if (closeAuthority === null) throw new Error('setup: close authority null');
  const closeNowMs = T0 + MINUTE + 500;
  const closeQuote = buildQuote(pair, '110', '112', closeNowMs - 100);
  const closeResult = await opened.session.executeClose(closeAuthority, {
    evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', closeNowMs)),
     executionPolicy: EXECUTION_POLICY, nowMs: closeNowMs,
  });
  if (closeResult.outcome !== 'CLOSED') throw new Error(`setup: close execution failed (${closeResult.outcome})`);
  return { ...opened, closeResult };
}

describe('P14-H live-DB — healthy accounts (§37-§40)', () => {
  it('a clean EMPTY account reconciles HEALTHY with no fault row (§37)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('HEALTHY');
    expect(result.issues).toHaveLength(0);
    expect(await prisma.paperReconciliationFault.count({ where: { accountId } })).toBe(0);
    expect(result.fundingDisclosure.fundingCapability).toBe('FUNDING_UNSUPPORTED');
  });

  it('a genuine ADMITTED reservation + PENDING slot reconciles HEALTHY (§38)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: buildContext(kernel, decision) }, coordinator);
    expect(admitted.outcome).toBe('ADMITTED');

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('HEALTHY');
    expect(await prisma.paperReconciliationFault.count({ where: { accountId } })).toBe(0);
  });

  it('a genuine OPEN position reconciles HEALTHY with exact Decimal facts (§39)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await setupGenuineOpen(accountId, PAIR);

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('HEALTHY');
    expect(result.issues).toHaveLength(0);
    expect(await prisma.paperReconciliationFault.count({ where: { accountId } })).toBe(0);
  }, 30_000);

  it('a genuine OPEN then CLOSE reconciles HEALTHY (§40)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await setupGenuineClosed(accountId, PAIR);

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('HEALTHY');
    expect(result.issues).toHaveLength(0);
    expect(await prisma.paperReconciliationFault.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('F14-03 legacy instrument-economics reconciliation', () => {
  it('diagnoses an active legacy NULL binding deterministically and never backfills it', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const opened = await setupGenuineOpen(accountId, PAIR);
    await prisma.paperExecutionIntent.update({ where: { executionIntentId: opened.openResult.executionIntentId }, data: { instrumentEconomicsSnapshotId: null } });

    const first = await new PaperAccountReconciler(prisma).reconcile(accountId);
    const second = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(first.status).toBe('UNHEALTHY');
    expect(first.issues).toContainEqual(expect.objectContaining({ message: 'LEGACY_UNVERIFIABLE_INSTRUMENT_ECONOMICS' }));
    expect(second.issues.find((issue) => issue.message === 'LEGACY_UNVERIFIABLE_INSTRUMENT_ECONOMICS')?.faultId)
      .toBe(first.issues.find((issue) => issue.message === 'LEGACY_UNVERIFIABLE_INSTRUMENT_ECONOMICS')?.faultId);
    expect((await prisma.paperExecutionIntent.findUniqueOrThrow({ where: { executionIntentId: opened.openResult.executionIntentId } })).instrumentEconomicsSnapshotId).toBeNull();
  });

  it('preserves and diagnoses closed historical legacy NULL bindings', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const closed = await setupGenuineClosed(accountId, PAIR);
    await prisma.paperExecutionIntent.updateMany({ where: { accountId }, data: { instrumentEconomicsSnapshotId: null } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues.filter((issue) => issue.message === 'LEGACY_UNVERIFIABLE_INSTRUMENT_ECONOMICS')).toHaveLength(2);
    expect(await prisma.paperExecutionIntent.count({ where: { accountId, instrumentEconomicsSnapshotId: null } })).toBe(2);
    expect(await prisma.paperPositionOwnershipHistory.findUnique({ where: { positionInstanceId: closed.openResult.positionInstanceId } })).not.toBeNull();
  });
});

describe('P14-H live-DB — account ledger mismatch (§41/§42/§50)', () => {
  it('a tampered account cumulative fee projection is UNHEALTHY, persists a fault, and is never repaired', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await setupGenuineOpen(accountId, PAIR);

    const before = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFeesInr: before.cumulativeFeesInr.plus('1') } });
    const positionBefore = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const fillsBefore = await prisma.paperFill.findMany({ where: { accountId } });
    const ledgerBefore = await prisma.paperLedgerEntry.findMany({ where: { accountId } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'ACCOUNT_LEDGER_MISMATCH' }));

    const faults = await prisma.paperReconciliationFault.findMany({ where: { accountId } });
    expect(faults).toHaveLength(1);
    expect(faults[0]?.faultType).toBe('ACCOUNT_LEDGER_MISMATCH');

    // No repair — tampered value untouched; no other table mutated (§50).
    const accountAfter = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(accountAfter.cumulativeFeesInr.toFixed()).toBe(before.cumulativeFeesInr.plus('1').toFixed());
    const positionAfter = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfter).toEqual(positionBefore);
    expect(await prisma.paperFill.findMany({ where: { accountId } })).toEqual(fillsBefore);
    expect(await prisma.paperLedgerEntry.findMany({ where: { accountId } })).toEqual(ledgerBefore);
  }, 30_000);

  it('a tampered account realized-PnL projection is UNHEALTHY (§42)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await setupGenuineClosed(accountId, PAIR);

    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeRealizedPnlInr: { increment: '1' } } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'ACCOUNT_LEDGER_MISMATCH' }));
  }, 30_000);
});

describe('P14-H live-DB — funding invariant (§43)', () => {
  it('nonzero account cumulative funding is UNHEALTHY with no repair and no provider lookup', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFundingInr: '1' } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'FUNDING_INVARIANT_VIOLATION' }));
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).cumulativeFundingInr.toFixed()).toBe('1');
  });

  it('a nonzero position cumulative funding projection is UNHEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperPosition.create({ data: { accountId, pair: PAIR, status: 'EMPTY', cumulativeFundingInr: '-0.25' } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'FUNDING_INVARIANT_VIOLATION' }));
  });

  it('a FUNDING ledger row is UNHEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperLedgerEntry.create({ data: { entryId: `${accountId}-funding`, type: 'FUNDING', accountId, amountInr: '0', eventTimeMs: 1n } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'FUNDING_INVARIANT_VIOLATION' }));
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, type: 'FUNDING' } })).toBe(1);
  });
});

describe('P14-H live-DB — order/fill mismatch (§44)', () => {
  it('a FILLED order without a fill is UNHEALTHY and no fill is synthesized', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperExecutionPolicySnapshot.upsert({
      where: { executionPolicySnapshotId: 'p'.repeat(64) },
      create: {
        executionPolicySnapshotId: 'p'.repeat(64), policyVersion: 'P14_EXECUTION_POLICY_V1', fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
        maxEvidenceAgeMs: 5000, requiredHealthState: 'HEALTHY', takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT',
        tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1', quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001',
        currencyConversionPolicy: 'P14_INR_CONVERSION_V1', accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
      },
      update: {},
    });
    const executionIntentId = sha256CanonicalJson({ orphanOrderFor: accountId });
    await prisma.paperExecutionIntent.create({
      data: {
        executionIntentId, action: 'OPEN', accountId, pair: PAIR, strategyInstanceId: 'si-1', strategyId: 'strat-1', strategyVersion: 'v1',
        parameterHash: 'h'.repeat(64), riskDecisionId: 'r'.repeat(64), evaluationTimeMs: T0, executionPolicySnapshotId: 'p'.repeat(64),
      },
    });
    await prisma.paperOrder.create({ data: { executionIntentId, accountId, action: 'OPEN', state: 'FILLED' } });
    // Deliberately no paperFill row.

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'ORDER_FILL_MISMATCH' }));
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect((await prisma.paperOrder.findUniqueOrThrow({ where: { executionIntentId } })).state).toBe('FILLED');
  });
});

describe('P14-H live-DB — OPEN position fact mismatch (§45)', () => {
  it('a tampered OPEN position field with an unchanged opening fill is UNHEALTHY with no repair', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { openResult } = await setupGenuineOpen(accountId, PAIR);

    const fillBefore = await prisma.paperFill.findUniqueOrThrow({ where: { orderId: openResult.executionIntentId } });
    await prisma.paperPosition.update({ where: { accountId_pair: { accountId, pair: PAIR } }, data: { quantity: paperDecimal(openResult.quantity).plus('1').toFixed() } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'POSITION_STATE_MISMATCH' }));

    const fillAfter = await prisma.paperFill.findUniqueOrThrow({ where: { orderId: openResult.executionIntentId } });
    expect(fillAfter).toEqual(fillBefore);
    const positionAfter = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfter.quantity?.toFixed()).toBe(paperDecimal(openResult.quantity).plus('1').toFixed());
  }, 30_000);
});

describe('P14-H live-DB — closed history mismatch (§46)', () => {
  it('a tampered ownership history row against genuine close facts is UNHEALTHY with no repair', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { openResult } = await setupGenuineClosed(accountId, PAIR);

    const historyBefore = await prisma.paperPositionOwnershipHistory.findUniqueOrThrow({ where: { positionInstanceId: openResult.positionInstanceId } });
    await prisma.paperPositionOwnershipHistory.update({
      where: { positionInstanceId: openResult.positionInstanceId },
      data: { realizedPnlInr: historyBefore.realizedPnlInr.plus('1') },
    });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'OWNERSHIP_HISTORY_MISMATCH' }));

    const historyAfter = await prisma.paperPositionOwnershipHistory.findUniqueOrThrow({ where: { positionInstanceId: openResult.positionInstanceId } });
    expect(historyAfter.realizedPnlInr.toFixed()).toBe(historyBefore.realizedPnlInr.plus('1').toFixed());
  }, 30_000);
});

describe('P14-H live-DB — reservation mismatch (§47)', () => {
  it('a PENDING slot backed by a non-ADMITTED reservation is UNHEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: buildContext(kernel, decision) }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('setup failed');

    // Directly corrupt the durable reservation status while the slot remains PENDING (impossible under normal operation).
    await prisma.paperReservation.update({ where: { admissionId: admitted.admission.admissionId }, data: { status: 'RELEASED' } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'RESERVATION_STATE_MISMATCH' }));
  });
});

describe('F14-05 correction — bidirectional reservation <-> slot reverse checks', () => {
  it('an ADMITTED reservation next to an EMPTY, unclaimed slot is UNHEALTHY (the exact previously-invisible defect)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: buildContext(kernel, decision) }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('setup failed');

    // Directly corrupt the durable slot back to EMPTY while the reservation remains genuinely ADMITTED
    // (impossible under normal operation — the forward-only check over existing slots cannot see this).
    await prisma.paperPosition.update({ where: { accountId_pair: { accountId, pair: PAIR } }, data: { status: 'EMPTY', admissionId: null } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'RESERVATION_STATE_MISMATCH', message: 'ADMITTED_RESERVATION_NOT_REFLECTED_IN_PENDING_SLOT' }));

    const reservationAfter = await prisma.paperReservation.findUniqueOrThrow({ where: { admissionId: admitted.admission.admissionId } });
    expect(reservationAfter.status).toBe('ADMITTED'); // no repair
  });

  it('an ADMITTED reservation whose slot points at a DIFFERENT admissionId is UNHEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: buildContext(kernel, decision) }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('setup failed');

    // Slot claims a well-formed but wrong (nonexistent) admissionId while the genuine reservation stays ADMITTED.
    await prisma.paperPosition.update({ where: { accountId_pair: { accountId, pair: PAIR } }, data: { admissionId: 'f'.repeat(64) } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'RESERVATION_STATE_MISMATCH', message: 'ADMITTED_RESERVATION_NOT_REFLECTED_IN_PENDING_SLOT' }));
  });

  it('a CONSUMED reservation with neither a current OPEN slot nor completed ownership history is UNHEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { openResult } = await setupGenuineClosed(accountId, PAIR);

    // The CONSUMED opening reservation's slot is now EMPTY (genuinely closed) — delete
    // its ownership history row entirely, leaving NEITHER an open slot NOR history.
    await prisma.paperPositionOwnershipHistory.delete({ where: { positionInstanceId: openResult.positionInstanceId } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'RESERVATION_STATE_MISMATCH', message: 'CONSUMED_RESERVATION_WITHOUT_OPEN_OR_COMPLETED_LIFECYCLE' }));
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'OWNERSHIP_HISTORY_MISMATCH', message: 'COMPLETED_CLOSE_MISSING_OWNERSHIP_HISTORY' }));
  }, 30_000);
});

describe('F14-05 correction — OPEN leverage / initial margin economic checks', () => {
  it('a tampered OPEN slot leverage (opening intent unchanged) is UNHEALTHY with no repair', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { openResult } = await setupGenuineOpen(accountId, PAIR);

    const positionBefore = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const tamperedLeverage = positionBefore.leverage!.plus('1');
    await prisma.paperPosition.update({ where: { accountId_pair: { accountId, pair: PAIR } }, data: { leverage: tamperedLeverage } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'POSITION_STATE_MISMATCH', message: 'OPEN_SLOT_ECONOMIC_FACT_MISMATCH', evidence: expect.objectContaining({ mismatches: expect.arrayContaining([expect.objectContaining({ field: 'leverage' })]) }) }));

    const positionAfter = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfter.leverage!.toFixed()).toBe(tamperedLeverage.toFixed()); // no repair
    expect(openResult.outcome).toBe('FILLED');
  }, 30_000);

  it('a tampered OPEN slot initial margin (opening intent/fill unchanged) is UNHEALTHY with no repair', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await setupGenuineOpen(accountId, PAIR);

    const positionBefore = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const tamperedMargin = positionBefore.initialMarginInr!.plus('1');
    await prisma.paperPosition.update({ where: { accountId_pair: { accountId, pair: PAIR } }, data: { initialMarginInr: tamperedMargin } });

    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(result.status).toBe('UNHEALTHY');
    expect(result.issues).toContainEqual(expect.objectContaining({ faultType: 'POSITION_STATE_MISMATCH', message: 'OPEN_SLOT_ECONOMIC_FACT_MISMATCH', evidence: expect.objectContaining({ mismatches: expect.arrayContaining([expect.objectContaining({ field: 'initialMarginInr' })]) }) }));

    const positionAfter = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfter.initialMarginInr!.toFixed()).toBe(tamperedMargin.toFixed()); // no repair
  }, 30_000);
});

describe('P14-H live-DB — repeated fault / idempotency (§26/§48)', () => {
  it('running reconciliation twice against unchanged bad state does not create duplicate fault rows', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFundingInr: '1' } });

    const reconciler = new PaperAccountReconciler(prisma);
    const first = await reconciler.reconcile(accountId);
    const second = await reconciler.reconcile(accountId);

    expect(first.status).toBe('UNHEALTHY');
    expect(second.status).toBe('UNHEALTHY');
    expect(second.issues[0]?.faultId).toBe(first.issues[0]?.faultId);
    expect(await prisma.paperReconciliationFault.count({ where: { accountId } })).toBe(1);
  });
});

describe('P14-H live-DB — multi-account isolation (§49)', () => {
  it('a corrupted account is UNHEALTHY while an unrelated clean account remains HEALTHY, with no cross-account fault', async () => {
    if (skip()) return;
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(accountA);
    await initAccount(accountB);
    await provisionPairSlot(accountB, PAIR);
    await prisma.paperAccount.update({ where: { accountId: accountA }, data: { cumulativeFundingInr: '1' } });

    const reconciler = new PaperAccountReconciler(prisma);
    const resultA = await reconciler.reconcile(accountA);
    const resultB = await reconciler.reconcile(accountB);

    expect(resultA.status).toBe('UNHEALTHY');
    expect(resultB.status).toBe('HEALTHY');
    expect(await prisma.paperReconciliationFault.count({ where: { accountId: accountA } })).toBe(1);
    expect(await prisma.paperReconciliationFault.count({ where: { accountId: accountB } })).toBe(0);
  });
});

describe('P14-H live-DB — result immutability and ownerFence reporting', () => {
  it('returns a frozen result and issues array, and observes ownerFence without mutating it', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);

    const before = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const result = await new PaperAccountReconciler(prisma).reconcile(accountId);
    const after = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(result.ownerFence).toBe(before.ownerFence);
    expect(after.ownerFence).toBe(before.ownerFence);
    expect(after.revision).toBe(before.revision);
  });
});
