import type { InstrumentMetadata } from '../coin-runtime';
import { isFuturesEventStrategy } from '../integration/coindcx/live/futures-strategies';
import { atr as wilderAtr, macroTrendGates, costGate } from '../integration/coindcx/live/strategy-gates';
import { Decimal } from '../core/decimal/decimal';
import type { RestCandleRecord } from '../market-data/rest-candle-reader';
import { HistoricalStrategySession, strategyParameters, protectivePrices, roundTripCostFraction, timeframeResolution, VirtualFillBook, virtualContract } from '../integration/coindcx/live/practical-backtest-runner';
import { BOT_SHADOW_RISK_SOURCES, evaluateBotRisk, sealBotRiskEvidence } from '../integration/coindcx/live/practical-bot-evaluation';
import { createBotShadowRiskState } from '../integration/coindcx/live/practical-bot-shadow-risk';
import { sha256CanonicalJson, type EntryStopProposal, type RiskDecision, type SettlementConversionSnapshot } from '../risk';
import type { StrategyDecision, StrategyKernel } from '../strategies';
import { auditWorkspace, alertWorkspace, workspaceId, paperSessionSchema, type PaperSession, type WorkspaceState } from './workspace-store';
import { restoreCandle, storeCandle } from './workspace-data';

/** Builds M7 projections from THIS virtual book only; no venue account evidence or live authority is inferred. */
function paperRisk(session: PaperSession, kernel: StrategyKernel, decision: StrategyDecision, instrument: InstrumentMetadata,
  settlement: SettlementConversionSnapshot, now: number, price: Decimal, instrumentObservedAtMs: number, signalAtr?: number | null): RiskDecision | null {
  const book = new VirtualFillBook(session.config, Number(settlement.rateInrPerUsdt), session.book), p = book.state.position;
  const equity = book.mark(price), sources = BOT_SHADOW_RISK_SOURCES, accountId = session.id;
  const today = new Date(now).toISOString().slice(0, 10), daily = session.fills.filter(f => new Date(f.timestampMs).toISOString().startsWith(today));
  const gross = daily.reduce((sum, f) => sum.plus(f.grossPnlInr), new Decimal(0)), fees = daily.reduce((sum, f) => sum.plus(f.feeInr), new Decimal(0));
  const locked = p ? new Decimal(p.marginUsedInr) : new Decimal(0);
  const funding = [...book.state.trades.flatMap(t => t.events), ...(p?.events ?? [])].filter(e => e.type === 'FUNDING_SETTLEMENT' && new Date(e.timestampMs).toISOString().startsWith(today))
    .reduce((sum, e) => sum.plus(String(e.details['fundingCashflowInr'] ?? 0)), new Decimal(0));
  let state = createBotShadowRiskState({ capital: { accountFingerprint: accountId, initialEquityInr: String(session.config.capitalInr), equityInr: equity.toFixed(),
    peakEquityInr: Decimal.max(equity, session.peakEquityInr).toFixed(), lockedMarginInr: locked.toFixed(), createdAtMs: session.createdAtMs,
    dailyPnl: { realizedTradingPnlInr: gross.toFixed(), feesInr: fees.toFixed(), fundingPnlInr: funding.toFixed(), otherAccountAdjustmentsInr: '0', netDailyPnlInr: gross.minus(fees).plus(funding).toFixed() },
    consecutiveLossCount: session.consecutiveLossCount, cooldownActiveUntilMs: null, reservations: [] },
    instrument, instrumentObservedAtMs, evaluationTimeMs: now, settlement, positions: [], allowOfflineFlat: true });
  if (p && state.pairSnapshot && state.exposureSnapshot) {
    const unit = price.times(p.contractMultiplier).times(book.inrPerUsdt).toDecimalPlaces(8), notional = unit.times(p.quantity);
    const owner = String(p.events[0]?.details['strategyInstanceId']);
    state = { ...state, pairSnapshot: sealBotRiskEvidence({ ...state.pairSnapshot,
      position: { state: 'OPEN', positionId: `${session.id}-position`, positionDirection: p.side, quantityMagnitude: p.quantity,
        valuation: { valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt', valuationPriceUsdt: price.toFixed(),
          valuationPriceSourceId: sources.pairRiskSourceId, valuationPriceSourceTimeMs: decision.evaluationTimeMs, valuationPriceObservedAtMs: now,
          contractMultiplier: p.contractMultiplier, conversionMarket: settlement.conversionMarketId, conversionRateInrPerUsdt: settlement.rateInrPerUsdt,
          conversionSourceId: sources.conversionSourceId, unitValuationInrPerQty: unit.toFixed(), aggregateCurrentNotionalInr: notional.toFixed() } },
      ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId, pair: instrument.pair, positionId: `${session.id}-position`, instanceOwnership: [{
        strategyInstanceId: owner, strategyId: kernel.strategyId, strategyVersion: kernel.strategyVersion, parameterHash: kernel.parameterHash,
        currentQuantity: p.quantity, currentNotionalInr: notional.toFixed() }] } }),
      exposureSnapshot: sealBotRiskEvidence({ ...state.exposureSnapshot, globalOpenNotionalInr: notional.toFixed(), concurrentOpenPositions: 1,
        perPairOpenNotionalInr: { [instrument.pair]: notional.toFixed() }, perStrategyOpenNotionalInr: { [kernel.strategyId]: notional.toFixed() } }) };
  }
  let entryStopProposal: EntryStopProposal | undefined;
  if (decision.targetExposure && decision.targetExposure !== 'FLAT' && session.config.stopLossMode !== 'NONE') {
    const side = decision.targetExposure, tick = instrument.priceIncrement;
    const entry = price.toNearest(tick, side === 'LONG' ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR);
    const protection = protectivePrices(session.config, entry, new Decimal(session.config.maxOrderNotionalInr), side, signalAtr);
    const stop = new Decimal(protection.stopPrice!).toNearest(tick, side === 'LONG' ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL);
    const content = { proposalPolicyId: 'VIRTUAL_PAPER_CONFIGURED_STOP_V1', sourceStrategyDecisionId: decision.decisionId, pair: instrument.pair,
      entryPriceUsdt: entry.toFixed(), stopPriceUsdt: stop.toFixed(), provenance: { sourceId: sources.pairRiskSourceId, sourceTimeMs: decision.evaluationTimeMs, observedAtMs: now, contentSha256: '' } };
    entryStopProposal = sealBotRiskEvidence({ ...content, proposalId: sha256CanonicalJson(content) });
  }
  // Explicit null behavior: NONE supplies no fictitious stop; M7 may correctly refuse an unprotected entry.
  const explicitState = { ...state, ...(entryStopProposal ? { entryStopProposal } : {}) };
  return evaluateBotRisk({ kernel, decision, instrument, instrumentObservedAtMs, positionObservedAtMs: now, evaluationTimeMs: now,
    maxInr: String(session.config.maxOrderNotionalInr), accountFingerprint: accountId,
    positions: p ? [{ venuePositionId: `${session.id}-position`, pair: instrument.pair, signedQuantity: new Decimal(p.quantity).times(p.side === 'LONG' ? 1 : -1).toFixed() }] : [], state: explicitState }).decision;
}

/** Synchronous transaction body: one queued order, next-open fills, idempotent closed-bar progression. */
export function stepPaperSession(state: WorkspaceState, session: PaperSession, incoming: readonly RestCandleRecord[], instrument: InstrumentMetadata,
  settlement: SettlementConversionSnapshot, now: number, allowEntries: boolean, instrumentObservedAtMs = now, macroSource: readonly RestCandleRecord[] = []): PaperSession {
  if (session.status !== 'RUNNING') throw new Error('PAPER_SESSION_PAUSED');
  const minutes = Number(timeframeResolution[session.config.timeframe]), interval = minutes * 60_000;
  const history = session.candles.map(c => restoreCandle(instrument.pair, c));
  for (const bar of incoming) {
    const previous = history.find(c => c.openTimeMs === bar.openTimeMs);
    if (previous && JSON.stringify(storeCandle(previous)) !== JSON.stringify(storeCandle(bar))) throw new Error('PAPER_CANDLE_REVISION');
    if (!previous) history.push(bar);
  }
  history.sort((a, b) => a.openTimeMs - b.openTimeMs);
  if (!history.length || history.length > 5000) throw new Error('PAPER_HISTORY_LIMIT');
  if (history.some((b, i) => b.pair !== instrument.pair || b.openTimeMs + interval > now || (i > 0 && b.openTimeMs !== history[i - 1]!.openTimeMs + interval))) throw new Error('INCOMPLETE_CANDLE_HISTORY');
  const strategy = new HistoricalStrategySession(instrument.pair, session.config.strategy, minutes, history[0]!.openTimeMs, strategyParameters(session.config));
  const book = new VirtualFillBook(session.config, Number(settlement.rateInrPerUsdt), session.book, virtualContract(instrument, Number(settlement.rateInrPerUsdt)));
  const gateBars = history.map(c => ({ openTimeMs: c.openTimeMs, closeTimeMs: c.openTimeMs + interval,
    open: c.open.toNumber(), high: c.high.toNumber(), low: c.low.toNumber(), close: c.close.toNumber(), volume: c.volume.toNumber() }));
  const atrValues = wilderAtr(gateBars);
  const atrByClose = new Map(history.map((c, i) => [c.openTimeMs + interval, atrValues[i] ?? null]));
  const macro = session.config.use4hTrend100 || session.config.use4hTrend200 ? macroTrendGates(gateBars, macroSource.map(c => ({
    openTimeMs: c.openTimeMs, closeTimeMs: c.openTimeMs + 60_000, open: c.open.toNumber(), high: c.high.toNumber(), low: c.low.toNumber(), close: c.close.toNumber(), volume: c.volume.toNumber() }))) : null;
  const macroByClose = new Map(gateBars.map((c, i) => [c.closeTimeMs, macro?.[i]]));
  let pending: StrategyDecision | null = null;
  const decisions = new Map<string, StrategyDecision>();
  const bootstrap = session.lastProcessedOpenMs === null;
  const syncBook = (): void => { session.book = paperSessionSchema.shape.book.parse(book.state); };
  const recordExit = (trade: NonNullable<ReturnType<VirtualFillBook['exit']>>, orderId: string): void => {
    const event = trade.events.at(-1)!;
    session.fills.push({ id: workspaceId(state, 'fill'), orderId, kind: 'EXIT', side: trade.side, timestampMs: Date.parse(trade.exitTimeIso), price: trade.exitPrice,
      quantity: trade.quantity, feeInr: Number(event.details['feeInr']), grossPnlInr: trade.grossPnlInr, reason: trade.exitReason });
    session.consecutiveLossCount = trade.netPnlInr < 0 ? session.consecutiveLossCount + 1 : 0;
    auditWorkspace(state, now, 'PAPER_EXIT_FILL', session.id, { orderId, reason: trade.exitReason, netPnlInr: trade.netPnlInr });
  };
  const queue = (decision: StrategyDecision | null, price: Decimal): void => {
    if (!decision || decision.status !== 'READY') return;
    if ((session.config.stopLossMode === 'ATR' || session.config.takeProfitMode === 'ATR' || session.config.trailingAtrMult > 0) && atrByClose.get(decision.evaluationTimeMs) == null) return;
    if (book.state.position && (decision.targetExposure === 'FLAT' ? session.config.holdSignalOnZero : !session.config.exitOnOppositeSignal)) return;
    if (!book.state.position && decision.targetExposure && decision.targetExposure !== 'FLAT') {
      const point = macroByClose.get(decision.evaluationTimeMs), long = decision.targetExposure === 'LONG';
      if (now < book.state.nextEntryTimeMs || !isFuturesEventStrategy(session.config.strategy) && (!costGate(atrByClose.get(decision.evaluationTimeMs) ?? null, price.toNumber(), session.config.costGateMult, roundTripCostFraction(session.config))
        || session.config.use4hTrend200 && !(long ? point?.long200 : point?.short200)
        || session.config.use4hTrend100 && !(long ? point?.long100 : point?.short100))) return;
    }
    syncBook();
    const adjusted = book.fillPrice(price, decision.targetExposure === 'SHORT' ? -1 : 1);
    const risk = paperRisk(session, strategy.kernel, decision, instrument, settlement, now, adjusted, instrumentObservedAtMs, atrByClose.get(decision.evaluationTimeMs));
    session.lastRisk = risk;
    if (!risk || risk.status !== 'ACCEPTED') return;
    if (risk.action === 'OPEN' && !allowEntries) return;
    if (risk.action === 'OPEN' && session.config.stopLossMode === 'INR' && new Decimal(session.config.stopLossValue).gt(book.mark(price).times('.0025'))) {
      alertWorkspace(state, now, 'PAPER_STOP_BUDGET_EXCEEDED', 'The configured fixed INR stop exceeds the M7 risk-per-trade budget. No entry is admitted.', session.id); return;
    }
    if (session.orders.some(o => o.status === 'Working')) return;
    const side = risk.action === 'CLOSE' ? book.state.position!.side : decision.targetExposure as 'LONG' | 'SHORT';
    session.orders.push({ id: workspaceId(state, 'paper-order'), status: 'Working', action: risk.action, side, createdAtMs: now, updatedAtMs: now,
      decisionId: decision.decisionId, quantity: risk.approved.approvedQuantity, riskDecisionId: risk.riskDecisionId, reason: null });
  };
  for (const bar of history) {
    const isNew = !bootstrap && bar.openTimeMs > session.lastProcessedOpenMs!;
    if (isNew) {
      book.settleFunding(bar.open, bar.openTimeMs);
      const order = session.orders.find(o => o.status === 'Working');
      const source = order ? decisions.get(order.decisionId) : undefined;
      if (order && source && order.createdAtMs <= bar.openTimeMs) {
        syncBook();
        const risk = paperRisk(session, strategy.kernel, source, instrument, settlement, now, book.fillPrice(bar.open, order.side === 'LONG' ? 1 : -1), instrumentObservedAtMs, atrByClose.get(source.evaluationTimeMs)); session.lastRisk = risk;
        const inrStopTooLarge = session.config.stopLossMode === 'INR' && new Decimal(session.config.stopLossValue).gt(book.mark(bar.open).times('.0025'));
        if ((order.action === 'OPEN' && (!allowEntries || inrStopTooLarge)) || !risk || risk.status !== 'ACCEPTED' || risk.action !== order.action) {
          order.status = 'Cancelled'; order.reason = !allowEntries ? 'OPERATOR_STOPPED' : 'M7_RECHECK_REFUSED';
        } else if (order.action === 'OPEN') {
          if (book.entry(source, bar.open, bar.openTimeMs, risk.approved.approvedQuantity, instrument.unitContractValue.toFixed(), atrByClose.get(source.evaluationTimeMs))) {
            order.status = 'Filled'; order.quantity = risk.approved.approvedQuantity; order.riskDecisionId = risk.riskDecisionId;
            const p = book.state.position!; order.quantity = p.quantity;
            session.fills.push({ id: workspaceId(state, 'fill'), orderId: order.id, kind: 'ENTRY', side: p.side, timestampMs: p.entryTimeMs,
              price: Number(p.entryPrice), quantity: Number(p.quantity), feeInr: Number(p.entryFeeInr), grossPnlInr: 0, reason: 'M7_APPROVED_ENTRY' });
            auditWorkspace(state, now, 'PAPER_ENTRY_FILL', session.id, { orderId: order.id, riskDecisionId: risk.riskDecisionId });
          } else { order.status = 'Cancelled'; order.reason = 'FILL_CAP_OR_CASH_REFUSED'; }
        } else {
          const trade = book.exit(bar.open, bar.openTimeMs, 'SIGNAL_FLAT'); if (trade) { order.status = 'Filled'; recordExit(trade, order.id); }
        }
        order.updatedAtMs = now;
      } else if (order && !source) { order.status = 'Cancelled'; order.updatedAtMs = now; order.reason = 'STALE_DECISION'; }
      const exited = book.protection(bar, bar.openTimeMs + interval);
      if (!exited) book.settleFunding(bar.close, bar.openTimeMs + interval);
      if (exited) {
        const id = workspaceId(state, 'paper-order'); session.orders.push({ id, status: 'Filled', action: 'CLOSE', side: exited.side,
          createdAtMs: bar.openTimeMs + interval, updatedAtMs: now, decisionId: String(exited.events[0]!.details['decisionId']),
          quantity: String(exited.quantity), riskDecisionId: session.orders.filter(o => o.action === 'OPEN' && o.status === 'Filled').at(-1)?.riskDecisionId ?? '',
          reason: 'PROTECTIVE_EXIT_FROM_APPROVED_ENTRY' }); recordExit(exited, id);
      }
    }
    pending = strategy.update(bar, { macroTrend: macroByClose.get(bar.openTimeMs + interval) ?? null }).decision;
    if (pending) decisions.set(pending.decisionId, pending);
    if (isNew) {
      syncBook(); session.lastProcessedOpenMs = bar.openTimeMs;
      session.peakEquityInr = Decimal.max(session.peakEquityInr, book.mark(bar.close)).toFixed();
      if (bar === history.at(-1)) queue(pending, bar.close);
    }
  }
  const last = history.at(-1)!;
  if (bootstrap) { session.lastProcessedOpenMs = last.openTimeMs; queue(pending, last.close); }
  syncBook(); session.candles = history.map(storeCandle); session.lastMarkPriceUsdt = last.close.toFixed(); session.lastFxInrPerUsdt = book.inrPerUsdt;
  session.equityInr = book.mark(last.close).toFixed(); session.unrealizedPnlInr = book.mark(last.close).minus(book.state.cashInr).toFixed();
  session.peakEquityInr = Decimal.max(session.peakEquityInr, session.equityInr).toFixed(); session.updatedAtMs = now;
  const risk = session.lastRisk as RiskDecision | null;
  if (risk?.status === 'REJECTED' && !['NO_CHANGE', 'REVERSAL_DEFERRED'].includes(risk.action)) alertWorkspace(state, now, 'PAPER_M7_REFUSED', risk.primaryReasonCode, session.id);
  return session;
}
