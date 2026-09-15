import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import type { AdmissionRequest } from '../../../src/dispatch';
import {
  buildExecutionPolicySnapshot, buildInstrumentEconomicsSnapshot, EXECUTION_POLICY_VERSION, PAPER_FUNDING_CAPABILITY, paperDecimal,
  type ExecutionPolicySnapshot, type PaperExecutionQuoteSnapshot,
} from '../../../src/execution';
import { mintPaperOpenExecutionAuthority } from '../../../src/execution/open-authority';
import { mintPaperCloseExecutionAuthority, type PaperClosePositionBinding } from '../../../src/execution/close-authority';
import { PaperAccountRepository } from '../../../src/execution/persistence/account-repository';
import { PaperAccountKernel } from '../../../src/execution/persistence/paper-account-kernel';
import { openPaperAccountSession } from '../../../src/execution/persistence/paper-account-session';
import {
  issueTrustedPaperExecutionEvidence, type TrustedPaperConversionEvidence, type TrustedPaperOrderbookDepth,
} from '../../../src/execution/trusted-evidence';
import { sha256CanonicalJson } from '../../../src/risk';
import type { CanonicalPositionValuation, PairRiskSnapshot, RiskEvaluationContext } from '../../../src/risk';
import type { StrategyKernel } from '../../../src/strategies';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, PAIR, policyFor } from '../../unit/dispatch/helpers';
import { makePair, seal } from '../../unit/risk/helpers';

// P14-G live-DB restart/rehydration/kernel-startup suite — mirrors the exact
// P14-D/P14-E disposable shadow-database pattern. Every test is skipped, not
// failed, if no local MySQL is reachable.

const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p14g_test_${randomBytes(6).toString('hex')}`;

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
  if (!dbAvailable) console.warn('P14-G live-DB suite skipped: no reachable disposable MySQL environment (see beforeAll).');
  return !dbAvailable;
}

let accountCounter = 0;
function freshAccountId(): string { accountCounter += 1; return `p14g-account-${accountCounter}`; }

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

// Mirrors tests/integration/execution/paper-execution-engine.test.ts's own
// (non-exported) `openPairSnapshotFor` helper exactly — a CLOSE decision's
// risk context must present an OPEN, reconciled-ownership pair snapshot
// (RiskEngine cross-verifies notional = quantity * unitValuation), never the
// default EMPTY-position snapshot `buildContext` supplies for OPEN requests.
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

async function buildRequest(accountId: string, pair: string, evaluationTimeMs: number): Promise<AdmissionRequest> {
  const kernel = makeKernel(pair);
  const decision = evaluateDecision(kernel, evaluationTimeMs);
  return { accountId, policy: policyFor(pair), context: buildContext(kernel, decision) };
}

describe('P14-G live-DB — clean empty account restart (§61)', () => {
  it('a fresh account with no position/pending reservation starts READY with no economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const runtime = await kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });

    expect(runtime.state).toBe('READY');
    expect(kernel.getState(accountId)).toBe('READY');
    expect(runtime.positions).toHaveLength(1);
    expect(runtime.position(PAIR)).toMatchObject({ status: 'EMPTY', pair: PAIR });
    expect(runtime.session.snapshot.cumulativeFundingInr).toBe('0');

    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(account.revision).toBe(1n); // only the ownership-acquisition bump — no economic write occurred
  });
});

describe('P14-G live-DB — OPEN position restart (§41/§63/§64/§65)', () => {
  it('rehydrates an OPEN position exactly, mints fresh CLOSE authority, closes once, and forbids duplicate economics', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    // --- Process 1: admit + OPEN ---
    const { result: planResult } = await genuineResearchApproval();
    const kernel1 = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel1, T0);
    const coordinator1 = new RiskAdmissionCoordinator();
    const openContext = buildContext(kernel1, openDecision);

    const kernelProcess1 = new PaperAccountKernel(prisma);
    const runtime1 = await kernelProcess1.startPaperAccountRuntime({ accountId, coordinator: coordinator1, prisma });
    const session1 = runtime1.session;

    const admissionRequest: AdmissionRequest = { accountId, policy: policyFor(PAIR), context: openContext };
    const admitted = await session1.admitAndPersist(PAIR, admissionRequest, coordinator1);
    expect(admitted.outcome).toBe('ADMITTED');
    if (admitted.outcome !== 'ADMITTED') return;

    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator: coordinator1, accountId, kernel: kernel1, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    expect(openAuthority).not.toBeNull();
    if (openAuthority === null) return;

    const openNowMs = T0 + 500;
    const openQuote = buildQuote(PAIR, '99', '99.5', openNowMs - 100);
    const openDepth = buildDepth(openQuote, '1000000', '1000000');
    const openConversion = buildConversion('80', openNowMs);

    const openResult = await session1.executeOpen(openAuthority, {
      evidence: trust(openQuote, openDepth, openConversion), instrumentEconomics: INSTRUMENT_ECONOMICS,
      executionPolicy: EXECUTION_POLICY, nowMs: openNowMs,
    }, coordinator1);
    expect(openResult.outcome).toBe('FILLED');
    if (openResult.outcome !== 'FILLED') return;

    const durablePositionBeforeRestart = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });

    // --- Simulate a full process restart: discard every in-memory runtime/session/coordinator instance ---
    const coordinator2 = new RiskAdmissionCoordinator();
    const kernelProcess2 = new PaperAccountKernel(prisma); // fresh kernel/orchestrator instance (§62)
    const runtime2 = await kernelProcess2.startPaperAccountRuntime({ accountId, coordinator: coordinator2, prisma });

    expect(runtime2.state).toBe('READY');
    const rehydrated = runtime2.position(PAIR);
    expect(rehydrated?.status).toBe('OPEN');
    if (rehydrated?.status !== 'OPEN') return;

    // Exact durable Decimal-string equality — never approximate Number equality (§63).
    expect(rehydrated.positionInstanceId).toBe(openResult.positionInstanceId);
    expect(rehydrated.quantity).toBe(durablePositionBeforeRestart.quantity!.toFixed());
    expect(rehydrated.averageEntryPriceInr).toBe(durablePositionBeforeRestart.averageEntryPriceInr!.toFixed());
    expect(rehydrated.leverage).toBe(durablePositionBeforeRestart.leverage!.toFixed());
    expect(rehydrated.initialMarginInr).toBe(durablePositionBeforeRestart.initialMarginInr!.toFixed());
    expect(rehydrated.revision).toBe(durablePositionBeforeRestart.revision);
    expect(rehydrated.side).toBe('LONG');
    expect(rehydrated.cumulativeFundingInr).toBe('0'); // funding remains excluded (§26/§27)

    // No OPEN authority is rehydrated from durable rows — only a mechanical view (§51).
    expect((rehydrated as unknown as Record<string, unknown>)['openAuthority']).toBeUndefined();

    // --- Fresh CLOSE authority via the trusted path, bound to the exact durable revision (§14/§21/§52) ---
    // Reuses `kernel1` (same strategyInstanceId/strategyId/strategyVersion/
    // parameterHash the OPEN admission recorded) — a restarted process
    // reconnecting to the same logical strategy instance, exactly mirroring
    // the frozen P14-E OPEN->CLOSE happy-path test's own convention of
    // reusing one kernel across both legs.
    const closeDecision = evaluateDecision(kernel1, T0 + MINUTE, 'FLAT');
    const closeContext = buildContext(kernel1, closeDecision, { pairSnapshot: openPairSnapshotFor(kernel1, rehydrated.quantity, closeDecision.evaluationTimeMs) });
    const positionBinding: PaperClosePositionBinding = {
      positionInstanceId: rehydrated.positionInstanceId, positionRevision: rehydrated.revision,
      ownerStrategyInstanceId: rehydrated.ownerStrategyInstanceId, ownerStrategyId: rehydrated.ownerStrategyId,
      ownerStrategyVersion: rehydrated.ownerStrategyVersion, ownerParameterHash: rehydrated.ownerParameterHash,
      ownedQuantity: rehydrated.quantity,
    };
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator: coordinator2, accountId, kernel: kernel1, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      policy: policyFor(PAIR), evidence: evidenceFrom(closeContext), position: positionBinding,
    });
    expect(closeAuthority).not.toBeNull();
    if (closeAuthority === null) return;

    const closeNowMs = T0 + MINUTE + 500;
    const closeQuote = buildQuote(PAIR, '110', '112', closeNowMs - 100);
    const closeDepth = buildDepth(closeQuote, '1000000', '1000000');
    const closeResult = await runtime2.session.executeClose(closeAuthority, {
      evidence: trust(closeQuote, closeDepth, buildConversion('80', closeNowMs)),
      executionPolicy: EXECUTION_POLICY, nowMs: closeNowMs,
    });
    expect(closeResult.outcome).toBe('CLOSED');
    expect(closeResult).toMatchObject({ fundingDisclosure: PAPER_FUNDING_CAPABILITY });

    const positionAfterClose = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfterClose.status).toBe('EMPTY');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(2); // exactly one OPEN fill + one CLOSE fill — no duplicate economics
    expect(await prisma.paperPositionOwnershipHistory.count({ where: { accountId } })).toBe(1);
  }, 60_000);
});

describe('P14-G live-DB — PENDING reservation restart (§42)', () => {
  it('restores C3 pending exposure before READY, keeps the slot PENDING, and mints no OPEN authority from the row alone', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const coordinator1 = new RiskAdmissionCoordinator();
    const kernelProcess1 = new PaperAccountKernel(prisma);
    const runtime1 = await kernelProcess1.startPaperAccountRuntime({ accountId, coordinator: coordinator1, prisma });
    const request = await buildRequest(accountId, PAIR, T0);
    const admitted = await runtime1.session.admitAndPersist(PAIR, request, coordinator1);
    expect(admitted.outcome).toBe('ADMITTED');
    if (admitted.outcome !== 'ADMITTED') return;

    // Restart before any OPEN execution occurs.
    const coordinator2 = new RiskAdmissionCoordinator();
    const kernelProcess2 = new PaperAccountKernel(prisma);
    const runtime2 = await kernelProcess2.startPaperAccountRuntime({ accountId, coordinator: coordinator2, prisma });

    const rehydrated = runtime2.position(PAIR);
    expect(rehydrated?.status).toBe('PENDING');
    if (rehydrated?.status !== 'PENDING') return;
    expect(rehydrated.admissionId).toBe(admitted.admission.admissionId);
    expect((rehydrated as unknown as Record<string, unknown>)['openAuthority']).toBeUndefined();

    // A new competing admission for the same pair sees the additive pending exposure and cannot claim the slot.
    const competingRequest = await buildRequest(accountId, PAIR, T0 + MINUTE);
    const competingResult = await runtime2.session.admitAndPersist(PAIR, competingRequest, coordinator2);
    expect(competingResult.outcome).toBe('PAIR_SLOT_UNAVAILABLE');
  });
});

describe('P14-G live-DB — closed lifecycle restart (§43)', () => {
  it('a slot that was OPEN then CLOSED before restart remains EMPTY, with unchanged history, after restart', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const { result: planResult } = await genuineResearchApproval();
    const kernel1 = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel1, T0);
    const coordinator1 = new RiskAdmissionCoordinator();
    const openContext = buildContext(kernel1, openDecision);
    const session1 = await openPaperAccountSession({ accountId, coordinator: coordinator1, prisma });
    const admitted = await session1.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: openContext }, coordinator1);
    if (admitted.outcome !== 'ADMITTED') throw new Error('setup failed');
    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator: coordinator1, accountId, kernel: kernel1, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    if (openAuthority === null) throw new Error('setup failed');
    const openNowMs = T0 + 500;
    const openResult = await session1.executeOpen(openAuthority, {
      evidence: trust(buildQuote(PAIR, '99', '99.5', openNowMs - 100), buildDepth(buildQuote(PAIR, '99', '99.5', openNowMs - 100), '1000000', '1000000'), buildConversion('80', openNowMs)),
      instrumentEconomics: INSTRUMENT_ECONOMICS, executionPolicy: EXECUTION_POLICY, nowMs: openNowMs,
    }, coordinator1);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    const positionAfterOpen = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const closeDecision = evaluateDecision(kernel1, T0 + MINUTE, 'FLAT');
    const closeContext = buildContext(kernel1, closeDecision, { pairSnapshot: openPairSnapshotFor(kernel1, openResult.quantity, closeDecision.evaluationTimeMs) });
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator: coordinator1, accountId, kernel: kernel1, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      policy: policyFor(PAIR), evidence: evidenceFrom(closeContext),
      position: {
        positionInstanceId: openResult.positionInstanceId, positionRevision: positionAfterOpen.revision,
        ownerStrategyInstanceId: kernel1.strategyInstanceId, ownerStrategyId: kernel1.strategyId,
        ownerStrategyVersion: kernel1.strategyVersion, ownerParameterHash: kernel1.parameterHash, ownedQuantity: openResult.quantity,
      },
    });
    if (closeAuthority === null) throw new Error('setup failed');
    const closeNowMs = T0 + MINUTE + 500;
    const closeQuote = buildQuote(PAIR, '110', '112', closeNowMs - 100);
    const closeResult = await session1.executeClose(closeAuthority, {
      evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', closeNowMs)),
       executionPolicy: EXECUTION_POLICY, nowMs: closeNowMs,
    });
    if (closeResult.outcome !== 'CLOSED') throw new Error('setup failed');

    const historyBefore = await prisma.paperPositionOwnershipHistory.findUniqueOrThrow({ where: { positionInstanceId: openResult.positionInstanceId } });

    // Restart.
    const coordinator2 = new RiskAdmissionCoordinator();
    const kernelProcess2 = new PaperAccountKernel(prisma);
    const runtime2 = await kernelProcess2.startPaperAccountRuntime({ accountId, coordinator: coordinator2, prisma });

    expect(runtime2.position(PAIR)).toMatchObject({ status: 'EMPTY', pair: PAIR });
    const historyAfter = await prisma.paperPositionOwnershipHistory.findUniqueOrThrow({ where: { positionInstanceId: openResult.positionInstanceId } });
    expect(historyAfter).toEqual(historyBefore);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(2);
  }, 60_000);
});

describe('P14-G live-DB — released reservation restart (§39)', () => {
  it('a durable RELEASED reservation does not restore as pending exposure, but the sequence watermark survives', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const request: AdmissionRequest = { accountId, policy: policyFor(PAIR), context: buildContext(kernel, decision) };

    const coordinator1 = new RiskAdmissionCoordinator();
    const session1 = await openPaperAccountSession({ accountId, coordinator: coordinator1, prisma });
    const admitted = await session1.admitAndPersist(PAIR, request, coordinator1);
    if (admitted.outcome !== 'ADMITTED') throw new Error('setup failed');
    const released = await session1.releaseAndPersist(admitted.admission.admissionId, coordinator1);
    expect(released).toBe('RELEASED');

    const coordinator2 = new RiskAdmissionCoordinator();
    const kernelProcess2 = new PaperAccountKernel(prisma);
    const runtime2 = await kernelProcess2.startPaperAccountRuntime({ accountId, coordinator: coordinator2, prisma });
    expect(runtime2.position(PAIR)).toMatchObject({ status: 'EMPTY', pair: PAIR });
    expect(runtime2.restoreResult.restoredReservationCount).toBe(0);
    expect(runtime2.restoreResult.restoredWatermarkCount).toBe(1); // watermark preserved even though not currently pending
  });
});

describe('F14-04 correction — released generation history survives restart (§4)', () => {
  it('a retry of the same unfilled source decision after restart allocates generation 2, leaves the generation-1 row RELEASED, and proceeds to exactly one eventual fill', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, T0);
    const request: AdmissionRequest = { accountId, policy: policyFor(PAIR), context: buildContext(kernel, decision) };

    // --- Process 1: admit generation 1, release without fill ---
    const coordinator1 = new RiskAdmissionCoordinator();
    const session1 = await openPaperAccountSession({ accountId, coordinator: coordinator1, prisma });
    const admittedGen1 = await session1.admitAndPersist(PAIR, request, coordinator1);
    if (admittedGen1.outcome !== 'ADMITTED') throw new Error('setup failed');
    expect(admittedGen1.admission.generation).toBe(1);
    const releasedGen1 = await session1.releaseAndPersist(admittedGen1.admission.admissionId, coordinator1);
    expect(releasedGen1).toBe('RELEASED');

    // --- Destroy all process-local coordinator/session state; fresh coordinator/kernel restore ---
    const coordinator2 = new RiskAdmissionCoordinator();
    const kernelProcess2 = new PaperAccountKernel(prisma);
    const runtime2 = await kernelProcess2.startPaperAccountRuntime({ accountId, coordinator: coordinator2, prisma });
    expect(runtime2.position(PAIR)).toMatchObject({ status: 'EMPTY', pair: PAIR });

    // --- Retry the SAME (unfilled) source decision through the restored runtime ---
    const admittedGen2 = await runtime2.session.admitAndPersist(PAIR, request, coordinator2);
    if (admittedGen2.outcome !== 'ADMITTED') throw new Error('retry admission failed');
    expect(admittedGen2.admission.generation).toBe(2); // never reuses generation 1, even though restore() never restores a RELEASED row as pending exposure
    expect(admittedGen2.admission.sourceStrategyDecisionId).toBe(admittedGen1.admission.sourceStrategyDecisionId);
    expect(admittedGen2.admission.admissionId).not.toBe(admittedGen1.admission.admissionId);

    const slotAfterRetryAdmission = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(slotAfterRetryAdmission.status).toBe('PENDING');
    expect(slotAfterRetryAdmission.admissionId).toBe(admittedGen2.admission.admissionId);

    const gen1RowAfterRetry = await prisma.paperReservation.findUniqueOrThrow({ where: { admissionId: admittedGen1.admission.admissionId } });
    expect(gen1RowAfterRetry.status).toBe('RELEASED');
    expect(gen1RowAfterRetry.generation).toBe(1);

    // --- OPEN may proceed through the normal path; exactly one eventual fill ---
    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator: coordinator2, accountId, kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(request.context),
    });
    expect(openAuthority).not.toBeNull();
    if (openAuthority === null) return;
    const openNowMs = T0 + 500;
    const openQuote = buildQuote(PAIR, '99', '99.5', openNowMs - 100);
    const openDepth = buildDepth(openQuote, '1000000', '1000000');
    const openResult = await runtime2.session.executeOpen(openAuthority, {
      evidence: trust(openQuote, openDepth, buildConversion('80', openNowMs)), instrumentEconomics: INSTRUMENT_ECONOMICS,
      executionPolicy: EXECUTION_POLICY, nowMs: openNowMs,
    }, coordinator2);
    expect(openResult.outcome).toBe('FILLED');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);

    // --- Terminal retry after fill can never generate a second economic fill ---
    const retryAfterFill = await runtime2.session.admitAndPersist(PAIR, request, coordinator2);
    expect(retryAfterFill.outcome).toBe('SOURCE_DECISION_ALREADY_EXECUTED');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
  }, 60_000);
});

describe('P14-G live-DB — funding invariant restart (§45/§68)', () => {
  it('startup fails before READY when durable funding facts are non-zero, and never repairs them', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFundingInr: '1' } });

    const kernel = new PaperAccountKernel(prisma);
    await expect(kernel.startPaperAccountRuntime({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma })).rejects.toMatchObject({
      code: 'FUNDING_INVARIANT_VIOLATION',
    });
    expect(kernel.getState(accountId)).toBe('FAULTED');
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).cumulativeFundingInr.toFixed()).toBe('1');
  });
});

describe('P14-G live-DB — partial/impossible structural state detection (§46)', () => {
  it('an OPEN pair slot with no terminal opening PaperFill fails closed as RECONCILIATION_REQUIRED, without repair', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);

    // Seed a structurally impossible OPEN slot directly (test setup only —
    // production code never writes an OPEN slot without a completed opening
    // fill; this proves P14-G detects the impossible case rather than
    // trusting a persisted row's mere existence, per V2.2 §35).
    await prisma.paperExecutionPolicySnapshot.create({
      data: {
        executionPolicySnapshotId: 'p'.repeat(64), policyVersion: 'P14_EXECUTION_POLICY_V1', fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
        maxEvidenceAgeMs: 5000, requiredHealthState: 'HEALTHY', takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT',
        tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1', quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001',
        currencyConversionPolicy: 'P14_INR_CONVERSION_V1', accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
      },
    });
    await prisma.paperReservation.create({
      data: {
        admissionId: 'a'.repeat(64), accountId, riskDecisionId: 'r'.repeat(64), sourceStrategyDecisionId: 'd'.repeat(64),
        strategyInstanceId: 'si-1', strategyId: 'strat-1', strategyVersion: 'v1', parameterHash: 'h'.repeat(64), pair: PAIR,
        decisionSequence: 1, direction: 'LONG', approvedNotionalInr: '100', approvedMarginInr: '10', generation: 1, status: 'CONSUMED',
      },
    });
    await prisma.paperExecutionIntent.create({
      data: {
        executionIntentId: 'i'.repeat(64), action: 'OPEN', accountId, pair: PAIR, strategyInstanceId: 'si-1', strategyId: 'strat-1',
        strategyVersion: 'v1', parameterHash: 'h'.repeat(64), riskDecisionId: 'r'.repeat(64), evaluationTimeMs: T0,
        executionPolicySnapshotId: 'p'.repeat(64), admissionId: 'a'.repeat(64),
      },
    });
    // Deliberately NO paperOrder / paperFill row — the OPEN slot below claims a completed opening that never actually occurred.
    await prisma.paperPosition.create({
      data: {
        accountId, pair: PAIR, status: 'OPEN', admissionId: 'a'.repeat(64), positionInstanceId: 'missing-fill-position',
        side: 'LONG', quantity: '1', averageEntryPriceInr: '100', leverage: '1', initialMarginInr: '10', openedAtMs: BigInt(T0),
        ownerStrategyInstanceId: 'si-1', ownerStrategyId: 'strat-1', ownerStrategyVersion: 'v1', ownerParameterHash: 'h'.repeat(64),
      },
    });

    const kernel = new PaperAccountKernel(prisma);
    await expect(kernel.startPaperAccountRuntime({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma })).rejects.toMatchObject({
      code: 'RECONCILIATION_REQUIRED',
    });
    expect(kernel.getState(accountId)).toBe('FAULTED');
    // No repair occurred — the impossible row is untouched.
    const slot = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(slot.status).toBe('OPEN');
    expect(await prisma.paperOrder.count({ where: { accountId } })).toBe(0);
  });
});

describe('P14-G live-DB — startup concurrency (§47/§32)', () => {
  it('two concurrent startPaperAccountRuntime calls for the same account in the same process join a single READY runtime', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();

    const [runtimeA, runtimeB] = await Promise.all([
      kernel.startPaperAccountRuntime({ accountId, coordinator, prisma }),
      kernel.startPaperAccountRuntime({ accountId, coordinator, prisma }),
    ]);
    expect(runtimeA).toBe(runtimeB); // identical instance — single-flight, not two independent starts
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(account.ownerFence).toBe(1n); // exactly one acquireOwnership call occurred
  });

  it('two different accounts start independently with no cross-account serialization', async () => {
    if (skip()) return;
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(accountA);
    await initAccount(accountB);
    const kernel = new PaperAccountKernel(prisma);
    const [runtimeA, runtimeB] = await Promise.all([
      kernel.startPaperAccountRuntime({ accountId: accountA, coordinator: new RiskAdmissionCoordinator(), prisma }),
      kernel.startPaperAccountRuntime({ accountId: accountB, coordinator: new RiskAdmissionCoordinator(), prisma }),
    ]);
    expect(runtimeA.accountId).toBe(accountA);
    expect(runtimeB.accountId).toBe(accountB);
    expect(runtimeA.state).toBe('READY');
    expect(runtimeB.state).toBe('READY');
  });
});

describe('P14-G live-DB — stale owner takeover (§44)', () => {
  it('a superseded runtime session fails closed on STALE_FENCE after a fresh kernel start takes over', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const kernelA = new PaperAccountKernel(prisma);
    const coordinatorA = new RiskAdmissionCoordinator();
    const runtimeA = await kernelA.startPaperAccountRuntime({ accountId, coordinator: coordinatorA, prisma });
    expect(runtimeA.state).toBe('READY');

    const kernelB = new PaperAccountKernel(prisma);
    const coordinatorB = new RiskAdmissionCoordinator();
    const runtimeB = await kernelB.startPaperAccountRuntime({ accountId, coordinator: coordinatorB, prisma });
    expect(runtimeB.ownerFence).toBeGreaterThan(runtimeA.ownerFence);

    const request = await buildRequest(accountId, PAIR, T0);
    await expect(runtimeA.session.admitAndPersist(PAIR, request, coordinatorA)).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(coordinatorA.isAccountFaulted(accountId)).toBe(false);
  });
});

describe('P14-G live-DB — crash during startup (§48)', () => {
  it('a failure injected after ownership acquisition returns no READY runtime and allows a fresh takeover', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);

    // Force P14-G's own post-session rehydration step to fail by seeding an
    // impossible EMPTY slot (admissionId set while status EMPTY) — ownership
    // has already been genuinely acquired by openPaperAccountSession by the
    // time this is detected.
    await prisma.paperPosition.create({ data: { accountId, pair: PAIR, status: 'EMPTY', admissionId: 'orphan-admission-id' } });

    const kernel = new PaperAccountKernel(prisma);
    await expect(kernel.startPaperAccountRuntime({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma })).rejects.toMatchObject({
      code: 'RECONCILIATION_REQUIRED',
    });
    expect(kernel.getState(accountId)).toBe('FAULTED');

    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(account.ownerFence).toBe(1n); // ownership was genuinely acquired despite the later failure

    // Fix the impossible row and prove a fresh startup can take over with a higher fence.
    await prisma.paperPosition.update({ where: { accountId_pair: { accountId, pair: PAIR } }, data: { admissionId: null } });
    const runtime = await kernel.startPaperAccountRuntime({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma });
    expect(runtime.state).toBe('READY');
    expect(runtime.ownerFence).toBe(2n);
  });
});

const POISON_PAIR = 'B-ETH_USDT';

/** Seeds a structurally impossible OPEN pair slot (no terminal opening PaperFill) for `pair` — mirrors the §46 test's own setup. */
async function seedImpossibleOpenSlot(accountId: string, pair: string): Promise<void> {
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
  const admissionId = sha256CanonicalJson({ poisonAdmissionFor: accountId, pair });
  const executionIntentId = sha256CanonicalJson({ poisonIntentFor: accountId, pair });
  const sourceStrategyDecisionId = sha256CanonicalJson({ poisonSourceDecisionFor: accountId, pair });
  await prisma.paperReservation.create({
    data: {
      admissionId, accountId, riskDecisionId: 'r'.repeat(64), sourceStrategyDecisionId,
      strategyInstanceId: 'si-poison', strategyId: 'strat-poison', strategyVersion: 'v1', parameterHash: 'h'.repeat(64), pair,
      decisionSequence: 1, direction: 'LONG', approvedNotionalInr: '100', approvedMarginInr: '10', generation: 1, status: 'CONSUMED',
    },
  });
  await prisma.paperExecutionIntent.create({
    data: {
      executionIntentId, action: 'OPEN', accountId, pair, strategyInstanceId: 'si-poison', strategyId: 'strat-poison',
      strategyVersion: 'v1', parameterHash: 'h'.repeat(64), riskDecisionId: 'r'.repeat(64), evaluationTimeMs: T0,
      executionPolicySnapshotId: 'p'.repeat(64), admissionId,
    },
  });
  // Deliberately NO paperOrder / paperFill row — the OPEN slot below claims a
  // completed opening that never actually occurred. `upsert` (not `create`)
  // because the pair slot may already exist as a pre-provisioned EMPTY row.
  const positionInstanceId = sha256CanonicalJson({ poisonPositionFor: accountId, pair });
  const openSlotData = {
    status: 'OPEN' as const, admissionId, positionInstanceId,
    side: 'LONG' as const, quantity: '1', averageEntryPriceInr: '100', leverage: '1', initialMarginInr: '10', openedAtMs: BigInt(T0),
    ownerStrategyInstanceId: 'si-poison', ownerStrategyId: 'strat-poison', ownerStrategyVersion: 'v1', ownerParameterHash: 'h'.repeat(64),
  };
  await prisma.paperPosition.upsert({
    where: { accountId_pair: { accountId, pair } },
    create: { accountId, pair, ...openSlotData },
    update: openSlotData,
  });
}

describe('P14-G-MAJ-01 correction — post-C3 rehydration failure faults the coordinator', () => {
  it('exact reproduction: faults the coordinator on structural failure after C3 restore, then an authoritative retry with the SAME coordinator succeeds once the defect is fixed (§7)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await provisionPairSlot(accountId, POISON_PAIR);

    // 1. Durable admission history that genuinely restores C3 in-memory state on the next startup.
    const genuineRequest = await buildRequest(accountId, PAIR, T0);
    const seedingCoordinator = new RiskAdmissionCoordinator();
    const seedingSession = await openPaperAccountSession({ accountId, coordinator: seedingCoordinator, prisma });
    const admitted = await seedingSession.admitAndPersist(PAIR, genuineRequest, seedingCoordinator);
    expect(admitted.outcome).toBe('ADMITTED');
    seedingSession.release();

    // 2. Seed the structural P14-G defect that will fail rehydration AFTER C3 restore commits.
    await seedImpossibleOpenSlot(accountId, POISON_PAIR);

    // 3/4/5/6. Call startPaperAccountRuntime — rejects with the original structural error, not a generic fault code.
    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    await expect(kernel.startPaperAccountRuntime({ accountId, coordinator, prisma })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(kernel.getState(accountId)).toBe('FAULTED');
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);

    // 8. Fix ONLY the structural DB defect.
    await prisma.paperPosition.update({
      where: { accountId_pair: { accountId, pair: POISON_PAIR } },
      data: { status: 'EMPTY', admissionId: null, positionInstanceId: null, side: null, quantity: null, averageEntryPriceInr: null, leverage: null, initialMarginInr: null, openedAtMs: null, ownerStrategyInstanceId: null, ownerStrategyId: null, ownerStrategyVersion: null, ownerParameterHash: null },
    });

    // 9/10. Retry using the SAME coordinator — must take the authoritative restore path and succeed.
    const runtime = await kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });
    expect(runtime.state).toBe('READY');

    // 11. Fault cleared according to frozen P14-D behavior.
    expect(coordinator.isAccountFaulted(accountId)).toBe(false);
    expect(runtime.restoreResult.recoveredFromFault).toBe(true);

    // 12. Restored pending/watermark state equals durable truth: the genuine PENDING admission on PAIR is still there.
    expect(runtime.restoreResult.restoredReservationCount).toBe(1);
    expect(runtime.position(PAIR)).toMatchObject({ status: 'PENDING' });
    expect(runtime.position(POISON_PAIR)).toMatchObject({ status: 'EMPTY' });
  }, 60_000);

  it('blocks direct coordinator use for the faulted account after a failed post-C3 startup, before an authoritative retry (§8)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, POISON_PAIR);
    await seedImpossibleOpenSlot(accountId, POISON_PAIR);

    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    await expect(kernel.startPaperAccountRuntime({ accountId, coordinator, prisma })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);

    const request = await buildRequest(accountId, PAIR, T0);
    await expect(coordinator.admit(request)).rejects.toThrow(/FAULTED/);
  });

  it('faulting account A never faults or clears account B on the same coordinator (§9)', async () => {
    if (skip()) return;
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(accountA);
    await initAccount(accountB);
    await provisionPairSlot(accountA, POISON_PAIR);
    await provisionPairSlot(accountB, PAIR);
    await seedImpossibleOpenSlot(accountA, POISON_PAIR);

    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    await expect(kernel.startPaperAccountRuntime({ accountId: accountA, coordinator, prisma })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(coordinator.isAccountFaulted(accountA)).toBe(true);
    expect(coordinator.isAccountFaulted(accountB)).toBe(false);

    const runtimeB = await kernel.startPaperAccountRuntime({ accountId: accountB, coordinator, prisma });
    expect(runtimeB.state).toBe('READY');
    expect(coordinator.isAccountFaulted(accountB)).toBe(false);
  });
});

describe('P14-G-MAJ-02 correction — repeated start of an already-READY account is idempotent', () => {
  it('a repeated start returns the same runtime with zero DB mutation (§18)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();

    const runtime1 = await kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });
    const accountAfterFirst = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const fenceAfterFirst = accountAfterFirst.ownerFence;
    const revisionAfterFirst = accountAfterFirst.revision;

    const runtime2 = await kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });

    expect(runtime2).toBe(runtime1);
    expect(runtime2.session).toBe(runtime1.session);
    expect(kernel.getState(accountId)).toBe('READY');

    const accountAfterSecond = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(accountAfterSecond.ownerFence).toBe(fenceAfterFirst);
    expect(accountAfterSecond.revision).toBe(revisionAfterFirst);

    // The original runtime's session remains usable — no DURABLE_CONFLICT, no invalidation.
    const request = await buildRequest(accountId, PAIR, T0);
    const result = await runtime1.session.admitAndPersist(PAIR, request, coordinator);
    expect(result.outcome).toBe('ADMITTED');
  });

  it('many repeated starts after READY all resolve to the same runtime with no further ownership acquisition (§19)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();

    const first = await kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });
    const fence = (await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).ownerFence;

    for (let i = 0; i < 5; i += 1) {
      const repeated = await kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });
      expect(repeated).toBe(first);
    }
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).ownerFence).toBe(fence);
  });

  it('a later call arriving right after READY resolves joins the cache, never a second in-flight startup (§20)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();

    const firstStartPromise = kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });
    const [firstResult, secondResult] = await Promise.all([
      firstStartPromise,
      firstStartPromise.then((runtime) => kernel.startPaperAccountRuntime({ accountId, coordinator, prisma }).then(() => runtime)),
    ]);
    expect(secondResult).toBe(firstResult);

    const laterCall = await kernel.startPaperAccountRuntime({ accountId, coordinator, prisma });
    expect(laterCall).toBe(firstResult);
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).ownerFence).toBe(1n);
  });

  it('a failed startup never caches a READY runtime — a subsequent successful start is not short-circuited (§15/§21)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFundingInr: '1' } });
    const kernel = new PaperAccountKernel(prisma);
    const coordinator = new RiskAdmissionCoordinator();

    await expect(kernel.startPaperAccountRuntime({ accountId, coordinator, prisma })).rejects.toMatchObject({ code: 'FUNDING_INVARIANT_VIOLATION' });
    expect(kernel.getState(accountId)).toBe('FAULTED');

    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFundingInr: '0' } });
    const runtime = await kernel.startPaperAccountRuntime({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma });
    expect(runtime.state).toBe('READY');
  });
});

describe('P14-G live-DB — READY gate (§66)', () => {
  it('no usable runtime/session is observable until startPaperAccountRuntime resolves', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const kernel = new PaperAccountKernel(prisma);
    const startPromise = kernel.startPaperAccountRuntime({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma });
    // Nothing usable is reachable through the kernel while startup is in flight — only a diagnostic state string.
    expect(['ACQUIRING_OWNERSHIP', 'RESTORING_RUNTIME']).toContain(kernel.getState(accountId));
    const runtime = await startPromise;
    expect(runtime.state).toBe('READY');
    expect(kernel.getState(accountId)).toBe('READY');
  });
});

describe('P14-G live-DB — P14-F promotion guard regression (§55)', () => {
  it('a successful P14-G restart does not treat READY as production promotion evidence', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    const kernel = new PaperAccountKernel(prisma);
    const runtime = await kernel.startPaperAccountRuntime({ accountId, coordinator: new RiskAdmissionCoordinator(), prisma });
    expect(runtime.state).toBe('READY');
    const { isPaperFundingProductionPromotionEvidence } = await import('../../../src/execution/funding-capability');
    expect(isPaperFundingProductionPromotionEvidence()).toBe(false);
  });
});

describe('F14-06 correction — CLOSE stale account revision race', () => {
  it('a stale expectedRevision rejects CLOSE before any economic mutation (same ownerFence — revision alone protects)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    const PAIR2 = 'B-ETH_USDT';
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await provisionPairSlot(accountId, PAIR2);
    const { result: planResult } = await genuineResearchApproval();

    const coordinator = new RiskAdmissionCoordinator();
    const session = (await new PaperAccountKernel(prisma).startPaperAccountRuntime({ accountId, coordinator, prisma })).session;

    // --- Genuine OPEN on PAIR ---
    const kernel = makeKernel(PAIR);
    const openDecision = evaluateDecision(kernel, T0);
    const openContext = buildContext(kernel, openDecision);
    const admitted = await session.admitAndPersist(PAIR, { accountId, policy: policyFor(PAIR), context: openContext }, coordinator);
    if (admitted.outcome !== 'ADMITTED') throw new Error('setup failed');
    const openAuthority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId, kernel, decision: openDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      planResult, policy: policyFor(PAIR), evidence: evidenceFrom(openContext),
    });
    if (openAuthority === null) throw new Error('setup failed');
    const openNowMs = T0 + 500;
    const openQuote = buildQuote(PAIR, '99', '99.5', openNowMs - 100);
    const openResult = await session.executeOpen(openAuthority, {
      evidence: trust(openQuote, buildDepth(openQuote, '1000000', '1000000'), buildConversion('80', openNowMs)),
      instrumentEconomics: INSTRUMENT_ECONOMICS, executionPolicy: EXECUTION_POLICY, nowMs: openNowMs,
    }, coordinator);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    const staleRevision = (await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).revision; // "HEALTHY observed at revision R"

    // A second, unrelated same-account mutation (same ownerFence) advances revision to R+1.
    const kernel2 = makeKernel(PAIR2);
    const decision2 = evaluateDecision(kernel2, T0);
    const admitted2 = await session.admitAndPersist(PAIR2, { accountId, policy: policyFor(PAIR2), context: buildContext(kernel2, decision2) }, coordinator);
    if (admitted2.outcome !== 'ADMITTED') throw new Error('setup failed');
    expect(admitted2.accountRevision).toBe(staleRevision + 1n);

    // Genuine fresh CLOSE authority for the OPEN position, deliberately bound to the STALE revision.
    const closeDecision = evaluateDecision(kernel, T0 + MINUTE, 'FLAT');
    const closeContext = buildContext(kernel, closeDecision, { pairSnapshot: openPairSnapshotFor(kernel, openResult.quantity, closeDecision.evaluationTimeMs) });
    const positionAfterOpen = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const positionBinding: PaperClosePositionBinding = {
      positionInstanceId: openResult.positionInstanceId, positionRevision: positionAfterOpen.revision,
      ownerStrategyInstanceId: kernel.strategyInstanceId, ownerStrategyId: kernel.strategyId,
      ownerStrategyVersion: kernel.strategyVersion, ownerParameterHash: kernel.parameterHash, ownedQuantity: openResult.quantity,
    };
    const closeAuthority = await mintPaperCloseExecutionAuthority({
      coordinator, accountId, kernel, decision: closeDecision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID,
      policy: policyFor(PAIR), evidence: evidenceFrom(closeContext), position: positionBinding,
    });
    if (closeAuthority === null) throw new Error('setup failed');
    const closeNowMs = T0 + MINUTE + 500;
    const closeQuote = buildQuote(PAIR, '110', '112', closeNowMs - 100);

    await expect(session.executeClose(closeAuthority, {
      evidence: trust(closeQuote, buildDepth(closeQuote, '1000000', '1000000'), buildConversion('80', closeNowMs)),
       executionPolicy: EXECUTION_POLICY, nowMs: closeNowMs,
    }, staleRevision)).rejects.toMatchObject({ code: 'STALE_ACCOUNT_REVISION' });

    const positionAfterRejectedClose = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfterRejectedClose.status).toBe('OPEN'); // no economic mutation occurred
    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR } })).toBe(1); // only the original OPEN fill
  }, 60_000);
});
