import { BacktestDecimal, InMemoryBacktestDatasetSource, computeBacktestFundingScheduleContentSha256, type BacktestFundingEvent, type BacktestFundingSchedule } from '../../../../src/backtest';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { candles, datasetManifest, resources } from './helpers';

export function fundingEvent(fundingTimeMs: number, fundingRate = '0.01'): BacktestFundingEvent {
  return { fundingTimeMs, fundingRate: new BacktestDecimal(fundingRate), referencePrice: new BacktestDecimal('100') };
}

export function fundingSource(pair: string, events: readonly BacktestFundingEvent[]): BacktestFundingSchedule {
  return { sourceId: `verified-${pair}-funding-v1`, fidelity: 'VERIFIED_SCHEDULE', contentSha256: computeBacktestFundingScheduleContentSha256(events), events };
}

export function fundedResource(pair: string, events: readonly BacktestFundingEvent[], count = 24) {
  // Integer fixture prices create a persistent EMA long signal and actual exposure
  // in every analysis window; all financial calculations use production Decimal.
  const rows = candles(pair, count).map((row, index) => createCanonicalCandle1m({ ...row,
    open: String(100 + index), high: String(101 + index), low: String(99 + index), close: String(100 + index),
  }));
  return { ...resources(pair), datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource(`b2-${pair}`, rows), fundingSchedule: fundingSource(pair, events) };
}

export function reloadFunding(schedule: BacktestFundingSchedule): BacktestFundingSchedule {
  const serialized = JSON.parse(JSON.stringify(schedule)) as { sourceId: string; contentSha256: string; fidelity: BacktestFundingSchedule['fidelity']; events: { fundingTimeMs: number; fundingRate: string; referencePrice: string }[] };
  return { ...serialized, events: serialized.events.map((event) => ({ ...event, fundingRate: new BacktestDecimal(event.fundingRate), referencePrice: new BacktestDecimal(event.referencePrice) })) };
}
