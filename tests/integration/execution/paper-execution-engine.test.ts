import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import type { AdmissionRequest } from '../../../src/dispatch';
import {
  buildExecutionPolicySnapshot, computeOpenExecutionIntentId, computeSourceExecutionKey, EXECUTION_POLICY_VERSION,
  PAPER_FUNDING_CAPABILITY, paperDecimal, type ExecutionPolicySnapshot, type PaperExecutionQuoteSnapshot,
} from '../../../src/execution';
import { mintPaperOpenExecutionAuthority, PaperOpenExecutionAuthority } from '../../../src/execution/open-authority';
import { mintPaperCloseExecutionAuthority, PaperCloseExecutionAuthority, type PaperClosePositionBinding } from '../../../src/execution/close-authority';
import { PaperAccountRepository } from '../../../src/execution/persistence/account-repository';
import { openPaperAccountSession } from '../../../src/execution/persistence';
import {
  issueTrustedPaperExecutionEvidence,
  type TrustedPaperConversionEvidence,
  type TrustedPaperOrderbookDepth,
} from '../../../src/execution/trusted-evidence';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { getTrustedPaperExecutionEvidence } from '../../../src/integration/coindcx/execution-evidence-adapter';
import { CoinDcxPaperEvidence } from '../../../src/integration/coindcx/paper-evidence';
import { FakeCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';
import { sha256CanonicalJson } from '../../../src/risk';
import type { CanonicalPositionValuation, PairRiskSnapshot, RiskEvaluationContext } from '../../../src/risk';
import type { StrategyKernel } from '../../../src/strategies';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, PAIR, policyFor } from '../../unit/dispatch/helpers';
import { makePair, seal } from '../../unit/risk/helpers';

// P14-E integrated OPEN/CLOSE economic execution — real disposable-MySQL suite,
// mirroring the P14-D shadow-database pattern exactly (see
// tests/integration/execution/paper-account-persistence.test.ts). Every test
// is skipped, not failed, if no local MySQL is reachable.
//
// `genuineResearchApproval()` (tests/unit/dispatch/helpers.ts) always mints its
// PASSED verdict for the fixed `PAIR` ('B-BTC_USDT') — it is not parameterized
// by pair — so every OPEN test here uses `PAIR` via `makeKernel()`'s default,
// exactly like tests/unit/execution/open-authority.test.ts. Independent test
// cases are isolated by using a fresh `accountId` each (P14-D's own
// convention), not by varying the pair.

const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p14e_test_${randomBytes(6).toString('hex')}`;

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
  if (!dbAvailable) console.warn('P14-E live-DB suite skipped: no reachable disposable MySQL environment (see beforeAll).');
  return !dbAvailable;
}

let accountCounter = 0;
function freshAccountId(): string { accountCounter += 1; return `p14e-account-${accountCounter}`; }

const INSTRUMENT_SPEC_SNAPSHOT_ID = 'instrument-1';
const T0 = 1_200_000;
const MINUTE = 60_000;

async function initAccount(accountId: string): Promise<void> {
  await new PaperAccountRepository(prisma).ensureAccountInitialized(accountId, '1000000');
}
async function provisionPairSlot(accountId: string, pair: string): Promise<void> {
  await prisma.paperPosition.upsert({ where: { accountId_pair: { accountId, pair } }, create: { accountId, pair, status: 'EMPTY' }, update: {} });
}

function evidenceFrom(context: RiskEvaluationContext) {
  const { strategyOrigin: _strategyOrigin, candidate: _candidate, ...evidence } = context;
  return evidence;
}

const EXECUTION_POLICY: ExecutionPolicySnapshot = buildExecutionPolicySnapshot({
  policyVersion: EXECUTION_POLICY_VERSION,
  fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
  marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 5000, requiredHealthState: 'HEALTHY' },
  takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT', tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1',
  quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001', currencyConversionPolicy: 'P14_INR_CONVERSION_V1',
  accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
});
// Matches the leverage-tier fixture's own `priceIncrement`/`quantityIncrement` ('1') in tests/unit/risk/helpers.ts,
// so RiskEngine's own internally-floored `approvedQuantity` is guaranteed aligned to it.
const PRICE_INCREMENT = '1';
const QUANTITY_INCREMENT = '1';

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
function trust(
  quote: PaperExecutionQuoteSnapshot,
  depth: TrustedPaperOrderbookDepth,
  conversion: TrustedPaperConversionEvidence,
  conversionLocalPollFreshnessMs = 60_000,
) {
  return issueTrustedPaperExecutionEvidence({ quote, orderbookDepth: depth, conversion, conversionLocalPollFreshnessMs });
}

function expectFundingExcluded(result: object): void {
  expect(result).toMatchObject({ fundingDisclosure: PAPER_FUNDING_CAPABILITY });
  expect(Object.isFrozen(result)).toBe(true);
}

// Fixed per-unit valuation used by the CLOSE-reconciliation fixture below — RiskEngine
// cross-verifies `aggregateCurrentNotionalInr`/`currentNotionalInr` genuinely equal
// `quantity * unitValuationInrPerQty` (POSITION_OWNERSHIP_UNRECONCILED otherwise), so
// both must be derived from the real owned quantity, never a fixed magic constant.
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
/**
 * `ownership.accountId` here is deliberately the LITERAL 'account-1' (matching
 * `buildContext`'s default, unoverridden `accountSnapshot.accountId`) — this
 * is RiskEngine's own internal PAIR_ACCOUNT_INSTRUMENT_IDENTITY cross-check
 * between two fields *within the same context*, and is entirely independent
 * of the real paper-persistence `accountId` this test uses for
 * `coordinator.admit()`/`openPaperAccountSession` (see
 * tests/unit/execution/close-authority.test.ts's identical convention).
 */
/**
 * `makePair()`'s own default provenance is hardcoded to a fixed fixture
 * timestamp (only coincidentally equal to `T0` elsewhere) — for a CLOSE
 * decision evaluated at a LATER time (a genuinely later candle, as a real
 * strategy instance would produce), that default reads as stale evidence to
 * RiskEngine's own freshness check. `evaluationTimeMs` re-stamps the
 * provenance to the actual decision time, mirroring `dispatch/helpers.ts`'s
 * internal (non-exported) `retimed()` helper.
 */
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

describe('P14-E live-DB — OPEN then CLOSE happy path', () => {
  it('mints genuine authorities, executes a full OPEN then CLOSE, and produces the correct atomic economic write set', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const openContext = buildContext(kernel, openDecision);

    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admissionRequest: AdmissionRequest = { accountId, policy: policyFor(PAIR), context: openContext };
    const admitted = await session.admitAndPersist(PAIR, admissionRequest, coordinator);
    expect(admitted.outcome).toBe('ADMITTED');
    if (admitted.outcome !== 'ADMITTED') return;

    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    expect(openAuthority).not.toBeNull();
    if (openAuthority === null) return;

    const openNowMs = T0 + 500;
    const openQuote = buildQuote(PAIR, '99', '99.5', openNowMs - 100);
    const openDepth = buildDepth(openQuote, '1000000', '1000000');
    const conversion = buildConversion('80', openNowMs);

    const openResult = await session.executeOpen(openAuthority, {
      evidence: trust(openQuote, openDepth, conversion), priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT,
      executionPolicy: EXECUTION_POLICY, nowMs: openNowMs,
    }, coordinator);
    expect(openResult.outcome).toBe('FILLED');
    expectFundingExcluded(openResult);
    if (openResult.outcome !== 'FILLED') return;
    expect(openResult.side).toBe('BUY');

    const intent = await prisma.paperExecutionIntent.findUnique({ where: { executionIntentId: openResult.executionIntentId } });
    expect(intent?.action).toBe('OPEN');
    expect(intent?.admissionId).toBe(admitted.admission.admissionId);
    const order = await prisma.paperOrder.findUnique({ where: { executionIntentId: openResult.executionIntentId } });
    expect(order?.state).toBe('FILLED');
    const fill = await prisma.paperFill.findUnique({ where: { orderId: openResult.executionIntentId } });
    expect(fill).not.toBeNull();
    expect(fill?.side).toBe('BUY');
    expect(fill?.sourceStrategyDecisionId).toBe(openDecision.decisionId);
    const openLedger = await prisma.paperLedgerEntry.findMany({ where: { accountId, sourceFillId: openResult.executionIntentId } });
    expect(openLedger).toHaveLength(1);
    expect(openLedger[0]?.type).toBe('FEE');
    expect(openLedger[0]?.amountInr.toFixed()).toBe(`-${fill!.feeInr.toFixed()}`);

    const positionAfterOpen = await prisma.paperPosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfterOpen?.status).toBe('OPEN');
    expect(positionAfterOpen?.side).toBe('LONG');
    expect(positionAfterOpen?.positionInstanceId).toBe(openResult.positionInstanceId);
    expect(positionAfterOpen?.admissionId).toBe(admitted.admission.admissionId);
    expect(positionAfterOpen?.cumulativeFeesInr.toFixed()).toBe(fill!.feeInr.toFixed());
    expect(positionAfterOpen?.cumulativeFundingInr.toFixed()).toBe('0');

    const reservationAfterOpen = await prisma.paperReservation.findUnique({ where: { admissionId: admitted.admission.admissionId } });
    expect(reservationAfterOpen?.status).toBe('CONSUMED');

    const accountAfterOpen = await prisma.paperAccount.findUnique({ where: { accountId } });
    expect(accountAfterOpen?.cumulativeFeesInr.toFixed()).toBe(fill!.feeInr.toFixed());
    expect(accountAfterOpen?.cumulativeFundingInr.toFixed()).toBe('0');
    expect(coordinator.isAccountFaulted(accountId)).toBe(false);

    // --- CLOSE --- (a second decision, one full candle later, on the same kernel)
    const closeDecision = evaluateDecision(kernel, T0 + MINUTE, 'FLAT');
    const closeContext = buildContext(kernel, closeDecision, { pairSnapshot: openPairSnapshotFor(kernel, openResult.quantity, closeDecision.evaluationTimeMs) });
    const positionBinding: PaperClosePositionBinding = {
      positionInstanceId: openResult.positionInstanceId, positionRevision: positionAfterOpen!.revision,
      ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
      ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash, ownedQuantity: openResult.quantity,
    };
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId, kernel, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      policy: policyFor(PAIR), evidence: evidenceFrom(closeContext), position: positionBinding,
    });
    expect(closeAuthority).not.toBeNull();
    if (closeAuthority === null) return;

    const closeNowMs = T0 + MINUTE + 500;
    const closeQuote = buildQuote(PAIR, '110', '112', closeNowMs - 100);
    const closeDepth = buildDepth(closeQuote, '1000000', '1000000');

    const closeResult = await session.executeClose(closeAuthority, {
      evidence: trust(closeQuote, closeDepth, buildConversion('80', closeNowMs)), priceIncrement: PRICE_INCREMENT,
      executionPolicy: EXECUTION_POLICY, nowMs: closeNowMs,
    });
    expect(closeResult.outcome).toBe('CLOSED');
    expectFundingExcluded(closeResult);
    if (closeResult.outcome !== 'CLOSED') return;
    expect(closeResult.side).toBe('SELL');
    expect(closeResult.realizedPnlInr).toBe('900');

    const closeFill = await prisma.paperFill.findUnique({ where: { orderId: closeResult.executionIntentId } });
    expect(closeFill?.realizedPnlInr?.toFixed()).toBe(closeResult.realizedPnlInr);
    const closeLedger = await prisma.paperLedgerEntry.findMany({ where: { accountId, sourceFillId: closeResult.executionIntentId } });
    expect(closeLedger).toHaveLength(2);
    expect(closeLedger.map((e) => e.type).sort()).toEqual(['FEE', 'REALIZED_PNL']);

    const history = await prisma.paperPositionOwnershipHistory.findUnique({ where: { positionInstanceId: openResult.positionInstanceId } });
    expect(history?.openingExecutionIntentId).toBe(openResult.executionIntentId);
    expect(history?.closingExecutionIntentId).toBe(closeResult.executionIntentId);
    expect(history?.realizedPnlInr.toFixed()).toBe(closeResult.realizedPnlInr);
    expect(history?.totalFundingInr.toFixed()).toBe('0');
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, type: 'FUNDING' } })).toBe(0);

    const positionAfterClose = await prisma.paperPosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfterClose?.status).toBe('EMPTY');
    expect(positionAfterClose?.positionInstanceId).toBeNull();
    expect(positionAfterClose?.cumulativeFeesInr.toFixed()).toBe('0');

    const accountAfterClose = await prisma.paperAccount.findUnique({ where: { accountId } });
    const totalFees = accountAfterOpen!.cumulativeFeesInr.plus(closeFill!.feeInr);
    expect(accountAfterClose?.cumulativeFeesInr.toFixed()).toBe(totalFees.toFixed());
    expect(accountAfterClose?.cumulativeRealizedPnlInr.toFixed()).toBe(closeResult.realizedPnlInr);
    expect(accountAfterClose?.cumulativeFundingInr.toFixed()).toBe('0');
  }, 60_000);
});

describe('P14-F live-DB — long-held restored position remains mechanically closable', () => {
  it('restores and closes after a long elapsed time without synthesizing funding', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel, T0);
    const firstCoordinator = new RiskAdmissionCoordinator();
    const openContext = buildContext(kernel, openDecision);
    const firstSession = await openPaperAccountSession({ accountId, coordinator: firstCoordinator, prisma });
    const admitted = await firstSession.admitAndPersist(
      PAIR,
      { accountId, policy: policyFor(PAIR), context: openContext },
      firstCoordinator,
    );
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator: firstCoordinator, accountId, kernel, decision: openDecision,
      instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID, planResult,
      policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    if (openAuthority === null) throw new Error('fixture');
    const openQuote = buildQuote(PAIR, '99', '99.5', T0);
    const openResult = await firstSession.executeOpen(openAuthority, {
      evidence: trust(openQuote, buildDepth(openQuote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT,
      executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, firstCoordinator);
    if (openResult.outcome !== 'FILLED') throw new Error('fixture');
    expectFundingExcluded(openResult);
    firstSession.release();

    const restartedCoordinator = new RiskAdmissionCoordinator();
    const restoredSession = await openPaperAccountSession({ accountId, coordinator: restartedCoordinator, prisma });
    expect(restoredSession.state).toBe('READY');
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const closeTimeMs = T0 + (30 * 24 * 60 * 60 * 1000);
    const closeDecision = evaluateDecision(kernel, closeTimeMs, 'FLAT');
    const closeContext = buildContext(kernel, closeDecision, {
      pairSnapshot: openPairSnapshotFor(kernel, openResult.quantity, closeTimeMs),
    });
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator: restartedCoordinator, accountId, kernel, decision: closeDecision,
      instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID, policy: policyFor(PAIR),
      evidence: evidenceFrom(closeContext), position: {
        positionInstanceId: openResult.positionInstanceId, positionRevision: position.revision,
        ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
        ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash,
        ownedQuantity: openResult.quantity,
      },
    });
    if (closeAuthority === null) throw new Error('fixture');
    const closeQuote = buildQuote(PAIR, '110', '112', closeTimeMs);
    const closeResult = await restoredSession.executeClose(closeAuthority, {
      evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', closeTimeMs)),
      priceIncrement: PRICE_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: closeTimeMs,
    });

    expect(closeResult.outcome).toBe('CLOSED');
    expectFundingExcluded(closeResult);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, type: 'FUNDING' } })).toBe(0);
    const history = await prisma.paperPositionOwnershipHistory.findUniqueOrThrow({ where: { positionInstanceId: openResult.positionInstanceId } });
    expect(history.totalFundingInr.toFixed()).toBe('0');
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).cumulativeFundingInr.toFixed()).toBe('0');
  }, 60_000);
});

describe('P14-E live-DB — OPEN safety', () => {
  it('rejects a forged OPEN authority object structurally (never throws through to a fill)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);

    const forged = { accountId, admission: {}, decision: {}, researchApproval: {}, strategyOrigin: {} } as unknown as PaperOpenExecutionAuthority;
    const quote = buildQuote(PAIR, '99', '99.5', T0);
    await expect(session.executeOpen(forged, {
      evidence: trust(quote, buildDepth(quote, '1000', '1000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator)).rejects.toMatchObject({ code: 'NOT_OWNER' });

    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR } })).toBe(0);
  }, 30_000);

  it('fails closed (no mutation) when approved-side executable depth is insufficient (AON policy)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    expect(admitted.outcome).toBe('ADMITTED');
    if (admitted.outcome !== 'ADMITTED') return;
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    expect(authority).not.toBeNull();
    if (authority === null) return;

    const quote = buildQuote(PAIR, '99', '99.5', T0);
    const result = await session.executeOpen(authority, {
      evidence: trust(quote, buildDepth(quote, '1000000', '0.0000001'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator);
    expect(result.outcome).toBe('INSUFFICIENT_LIQUIDITY');
    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR } })).toBe(0);
    const reservation = await prisma.paperReservation.findUnique({ where: { admissionId: admitted.admission.admissionId } });
    expect(reservation?.status).toBe('ADMITTED');
    const slot = await prisma.paperPosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(slot?.status).toBe('PENDING');
  }, 30_000);

  it('returns terminal idempotency before the consumed OPEN slot/reservation checks on an exact committed retry', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    expect(admitted.outcome).toBe('ADMITTED');
    if (admitted.outcome !== 'ADMITTED') return;
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    expect(authority).not.toBeNull();
    if (authority === null) return;

    const quote = buildQuote(PAIR, '99', '99.5', T0);
    const inputs = {
      evidence: trust(quote, buildDepth(quote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    };
    const first = await session.executeOpen(authority, inputs, coordinator);
    expect(first.outcome).toBe('FILLED');
    expectFundingExcluded(first);
    const before = {
      fills: await prisma.paperFill.count({ where: { accountId, pair: PAIR } }),
      ledger: await prisma.paperLedgerEntry.count({ where: { accountId, pair: PAIR } }),
      account: await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } }),
      position: await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } }),
    };
    const retry = await session.executeOpen(authority, { ...inputs, nowMs: T0 + 100_000 }, coordinator);
    expect(retry.outcome).toBe('SOURCE_DECISION_ALREADY_EXECUTED');
    expectFundingExcluded(retry);
    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR } })).toBe(1);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, pair: PAIR } })).toBe(before.ledger);
    expect(await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).toEqual(before.account);
    expect(await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).toEqual(before.position);
    const reservation = await prisma.paperReservation.findUnique({ where: { admissionId: admitted.admission.admissionId } });
    expect(reservation?.status).toBe('CONSUMED');
  }, 30_000);

  it('a stale session (superseded by a fence takeover) fails closed on STALE_FENCE without faulting the account', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const staleSession = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await staleSession.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    expect(admitted.outcome).toBe('ADMITTED');
    if (admitted.outcome !== 'ADMITTED') return;
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    expect(authority).not.toBeNull();
    if (authority === null) return;

    // Takeover by a fresh coordinator/process — supersedes staleSession's fence.
    await openPaperAccountSession({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma });

    const quote = buildQuote(PAIR, '99', '99.5', T0);
    await expect(staleSession.executeOpen(authority, {
      evidence: trust(quote, buildDepth(quote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator)).rejects.toMatchObject({ code: 'STALE_FENCE' });

    expect(staleSession.state).toBe('READY');
    expect(coordinator.isAccountFaulted(accountId)).toBe(false);
    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR } })).toBe(0);
  }, 30_000);
});

describe('P14-E live-DB — CLOSE safety', () => {
  it('rejects a forged CLOSE authority object structurally', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const forged = { accountId, decision: {}, strategyOrigin: {}, position: {}, reduceOnlyQuantity: '1' } as unknown as PaperCloseExecutionAuthority;
    const quote = buildQuote(PAIR, '99', '99.5', T0);
    await expect(session.executeClose(forged, {
      evidence: trust(quote, buildDepth(quote, '1000', '1000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    })).rejects.toMatchObject({ code: 'NOT_OWNER' });
  }, 30_000);

  it('a stale positionRevision (a successor mutation already happened) is rejected — no double economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const openContext = buildContext(kernel, openDecision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: openContext }, coordinator);
    expect(admitted.outcome).toBe('ADMITTED');
    if (admitted.outcome !== 'ADMITTED') return;
    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    if (openAuthority === null) throw new Error('fixture');
    const openQuote = buildQuote(PAIR, '99', '99.5', T0);
    const openResult = await session.executeOpen(openAuthority, {
      evidence: trust(openQuote, buildDepth(openQuote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator);
    if (openResult.outcome !== 'FILLED') throw new Error('fixture');

    const closeDecision = evaluateDecision(kernel, T0 + MINUTE, 'FLAT');
    const closeContext = buildContext(kernel, closeDecision, { pairSnapshot: openPairSnapshotFor(kernel, openResult.quantity, closeDecision.evaluationTimeMs) });
    const staleBinding: PaperClosePositionBinding = {
      positionInstanceId: openResult.positionInstanceId, positionRevision: 1, // stale — the real revision after OPEN is 2
      ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
      ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash, ownedQuantity: openResult.quantity,
    };
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId, kernel, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      policy: policyFor(PAIR), evidence: evidenceFrom(closeContext), position: staleBinding,
    });
    expect(closeAuthority).not.toBeNull();
    if (closeAuthority === null) return;

    const closeQuote = buildQuote(PAIR, '110', '112', T0 + MINUTE + 500);
    const result = await session.executeClose(closeAuthority, {
      evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', T0 + MINUTE + 500)),
      priceIncrement: PRICE_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0 + MINUTE + 500,
    });
    expect(result.outcome).toBe('POSITION_NOT_READY');
    const position = await prisma.paperPosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position?.status).toBe('OPEN'); // unchanged — still open, never closed by the stale attempt
    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR, action: 'CLOSE' } })).toBe(0);
  }, 30_000);

  it('a duplicate CLOSE after a genuine close cannot double-realize PnL or double-charge fees', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const openContext = buildContext(kernel, openDecision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: openContext }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    if (openAuthority === null) throw new Error('fixture');
    const openQuote = buildQuote(PAIR, '99', '99.5', T0);
    const openResult = await session.executeOpen(openAuthority, {
      evidence: trust(openQuote, buildDepth(openQuote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator);
    if (openResult.outcome !== 'FILLED') throw new Error('fixture');
    const positionAfterOpen = await prisma.paperPosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });

    const closeDecision = evaluateDecision(kernel, T0 + MINUTE, 'FLAT');
    const closeContext = buildContext(kernel, closeDecision, { pairSnapshot: openPairSnapshotFor(kernel, openResult.quantity, closeDecision.evaluationTimeMs) });
    const binding: PaperClosePositionBinding = {
      positionInstanceId: openResult.positionInstanceId, positionRevision: positionAfterOpen!.revision,
      ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
      ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash, ownedQuantity: openResult.quantity,
    };
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId, kernel, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      policy: policyFor(PAIR), evidence: evidenceFrom(closeContext), position: binding,
    });
    if (closeAuthority === null) throw new Error('fixture');
    const closeQuote = buildQuote(PAIR, '110', '112', T0 + MINUTE + 500);
    const closeInputs = {
      evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', T0 + MINUTE + 500)),
      priceIncrement: PRICE_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0 + MINUTE + 500,
    };
    const firstClose = await session.executeClose(closeAuthority, closeInputs);
    expect(firstClose.outcome).toBe('CLOSED');
    expectFundingExcluded(firstClose);
    const beforeRetry = {
      fillCount: await prisma.paperFill.count({ where: { accountId, pair: PAIR, action: 'CLOSE' } }),
      ledgerCount: await prisma.paperLedgerEntry.count({ where: { accountId, sourceFillId: firstClose.outcome === 'CLOSED' ? firstClose.executionIntentId : '' } }),
      history: await prisma.paperPositionOwnershipHistory.findMany({ where: { accountId, pair: PAIR } }),
      account: await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } }),
      position: await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } }),
    };

    // A second attempt with the SAME (now-stale, already-consumed) authority must not double-apply anything.
    const secondClose = await session.executeClose(closeAuthority, { ...closeInputs, nowMs: T0 + 200_000 });
    expect(secondClose.outcome).toBe('SOURCE_DECISION_ALREADY_EXECUTED');
    expectFundingExcluded(secondClose);

    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR, action: 'CLOSE' } })).toBe(beforeRetry.fillCount);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, sourceFillId: firstClose.outcome === 'CLOSED' ? firstClose.executionIntentId : '' } })).toBe(beforeRetry.ledgerCount);
    expect(await prisma.paperPositionOwnershipHistory.findMany({ where: { accountId, pair: PAIR } })).toEqual(beforeRetry.history);
    const accountFinal = await prisma.paperAccount.findUnique({ where: { accountId } });
    expect(accountFinal).toEqual(beforeRetry.account);
    expect(await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).toEqual(beforeRetry.position);
    expect(firstClose.outcome === 'CLOSED' ? accountFinal?.cumulativeRealizedPnlInr.toFixed() : null).toBe(firstClose.outcome === 'CLOSED' ? firstClose.realizedPnlInr : null);
  }, 30_000);
});

describe('P14-E correction proofs — evidence freshness and approved economics', () => {
  it('rejects stale/future conversion observations with zero economic mutation, but accepts a fresh local observation with an old provider timestamp', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    if (authority === null) throw new Error('fixture');

    const nowMs = T0 + 100_000;
    const quote = buildQuote(PAIR, '99', '99.5', nowMs);
    const baseCounts = {
      intents: await prisma.paperExecutionIntent.count({ where: { accountId } }),
      orders: await prisma.paperOrder.count({ where: { accountId } }),
      fills: await prisma.paperFill.count({ where: { accountId } }),
      ledger: await prisma.paperLedgerEntry.count({ where: { accountId } }),
    };
    const run = (conversion: TrustedPaperConversionEvidence, localFreshnessMs = 60_000) => session.executeOpen(authority, {
      evidence: trust(quote, buildDepth(quote, '1000000', '1000000'), conversion, localFreshnessMs),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs,
    }, coordinator);

    await expect(run(buildConversion('80', nowMs - 60_001))).resolves.toMatchObject({ outcome: 'EVIDENCE_INVALID', reason: 'CONVERSION_STALE_AT_USE', fundingDisclosure: PAPER_FUNDING_CAPABILITY });
    await expect(run(buildConversion('80', nowMs + 1))).resolves.toMatchObject({ outcome: 'EVIDENCE_INVALID', reason: 'CONVERSION_CLOCK_FAULT', fundingDisclosure: PAPER_FUNDING_CAPABILITY });
    expect(await prisma.paperExecutionIntent.count({ where: { accountId } })).toBe(baseCounts.intents);
    expect(await prisma.paperOrder.count({ where: { accountId } })).toBe(baseCounts.orders);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(baseCounts.fills);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId } })).toBe(baseCounts.ledger);

    const provider = new CoinDcxPaperEvidence({
      instruments: [{ pair: PAIR, underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID }],
      clock: new FakeClock(nowMs), socketFactory: new FakeCoinDcxSocketFactory(),
      policy: { orderbookFreshnessMs: 5_000, markFreshnessMs: 5_000, conversionLocalPollFreshnessMs: 60_000, allowedProviderFutureSkewMs: 1_000 },
    });
    const generation = provider.startOrderbookWebSocket();
    expect(provider.ingestOrderbookWebSocket({
      data: JSON.stringify({ type: 'depth-snapshot', pr: 'futures', s: 'BTCUSDT', ts: String(nowMs), vs: '1', bids: [['99', '1000000']], asks: [['99.5', '1000000']] }),
    }, generation)).toMatchObject({ accepted: true });
    expect(provider.ingestConversionRest([{
      symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '80', last_updated_at: '1',
    }])).toMatchObject({ accepted: true });
    const trusted = getTrustedPaperExecutionEvidence(provider, PAIR);
    expect(trusted.state).toBe('AVAILABLE');
    if (trusted.state !== 'AVAILABLE') return;
    const freshWithOldProviderTime = await session.executeOpen(authority, {
      evidence: trusted.evidence, priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT,
      executionPolicy: EXECUTION_POLICY, nowMs,
    }, coordinator);
    expect(freshWithOldProviderTime.outcome).toBe('FILLED');
  }, 30_000);

  it('rejects adverse-slippage economics above admission with no intent/order/fill/ledger/position/account economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    if (authority === null) throw new Error('fixture');
    const beforeAccount = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const beforePosition = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const quote = buildQuote(PAIR, '100', '101', T0);
    const result = await session.executeOpen(authority, {
      evidence: trust(quote, buildDepth(quote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator);
    expect(result).toMatchObject({ outcome: 'APPROVED_RISK_EXCEEDED', reason: 'EXECUTION_EXCEEDS_APPROVED_NOTIONAL', fundingDisclosure: PAPER_FUNDING_CAPABILITY });
    expect(await prisma.paperExecutionIntent.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperOrder.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).toEqual(beforeAccount);
    expect(await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).toEqual(beforePosition);
  }, 30_000);

  it('rejects a plain caller-shaped trusted bundle at runtime with no economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    if (authority === null) throw new Error('fixture');
    const result = await session.executeOpen(authority, {
      evidence: { __trustedPaperExecutionEvidence: undefined } as never,
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator);
    expect(result).toMatchObject({ outcome: 'EVIDENCE_INVALID', reason: 'UNTRUSTED_EXECUTION_EVIDENCE', fundingDisclosure: PAPER_FUNDING_CAPABILITY });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('P14-E correction proofs — terminal conflict rollback and ambiguous OPEN recovery', () => {
  it('does not misclassify an unrelated execution-intent P2002 as terminal source execution', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    if (authority === null) throw new Error('fixture');
    const record = PaperOpenExecutionAuthority.read(authority)!;
    const executionIntentId = computeOpenExecutionIntentId({
      admissionId: record.admission.admissionId, riskDecisionId: record.admission.riskDecisionId, accountId, pair: PAIR,
      strategyInstanceId: record.admission.strategyInstanceId, strategyId: record.admission.strategyId,
      strategyVersion: record.admission.strategyVersion, parameterHash: record.admission.parameterHash,
      approvedQuantity: record.decision.approved.approvedQuantity, approvedLeverage: record.decision.approved.approvedLeverage,
      approvedNotionalInr: record.admission.approvedNotionalInr, approvedMarginInr: record.admission.approvedMarginInr,
      evaluationTimeMs: record.decision.evaluationTimeMs, executionPolicySnapshotId: EXECUTION_POLICY.executionPolicySnapshotId,
    });
    await prisma.paperExecutionPolicySnapshot.upsert({
      where: { executionPolicySnapshotId: EXECUTION_POLICY.executionPolicySnapshotId },
      create: {
        executionPolicySnapshotId: EXECUTION_POLICY.executionPolicySnapshotId, policyVersion: EXECUTION_POLICY.content.policyVersion,
        fillSelectionPolicy: EXECUTION_POLICY.content.fillSelectionPolicy, maxEvidenceAgeMs: EXECUTION_POLICY.content.marketEvidenceEligibilityPolicy.maxEvidenceAgeMs,
        requiredHealthState: EXECUTION_POLICY.content.marketEvidenceEligibilityPolicy.requiredHealthState, takerFeeRate: EXECUTION_POLICY.content.takerFeeRate,
        slippageBps: EXECUTION_POLICY.content.slippageBps, spreadSemantics: EXECUTION_POLICY.content.spreadSemantics,
        tickRoundingPolicy: EXECUTION_POLICY.content.tickRoundingPolicy, quantityPolicy: EXECUTION_POLICY.content.quantityPolicy,
        contractMultiplier: EXECUTION_POLICY.content.contractMultiplier, currencyConversionPolicy: EXECUTION_POLICY.content.currencyConversionPolicy,
        accountingPolicy: EXECUTION_POLICY.content.accountingPolicy, executionSemanticsVersion: EXECUTION_POLICY.content.executionSemanticsVersion,
      }, update: {},
    });
    await prisma.paperExecutionIntent.create({
      data: {
        executionIntentId, action: 'OPEN', accountId, pair: PAIR, strategyInstanceId: record.admission.strategyInstanceId,
        strategyId: record.admission.strategyId, strategyVersion: record.admission.strategyVersion, parameterHash: record.admission.parameterHash,
        riskDecisionId: 'conflicting-risk-decision', evaluationTimeMs: record.decision.evaluationTimeMs,
        executionPolicySnapshotId: EXECUTION_POLICY.executionPolicySnapshotId,
      },
    });
    const quote = buildQuote(PAIR, '99', '99.5', T0);
    await expect(session.executeOpen(authority, {
      evidence: trust(quote, buildDepth(quote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator)).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.paperExecutionIntent.count({ where: { accountId } })).toBe(1);
    expect(await prisma.paperOrder.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
  }, 30_000);

  it('forces rollback on a terminal fill P2002 after the losing intent/order were created, then classifies from durable state outside the transaction', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    let terminalReads = 0;
    const conflictPrisma = prisma.$extends({
      query: {
        paperFill: {
          async findUnique({ args, query }) {
            terminalReads += 1;
            if (terminalReads === 1) return null;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma: conflictPrisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    if (authority === null) throw new Error('fixture');

    await prisma.paperExecutionPolicySnapshot.upsert({
      where: { executionPolicySnapshotId: EXECUTION_POLICY.executionPolicySnapshotId },
      create: {
        executionPolicySnapshotId: EXECUTION_POLICY.executionPolicySnapshotId, policyVersion: EXECUTION_POLICY.content.policyVersion,
        fillSelectionPolicy: EXECUTION_POLICY.content.fillSelectionPolicy, maxEvidenceAgeMs: EXECUTION_POLICY.content.marketEvidenceEligibilityPolicy.maxEvidenceAgeMs,
        requiredHealthState: EXECUTION_POLICY.content.marketEvidenceEligibilityPolicy.requiredHealthState, takerFeeRate: EXECUTION_POLICY.content.takerFeeRate,
        slippageBps: EXECUTION_POLICY.content.slippageBps, spreadSemantics: EXECUTION_POLICY.content.spreadSemantics,
        tickRoundingPolicy: EXECUTION_POLICY.content.tickRoundingPolicy, quantityPolicy: EXECUTION_POLICY.content.quantityPolicy,
        contractMultiplier: EXECUTION_POLICY.content.contractMultiplier, currencyConversionPolicy: EXECUTION_POLICY.content.currencyConversionPolicy,
        accountingPolicy: EXECUTION_POLICY.content.accountingPolicy, executionSemanticsVersion: EXECUTION_POLICY.content.executionSemanticsVersion,
      },
      update: {},
    });
    const winnerIntentId = 'a'.repeat(64);
    await prisma.paperExecutionIntent.create({
      data: {
        executionIntentId: winnerIntentId, action: 'OPEN', accountId, pair: PAIR, strategyInstanceId: decision.strategyInstanceId,
        strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
        riskDecisionId: decision.decisionId, evaluationTimeMs: decision.evaluationTimeMs,
        executionPolicySnapshotId: EXECUTION_POLICY.executionPolicySnapshotId,
      },
    });
    await prisma.paperOrder.create({ data: { executionIntentId: winnerIntentId, accountId, action: 'OPEN', state: 'FILLED' } });
    await prisma.paperFill.create({
      data: {
        orderId: winnerIntentId, accountId, sourceStrategyDecisionId: decision.decisionId,
        sourceExecutionKey: computeSourceExecutionKey({ accountId, sourceStrategyDecisionId: decision.decisionId }),
        pair: PAIR, action: 'OPEN', side: 'BUY', fillPrice: '8000', quantity: PaperOpenExecutionAuthority.read(authority)!.decision.approved.approvedQuantity, feeInr: '0',
        quoteSnapshotContentSha256: 'winner', eventTimeMs: T0,
      },
    });
    const accountBefore = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const positionBefore = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const quote = buildQuote(PAIR, '99', '99.5', T0);
    const result = await session.executeOpen(authority, {
      evidence: trust(quote, buildDepth(quote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator);
    expect(result.outcome).toBe('SOURCE_DECISION_ALREADY_EXECUTED');
    expect(terminalReads).toBeGreaterThanOrEqual(2);
    expect(await prisma.paperExecutionIntent.count({ where: { accountId } })).toBe(1);
    expect(await prisma.paperOrder.count({ where: { accountId } })).toBe(1);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).toEqual(accountBefore);
    expect(await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).toEqual(positionBefore);
  }, 30_000);

  it('faults session/coordinator after genuine coordinator.release mutation and a later injected DB failure, then requires authoritative restore', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    let inject = true;
    const failingPrisma = prisma.$extends({
      query: {
        paperLedgerEntry: {
          async create({ args, query }) {
            if (inject) { inject = false; throw new Error('INJECTED_POST_RELEASE_LEDGER_FAILURE'); }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma: failingPrisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(context),
    });
    if (authority === null) throw new Error('fixture');
    const releaseSpy = vi.spyOn(coordinator, 'release');
    const quote = buildQuote(PAIR, '99', '99.5', T0);
    const inputs = {
      evidence: trust(quote, buildDepth(quote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    };
    await expect(session.executeOpen(authority, inputs, coordinator)).rejects.toMatchObject({ code: 'ADMISSION_OUTCOME_AMBIGUOUS' });
    expect(releaseSpy).toHaveBeenCalledWith(accountId, admitted.admission.admissionId);
    await expect(releaseSpy.mock.results[0]?.value).resolves.toMatchObject({ status: 'RELEASED' });
    expect(session.state).toBe('FAULTED');
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);
    await expect(session.executeOpen(authority, inputs, coordinator)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
    expect(() => session.executeClose({} as PaperCloseExecutionAuthority, {} as never)).toThrow(/ACCOUNT_NOT_READY/);
    await expect(session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context }, coordinator)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
    await expect(session.releaseAndPersist(admitted.admission.admissionId, coordinator)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
    await expect(coordinator.release(accountId, admitted.admission.admissionId)).rejects.toThrow(/FAULTED/);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect((await prisma.paperReservation.findUniqueOrThrow({ where: { admissionId: admitted.admission.admissionId } })).status).toBe('ADMITTED');

    const recovered = await openPaperAccountSession({ accountId, coordinator, prisma });
    expect(recovered.state).toBe('READY');
    expect(recovered.restoreResult.recoveredFromFault).toBe(true);
    expect(coordinator.isAccountFaulted(accountId)).toBe(false);
    const recoveredResult = await recovered.executeOpen(authority, inputs, coordinator);
    expect(recoveredResult.outcome).toBe('FILLED');
  }, 30_000);
});

describe('P14-E correction proof — exact integrated accounting matrix', () => {
  it('posts exact LONG profit, LONG loss, SHORT profit, and SHORT loss', async () => {
    if (skip()) return;
    const cases = [
      { side: 'LONG' as const, closeBid: '110', closeAsk: '110.5', expected: '900' },
      { side: 'LONG' as const, closeBid: '90.5', closeAsk: '91', expected: '-1000' },
      { side: 'SHORT' as const, closeBid: '89', closeAsk: '89.5', expected: '1000' },
      { side: 'SHORT' as const, closeBid: '110', closeAsk: '110.5', expected: '-1100' },
    ];
    const { result: planResult } = await genuineResearchApproval();
    for (const testCase of cases) {
      const accountId = freshAccountId();
      await initAccount(accountId);
      await provisionPairSlot(accountId, PAIR);
      const kernel = makeKernel(PAIR);
      const openDecision = evaluateDecision(kernel, T0, testCase.side);
      const coordinator = new RiskAdmissionCoordinator();
      const baseOpenContext = buildContext(kernel, openDecision);
      const openContext = testCase.side === 'SHORT'
        ? { ...baseOpenContext, entryStopProposal: seal({ ...baseOpenContext.entryStopProposal!, stopPriceUsdt: '110' }) }
        : baseOpenContext;
      const session = await openPaperAccountSession({ accountId, coordinator, prisma });
      const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: openContext }, coordinator);
      if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
      const openAuthority = await mintPaperOpenExecutionAuthority({
        coordinator, accountId, kernel, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
        planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
      });
      if (openAuthority === null) throw new Error('fixture');
      const openQuote = testCase.side === 'LONG'
        ? buildQuote(PAIR, '99', '99.5', T0)
        : buildQuote(PAIR, '100.5', '101', T0);
      const openResult = await session.executeOpen(openAuthority, {
        evidence: trust(openQuote, buildDepth(openQuote, '1000000', '1000000'), buildConversion('80', T0)),
        priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
      }, coordinator);
      expect(openResult.outcome).toBe('FILLED');
      if (openResult.outcome !== 'FILLED') continue;
      expect(openResult.quantity).toBe('1250');
      expect(openResult.fillPriceInr).toBe('8000');
      const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
      const closeDecision = evaluateDecision(kernel, T0 + MINUTE, 'FLAT');
      const closeContext = buildContext(kernel, closeDecision, {
        pairSnapshot: openPairSnapshotFor(kernel, openResult.quantity, closeDecision.evaluationTimeMs, testCase.side),
      });
      const closeAuthority = await mintPaperCloseExecutionAuthority({
        coordinator, accountId, kernel, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
        policy: policyFor(PAIR), evidence: evidenceFrom(closeContext), position: {
          positionInstanceId: openResult.positionInstanceId, positionRevision: position.revision,
          ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
          ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash, ownedQuantity: openResult.quantity,
        },
      });
      if (closeAuthority === null) throw new Error('fixture');
      const closeNow = T0 + MINUTE;
      const closeQuote = buildQuote(PAIR, testCase.closeBid, testCase.closeAsk, closeNow);
      const closeResult = await session.executeClose(closeAuthority, {
        evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', closeNow)),
        priceIncrement: PRICE_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: closeNow,
      });
      expect(closeResult.outcome).toBe('CLOSED');
      if (closeResult.outcome !== 'CLOSED') continue;
      expect(closeResult.realizedPnlInr).toBe(testCase.expected);
      expect((await prisma.paperFill.findUniqueOrThrow({ where: { orderId: closeResult.executionIntentId } })).realizedPnlInr?.toFixed()).toBe(testCase.expected);
      expect((await prisma.paperPositionOwnershipHistory.findUniqueOrThrow({ where: { positionInstanceId: openResult.positionInstanceId } })).realizedPnlInr.toFixed()).toBe(testCase.expected);
      const pnlLedger = await prisma.paperLedgerEntry.findUniqueOrThrow({
        where: { type_sourceFillId: { type: 'REALIZED_PNL', sourceFillId: closeResult.executionIntentId } },
      });
      expect(pnlLedger.amountInr.toFixed()).toBe(testCase.expected);
    }
  }, 60_000);
});

describe('P14-E correction proof — late CLOSE rollback', () => {
  it('rolls back fill, ledger, history, position, and account when a late CLOSE write fails', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    let failCloseLedger = false;
    const failingPrisma = prisma.$extends({
      query: {
        paperLedgerEntry: {
          async create({ args, query }) {
            if (failCloseLedger) throw new Error('INJECTED_LATE_CLOSE_LEDGER_FAILURE');
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const openContext = buildContext(kernel, openDecision);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma: failingPrisma });
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: openContext }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('fixture');
    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    if (openAuthority === null) throw new Error('fixture');
    const openQuote = buildQuote(PAIR, '99', '99.5', T0);
    const openResult = await session.executeOpen(openAuthority, {
      evidence: trust(openQuote, buildDepth(openQuote, '1000000', '1000000'), buildConversion('80', T0)),
      priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: T0,
    }, coordinator);
    if (openResult.outcome !== 'FILLED') throw new Error('fixture');
    const slot = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const closeDecision = evaluateDecision(kernel, T0 + MINUTE, 'FLAT');
    const closeContext = buildContext(kernel, closeDecision, { pairSnapshot: openPairSnapshotFor(kernel, openResult.quantity, closeDecision.evaluationTimeMs) });
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId, kernel, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      policy: policyFor(PAIR), evidence: evidenceFrom(closeContext), position: {
        positionInstanceId: openResult.positionInstanceId, positionRevision: slot.revision,
        ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
        ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash, ownedQuantity: openResult.quantity,
      },
    });
    if (closeAuthority === null) throw new Error('fixture');
    const beforeAccount = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const beforePosition = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const beforeLedger = await prisma.paperLedgerEntry.count({ where: { accountId } });
    failCloseLedger = true;
    const closeNow = T0 + MINUTE;
    const closeQuote = buildQuote(PAIR, '110', '110.5', closeNow);
    await expect(session.executeClose(closeAuthority, {
      evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', closeNow)),
      priceIncrement: PRICE_INCREMENT, executionPolicy: EXECUTION_POLICY, nowMs: closeNow,
    })).rejects.toThrow(/INJECTED_LATE_CLOSE_LEDGER_FAILURE/);
    expect(session.state).toBe('READY');
    expect(await prisma.paperFill.count({ where: { accountId, action: 'CLOSE' } })).toBe(0);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId } })).toBe(beforeLedger);
    expect(await prisma.paperPositionOwnershipHistory.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).toEqual(beforeAccount);
    expect(await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).toEqual(beforePosition);
  }, 30_000);
});
