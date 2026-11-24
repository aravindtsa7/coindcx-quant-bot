import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ui = createRequire(path.resolve('package.json'))('./src/dashboard/public/ui-core.js');
const app = fs.readFileSync(path.resolve('src/dashboard/public/app.js'), 'utf8');
const system = fs.readFileSync(path.resolve('src/dashboard/public/system.js'), 'utf8');
const execution = fs.readFileSync(path.resolve('src/dashboard/public/execution.js'), 'utf8');

/** A minimal document boundary exercises view generation and routing, not browser layout. */
class Element {
  textContent = ''; innerHTML = ''; value = ''; hidden = false; className = ''; open = false;
  disabled = false; isConnected = true; dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { toggle: () => false, remove: () => undefined };
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  listeners: Record<string, (e: any) => void> = {};
  addEventListener(name: string, fn: (e: any) => void) { this.listeners[name] = fn; } focus() {} getBoundingClientRect() { return { left: 100, right: 600, top: 100, bottom: 500 }; } close() { this.open = false; } showModal() { this.open = true; }
}
function fixture(populated: boolean, trackedCoins = ['BTC', 'ETH', 'SOL'], syncJob?: Record<string, unknown>) {
  const now = 1_795_290_000_000, step = 900000;
  const candles = Array.from({ length: 120 }, (_, i) => ({ timeMs: now + i * step, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 }));
  const summary = { netPnlInr: 10, grossPnlInr: 12, totalFeesInr: 2, totalTrades: 1, profitFactor: null, winRatePct: 100, maxDrawdownPct: .1 };
  const config = { coin: 'SOL', strategy: 'ema-trend', timeframe: '15m', bars: 120, capitalInr: 5000, maxOrderNotionalInr: 700, parameters: { fastPeriod: 9, slowPeriod: 21 }, stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'INR', takeProfitValue: 20 };
  const reportId = 'bt-' + 'a'.repeat(24);
  const report = { runId: reportId, mode: 'BACKTEST', pair: 'B-SOL_USDT', config, completedAtIso: new Date(now).toISOString(), summary,
    candles, equityCurve: [{ timestampMs: now, equityInr: 5000, drawdownPct: 0 }, { timestampMs: now + step, equityInr: 5010, drawdownPct: .1 }],
    conversion: { inrPerUsdt: 100, source: 'OPERATOR_FIXED' }, assumptions: ['Funding excluded'], trades: [{ tradeId: 'trade-1', side: 'LONG', entryTimeIso: new Date(now).toISOString(), exitTimeIso: new Date(now + step).toISOString(), entryPrice: 100, exitPrice: 102, quantity: .1, grossPnlInr: 12, feeInr: 2, netPnlInr: 10, exitReason: 'TAKE_PROFIT', events: [
      { type: 'SL_TP_ARMED', timestampMs: now, details: { stop: 99, takeProfit: 102, note: '<img src=x onerror=alert(1)>' } },
      { type: 'EXIT_FILL', timestampMs: now + step, details: { reason: 'TAKE_PROFIT' } }] }] };
  const dataset = { id: 'ds-' + 'b'.repeat(24), pair: report.pair, resolution: '15', fromMs: now, toMs: now + step * candles.length, candles,
    quality: { expectedBars: 120, receivedBars: 120, missingBars: 0, missingMinutes: null, duplicateCount: 0, invalidCount: 0, fabricatedCandles: 0, complete: true, gaps: [] } };
  const cell = { coin: 'SOL', parameters: { fastPeriod: 9, slowPeriod: 21 }, rank: 1, summary, status: 'COMPLETED', runId: reportId };
  const validation = { id: 'validation-000000000001', costStressMultiplier: 2, foldPolicy: 'Chronological', byPair: [{ pair: report.pair, selectedOnTrain: 1, candidates: [{ rank: 1, parameters: cell.parameters,
    folds: ['TRAIN', 'OOS', 'HOLDOUT'].map((name, i) => ({ name, bars: 40, fromMs: now + i * 40 * step, toMs: now + (i + 1) * 40 * step, runId: reportId, summary })), costStress: summary }] }] };
  const paperOrder = { id: 'paper-order-1', action: 'OPEN', status: 'Filled', side: 'LONG', quantity: '1', createdAtMs: now, updatedAtMs: now + step, decisionId: 'd1', riskDecisionId: 'r1', reason: null };
  const sampleSession = { id: 'paper-000000000001', name: 'Virtual', config, equityInr: '5010', unrealizedPnlInr: '10', status: 'PAUSED', createdAtMs: now, updatedAtMs: now + step, fills: [
    { id: 'fill-1', orderId: paperOrder.id, kind: 'ENTRY', side: 'LONG', timestampMs: now + step, price: 100, quantity: 1, feeInr: 2, grossPnlInr: 0, reason: 'M7_APPROVED_ENTRY' }],
    lastProcessedOpenMs: now, lastMarkPriceUsdt: '101', lastFxInrPerUsdt: 100, orders: [paperOrder],
    book: { cashInr: '4998', trades: [], position: { side: 'LONG', quantity: '1', entryPrice: '100', contractMultiplier: '.1', stopPrice: '99', takeProfitPrice: '102', events: [
      { type: 'DECISION_RECORDED', timestampMs: now, details: { decisionId: 'd1' } }, { type: 'ENTRY_FILL', timestampMs: now + step, details: { price: 100 } }, { type: 'SL_TP_ARMED', timestampMs: now + step, details: { stopPrice: 99 } }] } },
    lastRisk: { status: 'ACCEPTED', action: 'OPEN', primaryReasonCode: 'APPROVED', auditTrail: [{ step: 1, name: 'Policy', outcome: 'PASS', reasonCodes: [] }] } };
  const workspace: any = { trackedCoins, settings: { defaultCoin: 'SOL', timezone: 'Asia/Calcutta', language: 'en' }, operations: { admissionStopped: false, reason: '' },
    datasets: populated ? [{ ...dataset, bars: 120, complete: true, missingBars: 0 }] : [],
    savedStrategies: populated ? [{ id: 'strategy-1', name: '<script>alert(1)</script>', strategy: 'ema-trend', timeframe: '15m', parameters: config.parameters, slMode: 'PERCENT', slValue: 1, tpMode: 'INR', tpValue: 20, updatedAtMs: now }] : [],
    paperSessions: populated ? [sampleSession] : [],
    paperOrders: [], paperPositions: [], alerts: populated ? [{ id: 'alert-1', code: 'M7_REFUSED', severity: 'WARNING', message: '<script>alert(1)</script>', scope: 'SOL', createdAtMs: now, acknowledgedAtMs: null }] : [],
    auditLog: populated ? [{ id: 'audit-1', timestampMs: now, action: 'PAPER_SESSION_CREATED', scope: sampleSession.id, details: { capitalInr: 5000 } }] : [], jobs: [], backtestReports: [], busy: null,
    paperPolicies: populated ? [{ sessionId: sampleSession.id, policy: { riskPolicyId: 'policy-1', modeConfig: { riskPerTradePercent: '.25', maxConcurrentExposureInr: '700', maxConcurrentPositions: 1, maxDailyLossInr: '700' } } }] : [],
    shadowHistory: populated ? [{ runId: 'sh-' + 'c'.repeat(24), mode: 'SHADOW', savedAtIso: new Date(now).toISOString(), passes: [{ readLatencyMs: 500, observedAtMs: now }], summary: { status: 'COMPLETED', strategy: 'ema-trend' } }] : [],
    rateBudget: { connected: true, started: 2, pending: 0, inFlight: 0, admission: 'OPEN', unknown: false, pacing: { startsPerSecond: 1, startsPerMinute: 20, concurrency: 1 },
      traffic: [{ timestampMs: now, starts: 1 }, { timestampMs: now + 1000, starts: 2 }], scopes: { PUBLIC: { acquisitions: 2, started: 2, inFlight: 0, pending: 0, refused: 0 } } }, researchRuns: populated ? [
      { id: 'matrix-1', type: 'MATRIX', createdAtMs: now, result: { id: 'matrix-1', cells: [cell], ranked: [cell] } },
      { id: validation.id, type: 'VALIDATION', createdAtMs: now, result: validation }] : [],
    shadowReport: populated ? { account: { status: 'OBSERVED_CONVERGENCE', passes: [{ ordersSha256: 'abc', positionsSha256: 'def' }] }, cycles: [{ markets: [{ underlying: 'SOL', pair: report.pair, maxLeverage: 20 }], pairSummaries: [{ pair: report.pair, signal: 'LONG', minNotionalInr: 612, observedLeverageTiers: [{ leverage: '20', maxPositionSizeUsdt: '5000' }], riskReasonCodes: [], riskDecision: { status: 'APPROVED', auditTrail: [{ step: 'DECISION' }] } }] }] } : null };
  const reports = populated ? [{ runId: reportId, mode: 'BACKTEST', savedAtIso: new Date(now).toISOString(), summary, config, pair: report.pair }] : [];
  workspace.connections = { rest: { credentialsConfigured: populated, fingerprintPrefix: populated ? 'abcdef012345…' : null,
    accountStatus: populated ? 'OBSERVED_CONVERGENCE' : 'NOT_OBSERVED', http: { lastHttpStatus: populated ? 200 : null, source: 'FUTURES_CONVERSIONS' } },
    stream: { currentState: 'STOPPED', lastObservedState: populated ? 'AUTH_JOIN_SENT' : 'NOT_OBSERVED', epoch: null },
    storage: { local: { status: 'VERIFIED' }, mysqlConfigured: false, prismaSchemaPresent: true } };
  if (populated) workspace.shadowReport.account.records = { orders: [{ exchangeOrderId: 'venue-1', pair: report.pair, side: 'BUY', venueStatus: 'open', orderedQuantity: '2', filledQuantity: '0', providerCreatedAtMs: now, providerEventTimeMs: now + step }], positions: [], truncated: false };
  const elements = new Map<string, Element>(), buttons: Element[] = [], windowListeners: Record<string, () => void> = {}, documentListeners: Record<string, (e: any) => void> = {};
  const element = (selector: string) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector)!; };
  const location = { hash: '#overview' };
  let stepBarrier: Promise<void> | null = null, releaseStep: (() => void) | undefined;
  workspace.syncJobStatus = syncJob;
  let failSyncPoll = false;
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/data/sync/status' && failSyncPoll) { failSyncPoll = false; return { ok: false, status: 503, json: async () => ({ error: 'TEMPORARY_STATUS_FAILURE' }) }; }
    let mutation: any;
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      if (url.endsWith('/step')) { if (stepBarrier) await stepBarrier; mutation = workspace.paperSessions[0]; }
      else if (url.endsWith('/toggle')) { workspace.paperSessions[0].status = body.running ? 'RUNNING' : 'PAUSED'; mutation = workspace.paperSessions[0]; }
      else if (url === '/api/paper/sessions') { mutation = { ...structuredClone(sampleSession), id: 'paper-000000000002', name: body.name, config: body, status: 'RUNNING' }; workspace.paperSessions.push(mutation); }
      else if (url.endsWith('/ack')) { workspace.alerts[0].acknowledgedAtMs = now; mutation = workspace.alerts[0]; }
      else if (url === '/api/settings') { workspace.settings = { ...workspace.settings, ...body }; mutation = workspace.settings; }
      else if (url === '/api/catalog/coins') { if (!workspace.trackedCoins.includes('XRP')) workspace.trackedCoins.push('XRP'); mutation = { added: true, trackedCoins: workspace.trackedCoins }; }
      else if (url === '/api/backtest/run') { report.config = { ...report.config, ...body }; mutation = report; }
      else if (url === '/api/strategies') { mutation = { id: 'strategy-futures-test', updatedAtMs: now, ...body }; workspace.savedStrategies.push(mutation); }
      else if (url === '/api/data/sync') {
        workspace.syncJobStatus = { jobId: 'job-ui-test', status: 'RUNNING', coin: 'SOL', pair: 'B-SOL_USDT', operation: 'BACKFILL',
          completedChunks: 0, totalChunks: 3, percentComplete: 0, candlesFetched: 0, etaSeconds: null, message: 'Preparing missing candle chunks…', error: null };
        workspace.busy = 'DATA_SYNC'; mutation = { jobId: 'job-ui-test', status: 'RUNNING' };
      }
      else if (url === '/api/data/sync/cancel') { workspace.syncJobStatus.message = 'Cancelling after the current chunk is saved…'; mutation = workspace.syncJobStatus; }
      else if (url.startsWith('/api/operations/')) { workspace.operations = { admissionStopped: url.endsWith('/stop'), reason: body.reason, updatedAtMs: now }; mutation = workspace.operations; }
    }
    const value = mutation || (url === '/api/workspace' ? workspace : url === '/api/status' ? { readiness: { shadowReady: true, liveLocked: true, credentialsConfigured: false } }
      : url === '/api/evidence' ? { entries: reports.map(r => ({ id: r.runId, title: r.runId, kind: r.mode, source: '.local/reports', sha256: 'a'.repeat(64), integrity: 'VERIFIED', timestamp: new Date(now).toISOString() })), persistence: { status: 'VERIFIED' }, authorityChanges: 0 } : url.startsWith('/api/evidence/') ? { liveLocked: true, report } : url === '/api/reports' ? { reports } : url.startsWith('/api/reports/') ? report : url.startsWith('/api/data/datasets/') ? dataset
      : url.startsWith('/api/catalog/coins?') ? { coins: [{ underlying: 'XRP', pair: 'B-XRP_USDT', lotSize: '.1', tickSize: '.01', maxLeverage: '20', alreadyTracked: workspace.trackedCoins.includes('XRP') }], total: 1, limit: 6, offset: 0, hasMore: false }
      : url.startsWith('/api/candles?') ? { pair: report.pair, candles, overlays: candles.map(c => ({ timeMs: c.timeMs, emaFast: c.close, emaSlow: c.open, atr: 2, rsi: 55 })) } : null);
    const syncValue = url === '/api/data/sync/status' ? workspace.syncJobStatus : url === '/api/data/inventory' ? workspace.dataLake : value;
    return { ok: syncValue !== null, status: syncValue ? 200 : 404, json: async () => structuredClone(syncValue) };
  });
  const document = { title: '', documentElement: { lang: 'en' }, querySelector: element, querySelectorAll: (selector: string) => selector === '[data-exec]' ? buttons : selector === '[data-sync-progress]' ? [element('#banner-sync'), element('#modal-sync')] : [], addEventListener: (name: string, fn: (e: any) => void) => { documentListeners[name] = fn; } };
  const window = { WorkspaceUI: ui, addEventListener: (name: string, fn: () => void) => { windowListeners[name] = fn; } };
  class TestFormData { constructor(readonly form: { values: Record<string, string> }) {} entries() { return Object.entries(this.form.values)[Symbol.iterator](); } }
  const context = vm.createContext({ window, document, location, fetch, history: { replaceState: () => undefined }, URLSearchParams, Intl, Date, setTimeout, clearTimeout, FormData: TestFormData });
  vm.runInContext(execution, context);
  vm.runInContext(system, context);
  vm.runInContext(app, context);
  return { element, location, windowListeners, fetch, workspace, document, window, report,
    change: (el: any) => documentListeners['change']!({ target: el }),
    mainClick: (action: string, extra: Record<string, string> = {}) => { const button = new Element(); button.dataset = { action, ...extra }; documentListeners['click']!({ target: { closest: (selector: string) => selector === '[data-action]' ? button : null } }); return button; },
    systemClick: (action: string, id = '') => { const button = new Element(); button.dataset = { system: action, id }; documentListeners['click']!({ target: { closest: (selector: string) => selector === '[data-system]' ? button : null } }); return button; },
    click: (action: string, id = '') => { const button = new Element(); button.dataset = { exec: action, id }; buttons.push(button); documentListeners['click']!({ target: { closest: (selector: string) => selector === '[data-exec]' ? button : null } }); return button; },
    submit: (id: string, values: Record<string, string>) => { const preventDefault = vi.fn(); documentListeners['submit']!({ target: { id, values }, submitter: new Element(), preventDefault }); return preventDefault; },
    failNextSyncPoll: () => { failSyncPoll = true; },
    holdStep: () => { stepBarrier = new Promise<void>(resolve => { releaseStep = resolve; }); }, releaseStep: () => releaseStep?.() };
}

describe('Workspace screen rendering', () => {
  it.each([['supertrend', { atrPeriod: '10', multiplier: '3' }], ['vwap-mean-reversion', { vwapPeriod: '24', bandStdDev: '2' }]] as const)('persists %s presets and carries all futures controls into the backtest request', async (strategy, parameters) => {
    const f = fixture(true);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.location.hash = '#builder'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Futures Margin &amp; Leverage'));
    const values = { name: 'Futures preset', strategy, timeframe: '15m', leverage: '5', marginMode: 'ISOLATED', maintenanceMarginRateBps: '50', liquidationFeeBps: '100',
      trailingStopPct: '1.5', trailingActivationPct: '.5', fundingMode: 'MODELED_FIXED_BPS', fundingRateBpsPer8h: '1', maxOrderNotionalInr: '20000',
      stopLossMode: 'PERCENT', stopLossValue: '1', takeProfitMode: 'PERCENT', takeProfitValue: '3', ...parameters };
    f.submit('builder-form', values);
    await vi.waitFor(() => expect(f.workspace.savedStrategies.some((p: any) => p.id === 'strategy-futures-test')).toBe(true));
    const preset = f.workspace.savedStrategies.find((p: any) => p.id === 'strategy-futures-test');
    expect(preset).toMatchObject({ strategy, leverage: 5, trailingStopPct: 1.5, fundingMode: 'MODELED_FIXED_BPS', fundingRateBpsPer8h: 1 });
    await vi.waitFor(() => expect(f.location.hash).toBe('strategies'));
    f.mainClick('backtest-preset', { id: preset.id }); f.location.hash = '#backtest'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Backtest configuration'));
    const markup = f.element('#view').innerHTML;
    for (const text of ['Futures Margin &amp; Leverage', 'Trailing Stop-Loss', 'Perpetual Funding Model', '1.5', 'Modeled 8h Rate (bps)']) expect(markup).toContain(text);
    expect(markup).toContain(strategy === 'supertrend' ? 'Multiplier' : 'StdDev Band');
    f.submit('backtest-form', { ...values, coin: 'SOL', selection: preset.id, bars: '120', capitalInr: '5000', takerFeeBps: '5', spreadBps: '1', stopSlippageBps: '5' });
    await vi.waitFor(() => expect(f.location.hash).toBe('results'));
    const body = JSON.parse(f.fetch.mock.calls.find(([url]) => url === '/api/backtest/run')![1]!.body!);
    expect(body).toMatchObject({ strategy, leverage: 5, marginMode: 'ISOLATED', maintenanceMarginRateBps: 50, trailingStopPct: 1.5,
      trailingActivationPct: .5, fundingMode: 'MODELED_FIXED_BPS', fundingRateBpsPer8h: 1, maxOrderNotionalInr: 20000 });
  });
  it('updates live margin previews and funding-rate enablement when futures controls change', async () => {
    const f = fixture(true); await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    const preview = new Element(), rate = new Element(), mode = new Element(); mode.value = 'EXCLUDED';
    const form = { values: { leverage: '5', maintenanceMarginRateBps: '50', maxOrderNotionalInr: '20000', fundingMode: 'EXCLUDED' },
      querySelector: () => preview, elements: { namedItem: (key: string) => key === 'fundingMode' ? mode : rate } };
    f.change({ name: 'leverage', form, dataset: {}, matches: () => false });
    expect(preview.innerHTML).toContain('4,000'); expect(preview.innerHTML).toContain('19.50%'); expect(rate.disabled).toBe(true);
    mode.value = 'MODELED_FIXED_BPS'; form.values.fundingMode = mode.value;
    f.change({ name: 'fundingMode', form, dataset: {}, matches: () => false }); expect(rate.disabled).toBe(false);
  });
  it('renders enriched result metrics, exit colors and funding settlement rows without claiming observed historical funding', async () => {
    const f = fixture(true);
    Object.assign(f.report.config, { leverage: 5, fundingMode: 'MODELED_FIXED_BPS', fundingRateBpsPer8h: 1 });
    Object.assign(f.report.summary, { totalFundingInr: -2, liquidationCount: 2, avgMarginRoiPct: 5, fundingLabel: 'Modeled @ 1 bps/8h' });
    Object.assign(f.report.trades[0]!, { leverage: 5, marginUsedInr: 200, liquidationPrice: 80.5, fundingInr: -2, marginRoiPct: 5, exitReason: 'LIQUIDATION' });
    f.report.trades[0]!.events.push({ type: 'FUNDING_SETTLEMENT', timestampMs: Date.now(), details: { fundingCashflowInr: -2 } } as any);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.location.hash = '#results'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Avg Margin ROI %'));
    for (const text of ['Total Funding ₹', 'Liquidations', '5x', 'Modeled @ 1 bps/8h', 'Margin ₹', 'Liq Price', 'ROI %', 'pill red']) expect(f.element('#view').innerHTML).toContain(text);
    f.location.hash = '#ledger'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('FUNDING_SETTLEMENT'));
    expect(f.element('#view').innerHTML).toContain('LIQUIDATION'); expect(f.element('#view').innerHTML).toContain('fundingCashflowInr');
  });
  it('polls progress in the banner and open modal, refreshes inventory, and keeps cancellation active during a download', async () => {
    const f = fixture(false);
    f.workspace.dataLake = { coins: [{ underlying: 'SOL', pair: 'B-SOL_USDT', candleCount: 0, gapCount: 0, gaps: [], coverageDays: 0, sizeMb: 0, lotSize: '1', syncStatus: 'EMPTY' }], summary: {} };
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.location.hash = '#data'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Historical Data Inventory'));
    f.mainClick('history-backfill', { coin: 'SOL' });
    f.submit('history-form', { coin: 'SOL', historyMode: 'DAYS', days: '30' });
    await vi.waitFor(() => expect(f.element('#modal-sync').innerHTML).toContain('Cancel Job'));
    expect(f.element('#history-dialog').open).toBe(true);
    const submit = f.fetch.mock.calls.find(([url]) => url === '/api/data/sync')!;
    expect(JSON.parse(submit[1]!.body!)).toEqual({ action: 'backfill', coin: 'SOL', days: 30 });
    Object.assign(f.workspace.syncJobStatus, { completedChunks: 1, candlesFetched: 1000, percentComplete: 33, etaSeconds: 2 });
    Object.assign(f.workspace.dataLake.coins[0], { candleCount: 1000, coverageDays: 1000 / 1440, sizeMb: .1 });
    await vi.waitFor(() => expect(f.element('#banner-sync').innerHTML).toContain('Chunk 1 / 3 (33%)'), { timeout: 2000 });
    expect(f.element('#modal-sync').innerHTML).toContain('value="33"');
    expect(f.element('#modal-sync').innerHTML).toContain('ETA 2s');
    await vi.waitFor(() => expect(f.element('#history-inventory').innerHTML).toContain('1,000'));
    f.mainClick('sync-cancel');
    await vi.waitFor(() => expect(f.fetch.mock.calls.some(([url]) => url === '/api/data/sync/cancel')).toBe(true));
    expect(f.element('#modal-sync').innerHTML).toContain('Cancelling');
    Object.assign(f.workspace.syncJobStatus, { status: 'CANCELLED', message: 'Sync cancelled. All downloaded chunks are saved.' });
    await vi.waitFor(() => expect(f.element('#toast').textContent).toContain('Sync cancelled'), { timeout: 2000 });
    expect(f.element('#modal-sync').innerHTML).not.toContain('Cancel Job');
    const polls = f.fetch.mock.calls.filter(([url]) => url === '/api/data/sync/status').length;
    await new Promise(resolve => setTimeout(resolve, 850));
    expect(f.fetch.mock.calls.filter(([url]) => url === '/api/data/sync/status')).toHaveLength(polls);
  }, 10000);
  it('reattaches to running jobs after reload and retries a failed status poll before showing completion', async () => {
    const job = { jobId: 'restored-job', status: 'RUNNING', pair: 'B-SOL_USDT', operation: 'BACKFILL', completedChunks: 1,
      totalChunks: 3, candlesFetched: 1000, percentComplete: 33, etaSeconds: 1, error: null, message: 'Downloading saved job' };
    const f = fixture(false, ['BTC', 'ETH', 'SOL'], job);
    f.workspace.dataLake = { coins: [], summary: {} };
    await vi.waitFor(() => expect(f.element('#modal-sync').innerHTML).toContain('Chunk 1 / 3'));
    f.failNextSyncPoll();
    await vi.waitFor(() => expect(f.element('#notice').textContent).toContain('Retrying automatically'), { timeout: 2000 });
    expect(f.element('#modal-sync').innerHTML).toContain('Cancel Job');
    Object.assign(f.workspace.syncJobStatus, { status: 'COMPLETED', percentComplete: 100, completedChunks: 3, candlesFetched: 2500, message: 'Sync completed. All downloaded chunks are saved.' });
    await vi.waitFor(() => expect(f.element('#toast').textContent).toContain('Sync completed'), { timeout: 2000 });
    expect(f.element('#modal-sync').innerHTML).toContain('value="100"');
  }, 10000);
  it('synchronizes Days presets with UTC dates and unlocks date fields for Custom', async () => {
    const f = fixture(true);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    const fields = new Map(['lookbackMode', 'days', 'fromDate', 'toDate'].map(name => [name, { value: name === 'days' ? '3' : name === 'lookbackMode' ? 'DAYS' : '', readOnly: true }]));
    const form = { elements: { namedItem: (name: string) => fields.get(name) } };
    fields.get('days')!.value = '90';
    f.change({ dataset: {}, form, matches: (selector: string) => selector === '[data-days]' });
    const from = fields.get('fromDate')!, to = fields.get('toDate')!;
    expect(Date.parse(to.value) - Date.parse(from.value)).toBe(90 * 86400000);
    expect(to.value).toBe(new Date().toISOString().slice(0, 10)); expect(from.readOnly).toBe(true);
    fields.get('lookbackMode')!.value = 'CUSTOM';
    f.change({ dataset: {}, form, matches: (selector: string) => selector === '[data-lookback]' });
    expect(from.readOnly).toBe(false); expect(to.readOnly).toBe(false); expect(fields.get('days')!.value).toBe('CUSTOM');
  });
  it('propagates a tracked XRP across research, markets, paper, and onboarding selectors', async () => {
    const f = fixture(true, ['BTC', 'ETH', 'SOL', 'XRP']);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    for (const route of ['markets', 'instrument', 'builder', 'matrix', 'backtest', 'validation', 'paper-deploy', 'onboarding', 'data']) {
      f.location.hash = `#${route}`; f.windowListeners['hashchange']!();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.element('#view').innerHTML, route).toContain('XRP');
    }
    const markup = f.element('#view').innerHTML;
    for (const label of ['Coins Tracked', 'Total 1m Candles', 'Disk Storage (MB)', 'Global Sync Status', 'Historical Data Inventory', 'Coverage (Days)', 'Gaps &amp; Health', 'Repair']) expect(markup).toContain(label);
  });
  it('opens the searchable catalog and adds XRP without reloading the application', async () => {
    const f = fixture(false);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.mainClick('catalog-open');
    expect(f.element('#catalog-dialog').open).toBe(true);
    await vi.waitFor(() => expect(f.element('#catalog-results').innerHTML).toContain('B-XRP_USDT'));
    f.mainClick('catalog-add', { pair: 'B-XRP_USDT' });
    await vi.waitFor(() => expect(f.workspace.trackedCoins).toContain('XRP'));
    await vi.waitFor(() => expect(f.element('#catalog-results').innerHTML).toContain('Tracked'));
    f.location.hash = '#backtest'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('value="XRP"'));
  });
  it.each(['DAYS', 'CUSTOM'])('submits %s UTC windows alongside percent/INR protection', async lookbackMode => {
    const f = fixture(true);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.submit('backtest-form', { coin: 'SOL', selection: 'ema-trend', timeframe: '15m', lookbackMode, days: '3', fromDate: '2026-11-19', toDate: '2026-11-22', capitalInr: '5000', maxOrderNotionalInr: '700', fastPeriod: '9', slowPeriod: '21', stopLossMode: 'PERCENT', stopLossValue: '1', takeProfitMode: 'INR', takeProfitValue: '20', takerFeeBps: '5', spreadBps: '1', stopSlippageBps: '5' });
    await vi.waitFor(() => expect(f.location.hash).toBe('results'));
    const call = f.fetch.mock.calls.find(([url, init]) => url === '/api/backtest/run' && init?.method === 'POST');
    const body = JSON.parse(call![1]!.body!);
    expect(body).toMatchObject({ fromDate: '2026-11-19', toDate: '2026-11-22', bars: 300, stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'INR', takeProfitValue: 20 });
    if (lookbackMode === 'DAYS') expect(body.days).toBe(3); else expect(body).not.toHaveProperty('days');
  });
  it.each([false, true])('renders all 42 routes with %s populated data and escapes evidence', async populated => {
    const f = fixture(populated);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    for (const screen of ui.screens) {
      f.location.hash = `#${screen.id}`; f.windowListeners['hashchange']!();
      await vi.waitFor(() => expect(f.element('#page-title').textContent).toBe(screen.title));
      // Hydration uses immediately resolved JSON promises in this document boundary.
      await new Promise<void>(resolve => setImmediate(resolve));
      const markup = f.element('#view').innerHTML;
      expect(markup.length, screen.id).toBeGreaterThan(40);
      expect(markup, screen.id).not.toMatch(/(?:value="undefined"|>undefined<)/);
      expect(markup, screen.id).not.toContain('<script>alert(1)</script>');
      expect(markup, screen.id).not.toContain('<img src=x onerror=alert(1)>');
      if (populated && screen.id === 'quality') expect(markup).toContain('Not observable at this resolution');
      if (populated && screen.id === 'ledger') { expect(markup).toContain('SL_TP_ARMED'); expect(markup).toContain('&lt;img'); }
      if (populated && screen.id === 'validation') expect(markup).toContain('Gap / purge: 0 bars');
      if (populated && screen.id === 'paper') expect(markup).toContain('Step 1 Candle');
      if (populated && screen.id === 'orders') { expect(markup).toContain('OBS-venue-1'); expect(markup).toContain('paper-order-1'); }
      if (populated && screen.id === 'accounting') { expect(markup).toContain('Unresolved'); expect(markup).toContain('Embedded in modeled fill prices'); }
      if (populated && screen.id === 'connections') { expect(markup).toContain('abcdef012345…'); expect(markup).toContain('AUTH_JOIN_SENT'); expect(markup).toContain('STOPPED'); expect(markup).toContain('FUTURES_CONVERSIONS'); }
      if (screen.id === 'live-review') { expect(markup).toContain('LIVE REMAINS LOCKED'); expect(markup).toContain('OPEN'); expect(markup).toContain('False'); }
      if (populated && screen.id === 'budget') { expect(markup).toContain('REFERENCE · NOT CONFIGURED'); expect(markup).toContain('20'); }
      expect(markup).not.toContain('Full interactive controls arrive');
    }
    expect(f.element('#screen-jumper').innerHTML.match(/<option /g)).toHaveLength(42);
    expect(f.element('#navigation').innerHTML.match(/class="nav-link"/g)).toHaveLength(18);
    expect(f.fetch.mock.calls.some(([url]) => url.includes('/api/candles?'))).toBe(true);
  });
  it('deploys SL/TP and kernel parameters through the paper API and selects the returned session', async () => {
    const f = fixture(true);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.submit('paper-deploy-form', { name: 'ATR research', selection: 'atr-breakout', coin: 'SOL', timeframe: '5m', bars: '200', capitalInr: '125000', maxOrderNotionalInr: '700', atrPeriod: '20', breakoutMultiplier: '2', stopLossMode: 'PERCENT', stopLossValue: '1.25', takeProfitMode: 'INR', takeProfitValue: '50', takerFeeBps: '5', spreadBps: '1', slippageBps: '2', stopSlippageBps: '5' });
    await vi.waitFor(() => expect(f.location.hash).toContain('paper-workspace?session=paper-000000000002'));
    const call = f.fetch.mock.calls.find(([url, init]) => url === '/api/paper/sessions' && init?.method === 'POST');
    const body = JSON.parse(call![1]!.body!);
    expect(body).toMatchObject({ name: 'ATR research', coin: 'SOL', strategy: 'atr-breakout', stopLossMode: 'PERCENT', stopLossValue: 1.25, takeProfitMode: 'INR', takeProfitValue: 50, parameters: { timeframeMinutes: 5, atrPeriod: 20, breakoutMultiplier: '2' } });
    expect(body).not.toHaveProperty('confirmLive'); expect(body).not.toHaveProperty('riskProfile');
  });
  it('pauses/resumes and steps paper while leaving the stop control available during an in-flight job', async () => {
    const f = fixture(true);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.click('toggle', 'paper-000000000001');
    await vi.waitFor(() => expect(f.workspace.paperSessions[0].status).toBe('RUNNING'));
    await new Promise<void>(resolve => setImmediate(resolve));
    f.holdStep(); const step = f.click('step', 'paper-000000000001');
    try {
      await vi.waitFor(() => expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/step'))).toBe(true));
      f.location.hash = '#operations'; f.windowListeners['hashchange']!();
      f.element('#operations-reason').value = 'Operator review'; f.click('stop', 'operations');
      expect(f.element('#stop-dialog').open).toBe(true);
      expect(f.fetch.mock.calls.some(([url]) => url === '/api/operations/stop')).toBe(false);
      f.systemClick('confirm-stop');
      await vi.waitFor(() => expect(f.workspace.operations.admissionStopped).toBe(true));
      await vi.waitFor(() => expect(f.element('#admission-badge').textContent).toBe('ADMISSION STOPPED'));
      expect(f.fetch.mock.calls.some(([url]) => url === '/api/operations/stop')).toBe(true);
      expect(f.workspace.operations.reason).toBe('Operator review');
    } finally { f.releaseStep(); }
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.waitFor(() => expect(step.disabled).toBe(false));
    f.click('resume', 'operations'); await vi.waitFor(() => expect(f.workspace.operations.admissionStopped).toBe(false));
  });
  it('acknowledges alerts without removing underlying evidence and separates observed order detail from paper authority', async () => {
    const f = fixture(true);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.location.hash = '#alerts'; f.windowListeners['hashchange']!(); f.click('ack', 'alert-1');
    await vi.waitFor(() => expect(f.workspace.alerts[0].acknowledgedAtMs).toBeGreaterThan(0));
    expect(f.workspace.alerts[0].code).toBe('M7_REFUSED');
    await new Promise<void>(resolve => setImmediate(resolve));
    f.location.hash = '#order-detail?order=venue-1&source=OBSERVED'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Observed venue status: open'));
    expect(f.element('#view').innerHTML).toContain('No local strategy, M7 approval or ownership is implied');
    expect(f.element('#view').innerHTML).not.toContain('SL/TP armed');
    f.location.hash = '#order-detail?order=paper-order-1&source=PAPER&session=paper-000000000001'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('SL/TP armed'));
  });
  it('opens screen 42 without a mutation and dismisses stop confirmation by cancel or backdrop', async () => {
    const f = fixture(false);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.location.hash = '#stop-confirm'; f.windowListeners['hashchange']!();
    expect(f.element('#stop-dialog').open).toBe(true);
    expect(f.fetch.mock.calls.some(([url]) => url === '/api/operations/stop')).toBe(false);
    f.systemClick('cancel-stop'); expect(f.element('#stop-dialog').open).toBe(false);
    (f.window as any).openStop();
    const dialog = f.element('#stop-dialog');
    dialog.listeners['click']!({ target: dialog, clientX: 150, clientY: 150 });
    expect(dialog.open).toBe(true);
    dialog.listeners['click']!({ target: dialog, clientX: 10, clientY: 10 });
    expect(dialog.open).toBe(false);
    const markup = fs.readFileSync(path.resolve('src/dashboard/public/index.html'), 'utf8');
    expect(markup).toMatch(/<dialog[^>]+id="stop-dialog"[^>]+aria-labelledby="stop-title"[^>]+aria-describedby="stop-description"/);
    expect(markup).toContain('id="stop-cancel" data-system="cancel-stop" autofocus');
    // Escape and focus containment use native modal-dialog behavior, without cancel interception.
    expect(system).not.toMatch(/addEventListener\(['"]cancel/);
  });
  it('saves Tamil preferences, applies new run defaults, and leaves export submissions native', async () => {
    const f = fixture(false);
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('Virtual paper equity'));
    f.submit('settings-form', { language: 'ta', timezone: 'UTC', defaultCoin: 'ETH', defaultEquityInr: '125000', defaultMaxOrderNotionalInr: '900', defaultSlPct: '1.5', defaultTpPct: '3', researchCompletion: 'on' });
    await vi.waitFor(() => expect(f.document.documentElement.lang).toBe('ta'));
    expect(f.workspace.settings.notifications).toEqual({ researchCompletion: true, routineStatus: false });
    f.location.hash = '#backtest'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('value="125000"'));
    expect(f.element('#view').innerHTML).toContain('name="stopLossValue" type="number" value="1.5"');
    expect(f.element('#screen-jumper').innerHTML).toContain('புதிய வரலாற்றுச் சோதனை');
    f.location.hash = '#reports'; f.windowListeners['hashchange']!();
    await vi.waitFor(() => expect(f.element('#view').innerHTML).toContain('action="/api/reports/export" method="get"'));
    const before = f.fetch.mock.calls.length;
    expect(f.submit('export-form', { id: 'workspace-audit', format: 'json' })).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(before);
    expect(f.element('#screen-index-list').innerHTML.match(/class="screen-index-link"/g)).toHaveLength(42);
    expect(f.element('#screen-index-list').innerHTML).toContain('screen-index-group');
  });
});
