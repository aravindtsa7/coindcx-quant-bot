import type { InstrumentMetadata } from '../../../coin-runtime';
import { Decimal } from '../../../core/decimal/decimal';
import type { AccountRiskSnapshot, DailyPnlComponents, PairRiskSnapshot, PortfolioExposureSnapshot, SettlementConversionSnapshot } from '../../../risk';
import { BOT_SHADOW_RISK_SOURCES, botInstrumentSnapshotId, createBotInteriorLeverageSnapshot, sealBotRiskEvidence,
  type PracticalBotObservedPosition, type PracticalBotRiskState } from './practical-bot-evaluation';

export interface BotShadowReservation {
  readonly reservationId: string; readonly pair: string; readonly strategyInstanceId: string; readonly strategyId: string;
  readonly strategyVersion: string; readonly parameterHash: string; readonly direction: 'LONG' | 'SHORT';
  readonly notionalInr: string; readonly marginInr: string; readonly status: 'ADMITTED' | 'RELEASED';
}

/** Durable capital for this standalone, non-executing shadow account. It is never a venue balance assertion. */
export interface BotShadowCapital {
  readonly accountFingerprint: string; readonly initialEquityInr: string; readonly equityInr: string; readonly peakEquityInr: string;
  readonly lockedMarginInr: string; readonly createdAtMs: number; readonly dailyPnl: DailyPnlComponents;
  readonly consecutiveLossCount: number; readonly cooldownActiveUntilMs: number | null;
  readonly reservations: readonly BotShadowReservation[];
}

export function createBotShadowRiskState(input: {
  readonly capital: BotShadowCapital; readonly instrument: InstrumentMetadata; readonly instrumentObservedAtMs: number;
  readonly evaluationTimeMs: number; readonly settlement: SettlementConversionSnapshot | null;
  readonly positions: readonly PracticalBotObservedPosition[] | null; readonly allowOfflineFlat: boolean;
}): PracticalBotRiskState {
  const { capital, instrument, evaluationTimeMs: now } = input;
  const empty: PracticalBotRiskState = { scope: 'OPERATOR_SHADOW', accountSnapshot: null, exposureSnapshot: null, settlementRateSnapshot: input.settlement };
  // Existing or unobserved venue exposure cannot be assigned to this newly funded shadow book.
  if ((!input.allowOfflineFlat && input.positions === null) || input.positions?.some(position => !new Decimal(position.signedQuantity).isZero())) return empty;
  const source = (sourceId: string) => ({ sourceId, sourceTimeMs: capital.createdAtMs, observedAtMs: now, contentSha256: '' });
  const active = capital.reservations.filter(reservation => reservation.status === 'ADMITTED');
  const sum = (values: readonly string[]) => values.reduce((total, value) => total.plus(value), new Decimal(0)).toFixed();
  const group = (key: (reservation: BotShadowReservation) => string) => {
    const result: Record<string, string> = {};
    for (const reservation of active) { const id = key(reservation); result[id] = new Decimal(result[id] ?? '0').plus(reservation.notionalInr).toFixed(); }
    return result;
  };
  const instances = [...new Set(active.map(reservation => reservation.strategyInstanceId))].map(strategyInstanceId => {
    const rows = active.filter(reservation => reservation.strategyInstanceId === strategyInstanceId);
    const first = rows[0]!;
    if (rows.some(row => row.strategyId !== first.strategyId || row.strategyVersion !== first.strategyVersion || row.parameterHash !== first.parameterHash)) {
      throw new Error('SHADOW_RESERVATION_IDENTITY_MISMATCH');
    }
    return { strategyInstanceId, strategyId: first.strategyId, strategyVersion: first.strategyVersion, parameterHash: first.parameterHash,
      pendingNotionalInr: sum(rows.map(row => row.notionalInr)), pendingReservationCount: rows.length };
  });
  const accountSnapshot = sealBotRiskEvidence<AccountRiskSnapshot>({ accountId: capital.accountFingerprint,
    provenance: source(BOT_SHADOW_RISK_SOURCES.accountRiskSourceId), accountStateKnown: true,
    availableMarginInr: Decimal.max(0, new Decimal(capital.equityInr).minus(capital.lockedMarginInr).minus(sum(active.map(row => row.marginInr)))).toFixed(),
    lockedMarginInr: capital.lockedMarginInr, currentEquityInr: capital.equityInr, peakEquityInr: capital.peakEquityInr,
    dailyPnl: capital.dailyPnl, consecutiveLossCount: capital.consecutiveLossCount, cooldownActiveUntilMs: capital.cooldownActiveUntilMs,
    accountMaxLeverage: null, reconciliationSourceIds: ['OPERATOR_FUNDED_SHADOW_LEDGER_V1'] });
  const exposureSnapshot = sealBotRiskEvidence<PortfolioExposureSnapshot>({ accountId: capital.accountFingerprint,
    globalOpenNotionalInr: '0', perPairOpenNotionalInr: {}, perStrategyOpenNotionalInr: {}, concurrentOpenPositions: 0,
    pending: { status: 'KNOWN', globalPendingNotionalInr: sum(active.map(row => row.notionalInr)), pairPendingNotionalInr: group(row => row.pair),
      strategyPendingNotionalInr: group(row => row.strategyId), instancePendingReservations: instances, pendingReservationCount: active.length,
      pendingDirectionalNotionalInr: { longInr: sum(active.filter(row => row.direction === 'LONG').map(row => row.notionalInr)),
        shortInr: sum(active.filter(row => row.direction === 'SHORT').map(row => row.notionalInr)) } },
    provenance: source(BOT_SHADOW_RISK_SOURCES.exposureSourceId) });
  const pairSnapshot = sealBotRiskEvidence<PairRiskSnapshot>({ pair: instrument.pair, instrumentSpecSnapshotId: botInstrumentSnapshotId(instrument),
    status: instrument.status.toUpperCase(), exitOnly: instrument.exitOnly !== false, priceIncrement: instrument.priceIncrement.toFixed(),
    quantityIncrement: instrument.quantityIncrement.toFixed(), minPrice: instrument.minPrice.toFixed(), maxPrice: instrument.maxPrice.toFixed(),
    minQuantity: instrument.minQuantity.toFixed(), maxQuantity: instrument.maxQuantity.toFixed(), minTradeSize: instrument.minTradeSize.toFixed(),
    minNotional: instrument.minNotional.toFixed(), maxNotional: null, contractMultiplier: instrument.unitContractValue.toFixed(), position: { state: 'FLAT' },
    ownership: { status: 'RECONCILED', positionState: 'FLAT', accountId: capital.accountFingerprint, pair: instrument.pair, positionId: null, instanceOwnership: [] },
    provenance: source(BOT_SHADOW_RISK_SOURCES.pairRiskSourceId) });
  return { scope: 'OPERATOR_SHADOW', accountSnapshot, exposureSnapshot, pairSnapshot, settlementRateSnapshot: input.settlement,
    leverageTierSnapshot: createBotInteriorLeverageSnapshot(instrument, input.instrumentObservedAtMs) };
}
