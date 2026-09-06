import type { HistoricalDatasetManifest } from '../market-data/historical';
import type { CanonicalCandle1m } from '../market-data/types';
import type { HigherTimeframeCandle } from '../market-data/higher-timeframe/types';
import type { IndicatorKernel, IndicatorPoint } from '../indicators/types';
import type { BacktestDecimal } from './decimal';
import type { BacktestErrorCode } from './errors';

export type BacktestRunState = 'CREATED' | 'VALIDATING' | 'REPLAYING' | 'COMPLETED' | 'FAILED';
export type BacktestOrderType = 'MARKET' | 'POST_ONLY_LIMIT' | 'STOP_MARKET';
export type BacktestOrderSide = 'BUY' | 'SELL';
export type BacktestOrderState = 'PENDING_ACTIVATION' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';
export type BacktestPositionSide = 'FLAT' | 'LONG' | 'SHORT';
export type BacktestFeeClass = 'MAKER' | 'TAKER';
export type BacktestFundingFidelity = 'VERIFIED_SCHEDULE' | 'ASSUMPTION' | 'TEST_ONLY';

export interface BacktestInstrumentSpec {
  readonly pair: string;
  readonly priceIncrement: BacktestDecimal;
  readonly quantityIncrement: BacktestDecimal;
  readonly minQuantity: BacktestDecimal;
  readonly minTradeSize: BacktestDecimal;
  readonly minNotional: BacktestDecimal;
  readonly contractMultiplier: BacktestDecimal;
  readonly instrumentSpecSnapshotId: string;
}

export interface BacktestCostModel {
  readonly makerFeeRate: BacktestDecimal;
  readonly takerFeeRate: BacktestDecimal;
  readonly halfSpreadBps: BacktestDecimal;
  readonly marketSlippageBps: BacktestDecimal;
  readonly stopSlippageBps: BacktestDecimal;
}

export interface BacktestFundingEvent {
  readonly fundingTimeMs: number;
  readonly fundingRate: BacktestDecimal;
  readonly referencePrice: BacktestDecimal;
}

export interface BacktestFundingSchedule {
  readonly sourceId: string;
  readonly contentSha256: string;
  readonly fidelity: BacktestFundingFidelity;
  readonly events: readonly BacktestFundingEvent[];
}

export interface BacktestParticipantIdentity {
  readonly participantId: string;
  readonly participantVersion: string;
  readonly parameterHash: string;
  readonly gitCommitHash: string;
}

export interface BacktestIndicatorBinding<T = unknown> {
  readonly key: string;
  readonly timeframeMinutes: number;
  readonly kernel: IndicatorKernel<T>;
}

export interface BacktestOrderIntent {
  readonly pair: string;
  readonly type: BacktestOrderType;
  readonly side: BacktestOrderSide;
  readonly quantity: BacktestDecimal | string;
  readonly limitPrice?: BacktestDecimal | string;
  readonly stopPrice?: BacktestDecimal | string;
  readonly reduceOnly?: boolean;
  readonly ocoGroupId?: string;
}

export interface BacktestActionBatch {
  readonly cancelOrderIds?: readonly string[];
  readonly submitOrders?: readonly BacktestOrderIntent[];
}

export interface BacktestPositionSnapshot {
  readonly side: BacktestPositionSide;
  readonly quantity: BacktestDecimal;
  readonly averageEntryPrice: BacktestDecimal | null;
  readonly markPrice: BacktestDecimal | null;
  readonly unrealizedGrossPnl: BacktestDecimal;
}

export interface BacktestEquitySnapshot {
  readonly initialEquity: BacktestDecimal;
  readonly equity: BacktestDecimal;
  readonly realizedGrossPnl: BacktestDecimal;
  readonly unrealizedGrossPnl: BacktestDecimal;
  readonly makerFees: BacktestDecimal;
  readonly takerFees: BacktestDecimal;
  readonly totalFees: BacktestDecimal;
  readonly fundingPnl: BacktestDecimal;
  readonly spreadCostAttribution: BacktestDecimal;
  readonly slippageCostAttribution: BacktestDecimal;
  readonly netPnl: BacktestDecimal;
}

export interface BacktestOrderSnapshot {
  readonly orderId: string;
  readonly orderSequence: number;
  readonly pair: string;
  readonly type: BacktestOrderType;
  readonly side: BacktestOrderSide;
  readonly quantity: BacktestDecimal;
  readonly limitPrice: BacktestDecimal | null;
  readonly stopPrice: BacktestDecimal | null;
  readonly reduceOnly: boolean;
  readonly ocoGroupId: string | null;
  readonly state: BacktestOrderState;
  readonly submittedAtMs: number;
  readonly rejectionCode: BacktestErrorCode | null;
}

export interface BacktestEvaluationContext {
  readonly simulationTimeMs: number;
  readonly latestClosed1mCandle: CanonicalCandle1m;
  readonly latestClosedCandleByTimeframe: ReadonlyMap<number, CanonicalCandle1m | HigherTimeframeCandle>;
  readonly candlesClosedAtThisTimestamp: readonly (CanonicalCandle1m | HigherTimeframeCandle)[];
  readonly latestIndicatorPointByKey: ReadonlyMap<string, IndicatorPoint<unknown>>;
  readonly currentPosition: BacktestPositionSnapshot;
  readonly accountEquity: BacktestEquitySnapshot;
  readonly openOrders: readonly BacktestOrderSnapshot[];
}

export interface BacktestParticipantAdapter {
  onEvaluation(context: BacktestEvaluationContext): Promise<BacktestActionBatch> | BacktestActionBatch;
}

export interface BacktestRunManifest {
  readonly schemaVersion: 1;
  readonly venue: 'COINDCX';
  readonly market: 'FUTURES';
  readonly pair: string;
  readonly datasetId: string;
  readonly datasetContentSha256: string;
  readonly bootstrapFromInclusiveMs: number;
  readonly evaluationFromInclusiveMs: number;
  readonly evaluationToExclusiveMs: number;
  readonly replayToExclusiveMs: number;
  readonly configuredTimeframes: readonly number[];
  readonly instrumentSpecSnapshotId: string;
  readonly costModel: {
    readonly makerFeeRate: string;
    readonly takerFeeRate: string;
    readonly halfSpreadBps: string;
    readonly marketSlippageBps: string;
    readonly stopSlippageBps: string;
  };
  readonly fundingSchedule: {
    readonly sourceId: string;
    readonly contentSha256: string;
    readonly fidelity: BacktestFundingFidelity;
  };
  readonly intrabarAmbiguityPolicy: 'ADVERSE_FIRST';
  readonly maxOpenOrders: number;
  readonly engineSemanticVersion: string;
  readonly participant: BacktestParticipantIdentity;
  readonly initialEquity: string;
}

export type BacktestEventType =
  | 'DATASET_VERIFIED'
  | 'REPLAY_STARTED'
  | 'CANDLE_CLOSED'
  | 'INDICATOR_UPDATED'
  | 'ORDER_ACCEPTED'
  | 'ORDER_ACTIVATED'
  | 'ORDER_REJECTED'
  | 'ORDER_CANCELLATION_ACCEPTED'
  | 'ORDER_CANCELLED'
  | 'ORDER_FILLED'
  | 'TRADE_CLOSED'
  | 'POSITION_UPDATED'
  | 'ACCOUNT_MARKED'
  | 'FUNDING_APPLIED'
  | 'EVALUATION_COMPLETED'
  | 'RUN_COMPLETED';

export interface BacktestEvent {
  readonly sequence: number;
  readonly eventTimeMs: number;
  readonly type: BacktestEventType;
  readonly runId: string;
  readonly entityId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface BacktestEventSink {
  write(event: BacktestEvent): Promise<void> | void;
}

export interface BacktestDatasetSource {
  readonly sourceIdentity: string;
  readonly immutable: true;
  getRange(pair: string, fromInclusiveMs: number, toInclusiveMs: number): Promise<readonly CanonicalCandle1m[]>;
  assertIdentity?(expectedSourceIdentity: string): Promise<void> | void;
}

export interface BacktestEngineConfig {
  readonly datasetManifest: HistoricalDatasetManifest;
  readonly datasetSource: BacktestDatasetSource;
  readonly bootstrapFromInclusiveMs: number;
  readonly evaluationFromInclusiveMs: number;
  readonly evaluationToExclusiveMs: number;
  readonly replayToExclusiveMs: number;
  readonly configuredTimeframes?: readonly number[];
  readonly instrumentSpec: BacktestInstrumentSpec;
  readonly costModel: BacktestCostModel;
  readonly fundingSchedule: BacktestFundingSchedule;
  readonly indicatorBindings?: readonly BacktestIndicatorBinding[];
  readonly participant: BacktestParticipantAdapter;
  readonly participantIdentity: BacktestParticipantIdentity;
  readonly initialEquity: BacktestDecimal | string;
  readonly intrabarAmbiguityPolicy?: 'ADVERSE_FIRST';
  readonly maxOpenOrders?: number;
  readonly engineSemanticVersion?: string;
  readonly verificationPageMinutes?: number;
}

export interface BacktestFidelityDisclosure {
  readonly marketDataFidelity: 'CANONICAL_1M';
  readonly executionFidelity: 'CONSERVATIVE_1M_OHLCV';
  readonly partialFillModel: 'NOT_MODELED_PHASE9';
  readonly queueModel: 'NOT_MODELED_PHASE9';
  readonly riskEngine: 'NOT_APPLIED_PHASE9';
  readonly leverageModel: 'NOT_MODELED_PHASE9';
  readonly liquidationModel: 'NOT_MODELED_PHASE9';
  readonly fundingFidelity: BacktestFundingFidelity;
}

export interface BacktestFinancialSummary {
  readonly initialEquity: BacktestDecimal;
  readonly finalEquity: BacktestDecimal;
  readonly realizedGrossPnl: BacktestDecimal;
  readonly unrealizedGrossPnl: BacktestDecimal;
  readonly netPnl: BacktestDecimal;
  readonly makerFees: BacktestDecimal;
  readonly takerFees: BacktestDecimal;
  readonly totalFees: BacktestDecimal;
  readonly fundingPnl: BacktestDecimal;
  readonly spreadCostAttribution: BacktestDecimal;
  readonly slippageCostAttribution: BacktestDecimal;
}

export interface BacktestResultHashPayload {
  readonly runId: string;
  readonly terminalStatus: 'COMPLETED' | 'FAILED';
  readonly isValid: boolean;
  readonly pair: string;
  readonly datasetId: string;
  readonly timeRange: {
    readonly bootstrapFromInclusiveMs: number;
    readonly evaluationFromInclusiveMs: number;
    readonly evaluationToExclusiveMs: number;
    readonly replayToExclusiveMs: number;
  };
  readonly financialSummary: BacktestFinancialSummary;
  readonly fidelity: BacktestFidelityDisclosure;
  readonly totalFills: number;
  readonly totalClosedTrades: number;
  readonly terminalPosition: BacktestPositionSnapshot | null;
  readonly terminalOpenOrders: readonly BacktestOrderSnapshot[];
  readonly eventLedgerSha256: string;
}

export interface BacktestRunResult extends BacktestResultHashPayload {
  readonly terminalStatus: 'COMPLETED';
  readonly isValid: true;
  readonly resultSha256: string;
  readonly terminalError?: never;
}

export interface BacktestFailedRunResult {
  readonly runId: string | null;
  readonly terminalStatus: 'FAILED';
  readonly isValid: false;
  readonly terminalError: string;
  readonly errorCode: BacktestErrorCode;
  readonly eventLedgerSha256?: never;
  readonly resultSha256?: never;
}

export type BacktestRunOutcome = BacktestRunResult | BacktestFailedRunResult;

export interface BacktestFillSnapshot {
  readonly fillId: string;
  readonly orderId: string;
  readonly orderSequence: number;
  readonly eventTimeMs: number;
  readonly side: BacktestOrderSide;
  readonly quantity: BacktestDecimal;
  readonly fillPrice: BacktestDecimal;
  readonly rawReferencePrice: BacktestDecimal;
  readonly feeClass: BacktestFeeClass;
  readonly fee: BacktestDecimal;
  readonly realizedGrossPnl: BacktestDecimal;
  readonly closingQuantity: BacktestDecimal;
  readonly spreadCostAttribution: BacktestDecimal;
  readonly slippageCostAttribution: BacktestDecimal;
}
