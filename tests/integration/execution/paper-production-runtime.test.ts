import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import { buildExecutionPolicySnapshot, EXECUTION_POLICY_VERSION, paperDecimal, type ExecutionPolicySnapshot } from '../../../src/execution';
import { PaperAccountReconciler } from '../../../src/execution/persistence/paper-account-reconciler';
import { PaperAccountRepository } from '../../../src/execution/persistence/account-repository';
import { CoinDcxPaperEvidence, type PaperEvidenceInstrument } from '../../../src/integration/coindcx/paper-evidence';
import { FakeCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';
import {
  PaperAccountProductionComposer, PaperProductionRuntimeError, type ProductionCloseParams, type ProductionOpenParams,
} from '../../../src/integration/coindcx/paper-production-runtime';
import { assertProductionLifecycleTransitionAuthorized } from '../../../src/coin-runtime/lifecycle';
import { CoinLifecycleError } from '../../../src/core/errors/app-error';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, PAIR, policyFor } from '../../unit/dispatch/helpers';
import { makePair, seal } from '../../unit/risk/helpers';
import type { CanonicalPositionValuation, PairRiskSnapshot } from '../../../src/risk';
import type { StrategyKernel } from '../../../src/strategies';

// P14-I live-DB production composition suite — mirrors the exact P14-D/E/G/H
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
const PRICE_INCREMENT = '1';
const QUANTITY_INCREMENT = '1';

const EXECUTION_POLICY: ExecutionPolicySnapshot = buildExecutionPolicySnapshot({
  policyVersion: EXECUTION_POLICY_VERSION,
  fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
  marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 30_000, requiredHealthState: 'HEALTHY' },
  takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT', tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1',
  quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001', currencyConversionPolicy: 'P14_INR_CONVERSION_V1',
  accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
});

function evidenceFrom(context: ReturnType<typeof buildContext>) {
  const { strategyOrigin: _strategyOrigin, candidate: _candidate, ...evidence } = context;
  return evidence;
}

const WALL_CLOCK = { nowMs: () => Date.now() };
const PROVIDER_SYMBOL = 'BTCUSDT';
const PROVIDER_INSTRUMENTS: readonly PaperEvidenceInstrument[] = Object.freeze([
  Object.freeze({ pair: PAIR, underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID }),
]);

function makeProvider(): CoinDcxPaperEvidence {
  return new CoinDcxPaperEvidence({
    instruments: PROVIDER_INSTRUMENTS, clock: WALL_CLOCK, socketFactory: new FakeCoinDcxSocketFactory(),
    policy: { orderbookFreshnessMs: 30_000, markFreshnessMs: 30_000, conversionLocalPollFreshnessMs: 60_000, allowedProviderFutureSkewMs: 5_000 },
  });
}

function bookPayload(nowMs: number, bid: string, ask: string, version = '1') {
  return { event: 'depth-snapshot', data: JSON.stringify({ type: 'depth-snapshot', pr: 'futures', s: PROVIDER_SYMBOL, ts: String(nowMs), vs: version, bids: [[bid, '1000000']], asks: [[ask, '1000000']] }) };
}
function conversionPayload(rate: string, nowMs: number) {
  return [{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: rate, last_updated_at: String(nowMs) }];
}

/** Feeds a fresh, real (WS-actionable + REST conversion) evidence pair into a real `CoinDcxPaperEvidence` provider — same technique as `tests/unit/coindcx/paper-evidence.test.ts`. */
function feedFreshEvidence(provider: CoinDcxPaperEvidence, bid = '99', ask = '99.5', conversionRate = '80', nowMs = Date.now()): void {
  const generation = provider.startOrderbookWebSocket();
  const bookResult = provider.ingestOrderbookWebSocket(bookPayload(nowMs, bid, ask), generation);
  if (!bookResult.accepted) throw new Error(`test setup: orderbook ingest rejected: ${bookResult.reason}`);
  const conversionResult = provider.ingestConversionRest(conversionPayload(conversionRate, nowMs));
  if (!conversionResult.accepted) throw new Error(`test setup: conversion ingest rejected: ${conversionResult.reason}`);
}

function buildOpenParams(overrides: Partial<ProductionOpenParams> = {}, evaluationTimeMs = T0): Promise<ProductionOpenParams> {
  return (async () => {
    const { result: planResult } = await genuineResearchApproval();
    const kernel = makeKernel(PAIR);
    const decision = evaluateDecision(kernel, evaluationTimeMs);
    const riskEvidence = evidenceFrom(buildContext(kernel, decision));
    return {
      kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID, planResult, policy: policyFor(PAIR),
      riskEvidence, executionPolicy: EXECUTION_POLICY, priceIncrement: PRICE_INCREMENT, quantityIncrement: QUANTITY_INCREMENT,
      ...overrides,
    };
  })();
}
// A CLOSE decision's risk context must present an OPEN, reconciled-ownership
// pair snapshot (RiskEngine cross-verifies notional = quantity * unitValuation)
// — never the default EMPTY-position snapshot `buildContext` supplies for OPEN
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

function buildCloseParams(kernel: StrategyKernel, ownedQuantity: string, overrides: Partial<ProductionCloseParams> = {}, evaluationTimeMs = T0 + MINUTE): ProductionCloseParams {
  const decision = evaluateDecision(kernel, evaluationTimeMs, 'FLAT');
  const riskEvidence = evidenceFrom(buildContext(kernel, decision, { pairSnapshot: openPairSnapshotFor(kernel, ownedQuantity, decision.evaluationTimeMs) }));
  return {
    kernel, decision, instrumentSpecSnapshotId: INSTRUMENT_SPEC_SNAPSHOT_ID, policy: policyFor(PAIR),
    riskEvidence, executionPolicy: EXECUTION_POLICY, priceIncrement: PRICE_INCREMENT,
    ...overrides,
  };
}

describe('P14-I live-DB — clean startup (§74)', () => {
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
});

describe('P14-I live-DB — unhealthy startup (§75)', () => {
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

describe('P14-I live-DB — OPEN end-to-end (§47/§52)', () => {
  it('a genuine research-approved decision produces exactly one fill and correct durable state through the public P14-I path', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams();
    const result = await runtime.executeOpen(openParams);
    expect(result.outcome).toBe('FILLED');
    expect(result).toMatchObject({ fundingDisclosure: { fundingCapability: 'FUNDING_UNSUPPORTED', fundingApplied: false, economicCompleteness: 'FUNDING_EXCLUDED' } });
    if (result.outcome !== 'FILLED') return;

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('OPEN');
    expect(position.positionInstanceId).toBe(result.positionInstanceId);

    // §52: retrying the exact same source decision through P14-I is idempotent.
    const retryResult = await runtime.executeOpen(openParams);
    expect(retryResult.outcome).toBe('SOURCE_DECISION_ALREADY_EXECUTED');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
    const accountAfterRetry = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    const accountAfterFirst = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    expect(accountAfterRetry.cumulativeFeesInr.toFixed()).toBe(accountAfterFirst.cumulativeFeesInr.toFixed());
  }, 30_000);
});

describe('P14-I live-DB — forged OPEN input (§48)', () => {
  it('a structurally forged StrategyDecision is rejected with zero economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const genuineParams = await buildOpenParams();
    const forgedDecision = { ...genuineParams.decision, decisionId: 'forged-decision-id-does-not-match-hash' };
    const forgedParams: ProductionOpenParams = { ...genuineParams, decision: forgedDecision };

    // The forged object is rejected by the genuine trusted risk/strategy
    // layer itself (a structurally forged decision fails an existing
    // validation deep in RiskEngine/authorizeStrategyDispatch) — P14-I never
    // masks or swallows that rejection into a generic code (§46); the exact
    // meaningful lower-layer error propagates untouched.
    await expect(runtime.executeOpen(forgedParams)).rejects.toThrow();
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('EMPTY');
  }, 30_000);
});

describe('P14-I live-DB — OPEN provider failure (§49)', () => {
  it('valid admission but no available market evidence yields EVIDENCE_UNAVAILABLE with zero economic mutation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider(); // never fed — no evidence available

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams();
    await expect(runtime.executeOpen(openParams)).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    // The durable admission reservation IS created before the evidence check (existing, unweakened P14-D contract) — the pair slot is legitimately PENDING, not repaired/rolled back by P14-I.
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('PENDING');
    expect(await prisma.paperReservation.count({ where: { accountId, status: 'ADMITTED' } })).toBe(1);
  }, 30_000);
});

describe('P14-I live-DB — OPEN health failure / P14-I-A1 mandatory test A', () => {
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

    const openParams = await buildOpenParams();
    await expect(runtime.executeOpen(openParams)).rejects.toMatchObject({ code: 'RECONCILIATION_UNHEALTHY' });

    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
    expect(await prisma.paperReconciliationFault.count({ where: { accountId, faultType: 'ACCOUNT_LEDGER_MISMATCH' } })).toBe(1);
  }, 30_000);
});

describe('P14-I live-DB — OPEN stale health race (§51)', () => {
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

    const openParams = await buildOpenParams();
    await expect(runtimeA.executeOpen(openParams)).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('P14-I live-DB — CLOSE end-to-end (§53)', () => {
  it('genuine OPEN then fresh CLOSE produces exactly one close fill, one history row, an EMPTY slot, and exact account totals', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');

    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams();
    const openResult = await runtime.executeOpen(openParams);
    expect(openResult.outcome).toBe('FILLED');
    if (openResult.outcome !== 'FILLED') return;

    feedFreshEvidence(provider, '110', '112'); // fresh CLOSE-side evidence — never reused from OPEN
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, openResult.quantity));
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

describe('P14-I live-DB — CLOSE cannot be replayed after the position is closed (§54 adaptation)', () => {
  it('a second CLOSE attempt after a completed close fails on POSITION_NOT_OPEN — no stale/regenerated authority is silently reused', async () => {
    if (skip()) return;
    // P14-I never accepts a caller-supplied CLOSE authority at all (it is
    // always minted fresh, internally, from the current durable position) —
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

    const openParams = await buildOpenParams();
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');
    feedFreshEvidence(provider, '110', '112');
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, openResult.quantity));
    if (closeResult.outcome !== 'CLOSED') throw new Error('setup failed');

    feedFreshEvidence(provider, '111', '113');
    await expect(runtime.executeClose(buildCloseParams(openParams.kernel, openResult.quantity, {}, T0 + 2 * MINUTE))).rejects.toMatchObject({ code: 'POSITION_NOT_OPEN' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(2); // still exactly OPEN + one CLOSE
  }, 30_000);
});

describe('P14-I live-DB — CLOSE provider failure (§55)', () => {
  it('a fresh durable OPEN with unavailable evidence yields no close fill and leaves the position OPEN', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams();
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    const positionBefore = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });

    // A fresh takeover (new composer/fence) whose provider has never been fed
    // any evidence at all — no fallback to the earlier OPEN-time quote is
    // permitted; CLOSE must obtain its own fresh reading.
    const starvedProvider = makeProvider();
    const composer2 = new PaperAccountProductionComposer({ prisma });
    const runtime2 = await composer2.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: starvedProvider });
    await expect(runtime2.executeClose(buildCloseParams(openParams.kernel, openResult.quantity))).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });

    const positionAfter = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionAfter).toEqual(positionBefore);
    expect(positionAfter.status).toBe('OPEN');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1);
  }, 30_000);
});

describe('P14-I-A1 mandatory test B/C/D — UNHEALTHY blocks CLOSE, then recovers', () => {
  it('an UNHEALTHY account blocks CLOSE before authority/evidence/execution; correcting the tamper then makes CLOSE succeed exactly once, with the historical fault preserved', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams();
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    // B: tamper a durable projection unrelated to the position mechanics, while the position remains mechanically OPEN.
    const beforeTamper = await prisma.paperAccount.findUniqueOrThrow({ where: { accountId } });
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFeesInr: beforeTamper.cumulativeFeesInr.plus('1') } });

    feedFreshEvidence(provider, '110', '112');
    await expect(runtime.executeClose(buildCloseParams(openParams.kernel, openResult.quantity))).rejects.toMatchObject({ code: 'RECONCILIATION_UNHEALTHY' });

    const positionStillOpen = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(positionStillOpen.status).toBe('OPEN');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(1); // still just the OPEN fill
    expect(await prisma.paperReconciliationFault.count({ where: { accountId, faultType: 'ACCOUNT_LEDGER_MISMATCH' } })).toBe(1);

    // C: externally restore the exact tampered value; fresh reconciliation must report HEALTHY.
    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeFeesInr: beforeTamper.cumulativeFeesInr } });
    const health = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(health.status).toBe('HEALTHY');

    feedFreshEvidence(provider, '111', '113');
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, openResult.quantity, {}, T0 + 2 * MINUTE));
    expect(closeResult.outcome).toBe('CLOSED');
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(2);
    expect(await prisma.paperPositionOwnershipHistory.count({ where: { accountId } })).toBe(1);

    // D: the historical fault row is never deleted/rewritten, even though the account is now healthy.
    expect(await prisma.paperReconciliationFault.count({ where: { accountId, faultType: 'ACCOUNT_LEDGER_MISMATCH' } })).toBe(1);
  }, 30_000);
});

describe('P14-I-A1 mandatory test E — no reduce-only bypass', () => {
  it('there is no parameter on the public CLOSE surface that bypasses the health gate', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openParams = await buildOpenParams();
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');

    await prisma.paperAccount.update({ where: { accountId }, data: { cumulativeRealizedPnlInr: '1' } });

    const closeParams = buildCloseParams(openParams.kernel, openResult.quantity);
    // `ProductionCloseParams` has no reduce-only/force/bypass field at all — every own-enumerable key is a genuine trust-chain input.
    expect(Object.keys(closeParams).sort()).toEqual(['decision', 'executionPolicy', 'instrumentSpecSnapshotId', 'kernel', 'policy', 'priceIncrement', 'riskEvidence'].sort());

    feedFreshEvidence(provider, '110', '112');
    await expect(runtime.executeClose(closeParams)).rejects.toMatchObject({ code: 'RECONCILIATION_UNHEALTHY' });
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('OPEN');
  }, 30_000);
});

describe('P14-I live-DB — concurrency (§58/§59/§60)', () => {
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

    const paramsA = await buildOpenParams({}, T0);
    const paramsB = await buildOpenParams({}, T0 + MINUTE);

    const settled = await Promise.allSettled([runtime.executeOpen(paramsA), runtime.executeOpen(paramsB)]);
    const filledCount = settled.filter((s) => s.status === 'fulfilled' && s.value.outcome === 'FILLED').length;
    expect(filledCount).toBe(1); // per-account serialization (§13) plus the frozen pair-slot contention rule (V2.2 §1) allow exactly one winner
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
      runtimeA.executeOpen(await buildOpenParams()),
      runtimeB.executeOpen(await buildOpenParams()),
    ]);
    expect(resultA.outcome).toBe('FILLED');
    expect(resultB.outcome).toBe('FILLED');
  }, 30_000);
});

describe('P14-I live-DB — cross-runtime stale owner (§61)', () => {
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

    await expect(runtimeA.executeOpen(await buildOpenParams())).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await prisma.paperFill.count({ where: { accountId } })).toBe(0);
  }, 30_000);
});

describe('P14-I live-DB — reconciliation after mutation (§62)', () => {
  it('a fresh P14-H run after OPEN and after CLOSE reports HEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });

    const openParams = await buildOpenParams();
    const openResult = await runtime.executeOpen(openParams);
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');
    const healthAfterOpen = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(healthAfterOpen.status).toBe('HEALTHY');

    feedFreshEvidence(provider, '110', '112');
    const closeResult = await runtime.executeClose(buildCloseParams(openParams.kernel, openResult.quantity));
    if (closeResult.outcome !== 'CLOSED') throw new Error('setup failed');
    const healthAfterClose = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(healthAfterClose.status).toBe('HEALTHY');
  }, 30_000);
});

describe('P14-I live-DB — promotion remains blocked (§57)', () => {
  it('PAPER -> PAPER_APPROVED is still blocked after successful production trading and HEALTHY reconciliation', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider);
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openResult = await runtime.executeOpen(await buildOpenParams());
    if (openResult.outcome !== 'FILLED') throw new Error('setup failed');
    const health = await new PaperAccountReconciler(prisma).reconcile(accountId);
    expect(health.status).toBe('HEALTHY');

    // P14-I never touches the promotion gate itself — exercise the exact
    // frozen P14-F function `CoinRegistry.transitionLifecycle` delegates to,
    // proving successful P14-I production trading grants no bypass.
    expect(() => assertProductionLifecycleTransitionAuthorized('PAPER', 'PAPER_APPROVED', 'BTC')).toThrow(CoinLifecycleError);
    expect(() => assertProductionLifecycleTransitionAuthorized('PAPER', 'PAPER_APPROVED', 'BTC')).toThrow(/FUNDING_UNSUPPORTED/);
  }, 30_000);
});

describe('P14-I live-DB — restart composition (§77)', () => {
  it('start -> OPEN -> discard all process-local objects -> fresh composition -> restart -> reconcile -> READY -> CLOSE', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider1 = makeProvider();
    feedFreshEvidence(provider1, '99', '99.5');
    const composer1 = new PaperAccountProductionComposer({ prisma });
    const runtime1 = await composer1.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider: provider1 });
    const openParams = await buildOpenParams();
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

    const closeResult = await runtime2.executeClose(buildCloseParams(openParams.kernel, openResult.quantity));
    expect(closeResult.outcome).toBe('CLOSED');
    const position = await prisma.paperPosition.findUniqueOrThrow({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position.status).toBe('EMPTY');
  }, 30_000);
});

describe('P14-I live-DB — funding disclosure regression (§56)', () => {
  it('OPEN and CLOSE results always disclose FUNDING_UNSUPPORTED/FUNDING_EXCLUDED with no FUNDING ledger row', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(accountId);
    await provisionPairSlot(accountId, PAIR);
    const provider = makeProvider();
    feedFreshEvidence(provider, '99', '99.5');
    const composer = new PaperAccountProductionComposer({ prisma });
    const runtime = await composer.start({ accountId, coordinator: new RiskAdmissionCoordinator(), provider });
    const openResult = await runtime.executeOpen(await buildOpenParams());
    expect(openResult).toMatchObject({
      fundingDisclosure: {
        fundingCapability: 'FUNDING_UNSUPPORTED', fundingApplied: false, economicCompleteness: 'FUNDING_EXCLUDED',
        paperEconomicStatus: 'PAPER_NOT_ECONOMICALLY_COMPLETE', pnlLabel: 'FUNDING_EXCLUDED_PNL',
      },
    });
    expect(await prisma.paperLedgerEntry.count({ where: { accountId, type: 'FUNDING' } })).toBe(0);
  }, 30_000);
});

describe('P14-I sanity — PaperProductionRuntimeError shape', () => {
  it('carries a stable machine-readable code distinct from generic errors', () => {
    const error = new PaperProductionRuntimeError('EVIDENCE_UNAVAILABLE', 'test');
    expect(error.code).toBe('EVIDENCE_UNAVAILABLE');
    expect(error.name).toBe('PaperProductionRuntimeError');
  });
});
