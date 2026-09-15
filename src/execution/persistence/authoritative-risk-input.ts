import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import {
  canonicalDecimalString, evidenceContentSha256, riskDecimal,
  type AccountRiskSnapshot, type DailyPnlComponents, type PairRiskSnapshot,
  type PortfolioExposureSnapshot, type RiskPolicy,
} from '../../risk';
import { computeAvailableMargin, computeCashBalance, computeEquity, computeUnrealizedPnlInr } from '../accounting';
import { paperDecimal, type PaperCalc } from '../decimal';
import { PaperAccountOwnership } from './account-ownership';
import { buildBaseExposureSnapshot } from './account-repository';
import { PaperPersistenceError } from './errors';
import { executionPolicySnapshotFromRow, instrumentEconomicsSnapshotFromRow } from './immutable-snapshots';

/**
 * [F14-01] Authoritative, durable-state-derived risk input for ONE paper
 * account.
 *
 * The defect this module closes: production admission accepted caller-supplied
 * `accountSnapshot`/`exposureSnapshot` risk evidence that was never bound to
 * the durable `PaperAccount`/`PaperPosition`/`PaperReservation` state it
 * claimed to describe. A caller could therefore execute against paper account
 * A while presenting account B's capital, omit a genuinely OPEN position from
 * the exposure it declared, understate its own realized losses/fees, or replay
 * a stale account observation — and `RiskEngine` would approve on that basis,
 * because Phase13 deliberately consumes an `AccountRiskStateProvider`-shaped
 * snapshot and never recomputes it (`docs/RISK_LEVERAGE_ENGINE.md` §12.3/§15.1).
 *
 * Every value below is DERIVED from durable rows read inside ONE
 * fence-verified `SELECT … FOR UPDATE` transaction on `paper_account`, using
 * the frozen V2 §12 INR cash-settled equations in `src/execution/accounting.ts`
 * and the frozen §12.1/§12.2 daily-window definitions — no new economics, no
 * invented field semantics, and nothing a caller can influence.
 *
 * ---------------------------------------------------------------------------
 * [F14-01 final correction] Mark-to-market equity.
 *
 * `docs/RISK_LEVERAGE_ENGINE.md` §12.3 is explicit: `currentEquityInr`
 * **includes** unrealized PnL of any open position, and §12.4's drawdown gate
 * is the one gate sensitive to it. An earlier revision of this module reported
 * the realized-only cash balance as `currentEquityInr`; that overstated equity
 * for an account holding a losing OPEN position, letting
 * `GLOBAL_MAX_DRAWDOWN_PERCENT` be bypassed and inflating the §11 risk budget
 * (`riskBudgetInr = currentEquityInr × riskPerTradePercent / 100`).
 *
 * The correction splits the derivation into the three responsibilities §28
 * requires, so no network call is ever hidden inside a DB-shaped function:
 *
 *   A. `loadAuthoritativePaperRiskBase` — durable, locked, revision-bound.
 *      Pure DB. Includes the complete OPEN-position valuation input set.
 *   B. (caller, outside the transaction) acquire production-acquired
 *      CoinDCX mark + conversion evidence.
 *   C/D. `deriveMarkToMarketRiskInput` — pure. Computes per-position
 *      unrealized PnL with the frozen `computeUnrealizedPnlInr`, sums it over
 *      EVERY durable OPEN position, and builds the final `AccountRiskSnapshot`
 *      with `equity = computeEquity(cashBalance, totalUnrealizedPnl)`.
 *
 * There is no fallback: a missing/stale/non-production-acquired mark for ANY
 * open position fails closed. Unrealized PnL is never assumed zero, never
 * derived from the entry price, and never taken from a candle/LTP.
 */

/** [F14-01] §12.2 frozen daily window: `[floor(evaluationTimeMs / 86_400_000) * 86_400_000, evaluationTimeMs]`, both endpoints inclusive. */
export const DAILY_WINDOW_MS = 86_400_000;

/** Durable pair-slot facts a caller-supplied `PairRiskSnapshot` must agree with. */
export interface AuthoritativePairSlotFacts {
  readonly pair: string;
  readonly status: 'EMPTY' | 'PENDING' | 'OPEN';
  readonly positionInstanceId: string | null;
  readonly side: 'LONG' | 'SHORT' | null;
  readonly quantity: string | null;
  readonly ownerStrategyInstanceId: string | null;
  readonly ownerStrategyId: string | null;
  readonly ownerStrategyVersion: string | null;
  readonly ownerParameterHash: string | null;
}

/**
 * [F14-01] Everything mark-to-market valuation of ONE durable OPEN position
 * needs. `contractMultiplier` is read from the position's OWN opening
 * `PaperExecutionIntent` -> `PaperInstrumentEconomicsSnapshot`. That immutable
 * Wave3-B opening lineage drives initial-margin reconciliation, MTM, and CLOSE;
 * the opening policy multiplier is revalidated only as an equality assertion,
 * never used as independent economic authority.
 */
export interface AuthoritativeOpenPositionValuation {
  readonly pair: string;
  readonly positionInstanceId: string;
  readonly side: 'LONG' | 'SHORT';
  readonly quantity: string;
  /** Already INR-denominated on the durable row: P14-E persists `fillPriceUsdt × conversionRate`. */
  readonly averageEntryPriceInr: string;
  readonly contractMultiplier: string;
}

/** [F14-01 step A] The locked, revision-bound durable base — no equity yet, because equity needs a mark. */
export interface AuthoritativePaperRiskBase {
  readonly accountId: string;
  readonly fence: bigint;
  /** The `PaperAccount.revision` this entire derivation is bound to. */
  readonly revision: bigint;
  readonly evaluationTimeMs: number;
  /** V2 §12 `cashBalance = S + R - F + G`, from durable columns only. */
  readonly cashBalanceInr: string;
  /** V2 §12 `L` — sum of durable OPEN positions' `initialMarginInr`. */
  readonly lockedMarginInr: string;
  /** V2 §12 `P` — sum of durably ADMITTED reservations' `approvedMarginInr`. */
  readonly reservedCapacityInr: string;
  readonly peakEquityInr: string;
  readonly consecutiveLossCount: number;
  readonly cooldownActiveUntilMs: number | null;
  readonly dailyPnl: DailyPnlComponents;
  /** EVERY durable OPEN position, not just the candidate pair's (§11). */
  readonly openPositions: readonly AuthoritativeOpenPositionValuation[];
  /** Derived from durable OPEN pair slots; `pending` stays `UNKNOWN` so `RiskAdmissionCoordinator` remains the single pending-exposure authority. */
  readonly exposureSnapshot: PortfolioExposureSnapshot;
  readonly pairSlots: readonly AuthoritativePairSlotFacts[];
}

export interface AuthoritativePaperRiskInput {
  readonly accountId: string;
  readonly fence: bigint;
  readonly revision: bigint;
  readonly evaluationTimeMs: number;
  /** Exact sum of every durable OPEN position's unrealized PnL; `'0'` only when the account genuinely holds no OPEN position. */
  readonly totalUnrealizedPnlInr: string;
  readonly accountSnapshot: AccountRiskSnapshot;
  readonly exposureSnapshot: PortfolioExposureSnapshot;
  readonly pairSlots: readonly AuthoritativePairSlotFacts[];
}

/**
 * [F14-01 step B result] Plain, already-verified valuation facts handed in by
 * the composition root. This module deliberately takes STRINGS, not a provider
 * — `src/execution/**` is structurally forbidden from importing the CoinDCX
 * integration surface, and the production caller (P14-I) is responsible for
 * proving production acquisition provenance (F14-02) before building this.
 */
export interface AuthoritativeValuationEvidence {
  readonly conversionRateInrPerUsdt: string;
  /** Provider mark price in USDT, per pair — mirrors P14-E's own `fillPriceInr = fillPriceUsdt × conversionRate`. */
  readonly markPriceUsdtByPair: ReadonlyMap<string, string>;
}

export type AuthoritativeRiskInputResult =
  | Readonly<{ status: 'DERIVED'; input: AuthoritativePaperRiskInput }>
  | Readonly<{ status: 'VALUATION_UNAVAILABLE'; reason: string }>;

export interface LoadAuthoritativePaperRiskBaseParams {
  readonly ownership: PaperAccountOwnership;
  readonly policy: RiskPolicy;
  /** The evaluation instant this fenced observation is bound to — also the §12.2 daily-window end. */
  readonly evaluationTimeMs: number;
}

export interface DeriveAuthoritativePaperRiskInputParams {
  readonly base: AuthoritativePaperRiskBase;
  readonly policy: RiskPolicy;
  /** `null` is valid ONLY for an account with zero durable OPEN positions (§21 — no provider work is performed for an unnecessary valuation). */
  readonly valuation: AuthoritativeValuationEvidence | null;
  /**
   * [F14-01 class F] External policy/config, not durable account state: the
   * paper schema persists no per-account exchange leverage cap. `null` (the
   * default) means "no account-level cap configured", exactly as Phase13
   * already treats a null `accountMaxLeverage`.
   */
  readonly accountMaxLeverage?: string | null;
}

function canonical(value: { toFixed(): string }): string {
  return canonicalDecimalString(value.toFixed());
}

/** Nullable durable decimal column -> exact fixed-point string (a slot is only required to carry these while `OPEN`). */
function optionalDecimal(value: { toFixed(): string } | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed();
}

function seal<T extends { readonly provenance: { readonly sourceId: string; readonly sourceTimeMs: number | null; readonly observedAtMs: number; readonly contentSha256: string } }>(value: T): T {
  return Object.freeze({ ...value, provenance: Object.freeze({ ...value.provenance, contentSha256: evidenceContentSha256(value) }) });
}

/**
 * [F14-01 step A] Reads durable account/position/reservation/ledger/policy
 * state under the held fence and returns the complete, revision-bound risk
 * base — including the full OPEN-position valuation input set.
 *
 * Mirrors `PaperAccountRepository.loadCoherentSnapshot`'s exact lock ordering
 * (`paper_account` row first, `SELECT … FOR UPDATE`, `ReadCommitted`) so it can
 * never invert against admission/execution/reconciliation locking, and
 * re-verifies the held fence inside the same transaction — a superseded owner
 * gets `STALE_FENCE` here rather than a silently stale snapshot.
 *
 * Performs ZERO network I/O (§5): market valuation evidence is acquired by the
 * caller only after this transaction has committed and released its lock.
 */
export async function loadAuthoritativePaperRiskBase(
  params: LoadAuthoritativePaperRiskBaseParams,
  prismaClient: PrismaClient = defaultPrisma,
): Promise<AuthoritativePaperRiskBase> {
  const record = PaperAccountOwnership.read(params.ownership);
  if (record === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');
  const { evaluationTimeMs, policy } = params;
  if (!Number.isSafeInteger(evaluationTimeMs) || evaluationTimeMs < 0) {
    throw new PaperPersistenceError('DURABLE_CONFLICT', 'evaluationTimeMs must be a non-negative safe integer');
  }
  const dayStartMs = Math.floor(evaluationTimeMs / DAILY_WINDOW_MS) * DAILY_WINDOW_MS;

  return prismaClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${record.accountId} FOR UPDATE`;
    const account = await tx.paperAccount.findUnique({ where: { accountId: record.accountId } });
    if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${record.accountId}`);
    if (account.ownerFence !== record.fence) {
      throw new PaperPersistenceError('STALE_FENCE', `Held fence ${record.fence} no longer matches current ${account.ownerFence} for ${record.accountId}`);
    }

    const [positions, reservations, windowLedger] = await Promise.all([
      tx.paperPosition.findMany({ where: { accountId: record.accountId } }),
      tx.paperReservation.findMany({ where: { accountId: record.accountId, status: 'ADMITTED' } }),
      tx.paperLedgerEntry.findMany({
        where: { accountId: record.accountId, eventTimeMs: { gte: BigInt(dayStartMs), lte: BigInt(evaluationTimeMs) } },
        select: { type: true, amountInr: true },
      }),
    ]);
    const openSlots = positions.filter((slot) => slot.status === 'OPEN');

    // [F14-01] Each OPEN position's own durably-bound contract multiplier,
    // resolved through its opening intent's execution-policy snapshot — the
    // exact same lineage P14-H uses to re-derive that position's initial
    // margin. Fetched inside this transaction so the multiplier is coherent
    // with the position it values.
    const openAdmissionIds = openSlots.map((slot) => slot.admissionId).filter((id): id is string => id !== null);
    const openingIntents = openAdmissionIds.length === 0 ? [] : await tx.paperExecutionIntent.findMany({
      where: { accountId: record.accountId, action: 'OPEN', admissionId: { in: openAdmissionIds } },
      include: { executionPolicy: true, instrumentEconomics: true },
    });
    const intentByAdmissionId = new Map(openingIntents.map((intent) => [intent.admissionId as string, intent]));

    const openPositions: AuthoritativeOpenPositionValuation[] = openSlots.map((slot) => {
      const quantity = optionalDecimal(slot.quantity);
      const averageEntryPriceInr = optionalDecimal(slot.averageEntryPriceInr);
      const openingIntent = slot.admissionId === null ? undefined : intentByAdmissionId.get(slot.admissionId);
      if (slot.positionInstanceId === null || slot.side === null || quantity === null || averageEntryPriceInr === null
        || openingIntent === undefined || openingIntent.instrumentEconomicsSnapshotId === null || openingIntent.instrumentEconomics === null) {
        // Structurally unvaluable durable state — fail closed, never value it
        // at zero or fall back to the entry price. P14-H owns diagnosis/repair.
        throw new PaperPersistenceError(
          'RECONCILIATION_REQUIRED',
          `OPEN paper_position (${record.accountId}, ${slot.pair}) cannot be authoritatively valued: missing opening instrument-economics lineage (LEGACY_UNVERIFIABLE)`,
        );
      }
      const economics = instrumentEconomicsSnapshotFromRow(openingIntent.instrumentEconomics);
      const policySnapshot = executionPolicySnapshotFromRow(openingIntent.executionPolicy);
      if (economics.pair !== slot.pair || !paperDecimal(policySnapshot.content.contractMultiplier).equals(paperDecimal(economics.contractMultiplier))) {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `OPEN paper_position (${record.accountId}, ${slot.pair}) has inconsistent policy/instrument economics lineage`);
      }
      return Object.freeze({
        pair: slot.pair, positionInstanceId: slot.positionInstanceId, side: slot.side,
        quantity, averageEntryPriceInr, contractMultiplier: economics.contractMultiplier,
      });
    });

    // --- V2 §12 frozen cash/margin equations, from durable columns only. ----
    const cashBalance = computeCashBalance({
      startingCapitalInr: paperDecimal(account.startingCapitalInr.toFixed()),
      cumulativeRealizedPnlInr: paperDecimal(account.cumulativeRealizedPnlInr.toFixed()),
      cumulativeFeesInr: paperDecimal(account.cumulativeFeesInr.toFixed()),
      cumulativeFundingInr: paperDecimal(account.cumulativeFundingInr.toFixed()),
    });
    // L — open-position initial margin, straight from the durable slots.
    const lockedMargin = openSlots.reduce(
      (sum, slot) => sum.plus(paperDecimal(optionalDecimal(slot.initialMarginInr) ?? '0')),
      paperDecimal('0'),
    );
    // P — durably ADMITTED (still-pending) reservations' approved margin. The
    // P14-C schema persists no separate opening-fee allowance column, so none
    // is invented here.
    const reservedCapacity = reservations.reduce((sum, row) => sum.plus(paperDecimal(row.approvedMarginInr.toFixed())), paperDecimal('0'));

    // --- §12.1/§12.2 realized-only daily PnL over the frozen UTC-day window. -
    const sumOf = (type: string): PaperCalc => windowLedger
      .filter((entry) => entry.type === type)
      .reduce((sum, entry) => sum.plus(paperDecimal(entry.amountInr.toFixed())), paperDecimal('0'));
    const realizedTradingPnl = sumOf('REALIZED_PNL');
    const fundingPnl = sumOf('FUNDING'); // P14-F: funding is unsupported and invariant-checked zero; summed rather than assumed.
    const fees = sumOf('FEE').negated(); // FEE postings are stored negative; `feesInr` is the positive charge.
    // No durable paper ledger type represents an out-of-band account
    // adjustment (the enum's remaining members are opening capital and margin
    // movement, neither of which is daily PnL), so this component is exactly 0.
    const otherAdjustments = paperDecimal('0');
    const netDailyPnl = realizedTradingPnl.plus(fundingPnl).minus(fees).plus(otherAdjustments);

    // Durable OPEN exposure — entry-time-fixed `quantity * averageEntryPriceInr`
    // (V2 §11: no live mark participates in EXPOSURE, which is a separate
    // frozen concept from equity), reusing the exact frozen P14-D projection
    // rather than a second implementation of the same arithmetic.
    const projection = buildBaseExposureSnapshot(
      record.accountId,
      openPositions.map((position) => ({
        pair: position.pair,
        strategyId: openSlots.find((slot) => slot.pair === position.pair)?.ownerStrategyId ?? '',
        quantity: position.quantity,
        averageEntryPriceInr: position.averageEntryPriceInr,
      })),
      evaluationTimeMs,
      policy.sourceAuthorityPolicy.exposureSourceId,
    );
    // `buildBaseExposureSnapshot` also carries `accountId` for its own
    // content hash; `RiskEvaluationContext` validation demands the exact
    // `PortfolioExposureSnapshot` key set, so it is dropped here and the
    // content hash resealed with `evidenceContentSha256` — the exact hash
    // RiskEngine independently recomputes over the whole snapshot.
    const { accountId: _projectionAccountId, ...exposureFields } = projection as PortfolioExposureSnapshot & { readonly accountId?: string };
    const exposureSnapshot = seal(exposureFields as PortfolioExposureSnapshot);

    return Object.freeze({
      accountId: record.accountId, fence: account.ownerFence, revision: account.revision, evaluationTimeMs,
      cashBalanceInr: canonical(cashBalance),
      lockedMarginInr: canonical(lockedMargin),
      reservedCapacityInr: canonical(reservedCapacity),
      peakEquityInr: canonical(account.peakEquityInr),
      consecutiveLossCount: account.consecutiveLossCount,
      cooldownActiveUntilMs: account.cooldownActiveUntilMs === null ? null : Number(account.cooldownActiveUntilMs),
      dailyPnl: Object.freeze({
        realizedTradingPnlInr: canonical(realizedTradingPnl), fundingPnlInr: canonical(fundingPnl), feesInr: canonical(fees),
        otherAccountAdjustmentsInr: canonical(otherAdjustments), netDailyPnlInr: canonical(netDailyPnl),
      }),
      openPositions: Object.freeze(openPositions),
      exposureSnapshot,
      pairSlots: Object.freeze(positions.map((slot) => Object.freeze({
        pair: slot.pair, status: slot.status, positionInstanceId: slot.positionInstanceId ?? null,
        side: slot.side ?? null, quantity: optionalDecimal(slot.quantity),
        ownerStrategyInstanceId: slot.ownerStrategyInstanceId ?? null, ownerStrategyId: slot.ownerStrategyId ?? null,
        ownerStrategyVersion: slot.ownerStrategyVersion ?? null, ownerParameterHash: slot.ownerParameterHash ?? null,
      }))),
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Builds and seals the final snapshot pair from a durable base plus an already-computed total unrealized PnL. */
function buildRiskInput(
  base: AuthoritativePaperRiskBase, policy: RiskPolicy, accountMaxLeverage: string | null, totalUnrealizedPnl: PaperCalc,
): AuthoritativePaperRiskInput {
  const cashBalance = paperDecimal(base.cashBalanceInr);
  // V2 §12 frozen: `equity = cashBalance + U`, never clamped — insolvency and
  // unrealized loss both stay visible.
  const equity = computeEquity(cashBalance, totalUnrealizedPnl);
  // V2 §12 frozen: `availableMargin = max(0, min(cashBalance, equity) - L - P)`
  // — a negative U now genuinely reduces spendable collateral, while a
  // positive U still never becomes spendable.
  const availableMargin = computeAvailableMargin({
    cashBalance, equity, lockedMarginInr: paperDecimal(base.lockedMarginInr), reservedCapacityInr: paperDecimal(base.reservedCapacityInr),
  });
  const accountSnapshot = seal<AccountRiskSnapshot>({
    accountId: base.accountId,
    provenance: { sourceId: policy.sourceAuthorityPolicy.accountRiskSourceId, sourceTimeMs: base.evaluationTimeMs, observedAtMs: base.evaluationTimeMs, contentSha256: '' },
    accountStateKnown: true,
    availableMarginInr: canonical(availableMargin),
    lockedMarginInr: base.lockedMarginInr,
    currentEquityInr: canonical(equity),
    peakEquityInr: base.peakEquityInr,
    dailyPnl: base.dailyPnl,
    consecutiveLossCount: base.consecutiveLossCount,
    cooldownActiveUntilMs: base.cooldownActiveUntilMs,
    accountMaxLeverage,
    reconciliationSourceIds: Object.freeze(['PAPER_DURABLE_ACCOUNT_V1', 'PAPER_DURABLE_POSITION_V1', 'PAPER_DURABLE_LEDGER_V1']),
  });
  return Object.freeze({
    accountId: base.accountId, fence: base.fence, revision: base.revision, evaluationTimeMs: base.evaluationTimeMs,
    totalUnrealizedPnlInr: canonical(totalUnrealizedPnl),
    accountSnapshot, exposureSnapshot: base.exposureSnapshot, pairSlots: base.pairSlots,
  });
}

/**
 * [F14-01 steps C/D] The production derivation: `currentEquityInr =
 * cashBalance + Σ unrealized PnL over EVERY durable OPEN position`
 * (`docs/RISK_LEVERAGE_ENGINE.md` §12.3), using the frozen
 * `computeUnrealizedPnlInr` — the exact LONG/SHORT formula P14-E's CLOSE path
 * already uses for realized PnL, with the position's own durably-bound
 * contract multiplier and `markPriceInr = markPriceUsdt × conversionRate`
 * (the identical conversion P14-E applies to `fillPriceUsdt`).
 *
 * Fails closed — never partially, never at zero — if any OPEN position lacks a
 * mark, or if valuation evidence is absent while OPEN positions exist. Pure:
 * no I/O, Decimal-only arithmetic, no native floating point.
 */
export function deriveMarkToMarketRiskInput(params: DeriveAuthoritativePaperRiskInputParams): AuthoritativeRiskInputResult {
  const { base, policy, valuation } = params;
  const accountMaxLeverage = params.accountMaxLeverage ?? null;

  if (base.openPositions.length === 0) {
    // §21: zero OPEN positions ⇒ unrealized PnL is exactly zero and no
    // valuation evidence is required (or requested) at all.
    return Object.freeze({ status: 'DERIVED' as const, input: buildRiskInput(base, policy, accountMaxLeverage, paperDecimal('0')) });
  }
  if (valuation === null) {
    return Object.freeze({ status: 'VALUATION_UNAVAILABLE' as const, reason: 'NO_VALUATION_EVIDENCE_FOR_OPEN_POSITIONS' });
  }
  const conversionRate = paperDecimal(valuation.conversionRateInrPerUsdt);
  if (!conversionRate.greaterThan(0)) {
    return Object.freeze({ status: 'VALUATION_UNAVAILABLE' as const, reason: 'CONVERSION_RATE_NOT_POSITIVE' });
  }

  let total = paperDecimal('0');
  for (const position of base.openPositions) {
    const markPriceUsdt = valuation.markPriceUsdtByPair.get(position.pair);
    if (markPriceUsdt === undefined) {
      return Object.freeze({ status: 'VALUATION_UNAVAILABLE' as const, reason: `NO_MARK_FOR_OPEN_POSITION:${position.pair}` });
    }
    const markUsdt = paperDecimal(markPriceUsdt);
    if (!markUsdt.greaterThan(0)) {
      return Object.freeze({ status: 'VALUATION_UNAVAILABLE' as const, reason: `MARK_NOT_POSITIVE:${position.pair}` });
    }
    total = total.plus(computeUnrealizedPnlInr({
      side: position.side,
      entryPriceInr: paperDecimal(position.averageEntryPriceInr),
      markPriceInr: markUsdt.times(conversionRate),
      quantity: paperDecimal(position.quantity),
      contractMultiplier: paperDecimal(position.contractMultiplier),
    }));
  }
  return Object.freeze({ status: 'DERIVED' as const, input: buildRiskInput(base, policy, accountMaxLeverage, total) });
}

/**
 * [F14-01/§23] CLOSE-only derivation: reports the realized-only cash balance
 * as `currentEquityInr` and performs NO market valuation.
 *
 * This is not the F14-01 defect reappearing — it is the frozen CLOSE contract.
 * Every equity-sensitive Phase13 gate is OPEN-only: §12.4 drawdown and §11's
 * `accountStateReasons` are pushed only under `action === 'OPEN'`
 * (`src/risk/engine.ts`), and `resolveTierSizingUnchecked` returns immediately
 * for a non-OPEN action (`src/risk/tier-resolution.ts`), so no CLOSE decision
 * reads `currentEquityInr` at all. Requiring a fresh mark here would add a new
 * market-evidence gate that could block de-risking — which the frozen rule
 * ("de-risking is never blocked by a circuit breaker") forbids. CLOSE's own
 * market-evidence requirement is unchanged and still enforced at execution
 * time by the P14-B trusted-evidence read.
 */
export function deriveCloseRiskInput(params: Omit<DeriveAuthoritativePaperRiskInputParams, 'valuation'>): AuthoritativePaperRiskInput {
  return buildRiskInput(params.base, params.policy, params.accountMaxLeverage ?? null, paperDecimal('0'));
}

/**
 * [F14-01] The one remaining risk input that must stay caller-supplied (it
 * also carries instrument-spec and market-valuation facts this layer has no
 * durable source for) is `PairRiskSnapshot` — but its `position`/`ownership`
 * members ARE durable-state-dependent. Rather than silently overwriting a
 * caller's object, this strictly compares every durable-dependent member to
 * the authoritative slot and returns a mismatch reason, so the caller's
 * request is REJECTED (never quietly rewritten). Returns `null` when the
 * snapshot genuinely agrees with durable state.
 *
 * Instrument-spec/valuation/market members are deliberately NOT checked here:
 * they are class-E/F facts owned by other gates (`verifyCurrentValuation`,
 * P14-B evidence provenance, and — still open — F14-03's authoritative
 * instrument-multiplier binding).
 */
export function pairSnapshotDurableMismatch(
  snapshot: PairRiskSnapshot,
  accountId: string,
  pairSlots: readonly AuthoritativePairSlotFacts[],
): string | null {
  const slot = pairSlots.find((entry) => entry.pair === snapshot.pair);
  const durablyOpen = slot !== undefined && slot.status === 'OPEN';

  if (snapshot.ownership.status === 'RECONCILED') {
    if (snapshot.ownership.accountId !== accountId) {
      return `pairSnapshot.ownership.accountId ${snapshot.ownership.accountId} is not the runtime account ${accountId}`;
    }
    if (snapshot.ownership.pair !== snapshot.pair) {
      return `pairSnapshot.ownership.pair ${snapshot.ownership.pair} does not match pairSnapshot.pair ${snapshot.pair}`;
    }
    if ((snapshot.ownership.positionState === 'OPEN') !== durablyOpen) {
      return `pairSnapshot.ownership.positionState ${snapshot.ownership.positionState} contradicts durable slot status ${slot?.status ?? 'ABSENT'} for ${snapshot.pair}`;
    }
    if (snapshot.ownership.positionState === 'OPEN' && slot !== undefined) {
      const owned = snapshot.ownership.instanceOwnership;
      const total = owned.reduce((sum, entry) => sum.plus(entry.currentQuantity), riskDecimal('0'));
      if (!total.eq(riskDecimal(slot.quantity ?? '0'))) {
        return `pairSnapshot.ownership declares ${total.toFixed()} owned quantity but the durable OPEN slot holds ${slot.quantity ?? '0'} for ${snapshot.pair}`;
      }
      const foreign = owned.find((entry) => entry.strategyInstanceId !== slot.ownerStrategyInstanceId || entry.strategyId !== slot.ownerStrategyId
        || entry.strategyVersion !== slot.ownerStrategyVersion || entry.parameterHash !== slot.ownerParameterHash);
      if (foreign !== undefined) {
        return `pairSnapshot.ownership declares a strategy instance that does not own the durable OPEN slot for ${snapshot.pair}`;
      }
    }
  }

  if ((snapshot.position.state === 'OPEN') !== durablyOpen) {
    return `pairSnapshot.position.state ${snapshot.position.state} contradicts durable slot status ${slot?.status ?? 'ABSENT'} for ${snapshot.pair}`;
  }
  if (snapshot.position.state === 'OPEN' && slot !== undefined) {
    if (snapshot.position.positionDirection !== slot.side) {
      return `pairSnapshot.position.positionDirection ${snapshot.position.positionDirection} contradicts durable side ${slot.side ?? 'NULL'} for ${snapshot.pair}`;
    }
    if (!riskDecimal(snapshot.position.quantityMagnitude).eq(riskDecimal(slot.quantity ?? '0'))) {
      return `pairSnapshot.position.quantityMagnitude ${snapshot.position.quantityMagnitude} contradicts durable quantity ${slot.quantity ?? '0'} for ${snapshot.pair}`;
    }
  }
  return null;
}
