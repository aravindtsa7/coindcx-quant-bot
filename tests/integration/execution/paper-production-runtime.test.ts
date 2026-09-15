import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import { buildExecutionPolicySnapshot, EXECUTION_POLICY_VERSION, paperDecimal, type ExecutionPolicySnapshot } from '../../../src/execution';
import { PaperAccountReconciler } from '../../../src/execution/persistence/paper-account-reconciler';
import { PaperAccountRepository } from '../../../src/execution/persistence/account-repository';
import {
  deriveMarkToMarketRiskInput, loadAuthoritativePaperRiskBase,
  type AuthoritativePaperRiskBase, type AuthoritativePaperRiskInput,
} from '../../../src/execution/persistence/authoritative-risk-input';
import { CoinDcxPaperEvidence, type PaperEvidenceInstrument } from '../../../src/integration/coindcx/paper-evidence';
import { FakeCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';
import {
  PaperAccountProductionComposer, PaperProductionRuntimeError, type ProductionCloseParams, type ProductionOpenParams,
} from '../../../src/integration/coindcx/paper-production-runtime';
import { assertProductionLifecycleTransitionAuthorized } from '../../../src/coin-runtime/lifecycle';
import { CoinLifecycleError } from '../../../src/core/errors/app-error';
import { evaluateDecision, genuineResearchApproval, makeKernel, PAIR, policyFor, productionRiskRequest } from '../../unit/dispatch/helpers';
import { PRODUCTION_ACQUISITION_CAPABILITY } from '../../../src/integration/coindcx/acquisition-capability';
import { TrustedProductionInstrumentBinding } from '../../../src/integration/coindcx/instrument-authority';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';
import { makeAccount, makePair, seal } from '../../unit/risk/helpers';
import { wire as instrumentWire } from '../../unit/coindcx/audit-a2-helpers';
import type { CanonicalPositionValuation, PairRiskSnapshot } from '../../../src/risk';
import type { StrategyKernel } from '../../../src/strategies';

// P14-I live-DB production composition suite â€” mirrors the exact P14-D/E/G/H
// disposable shadow-database pattern. Every test is skipped, not failed, if
// no local MySQL is reachable.

const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p14i_test_${randomBytes(6).toString('hex')}`;

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
  vi.spyOn(CoinDcxTransport.prototype, 'executeRead').mockImplementation(async (options) => {
    const pair = String(options.queryParams?.['pair'] ?? PAIR);
    const underlying = pair === PAIR_B ? 'ETH' : 'BTC';
    return {
      status: 200, headers: {}, durationMs: 0,
      data: { instrument: instrumentWire(underlying, { unit_contract_value: '0.001', price_increment: '1', quantity_increment: '1' }) },
    } as never;
  });
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
  if (!dbAvailable) console.warn('P14-I live-DB suite skipped: no reachable disposable MySQL environment (see beforeAll).');
  return !dbAvailable;
}

let accountCounter = 0;
function freshAccountId(): string { accountCounter += 1; return `p14i-account-${accountCounter}`; }

async function initAccount(accountId: string, capital = '1000000'): Promise<void> {
  await new PaperAccountRepository(prisma).ensureAccountInitialized(accountId, capital);
}
async function provisionPairSlot(accountId: string, pair: string): Promise<void> {
  await prisma.paperPosition.upsert({ where: { accountId_pair: { accountId, pair } }, create: { accountId, pair, status: 'EMPTY' }, update: {} });
}

const INSTRUMENT_SPEC_SNAPSHOT_ID = 'instrument-1';
const T0 = 1_200_000;
const MINUTE = 60_000;

const EXECUTION_POLICY: ExecutionPolicySnapshot = buildExecutionPolicySnapshot({
  policyVersion: EXECUTION_POLICY_VERSION,
  fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
  marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 30_000, requiredHealthState: 'HEALTHY' },
  takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT', tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1',
  quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001', currencyConversionPolicy: 'P14_INR_CONVERSION_V1',
  accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
});

const WALL_CLOCK = { nowMs: () => Date.now() };
const PROVIDER_SYMBOL = 'BTCUSDT';
/** [F14-01] A second genuinely research-approved pair — a multi-pair account is the only way to hold an OPEN position while opening elsewhere. */
const PAIR_B = 'B-ETH_USDT';
const PROVIDER_SYMBOL_B = 'ETHUSDT';
/** The conversion rate every fixture feeds, so `markPriceInr = markPriceUsdt × 80` exactly mirrors P14-E's own `fillPriceInr`. */
const CONVERSION_RATE = '80';
const PROVIDER_INSTRUMENTS: readonly PaperEvidenceInstrument[] = Object.freeze([
  Object.freeze({ pair: PAIR, underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID }),
  Object.freeze({ pair: PAIR_B, underlying: 'ETH', quoteCurrency: 'USDT', instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID }),
]);

/**
 * [F14-02] A provider whose injected clock/socket seams are re-blessed as an
 * approved acquisition path by the module-private, non-barrel
 * `PRODUCTION_ACQUISITION_CAPABILITY` â€” the sanctioned zero-network
 * "internal acquisition harness" route (Â§15/Â§20). A production caller going
 * through the public barrel cannot obtain this capability, so it cannot
 * reproduce this provider.
 */
function makeProvider(): CoinDcxPaperEvidence {
  return new CoinDcxPaperEvidence({
    instruments: PROVIDER_INSTRUMENTS, clock: WALL_CLOCK, socketFactory: new FakeCoinDcxSocketFactory(),
    policy: { orderbookFreshnessMs: 30_000, markFreshnessMs: 30_000, conversionLocalPollFreshnessMs: 60_000, allowedProviderFutureSkewMs: 5_000 },
    acquisitionCapability: PRODUCTION_ACQUISITION_CAPABILITY,
  });
}

function bookPayload(nowMs: number, bid: string, ask: string, version = '1', symbol = PROVIDER_SYMBOL) {
  return { event: 'depth-snapshot', data: JSON.stringify({ type: 'depth-snapshot', pr: 'futures', s: symbol, ts: String(nowMs), vs: version, bids: [[bid, '1000000']], asks: [[ask, '1000000']] }) };
}
function conversionPayload(rate: string, nowMs: number) {
  return [{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: rate, last_updated_at: String(nowMs) }];
}

function markPayload(nowMs: number, btcMark: string, ethMark = '50') {
  return {
    event: 'currentPrices@futures#update',
    data: JSON.stringify({
      ts: String(nowMs), vs: '1',
      [PROVIDER_SYMBOL]: { mp: btcMark, bmST: String(nowMs) },
      [PROVIDER_SYMBOL_B]: { mp: ethMark, bmST: String(nowMs) },
    }),
  };
}

function feedFreshEvidenceForPair(
  provider: CoinDcxPaperEvidence, pair: string, bid: string, ask: string,
  conversionRate = '80', nowMs = Date.now(), btcMark = bid, ethMark = bid,
): void {
  const generation = provider.startOrderbookWebSocket();
  // [F14-02] Supplying the acquisition capability is what makes this stand in
  // for the approved CoinDCX WS/conversion acquisition path; the identical
  // calls WITHOUT it produce caller-supplied data that can never be minted.
  const symbol = pair === PAIR_B ? PROVIDER_SYMBOL_B : PROVIDER_SYMBOL;
  const bookResult = provider.ingestOrderbookWebSocket(bookPayload(nowMs, bid, ask, '1', symbol), generation, pair, PRODUCTION_ACQUISITION_CAPABILITY);
  if (!bookResult.accepted) throw new Error(`test setup: orderbook ingest rejected: ${bookResult.reason}`);
  const conversionResult = provider.ingestConversionRest(conversionPayload(conversionRate, nowMs), PRODUCTION_ACQUISITION_CAPABILITY);
  if (!conversionResult.accepted) throw new Error(`test setup: conversion ingest rejected: ${conversionResult.reason}`);
  const markGeneration = provider.startMarkWebSocket();
  const markResult = provider.ingestMarkWebSocket(markPayload(nowMs, btcMark, ethMark), markGeneration, PRODUCTION_ACQUISITION_CAPABILITY);
  if (!markResult.accepted) throw new Error(`test setup: mark ingest rejected: ${markResult.reason}`);
}

/** Feeds fresh production-provenance BTC execution evidence plus both configured marks and conversion. */
function feedFreshEvidence(provider: CoinDcxPaperEvidence, bid = '99', ask = '99.5', conversionRate = '80', nowMs = Date.now()): void {
  feedFreshEvidenceForPair(provider, PAIR, bid, ask, conversionRate, nowMs, bid, '50');
}

function buildOpenParamsForPair(
  accountId: string, pair: string, overrides: Partial<ProductionOpenParams> = {}, evaluationTimeMs = T0,
  target: 'LONG' | 'SHORT' = 'LONG',
): Promise<ProductionOpenParams> {
  return (async () => {
    const { result: planResult } = await genuineResearchApproval(pair);
    const kernel = makeKernel(pair);
    const decision = evaluateDecision(kernel, evaluationTimeMs, target);
    return {
      kernel, decision, planResult, policy: policyFor(pair),
      // [F14-01] Only the non-authoritative half â€” P14-I derives the account
      // and exposure snapshots from durable state under the current revision.
      riskRequest: productionRiskRequest(kernel, decision, accountId),
      executionPolicy: EXECUTION_POLICY,
      ...overrides,
    };
  })();
}

function buildOpenParams(accountId: string, overrides: Partial<ProductionOpenParams> = {}, evaluationTimeMs = T0): Promise<ProductionOpenParams> {
  return buildOpenParamsForPair(accountId, PAIR, overrides, evaluationTimeMs);
}
// A CLOSE decision's risk context must present an OPEN, reconciled-ownership
// pair snapshot (RiskEngine cross-verifies notional = quantity * unitValuation)
// â€” never the default EMPTY-position snapshot `buildContext` supplies for OPEN
// requests. Mirrors `tests/integration/execution/paper-account-reconciler.test.ts`'s
// own `openPairSnapshotFor` helper exactly.
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
function openPairSnapshotFor(kernel: StrategyKernel, accountId: string, ownedQuantity: string, evaluationTimeMs: number, side: 'LONG' | 'SHORT' = 'LONG'): PairRiskSnapshot {
  const base = makePair();
  return seal({
    ...base, pair: kernel.pair, provenance: { ...base.provenance, sourceTimeMs: evaluationTimeMs, observedAtMs: evaluationTimeMs },
    position: { state: 'OPEN', positionId: 'exchange-position-1', positionDirection: side, quantityMagnitude: ownedQuantity, valuation: valuation(evaluationTimeMs, ownedQuantity) },
    ownership: {
      status: 'RECONCILED', positionState: 'OPEN', accountId, pair: kernel.pair, positionId: 'exchange-position-1',
      instanceOwnership: [{
        strategyInstanceId: kernel.strategyInstanceId, strategyId: kernel.strategyId, strategyVersion: kernel.strategyVersion,
        parameterHash: kernel.parameterHash, currentQuantity: ownedQuantity, currentNotionalInr: notionalFor(ownedQuantity),
      }],
    },
  });
}

function buildCloseParams(kernel: StrategyKernel, accountId: string, ownedQuantity: string, overrides: Partial<ProductionCloseParams> = {}, evaluationTimeMs = T0 + MINUTE): ProductionCloseParams {
  const decision = evaluateDecision(kernel, evaluationTimeMs, 'FLAT');
  return {
    kernel, decision, policy: policyFor(PAIR),
    riskRequest: productionRiskRequest(kernel, decision, accountId, { pairSnapshot: openPairSnapshotFor(kernel, accountId, ownedQuantity, decision.evaluationTimeMs) }),
    executionPolicy: EXECUTION_POLICY,
    ...overrides,
  };
}

describe('P14-I live-DB â€” clean startup (Â§74)', () => {
  it('an empty healthy account reaches production READY with no economic mutation during startup', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: makeProvider() });

    expect(runtime.state).toBe('READY');
    expect(composer.getState(accountId)).toBe('READY');
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(account.revision).toBe(1n); // only the ownership-acquisition bump
  });

  it('the READY production composition can acquire a genuine pair-only instrument binding outside economics', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const runtime = await new PaperAccountProductionComposer({ prisma }).start({
      accountId, coordinator: new RiskAdmissionCoordinator(), provider: makeProvider(),
    });
    const binding = await runtime.acquireInstrumentBinding(PAIR);
    expect(TrustedProductionInstrumentBinding.read(binding)).toMatchObject({
      pair: PAIR, contractMultiplier: '0.001', priceIncrement: '1', quantityIncrement: '1',
    });
    expect(await prisma.paperExecutionIntent.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId } })).toBe(0);
  });
});

describe('P14-I live-DB â€” unhealthy startup (Â§75)', () => {
  it('a tampered account fails closed at startup and exposes no production mutation facade', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFundingInr: '1' } });

    const composer = new PaperAccountProductionComposer({ prisma });
    await expect(composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: makeProvider() }))
      .rejects.toMatchObject({ code: 'FUNDING_INVARIANT_VIOLATION' }); // P14-G itself already fails closed before P14-I's own reconciliation even runs
    expect(composer.getState(accountId)).toBe('NOT_READY');
  });

  it('a P14-H-only structural mismatch (P14-G starts fine) is NOT_READY with RECONCILIATION_UNHEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    // Tamper a durable projection that P14-G's own structural checks do not
    // inspect (account cumulative fee vs ledger) but P14-H does.
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFeesInr: '1' } });

    const composer = new PaperAccountProductionComposer({ prisma });
    await expect(composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: makeProvider() }))
      .rejects.toMatchObject({ code: 'RECONCILIATION_UNHEALTHY' });
    expect(composer.getState(accountId)).toBe('NOT_READY');
    expect(await prisma.paperReconciliationFault.count({ where: { accountId } })).toBe(1);
  });
});

describe('P14-I live-DB â€” OPEN end-to-end (Â§47/Â§52)', () => {
  it('a genuine research-approved decision produces exactly one fill and correct durable state through the public P14-I path', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams(accountId);
    const result = await runtime.executeOpen(openParams);
    expect(result.outcome).toBe('FILLED');
    expect(result).toMatchObject({ fundingDisclosure: { fundingCapability: 'FUNDING_UNSUPPORTED', fundingApplied: false, economicCompleteness: 'FUNDING_EXCLUDED' } });
    if (result.outcome !== 'FILLED') return;

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('OPEN');
    expect(position.positionInstanceId).toBe(result.positionInstanceId);
    const intent = await prisma.paperExecutionIntent.findUniqueOrThrow({ where: { executionIntentId: result.executionIntentId } });
    expect(intent.instrumentEconomicsSnapshotId).not.toBeNull();
    const economics = await prisma.paperInstrumentEconomicsSnapshot.findUniqueOrThrow({ where: { instrumentEconomicsSnapshotId: intent.instrumentEconomicsSnapshotId! } });
    expect(economics.pair).toBe(PAIR);
    expect(economics.contractMultiplier.toFixed()).toBe('0.001');
    expect(economics.priceIncrement.toFixed()).toBe('1');
    expect(economics.quantityIncrement.toFixed()).toBe('1');
    expect(economics.instrumentSpecSnapshotId).not.toBe(INSTRUMENT_SPEC_SNAPSHOT_ID); // caller/provider structural id never selects authority

    // Â§52: retrying the exact same source decision through P14-I is idempotent.
    const retryResult = await runtime.executeOpen(openParams);
    expect(retryResult.outcome).toBe('SOURCE_DECISION_ALREADY_EXECUTED');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
    const accountAfterRetry = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const accountAfterFirst = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(accountAfterRetry.cumulativeFeesInr.toFixed()).toBe(accountAfterFirst.cumulativeFeesInr.toFixed());
  }, 30_000);
});

describe('P14-I live-DB â€” forged OPEN input (Â§48)', () => {
  it('a structurally forged StrategyDecision is rejected with zero economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const genuineParams = await buildOpenParams(accountId);
    const forgedDecision = { ...genuineParams.decision, decisionId: 'forged-decision-id-does-not-match-hash' };
    const forgedParams: ProductionOpenParams = { ...genuineParams, decision: forgedDecision };

    // The forged object is rejected by the genuine trusted risk/strategy
    // layer itself (a structurally forged decision fails an existing
    // validation deep in RiskEngine/authorizeStrategyDispatch) â€” P14-I never
    // masks or swallows that rejection into a generic code (Â§46); the exact
    // meaningful lower-layer error propagates untouched.
    await expect(runtime.executeOpen(forgedParams)).rejects.toThrow();
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('EMPTY');
  }, 30_000);
});

describe('P14-I live-DB â€” OPEN provider failure (Â§49)', () => {
  it('valid admission but no available market evidence yields EVIDENCE_UNAVAILABLE with zero economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider(); // never fed â€” no evidence available

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams(accountId);
    await expect(runtime.executeOpen(openParams)).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    // The durable admission reservation IS created before the evidence check (existing, unweakened P14-D contract) â€” the pair slot is legitimately PENDING, not repaired/rolled back by P14-I.
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('PENDING');
    expect(await prisma.paperReservation.count({ where: { accountId, status: 'ADMITTED' } })).toBe(1);
  }, 30_000);
});

describe('P14-I live-DB â€” OPEN health failure / P14-I-A1 mandatory test A', () => {
  it('an UNHEALTHY account blocks OPEN before any risk/economic execution, and the fault persists', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    // Tamper AFTER startup so the runtime is already READY, then attempt OPEN.
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeRealizedPnlInr: '1' } });

    const openParams = await buildOpenParams(accountId);
    await expect(runtime.executeOpen(openParams)).rejects.toMatchObject({ code: 'RECONCILIATION_UNHEALTHY' });

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperReconciliationFault.count({ where: { accountId, faultType: 'ACCOUNT_LEDGER_MISMATCH' } })).toBe(1);
  }, 30_000);
});

describe('P14-I live-DB â€” OPEN stale health race (Â§51)', () => {
  it('a legitimate competing owner taking over the account after health was observed prevents the mutation from proceeding', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    const composerA = new PaperAccountProductionComposer({ prisma });
    const runtimeA = await composerA.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    // A legitimate competing owner (a second composer/kernel) takes over the account.
    const composerB = new PaperAccountProductionComposer({ prisma });
    const runtimeB = await composerB.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: makeProvider() });
    expect(runtimeB.ownerFence).toBeGreaterThan(runtimeA.ownerFence);

    const openParams = await buildOpenParams(accountId);
    await expect(runtimeA.executeOpen(openParams)).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('P14-I live-DB â€” CLOSE end-to-end (Â§53)', () => {
  it('genuine OPEN then fresh CLOSE produces exactly one close fill, one history row, an EMPTY slot, and exact account totals', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    expect(openResult.outcome).toBe('FILLED');
    if (openResult.outcome !== 'FILLED') return;

    feedFreshEvidence(provider, '110', '112'); // fresh CLOSE-side evidence â€” never reused from OPEN
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity));
    expect(closeResult.outcome).toBe('CLOSED');
    expect(closeResult).toMatchObject({ fundingDisclosure: { fundingCapability: 'FUNDING_UNSUPPORTED', economicCompleteness: 'FUNDING_EXCLUDED', paperEconomicStatus: 'PAPER_NOT_ECONOMICALLY_COMPLETE', pnlLabel: 'FUNDING_EXCLUDED_PNL' } });
    if (closeResult.outcome !== 'CLOSED') return;

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(2);
    expect(await prisma.paperPositionOwnershipHistory.count({ where: { accountId } })).toBe(1);
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('EMPTY');
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(account.cumulativeRealizedPnlInr.toFixed()).toBe(closeResult.realizedPnlInr);
    expect(account.cumulativeFundingInr.toFixed()).toBe('0');
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, type: 'FUNDING' } })).toBe(0);
  }, 30_000);
});

describe('P14-I live-DB â€” CLOSE cannot be replayed after the position is closed (Â§54 adaptation)', () => {
  it('a second CLOSE attempt after a completed close fails on POSITION_NOT_OPEN â€” no stale/regenerated authority is silently reused', async () => {
    if (skip()) return;
    // P14-I never accepts a caller-supplied CLOSE authority at all (it is
    // always minted fresh, internally, from the current durable position) â€”
    // there is structurally no "stale authority" a caller could hold or
    // replay through the public surface. The closest meaningful proof is
    // that attempting CLOSE again once the position is genuinely gone fails
    // safely rather than resurrecting/reusing anything from the first CLOSE.
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');
    feedFreshEvidence(provider, '110', '112');
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity));
    if (closeResult.outcome !== 'CLOSED') throw new Error('setup failed');

    feedFreshEvidence(provider, '111', '113');
    await expect(runtime.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity, {}, T0 + 2 * MINUTE))).rejects.toMatchObject({ code: 'POSITION_NOT_OPEN' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(2); // still exactly OPEN + one CLOSE
  }, 30_000);
});

describe('P14-I live-DB â€” CLOSE provider failure (Â§55)', () => {
  it('a fresh durable OPEN with unavailable evidence yields no close fill and leaves the position OPEN', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    const positionBefore = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });

    // A fresh takeover (new composer/fence) whose provider has never been fed
    // any evidence at all â€” no fallback to the earlier OPEN-time quote is
    // permitted; CLOSE must obtain its own fresh reading.
    const starvedProvider = makeProvider();
    const composer2 = new PaperAccountProductionComposer({ prisma });
    const runtime2 = await composer2.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: starvedProvider });
    await expect(runtime2.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity))).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });

    const positionAfter = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfter).toEqual(positionBefore);
    expect(positionAfter.status).toBe('OPEN');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
  }, 30_000);
});

describe('P14-I-A1 mandatory test B/C/D â€” UNHEALTHY blocks CLOSE, then recovers', () => {
  it('an UNHEALTHY account blocks CLOSE before authority/evidence/execution; correcting the tamper then makes CLOSE succeed exactly once, with the historical fault preserved', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    // B: tamper a durable projection unrelated to the position mechanics, while the position remains mechanically OPEN.
    const beforeTamper = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFeesInr: beforeTamper.cumulativeFeesInr.plus('1') } });

    feedFreshEvidence(provider, '110', '112');
    await expect(runtime.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity))).rejects.toMatchObject({ code: 'RECONCILIATION_UNHEALTHY' });

    const positionStillOpen = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionStillOpen.status).toBe('OPEN');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1); // still just the OPEN fill
    expect(await prisma.paperReconciliationFault.count({ where: { accountId, faultType: 'ACCOUNT_LEDGER_MISMATCH' } })).toBe(1);

    // C: externally restore the exact tampered value; fresh reconciliation must report HEALTHY.
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFeesInr: beforeTamper.cumulativeFeesInr } });
    const health = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(health.status).toBe('HEALTHY');

    feedFreshEvidence(provider, '111', '113');
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity, {}, T0 + 2 * MINUTE));
    expect(closeResult.outcome).toBe('CLOSED');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(2);
    expect(await prisma.paperPositionOwnershipHistory.count({ where: { accountId } })).toBe(1);

    // D: the historical fault row is never deleted/rewritten, even though the account is now healthy.
    expect(await prisma.paperReconciliationFault.count({ where: { accountId, faultType: 'ACCOUNT_LEDGER_MISMATCH' } })).toBe(1);
  }, 30_000);
});

describe('P14-I-A1 mandatory test E â€” no reduce-only bypass', () => {
  it('there is no parameter on the public CLOSE surface that bypasses the health gate', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeRealizedPnlInr: '1' } });

    const closeParams = buildCloseParams(openParams.kernel, accountId, openResult.quantity);
    // `ProductionCloseParams` has no reduce-only/force/bypass field at all â€” every own-enumerable key is a genuine trust-chain input.
    expect(Object.keys(closeParams).sort()).toEqual(['decision', 'executionPolicy', 'kernel', 'policy', 'riskRequest'].sort());

    feedFreshEvidence(provider, '110', '112');
    await expect(runtime.executeClose(closeParams)).rejects.toMatchObject({ code: 'RECONCILIATION_UNHEALTHY' });
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('OPEN');
  }, 30_000);
});

describe('P14-I live-DB â€” concurrency (Â§58/Â§59/Â§60)', () => {
  it('two concurrent OPEN attempts for the same account/pair serialize and produce no duplicate economics', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const coordinator = new RiskAdmissionCoordinator();
    const runtime = await composer.start({ accountId, coordinator, provider });

    const paramsA = await buildOpenParams(accountId, {}, T0);
    const paramsB = await buildOpenParams(accountId, {}, T0 + MINUTE);

    const settled = await Promise.allSettled([runtime.executeOpen(paramsA), runtime.executeOpen(paramsB)]);
    const filledCount = settled.filter((s) => s.status === 'fulfilled' && s.value.outcome === 'FILLED').length;
    expect(filledCount).toBe(1); // per-account serialization (Â§13) plus the frozen pair-slot contention rule (V2.2 Â§1) allow exactly one winner
    // Exactly one economic fill regardless of which admission outcome surfaced for the loser.
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
    expect(await prisma.paperReservation.count({ where: { accountId, status: 'CONSUMED' } })).toBe(1);
  }, 30_000);

  it('two different accounts proceed independently with no global composition lock', async () => {
    if (skip()) return;
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(accountA);
    await initAccount(accountB);
    await provisionPairSlot(accountA, PAIR);
    await provisionPairSlot(accountB, PAIR);
    const providerA = makeProvider();
    const providerB = makeProvider();
    feedFreshEvidence(providerA);
    feedFreshEvidence(providerB);
    const composer = new PaperAccountProductionComposer({ prisma });

    const [runtimeA, runtimeB] = await Promise.all([
      composer.start({ accountId: accountA, coordinator: new RiskAdmissionCoordinator(), provider: providerA }),
      composer.start({ accountId: accountB, coordinator: new RiskAdmissionCoordinator(), provider: providerB }),
    ]);
    const [resultA, resultB] = await Promise.all([
      runtimeA.executeOpen(await buildOpenParams(accountA)),
      runtimeB.executeOpen(await buildOpenParams(accountB)),
    ]);
    expect(resultA.outcome).toBe('FILLED');
    expect(resultB.outcome).toBe('FILLED');
  }, 30_000);
});

describe('P14-I live-DB â€” cross-runtime stale owner (Â§61)', () => {
  it('mutation via a superseded runtime fails STALE_FENCE with no economic mutation under the old owner', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const providerA = makeProvider();
    feedFreshEvidence(providerA);
    const composerA = new PaperAccountProductionComposer({ prisma });
    const runtimeA = await composerA.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: providerA });

    const providerB = makeProvider();
    feedFreshEvidence(providerB);
    const composerB = new PaperAccountProductionComposer({ prisma });
    await composerB.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: providerB });

    await expect(runtimeA.executeOpen(await buildOpenParams(accountId))).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('P14-I live-DB â€” reconciliation after mutation (Â§62)', () => {
  it('a fresh P14-H run after OPEN and after CLOSE reports HEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');
    const healthAfterOpen = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(healthAfterOpen.status).toBe('HEALTHY');

    feedFreshEvidence(provider, '110', '112');
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity));
    if (closeResult.outcome !== 'CLOSED') throw new Error('setup failed');
    const healthAfterClose = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(healthAfterClose.status).toBe('HEALTHY');
  }, 30_000);
});

describe('P14-I live-DB â€” promotion remains blocked (Â§57)', () => {
  it('PAPER -> PAPER_APPROVED is still blocked after successful production trading and HEALTHY reconciliation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openResult = await runtime.executeOpen(await buildOpenParams(accountId));
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');
    const health = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(health.status).toBe('HEALTHY');

    // P14-I never touches the promotion gate itself â€” exercise the exact
    // frozen P14-F function `CoinRegistry.transitionLifecycle` delegates to,
    // proving successful P14-I production trading grants no bypass.
    expect(() => assertProductionLifecycleTransitionAuthorized('PAPER', 'PAPER_APPROVED', 'BTC')).toThrow(CoinLifecycleError);
    expect(() => assertProductionLifecycleTransitionAuthorized('PAPER', 'PAPER_APPROVED', 'BTC')).toThrow(/FUNDING_UNSUPPORTED/);
  }, 30_000);
});

describe('P14-I live-DB â€” restart composition (Â§77)', () => {
  it('start -> OPEN -> discard all process-local objects -> fresh composition -> restart -> reconcile -> READY -> CLOSE', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider1 = makeProvider();
    feedFreshEvidence(provider1, '99', '99.5');
    const composer1 = new PaperAccountProductionComposer({ prisma });
    const runtime1 = await composer1.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: provider1 });
    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime1.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    // Discard every process-local object and rebuild composition from scratch.
    const provider2 = makeProvider();
    feedFreshEvidence(provider2, '110', '112');
    const composer2 = new PaperAccountProductionComposer({ prisma });
    const runtime2 = await composer2.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: provider2 });
    expect(runtime2.state).toBe('READY');
    expect(runtime2.ownerFence).toBeGreaterThan(runtime1.ownerFence);
    expect(runtime2.readSnapshot().positions.find((p) => p.pair === PAIR)).toMatchObject({ status: 'OPEN' });

    const closeResult = await runtime2.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity));
    expect(closeResult.outcome).toBe('CLOSED');
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('EMPTY');
  }, 30_000);
});

describe('P14-I live-DB â€” funding disclosure regression (Â§56)', () => {
  it('OPEN and CLOSE results always disclose FUNDING_UNSUPPORTED/FUNDING_EXCLUDED with no FUNDING ledger row', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openResult = await runtime.executeOpen(await buildOpenParams(accountId));
    expect(openResult).toMatchObject({
      fundingDisclosure: {
        fundingCapability: 'FUNDING_UNSUPPORTED', fundingApplied: false, economicCompleteness: 'FUNDING_EXCLUDED',
        paperEconomicStatus: 'PAPER_NOT_ECONOMICALLY_COMPLETE', pnlLabel: 'FUNDING_EXCLUDED_PNL',
      },
    });
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, type: 'FUNDING' } })).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// [F14-01] Authoritative durable risk input. Production admission previously
// accepted caller-supplied account/exposure evidence unbound to the durable
// paper account — these are the mandated adversarial proofs (§26).
// ---------------------------------------------------------------------------

/** [F14-01 step A] Loads the durable, revision-bound risk base for `accountId` through a standalone, freshly-fenced ownership (only used on accounts no live runtime holds). */
async function deriveBase(accountId: string, evaluationTimeMs = T0, pair = PAIR): Promise<AuthoritativePaperRiskBase> {
  const ownership = await new PaperAccountRepository(prisma).acquireOwnership(accountId);
  return loadAuthoritativePaperRiskBase({ ownership, policy: policyFor(pair), evaluationTimeMs }, prisma);
}

/**
 * [F14-01 steps C/D] Durable base + explicit valuation facts -> the final
 * authoritative risk input. Passing `marks` is how a test states the
 * authoritative mark for each OPEN pair; an account with no OPEN position
 * needs none.
 */
function deriveWithMarks(
  riskBase: AuthoritativePaperRiskBase, marksUsdtByPair: Record<string, string> = {}, conversionRateInrPerUsdt = CONVERSION_RATE, pair = PAIR,
): AuthoritativePaperRiskInput {
  const valuation = riskBase.openPositions.length === 0
    ? null
    : { conversionRateInrPerUsdt, markPriceUsdtByPair: new Map(Object.entries(marksUsdtByPair)) };
  const result = deriveMarkToMarketRiskInput({ base: riskBase, policy: policyFor(pair), valuation });
  if (result.status !== 'DERIVED') throw new Error(`expected DERIVED, got ${result.status}: ${result.reason}`);
  return result.input;
}

/** Derives with the mark set exactly equal to every position's own entry price, i.e. an authoritative unrealized PnL of exactly zero. */
function deriveAtBreakEven(riskBase: AuthoritativePaperRiskBase): AuthoritativePaperRiskInput {
  const marks: Record<string, string> = {};
  for (const position of riskBase.openPositions) {
    // entryInr / rate == the USDT mark that makes markInr === entryInr exactly.
    marks[position.pair] = paperDecimal(position.averageEntryPriceInr).div(CONVERSION_RATE).toFixed();
  }
  return deriveWithMarks(riskBase, marks);
}

/**
 * A `PrismaClient` whose `$transaction` performs `effect()` immediately after
 * the `index`-th transaction (counted from when `arm()` is called) commits.
 * Prototype delegation, never a Proxy — every other client member resolves to
 * the real client untouched.
 */
function racingPrisma(real: PrismaClient, index: number, effect: () => Promise<void>): { readonly client: PrismaClient; arm(): void } {
  let armed = false;
  let seen = 0;
  const client = Object.create(real) as PrismaClient;
  Object.defineProperty(client, '$transaction', {
    value: async (...args: unknown[]) => {
      const mine = armed ? ++seen : 0;
      const result = await (real.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
      if (mine === index) await effect();
      return result;
    },
  });
  return { client, arm(): void { armed = true; seen = 0; } };
}

describe('F14-01 live-DB — authoritative account/exposure derivation (§3)', () => {
  it('derives capital, equity, peak, locked margin and daily PnL from durable facts alone, bound to the current fence/revision', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId, '750000');
    await provisionPairSlot(accountId, PAIR);

    const derived = deriveWithMarks(await deriveBase(accountId));
    expect(derived.accountId).toBe(accountId);
    expect(derived.accountSnapshot.accountId).toBe(accountId);
    expect(derived.accountSnapshot.accountStateKnown).toBe(true);
    // V2 §12: cashBalance = S + R - F + G, all four straight from durable columns.
    expect(derived.accountSnapshot.currentEquityInr).toBe('750000');
    expect(derived.accountSnapshot.peakEquityInr).toBe('750000');
    expect(derived.accountSnapshot.lockedMarginInr).toBe('0');
    expect(derived.accountSnapshot.availableMarginInr).toBe('750000');
    expect(derived.accountSnapshot.dailyPnl).toEqual({
      realizedTradingPnlInr: '0', fundingPnlInr: '0', feesInr: '0', otherAccountAdjustmentsInr: '0', netDailyPnlInr: '0',
    });
    expect(derived.exposureSnapshot.globalOpenNotionalInr).toBe('0');
    expect(derived.exposureSnapshot.concurrentOpenPositions).toBe(0);

    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(derived.revision).toBe(account.revision);
    expect(derived.fence).toBe(account.ownerFence);
    // The derived snapshots use the policy's own configured source ids, so
    // RiskEngine's source-authority gate accepts them.
    expect(derived.accountSnapshot.provenance.sourceId).toBe(policyFor(PAIR).sourceAuthorityPolicy.accountRiskSourceId);
    expect(derived.exposureSnapshot.provenance.sourceId).toBe(policyFor(PAIR).sourceAuthorityPolicy.exposureSourceId);
  }, 30_000);

  it('a genuine OPEN position is always present in the derived exposure, and a genuine fee is always present in the derived equity', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openResult = await runtime.executeOpen(await buildOpenParams(accountId));
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    const slot = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    const riskBase = await deriveBase(accountId);
    const derived = deriveAtBreakEven(riskBase);
    const expectedNotional = paperDecimal(slot.quantity!.toFixed()).times(slot.averageEntryPriceInr!.toFixed()).toFixed();
    expect(derived.exposureSnapshot.globalOpenNotionalInr).toBe(expectedNotional);
    expect(derived.exposureSnapshot.perPairOpenNotionalInr[PAIR]).toBe(expectedNotional);
    expect(derived.exposureSnapshot.concurrentOpenPositions).toBe(1);
    expect(derived.accountSnapshot.lockedMarginInr).toBe(slot.initialMarginInr!.toFixed());

    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(account.cumulativeFeesInr.greaterThan(0)).toBe(true);
    expect(derived.accountSnapshot.currentEquityInr)
      .toBe(paperDecimal('1000000').minus(account.cumulativeFeesInr.toFixed()).toFixed());
  }, 30_000);

  it('pending admitted capacity is counted exactly once — never folded into durable OPEN exposure, and never lost (§5)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider(); // never fed: the OPEN admits durably, then fails closed at the evidence read
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    await expect(runtime.executeOpen(await buildOpenParams(accountId))).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });

    const reservation = await prisma.paperReservation.findFirstOrThrow({ where: { accountId, status: 'ADMITTED' } });
    const derived = deriveWithMarks(await deriveBase(accountId));
    // The slot is PENDING, not OPEN: durable OPEN exposure stays zero, so the
    // reservation is not double-counted as realized exposure...
    expect(derived.exposureSnapshot.globalOpenNotionalInr).toBe('0');
    expect(derived.exposureSnapshot.concurrentOpenPositions).toBe(0);
    // ...and `pending` is left UNKNOWN so `RiskAdmissionCoordinator` remains
    // the single authority that folds pending exposure in, exactly once.
    expect(derived.exposureSnapshot.pending).toEqual({ status: 'UNKNOWN' });
    // It is not lost either: its approved margin is reserved capacity, deducted once.
    expect(derived.accountSnapshot.availableMarginInr)
      .toBe(paperDecimal('1000000').minus(reservation.approvedMarginInr.toFixed()).toFixed());
  }, 30_000);

  it('restart-restored durable exposure remains authoritative after every process-local object is discarded (§26)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openResult = await runtime.executeOpen(await buildOpenParams(accountId));
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');
    const before = deriveAtBreakEven(await deriveBase(accountId));

    // Fresh composition, as a real restart would have — the derivation is a
    // pure durable read, so it is unchanged by losing all in-process state.
    const provider2 = makeProvider();
    feedFreshEvidence(provider2);
    const composer2 = new PaperAccountProductionComposer({ prisma });
    await composer2.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: provider2 });
    const after = deriveAtBreakEven(await deriveBase(accountId));
    expect(after.exposureSnapshot.globalOpenNotionalInr).toBe(before.exposureSnapshot.globalOpenNotionalInr);
    expect(after.exposureSnapshot.concurrentOpenPositions).toBe(1);
    expect(after.accountSnapshot.currentEquityInr).toBe(before.accountSnapshot.currentEquityInr);
  }, 30_000);

  it('multi-account isolation: one account\'s capital and exposure never enter another account\'s evaluation (§10)', async () => {
    if (skip()) return;
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(accountA, '900000');
    await initAccount(accountB, '120000');
    await provisionPairSlot(accountA, PAIR);
    await provisionPairSlot(accountB, PAIR);

    // Give A a genuine OPEN position and a pending reservation; leave B flat.
    const providerA = makeProvider();
    feedFreshEvidence(providerA);
    const composerA = new PaperAccountProductionComposer({ prisma });
    const runtimeA = await composerA.start({ accountId: accountA, coordinator: new RiskAdmissionCoordinator(), provider: providerA });
    const openA = await runtimeA.executeOpen(await buildOpenParams(accountA));
    if (openA.outcome !== 'FILLED') throw new Error('setup failed');

    const derivedA = deriveAtBreakEven(await deriveBase(accountA));
    const derivedB = deriveWithMarks(await deriveBase(accountB));
    expect(derivedA.accountSnapshot.accountId).toBe(accountA);
    expect(derivedB.accountSnapshot.accountId).toBe(accountB);
    expect(derivedB.accountSnapshot.currentEquityInr).toBe('120000');
    expect(derivedB.accountSnapshot.peakEquityInr).toBe('120000');
    expect(derivedB.accountSnapshot.lockedMarginInr).toBe('0');
    expect(derivedB.exposureSnapshot.globalOpenNotionalInr).toBe('0');
    expect(derivedB.exposureSnapshot.concurrentOpenPositions).toBe(0);
    expect(derivedB.exposureSnapshot.perPairOpenNotionalInr).toEqual({});
    expect(derivedA.exposureSnapshot.concurrentOpenPositions).toBe(1);
    expect(derivedA.accountSnapshot.currentEquityInr).not.toBe(derivedB.accountSnapshot.currentEquityInr);
  }, 30_000);
});

describe('F14-01 live-DB — caller-supplied authoritative evidence is impossible (§6/§7/§8)', () => {
  it('a caller smuggling accountSnapshot/exposureSnapshot into riskRequest is rejected with zero economic mutation and zero provider work', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const readEvidence = vi.spyOn(CoinDcxPaperEvidence.prototype, 'readProductionAcquiredExecutionEvidence');
    try {
      const genuine = await buildOpenParams(accountId);
      for (const forbidden of ['accountSnapshot', 'exposureSnapshot'] as const) {
        const smuggled = {
          ...genuine,
          // A JS caller has no compile-time checking — this is the exact shape
          // TypeScript alone would not stop.
          riskRequest: { ...genuine.riskRequest, [forbidden]: makeAccount() } as ProductionOpenParams['riskRequest'],
        };
        await expect(runtime.executeOpen(smuggled)).rejects.toMatchObject({ code: 'RISK_INPUT_NOT_AUTHORITATIVE' });
      }
      expect(readEvidence).not.toHaveBeenCalled();
    } finally {
      readEvidence.mockRestore();
    }

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('EMPTY');
  }, 30_000);

  it('risk evidence bound to a DIFFERENT account is rejected before durable admission, with no reservation, slot mutation, revision bump, market evidence fetch, or economics (§7)', async () => {
    if (skip()) return;
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(accountA);
    await initAccount(accountB);
    await provisionPairSlot(accountA, PAIR);
    await provisionPairSlot(accountB, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId: accountA, coordinator: new RiskAdmissionCoordinator(), provider });

    const revisionBefore = (await prisma.paperAccount.findUniqueOrThrow({ where: { accountId: accountA } })).revision;
    const slotBefore = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId: accountA, pair: PAIR } } });

    // Astra's exact attack: execute against paper-account-A using risk
    // evidence for account B.
    const forAccountB = await buildOpenParams(accountB);
    const readEvidence = vi.spyOn(CoinDcxPaperEvidence.prototype, 'readProductionAcquiredExecutionEvidence');
    try {
      await expect(runtime.executeOpen(forAccountB)).rejects.toMatchObject({ code: 'RISK_INPUT_NOT_AUTHORITATIVE' });
      expect(readEvidence).not.toHaveBeenCalled();
    } finally {
      readEvidence.mockRestore();
    }

    expect(await prisma.paperReservation.count({ where: { accountId: accountA } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId: accountA } })).toBe(0);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId: accountA } })).toBe(0);
    expect(await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId: accountA, pair: PAIR } } })).toEqual(slotBefore);
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { accountId: accountA } })).revision).toBe(revisionBefore);
    // Account B — whose evidence was borrowed — is equally untouched.
    expect(await prisma.paperReservation.count({ where: { accountId: accountB } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId: accountB } })).toBe(0);
  }, 30_000);

  it('a genuine existing OPEN position cannot be omitted from the risk input (§8)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openResult = await runtime.executeOpen(await buildOpenParams(accountId));
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    const fillsBefore = await prisma.paperFill.count({ where: { accountId } });
    const revisionBefore = (await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).revision;

    // A NEW decision (not the idempotent retry of the filled one) whose pair
    // snapshot claims the account is FLAT — i.e. declares zero exposure for a
    // pair that genuinely holds an OPEN position.
    const omitting = await buildOpenParams(accountId, {}, T0 + MINUTE);
    expect(omitting.riskRequest.pairSnapshot.position.state).toBe('FLAT'); // the false claim
    await expect(runtime.executeOpen(omitting)).rejects.toMatchObject({ code: 'RISK_INPUT_NOT_AUTHORITATIVE' });

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(fillsBefore);
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } })).revision).toBe(revisionBefore);

    // The authoritative projection genuinely reports that exposure — the
    // caller's zero simply never reaches RiskEngine. (This derivation takes a
    // fresh fence of its own, so it is done last, after every no-mutation
    // assertion above.)
    const derived = deriveAtBreakEven(await deriveBase(accountId, T0 + MINUTE));
    expect(paperDecimal(derived.exposureSnapshot.globalOpenNotionalInr).greaterThan(0)).toBe(true);
  }, 30_000);

  it('an understated owned quantity on an OPEN pair is rejected rather than reducing durable exposure (§8)', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    feedFreshEvidence(provider, '110', '112');
    const understated = paperDecimal(openResult.quantity).div(2).toFixed();
    await expect(runtime.executeClose(buildCloseParams(openParams.kernel, accountId, understated)))
      .rejects.toMatchObject({ code: 'RISK_INPUT_NOT_AUTHORITATIVE' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1); // still just the OPEN fill
    expect((await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).status).toBe('OPEN');
  }, 30_000);
});

describe('F14-01 live-DB — the derived snapshot can never drift from the state it is admitted against (§4/§9)', () => {
  it('a legitimate same-account revision bump landing after the authoritative derivation blocks admission with STALE_ACCOUNT_REVISION and zero economics', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    // Transaction 1 of an OPEN is the fresh P14-H reconciliation; transaction 2
    // is the authoritative durable derivation. Bumping right after #2 commits
    // reproduces §9 exactly: health and the derivation both saw revision R,
    // and admission then finds R+1.
    let bumps = 0;
    const racing = racingPrisma(prisma, 2, async () => {
      if (bumps > 0) return;
      bumps += 1;
      await prisma.paperAccount.update({ where: { accountId }, data: { revision: { increment: 1 } } });
    });
    const composer = new PaperAccountProductionComposer({ prisma: racing.client });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    racing.arm();
    await expect(runtime.executeOpen(await buildOpenParams(accountId))).rejects.toMatchObject({ code: 'STALE_ACCOUNT_REVISION' });
    expect(bumps).toBe(1); // the race genuinely happened

    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect((await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).status).toBe('EMPTY');
  }, 30_000);

  it('a revision bump landing between the health observation and the derivation fails closed as HEALTH_STALE', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    let bumps = 0;
    const racing = racingPrisma(prisma, 1, async () => { // #1 = the fresh reconciliation
      if (bumps > 0) return;
      bumps += 1;
      await prisma.paperAccount.update({ where: { accountId }, data: { revision: { increment: 1 } } });
    });
    const composer = new PaperAccountProductionComposer({ prisma: racing.client });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    racing.arm();
    await expect(runtime.executeOpen(await buildOpenParams(accountId))).rejects.toMatchObject({ code: 'HEALTH_STALE' });
    expect(bumps).toBe(1);
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('F14-01 live-DB — production MTM equity drives OPEN risk (§12.3/§12.4)', () => {
  async function openSmallShort(
    runtime: Awaited<ReturnType<PaperAccountProductionComposer['start']>>, accountId: string,
  ): Promise<{ readonly params: ProductionOpenParams; readonly quantity: string }> {
    const baseParams = await buildOpenParamsForPair(accountId, PAIR, {}, T0, 'SHORT');
    const params: ProductionOpenParams = {
      ...baseParams,
      riskRequest: {
        ...baseParams.riskRequest,
        entryStopProposal: baseParams.riskRequest.entryStopProposal === null
          ? null
          : seal({ ...baseParams.riskRequest.entryStopProposal, stopPriceUsdt: '110' }),
        // Keep durable entry exposure small enough that it cannot mask the
        // subsequent MTM-equity assertion through an exposure ceiling.
        override: { overrideId: 'mtm-fixture-small-open', overrideRiskPerTradePercent: null, overrideMaxLeverage: null, overrideMaxNotionalInr: '80' },
      },
    };
    let result: Awaited<ReturnType<typeof runtime.executeOpen>>;
    try {
      result = await runtime.executeOpen(params);
    } catch (error) {
      const cause = error instanceof PaperProductionRuntimeError ? error.cause : error;
      throw new Error(`small SHORT setup rejected: ${JSON.stringify(cause)}`, { cause: error });
    }
    if (result.outcome !== 'FILLED') throw new Error('small SHORT setup did not fill');
    return { params, quantity: result.quantity };
  }

  async function shortMarkForTargetEquity(accountId: string, targetEquityInr: string): Promise<string> {
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const slot = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    if (slot.side !== 'SHORT' || slot.quantity === null || slot.averageEntryPriceInr === null) throw new Error('expected durable SHORT setup');
    const cash = paperDecimal(account.startingCapitalInr.toFixed())
      .plus(account.cumulativeRealizedPnlInr.toFixed())
      .minus(account.cumulativeFeesInr.toFixed())
      .plus(account.cumulativeFundingInr.toFixed());
    const targetUnrealized = paperDecimal(targetEquityInr).minus(cash);
    // SHORT U=(entry-mark)*quantity*multiplier. Solve exactly for mark and
    // convert INR -> provider USDT with the fixture conversion rate.
    return paperDecimal(slot.averageEntryPriceInr.toFixed())
      .minus(targetUnrealized.div(paperDecimal(slot.quantity.toFixed()).times('0.001')))
      .div(CONVERSION_RATE)
      .toFixed();
  }

  it('an OPEN on another pair is sized from loss-reduced MTM equity, not realized-only cash', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await provisionPairSlot(accountId, PAIR_B);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const runtime = await new PaperAccountProductionComposer({ prisma })
      .start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    await openSmallShort(runtime, accountId);

    const targetEquity = '800000';
    const btcMark = await shortMarkForTargetEquity(accountId, targetEquity);
    feedFreshEvidenceForPair(provider, PAIR_B, '99', '99.5', CONVERSION_RATE, Date.now(), btcMark, '99');
    const result = await runtime.executeOpen(await buildOpenParamsForPair(accountId, PAIR_B, {}, T0 + MINUTE));
    if (result.outcome !== 'FILLED') throw new Error(`expected second OPEN fill, got ${result.outcome}`);

    // Candidate stop risk is (100-90)×0.001×80 = ₹0.8 per unit.
    // ₹800,000 equity × 1% / ₹0.8 = exactly 10,000 units. Realized-only
    // cash would produce a strictly larger risk ceiling.
    expect(result.quantity).toBe('10000');
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const realizedOnlyRiskQuantity = paperDecimal(account.startingCapitalInr.toFixed())
      .plus(account.cumulativeRealizedPnlInr.toFixed())
      .minus(account.cumulativeFeesInr.toFixed())
      .plus(account.cumulativeFundingInr.toFixed())
      .times('0.01').div('0.8').floor().toFixed();
    expect(paperDecimal(result.quantity).lt(realizedOnlyRiskQuantity)).toBe(true);
  }, 30_000);

  it('an unrealized loss alone trips the drawdown breaker and leaves the candidate pair economically untouched', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await provisionPairSlot(accountId, PAIR_B);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const coordinator = new RiskAdmissionCoordinator();
    const runtime = await new PaperAccountProductionComposer({ prisma })
      .start({ accountId, coordinator, provider });
    await openSmallShort(runtime, accountId);

    const btcMark = await shortMarkForTargetEquity(accountId, '600000');
    feedFreshEvidenceForPair(provider, PAIR_B, '99', '99.5', CONVERSION_RATE, Date.now(), btcMark, '99');
    const realAdmit = coordinator.admit.bind(coordinator);
    let observedAdmission: Awaited<ReturnType<typeof coordinator.admit>> | null = null;
    const admitSpy = vi.spyOn(coordinator, 'admit').mockImplementation(async (request) => {
      observedAdmission = await realAdmit(request);
      return observedAdmission;
    });
    await expect(runtime.executeOpen(await buildOpenParamsForPair(accountId, PAIR_B, {}, T0 + MINUTE)))
      .rejects.toMatchObject({ code: 'AUTHORITY_REJECTED' });
    expect(admitSpy).toHaveBeenCalledTimes(1);
    expect(observedAdmission).toMatchObject({
      status: 'REJECTED', decision: { status: 'REJECTED', primaryReasonCode: 'DRAWDOWN_LIMIT', approved: null },
    });
    expect(await prisma.paperReservation.count({ where: { accountId, pair: PAIR_B } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR_B } })).toBe(0);
    expect((await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR_B } } })).status).toBe('EMPTY');
  }, 30_000);

  it('requires a fresh production-acquired mark for every durable OPEN pair, never only the candidate pair', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await provisionPairSlot(accountId, PAIR_B);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const runtime = await new PaperAccountProductionComposer({ prisma })
      .start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openedA = await openSmallShort(runtime, accountId);

    const breakEvenA = await shortMarkForTargetEquity(accountId, '999999');
    feedFreshEvidenceForPair(provider, PAIR_B, '49', '49.5', CONVERSION_RATE, Date.now(), breakEvenA, '49');
    const openB = await runtime.executeOpen(await buildOpenParamsForPair(accountId, PAIR_B, {}, T0 + MINUTE));
    if (openB.outcome !== 'FILLED') throw new Error('second OPEN setup did not fill');

    // New mark generation deliberately carries only A. B's old mark cannot be
    // reused across generations, so the all-OPEN-position valuation must fail.
    const nowMs = Date.now();
    const bookGeneration = provider.startOrderbookWebSocket();
    expect(provider.ingestOrderbookWebSocket(bookPayload(nowMs, '99', '99.5'), bookGeneration, PAIR, PRODUCTION_ACQUISITION_CAPABILITY))
      .toMatchObject({ accepted: true });
    expect(provider.ingestConversionRest(conversionPayload(CONVERSION_RATE, nowMs), PRODUCTION_ACQUISITION_CAPABILITY))
      .toMatchObject({ accepted: true });
    const markGeneration = provider.startMarkWebSocket();
    const onlyA = { data: JSON.stringify({ ts: String(nowMs), vs: '3', [PROVIDER_SYMBOL]: { mp: breakEvenA, bmST: String(nowMs) } }) };
    expect(provider.ingestMarkWebSocket(onlyA, markGeneration, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });

    const retryShape = await buildOpenParamsForPair(accountId, PAIR, {}, T0 + 2 * MINUTE, 'SHORT');
    const consistentA: ProductionOpenParams = {
      ...retryShape,
      riskRequest: {
        ...retryShape.riskRequest,
        pairSnapshot: openPairSnapshotFor(retryShape.kernel, accountId, openedA.quantity, retryShape.decision.evaluationTimeMs, 'SHORT'),
      },
    };
    const fillsBefore = await prisma.paperFill.count({ where: { accountId } });
    await expect(runtime.executeOpen(consistentA)).rejects.toMatchObject({
      code: 'EVIDENCE_UNAVAILABLE', message: expect.stringContaining(`NO_CURRENT_GENERATION_WEBSOCKET_MARK:${PAIR_B}`),
    });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(fillsBefore);
  }, 30_000);

  it('a revision change after the durable base remains stale through valuation and is rejected atomically at admission', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    await provisionPairSlot(accountId, PAIR_B);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    let bumps = 0;
    const racing = racingPrisma(prisma, 2, async () => {
      if (bumps > 0) return;
      bumps += 1;
      await prisma.paperAccount.update({ where: { accountId }, data: { revision: { increment: 1 } } });
    });
    const runtime = await new PaperAccountProductionComposer({ prisma: racing.client })
      .start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    await openSmallShort(runtime, accountId);

    const breakEvenA = await shortMarkForTargetEquity(accountId, '999999');
    feedFreshEvidenceForPair(provider, PAIR_B, '99', '99.5', CONVERSION_RATE, Date.now(), breakEvenA, '99');
    const valuationRead = vi.spyOn(CoinDcxPaperEvidence.prototype, 'readProductionAcquiredValuationEvidence');
    racing.arm();
    await expect(runtime.executeOpen(await buildOpenParamsForPair(accountId, PAIR_B, {}, T0 + MINUTE)))
      .rejects.toMatchObject({ code: 'STALE_ACCOUNT_REVISION' });

    expect(valuationRead).toHaveBeenCalledTimes(1);
    expect(bumps).toBe(1);
    expect(await prisma.paperReservation.count({ where: { accountId, pair: PAIR_B } })).toBe(0);
    expect(await prisma.paperFill.count({ where: { accountId, pair: PAIR_B } })).toBe(0);
    valuationRead.mockRestore();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// [F14-02] Fabricated market evidence cannot reach production OPEN or CLOSE.
// ---------------------------------------------------------------------------

/** A provider a public caller can build: same fakes, but NO acquisition capability anywhere. */
function callerFabricatedProvider(bid = '99', ask = '99.5', conversionRate = '80'): CoinDcxPaperEvidence {
  const provider = new CoinDcxPaperEvidence({
    instruments: PROVIDER_INSTRUMENTS, clock: WALL_CLOCK, socketFactory: new FakeCoinDcxSocketFactory(),
    policy: { orderbookFreshnessMs: 30_000, markFreshnessMs: 30_000, conversionLocalPollFreshnessMs: 60_000, allowedProviderFutureSkewMs: 5_000 },
  });
  const nowMs = Date.now();
  const generation = provider.startOrderbookWebSocket();
  if (!provider.ingestOrderbookWebSocket(bookPayload(nowMs, bid, ask), generation).accepted) throw new Error('setup: fabricated orderbook rejected');
  if (!provider.ingestConversionRest(conversionPayload(conversionRate, nowMs)).accepted) throw new Error('setup: fabricated conversion rejected');
  // Every pre-F14-02 P14-B gate passes on this data — that is the whole point.
  if (provider.getLatestExecutionQuote(PAIR).state !== 'AVAILABLE') throw new Error('setup: expected a fresh fabricated quote');
  return provider;
}

describe('F14-02 live-DB — production OPEN/CLOSE reject caller-fabricated market evidence (§27)', () => {
  it('OPEN: a fabricated-evidence provider yields EVIDENCE_UNAVAILABLE and never produces a fill', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: callerFabricatedProvider() });

    await expect(runtime.executeOpen(await buildOpenParams(accountId))).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperLedgerEntry.count({ where: { accountId } })).toBe(0);
    // The durable admission reservation IS created before the evidence check
    // (unchanged, unweakened P14-D contract) — but no economics follow it.
    expect((await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).status).toBe('PENDING');
  }, 30_000);

  it('CLOSE: a fabricated-evidence provider cannot close a genuinely OPEN position', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const genuineProvider = makeProvider();
    feedFreshEvidence(genuineProvider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: genuineProvider });
    const openParams = await buildOpenParams(accountId);
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    // A fresh takeover whose provider holds only fabricated (caller-fed) evidence.
    const composer2 = new PaperAccountProductionComposer({ prisma });
    const runtime2 = await composer2.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: callerFabricatedProvider('110', '112') });
    await expect(runtime2.executeClose(buildCloseParams(openParams.kernel, accountId, openResult.quantity)))
      .rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1); // still only the OPEN fill
    expect((await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } })).status).toBe('OPEN');
    expect(await prisma.paperPositionOwnershipHistory.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('P14-I sanity â€” PaperProductionRuntimeError shape', () => {
  it('carries a stable machine-readable code distinct from generic errors', () => {
    const error = new PaperProductionRuntimeError('EVIDENCE_UNAVAILABLE', 'test');
    expect(error.code).toBe('EVIDENCE_UNAVAILABLE');
    expect(error.name).toBe('PaperProductionRuntimeError');
  });
});
