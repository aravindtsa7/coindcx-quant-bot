import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PracticalBacktestRunner, parseBacktestConfig } from '../src/integration/coindcx/live/practical-backtest-runner';
import { DashboardReportStore } from '../src/dashboard/report-store';
import { startPracticalReadRuntime } from './practical-read-runtime';
import { WorkspaceStore } from '../src/dashboard/workspace-store';

export function parseBacktestArguments(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, allowNegative: true, options: {
    coin: { type: 'string', default: 'SOL' }, timeframe: { type: 'string', default: '15m' }, strategy: { type: 'string', default: 'ema-trend' },
    bars: { type: 'string', default: '300' }, 'capital-inr': { type: 'string', default: '5000' }, 'max-inr': { type: 'string', default: '700' },
    days: { type: 'string' }, 'from-date': { type: 'string' }, 'to-date': { type: 'string' }, 'from-ms': { type: 'string' }, 'to-ms': { type: 'string' },
    'fee-bps': { type: 'string', default: '5' }, 'maker-fee-bps': { type: 'string', default: '2' }, 'slippage-bps': { type: 'string', default: '2' },
    liquidity: { type: 'string', default: 'TAKER' }, 'inr-per-usdt': { type: 'string' }, 'end-time-ms': { type: 'string' },
    'sl-mode': { type: 'string', default: 'none' }, 'sl-value': { type: 'string', default: '0' },
    'tp-mode': { type: 'string', default: 'none' }, 'tp-value': { type: 'string', default: '0' },
    'spread-bps': { type: 'string', default: '1' }, 'stop-slippage-bps': { type: 'string', default: '5' },
    leverage: { type: 'string', default: '3' }, 'margin-mode': { type: 'string', default: 'ISOLATED' },
    'maintenance-margin-rate-bps': { type: 'string', default: '50' }, 'liquidation-fee-bps': { type: 'string', default: '100' },
    'trailing-stop-pct': { type: 'string', default: '0' }, 'trailing-activation-pct': { type: 'string', default: '0' },
    'sl-atr-mult': { type: 'string', default: '2' }, 'sl-min-pct': { type: 'string', default: '0.8' }, 'sl-max-pct': { type: 'string', default: '4' },
    'tp-atr-mult': { type: 'string', default: '3' }, 'tp-rr-multiple': { type: 'string', default: '2' }, 'trailing-atr-mult': { type: 'string', default: '0' },
    'breakeven-at-1r': { type: 'boolean', default: false }, 'sizing-mode': { type: 'string', default: 'FIXED_NOTIONAL' },
    'risk-per-trade-pct': { type: 'string', default: '2' }, 'gst-rate-pct': { type: 'string', default: '0' }, 'cooldown-bars': { type: 'string', default: '0' },
    'exit-on-opposite-signal': { type: 'boolean', default: true }, 'hold-signal-on-zero': { type: 'boolean' },
    'use-4h-trend-200': { type: 'boolean' }, 'use-4h-trend-100': { type: 'boolean' },
    'cost-gate-mult': { type: 'string' }, 'rt-cost': { type: 'string' },
    'funding-mode': { type: 'string' }, 'funding-rate-bps-per-8h': { type: 'string' },
    'swing-lookback': { type: 'string' }, 'max-pierce-atr': { type: 'string' }, 'wick-ratio': { type: 'string' }, 'rvol-min': { type: 'string' },
    'rsi-period': { type: 'string' }, 'rsi-max-long': { type: 'string' }, 'rsi-min-short': { type: 'string' }, 'sweep-window': { type: 'string' },
    'body-ratio': { type: 'string' }, 'bb-period': { type: 'string' }, 'bb-std': { type: 'string' }, 'rvol-climax': { type: 'string' },
    'rsi-long-max': { type: 'string' }, 'rsi-short-min': { type: 'string' }, 'ema-filter': { type: 'string' }, 'adx-max': { type: 'string' },
    'squeeze-q': { type: 'string' }, 'squeeze-lookback': { type: 'string' }, 'adx-min': { type: 'string' }, 'adx-rising': { type: 'boolean' }, 'vol-mult': { type: 'string' },
    'atr-period': { type: 'string' }, multiplier: { type: 'string' }, 'vwap-period': { type: 'string' }, 'band-std-dev': { type: 'string' },
  } });
  const config = parseBacktestConfig({ coin: values.coin?.toUpperCase(), timeframe: values.timeframe, strategy: values.strategy, bars: Number(values.bars),
    leverage: Number(values.leverage), marginMode: values['margin-mode']?.toUpperCase(), maintenanceMarginRateBps: Number(values['maintenance-margin-rate-bps']),
    liquidationFeeBps: Number(values['liquidation-fee-bps']), trailingStopPct: Number(values['trailing-stop-pct']), trailingActivationPct: Number(values['trailing-activation-pct']),
    ...(values['funding-mode'] === undefined ? {} : { fundingMode: values['funding-mode'].toUpperCase() }),
    ...(values['funding-rate-bps-per-8h'] === undefined ? {} : { fundingRateBpsPer8h: Number(values['funding-rate-bps-per-8h']) }),
    slAtrMult: Number(values['sl-atr-mult']), slMinPct: Number(values['sl-min-pct']), slMaxPct: Number(values['sl-max-pct']),
    tpAtrMult: Number(values['tp-atr-mult']), tpRrMultiple: Number(values['tp-rr-multiple']), trailingAtrMult: Number(values['trailing-atr-mult']),
    breakevenAt1R: values['breakeven-at-1r'], sizingMode: values['sizing-mode']?.toUpperCase(), riskPerTradePct: Number(values['risk-per-trade-pct']),
    gstRatePct: Number(values['gst-rate-pct']), cooldownBars: Number(values['cooldown-bars']), exitOnOppositeSignal: values['exit-on-opposite-signal'],
    holdSignalOnZero: values['hold-signal-on-zero'], use4hTrend200: values['use-4h-trend-200'], use4hTrend100: values['use-4h-trend-100'],
    ...(values['cost-gate-mult'] === undefined ? {} : { costGateMult: Number(values['cost-gate-mult']) }), ...(values['rt-cost'] === undefined ? {} : { rtCost: Number(values['rt-cost']) }),
    parameters: { ...Object.fromEntries(Object.entries({ swingLookback: values['swing-lookback'], maxPierceAtr: values['max-pierce-atr'],
      wickRatio: values['wick-ratio'], rvolMin: values['rvol-min'], rsiPeriod: values['rsi-period'], rsiMaxLong: values['rsi-max-long'], rsiMinShort: values['rsi-min-short'],
      sweepWindow: values['sweep-window'], bodyRatio: values['body-ratio'], bbPeriod: values['bb-period'], bbStd: values['bb-std'], rvolClimax: values['rvol-climax'],
      rsiLongMax: values['rsi-long-max'], rsiShortMin: values['rsi-short-min'], emaFilter: values['ema-filter'], adxMax: values['adx-max'],
      squeezeQ: values['squeeze-q'], squeezeLookback: values['squeeze-lookback'], adxMin: values['adx-min'], volMult: values['vol-mult'] })
      .filter(([, value]) => value !== undefined).map(([key, value]) => [key, Number(value)])),
      ...(values['adx-rising'] === undefined ? {} : { adxRising: values['adx-rising'] }), ...(values['atr-period'] === undefined ? {} : { atrPeriod: Number(values['atr-period']) }),
      ...(values.multiplier === undefined ? {} : { multiplier: values.multiplier }), ...(values['vwap-period'] === undefined ? {} : { vwapPeriod: Number(values['vwap-period']) }),
      ...(values['band-std-dev'] === undefined ? {} : { bandStdDev: values['band-std-dev'] }) },
    stopLossMode: values['sl-mode']?.toUpperCase(), stopLossValue: Number(values['sl-value']), takeProfitMode: values['tp-mode']?.toUpperCase(),
    takeProfitValue: Number(values['tp-value']), spreadBps: Number(values['spread-bps']), stopSlippageBps: Number(values['stop-slippage-bps']),
    capitalInr: Number(values['capital-inr']), maxOrderNotionalInr: Number(values['max-inr']), takerFeeBps: Number(values['fee-bps']),
    makerFeeBps: Number(values['maker-fee-bps']), slippageBps: Number(values['slippage-bps']), fillLiquidity: values.liquidity?.toUpperCase(),
    ...(values['inr-per-usdt'] === undefined ? {} : { inrPerUsdt: Number(values['inr-per-usdt']) }),
    ...(values.days === undefined ? {} : { days: Number(values.days) }),
    ...(values['from-date'] === undefined ? {} : { fromDate: values['from-date'] }),
    ...(values['to-date'] === undefined ? {} : { toDate: values['to-date'] }),
    ...(values['from-ms'] === undefined ? {} : { fromMs: Number(values['from-ms']) }),
    ...(values['to-ms'] === undefined ? {} : { toMs: Number(values['to-ms']) }),
    ...(values['end-time-ms'] === undefined ? {} : { endTimeMs: Number(values['end-time-ms']) }) });
  return config;
}
async function main(): Promise<void> {
  const config = parseBacktestArguments(process.argv.slice(2));
  const root = path.resolve(__dirname, '../.local');
  (await WorkspaceStore.open(root)).assertTracked(config.coin);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const runtime = await startPracticalReadRuntime();
  try {
    const report = await new PracticalBacktestRunner({ client: runtime.client, nowMs: () => runtime.clock.nowMs(), signal: controller.signal, archiveRoot: root,
      readInrPerUsdt: async () => Number((await runtime.readSettlementConversion()).rateInrPerUsdt) }).run(config);
    await new DashboardReportStore(root).saveBacktest(report);
    console.log(JSON.stringify({ runId: report.runId, pair: report.pair, sizingMode: report.sizingMode, conversion: report.conversion,
      leverage: report.config.leverage, marginMode: report.config.marginMode, liveLocked: true,
      ...report.summary, reportPath: path.join(root, 'backtest-reports', `${report.runId}.json`) }, null, 2));
  } finally { await runtime.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (require.main === module) void main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'BACKTEST_RUN_FAILED' }));
  process.exitCode = 1;
});
