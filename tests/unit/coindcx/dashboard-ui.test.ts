import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';

// The same dependency-free view model is executed in the browser and these tests.
const ui = createRequire(path.resolve('package.json'))('./src/dashboard/public/ui-core.js');

describe('42-screen workspace view model', () => {
  it('registers both futures kernels and calculates isolated margin previews without treating leverage as extra notional', () => {
    expect(ui.kernels.map((k: { id: string }) => k.id)).toEqual(expect.arrayContaining(['supertrend', 'vwap-mean-reversion']));
    expect(ui.parameters('supertrend', '15m', {})).toEqual({ timeframeMinutes: 15, atrPeriod: 10, multiplier: '3' });
    expect(ui.parameters('vwap-mean-reversion', '15m', {})).toEqual({ timeframeMinutes: 15, vwapPeriod: 24, bandStdDev: '2' });
    expect(ui.futuresPreview({ maxOrderNotionalInr: 20000, leverage: 5, maintenanceMarginRateBps: 50 })).toEqual({ requiredMarginInr: 4000, liquidationDistancePct: 19.5 });
    expect(ui.futuresPreview({ maxOrderNotionalInr: 20000, leverage: 20, maintenanceMarginRateBps: 500 }).liquidationDistancePct).toBeNull();
    expect(ui.futuresConfig({ leverage: '5', trailingStopPct: '1.5', fundingMode: 'MODELED_FIXED_BPS', fundingRateBpsPer8h: '-1' })).toMatchObject({ leverage: 5, trailingStopPct: 1.5, fundingRateBpsPer8h: -1 });
    expect(ui.fundingLabel({ fundingMode: 'MODELED_FIXED_BPS', fundingRateBpsPer8h: 1 })).toBe('Modeled @ 1 bps/8h');
  });
  it('includes modeled funding once in paper cash curves, daily results, and accounting', () => {
    const now = Date.parse('2026-01-01T08:00:00Z');
    const session = { createdAtMs: now - 3600000, config: { capitalInr: 5000, fundingMode: 'MODELED_FIXED_BPS' }, unrealizedPnlInr: '0', fills: [],
      book: { trades: [], position: { fundingInr: '-2', events: [{ type: 'FUNDING_SETTLEMENT', timestampMs: now, details: { fundingCashflowInr: -2 } }] } } };
    expect(ui.paperCurve({ paperSessions: [session] }).at(-1).equityInr).toBe(4998);
    expect(ui.paperSummary({ settings: { timezone: 'UTC' }, paperSessions: [session] }, now).todayPnl).toBe(-2);
    expect(ui.sessionAccounting(session).funding).toBe(-2);
  });
  it('resolves every design-book screen to a family and the 18 sidebar destinations', () => {
    expect(ui.screens).toHaveLength(42);
    expect(ui.screens.map((s: { id: string }) => s.id)).toEqual([
      'unlock', 'overview', 'markets', 'instrument', 'data', 'quality', 'backfill', 'strategies', 'builder', 'matrix',
      'backtest', 'results', 'ledger', 'validation', 'rankings', 'paper', 'paper-workspace', 'paper-deploy', 'orders',
      'order-detail', 'positions', 'risk', 'readiness', 'recovery', 'shadow', 'operations', 'alerts', 'audit', 'lineage',
      'budget', 'connections', 'settings', 'live-review', 'onboarding', 'allocation', 'accounting', 'news', 'reports',
      'position-detail', 'empty', 'connection-error', 'stop-confirm'
    ]);
    expect(new Set(ui.screens.map((s: { id: string }) => s.id)).size).toBe(42);
    const destinations = new Set(ui.nav.flatMap((g: [string, [string][]]) => g[1].map(link => link[0])));
    expect(destinations.size).toBe(18);
    for (const screen of ui.screens) {
      expect(ui.family(screen.id)).toContain(screen.id);
      if (screen.id !== 'unlock') expect(destinations.has(ui.parent(screen.id)), screen.id).toBe(true);
    }
    expect(ui.screens[12].id).toBe('ledger'); expect(ui.screens[41].id).toBe('stop-confirm');
  });
  it('never paints missing, duplicate or invalid bars as verified coverage', () => {
    const step = 60000;
    const candles = Array.from({ length: 56 }, (_, i) => ({ timeMs: i * step, open: '10', high: '12', low: '9', close: '11', volume: '1' }));
    candles.splice(3, 1); // second bin has a missing minute
    candles.push({ ...candles[4]! }); // third bin has a duplicate
    candles[8]!.high = '8'; // invalid OHLC in fifth bin
    const cells = ui.coverage({ resolution: '1', fromMs: 0, toMs: 56 * step, candles });
    expect(cells).toHaveLength(28);
    expect(cells[0].status).toBe('verified'); expect(cells[1].status).toBe('gap');
    expect(cells[2].status).toBe('gap'); expect(cells[4].status).toBe('gap');
    expect(cells.reduce((n: number, c: { expected: number }) => n + c.expected, 0)).toBe(56);
    expect(ui.coverage(null).every((c: { status: string }) => c.status === 'unknown')).toBe(true);
  });
  it('reports virtual realized P&L in the workspace timezone and keeps marks out of the cash curve', () => {
    const now = Date.parse('2026-11-22T01:00:00Z'), start = now - 86400000;
    const workspace = { settings: { timezone: 'Asia/Calcutta' }, paperSessions: [{ status: 'RUNNING', createdAtMs: start,
      config: { capitalInr: 5000 }, equityInr: '5035', unrealizedPnlInr: '25', fills: [
        { timestampMs: Date.parse('2026-11-21T20:00:00Z'), grossPnlInr: '0', feeInr: '2' },
        { timestampMs: now, grossPnlInr: '15', feeInr: '3' },
        { timestampMs: start, grossPnlInr: '0', feeInr: '0' }] }] };
    expect(ui.paperSummary(workspace, now)).toMatchObject({ equity: 5035, todayPnl: 10, active: 1, fees: 5 });
    expect(ui.paperCurve(workspace).at(-1).equityInr).toBe(5010);
    expect(ui.paperCurve({ paperSessions: [] })).toEqual([]);
  });
  it('only computes a 24h change from an actual matching closed bar', () => {
    expect(ui.closedDayChange([{ timeMs: 0, close: 100 }, { timeMs: 86400000, close: 110 }])).toBeCloseTo(10);
    expect(ui.closedDayChange([{ timeMs: 0, close: 100 }, { timeMs: 3600000, close: 110 }])).toBeNull();
  });
  it('maps presets to exact kernel parameters and recalculates timeframe bindings', () => {
    expect(ui.parameters('atr-breakout', '5m', { atrPeriod: '20', breakoutMultiplier: '2', fastPeriod: 3 })).toEqual({ atrPeriod: 20, breakoutMultiplier: '2', timeframeMinutes: 5 });
    expect(ui.parameters('multi-timeframe-trend', '1h', { fastPeriod: '7', slowPeriod: '28', timeframes: [15, 60] })).toMatchObject({ fastPeriod: 7, slowPeriod: 28, timeframes: [60, 240] });
    expect(ui.parameters('rsi-momentum', '1m', { period: '10' })).toMatchObject({ period: 10, longThreshold: '55', timeframeMinutes: 1 });
  });
  it('searches nested exit events and accepts older reports without event steps', () => {
    expect(ui.tradeMatches({ tradeId: '1', events: [{ details: { exitReason: 'STOP_LOSS' } }] }, 'stop_loss')).toBe(true);
    expect(ui.tradeMatches({ tradeId: '1', side: 'LONG' }, 'SL_TP_ARMED')).toBe(false);
  });
  it('parses the browser entrypoint without a bundler', () => {
    const source = fs.readFileSync(path.resolve('src/dashboard/public/app.js'), 'utf8');
    expect(() => new vm.Script(source)).not.toThrow();
    expect(source).not.toContain('confirmLive: true');
  });
  it('keeps venue observations separate from virtual ownership and does not fabricate absent records', () => {
    const w = { paperSessions: [{ id: 'paper-1', name: 'virtual', config: { coin: 'SOL' }, orders: [{ id: 'p1', status: 'Working' }] }],
      shadowReport: { account: { records: { orders: [{ exchangeOrderId: 'v1', venueStatus: 'open', orderedQuantity: '2' }] } } } };
    expect(ui.allOrders(w)).toMatchObject([{ source: 'PAPER', sessionId: 'paper-1', displayId: 'p1' }, { source: 'OBSERVED', sessionId: null, displayId: 'OBS-v1', quantity: '2' }]);
    expect(ui.allOrders({ shadowReport: { account: { passes: [{ orderCount: 10 }] } } })).toEqual([]);
  });
  it('requires actual FX, multiplier and mark for exposure and never double-counts embedded execution costs', () => {
    expect(ui.positionExposure({ quantity: '2', contractMultiplier: '.1' }, '100', 100)).toBe(2000);
    expect(ui.positionExposure({ quantity: '2', contractMultiplier: '.1' }, '100', null)).toBeNull();
    expect(ui.positionExposure({ quantity: '2' }, '100', 100)).toBeNull();
    expect(ui.sessionAccounting({ unrealizedPnlInr: '7', fills: [{ grossPnlInr: 20, feeInr: 2 }, { grossPnlInr: 0, feeInr: 1 }] })).toEqual({ realizedGross: 20, fees: 3, unrealized: 7, funding: null, transfers: null, executionCosts: 'EMBEDDED_IN_FILL_PRICES' });
  });
  it('only records protection arming for the linked actual entry, never for a working order alone', () => {
    const order = { id: 'p1', decisionId: 'd1', riskDecisionId: 'r1', createdAtMs: 100, updatedAtMs: 110, status: 'Working' };
    expect(ui.orderTimeline({ fills: [], book: { position: null, trades: [] } }, order).map((e: { title: string }) => e.title)).not.toContain('SL/TP armed');
    const events = [{ type: 'DECISION_RECORDED', timestampMs: 90, details: { decisionId: 'd1' } }, { type: 'SL_TP_ARMED', timestampMs: 120, details: { stopPrice: 99 } }];
    expect(ui.orderTimeline({ fills: [], book: { position: { events }, trades: [] } }, order).filter((e: { title: string }) => e.title === 'SL/TP armed')).toHaveLength(1);
    order.decisionId = 'unrelated'; expect(ui.orderTimeline({ book: { position: { events } } }, order).map((e: { title: string }) => e.title)).not.toContain('SL/TP armed');
  });
  it('filters alert impact, acknowledgement and scope without treating acknowledgement as resolution', () => {
    const alerts = [{ code: 'M7_REFUSED', message: 'check risk', scope: 'SOL', severity: 'WARNING', acknowledgedAtMs: null }, { code: 'OTHER', message: 'check', scope: 'BTC', severity: 'CRITICAL', acknowledgedAtMs: 12 }];
    expect(ui.filterAlerts(alerts, 'WARNING', 'OPEN', 'sol')).toEqual([alerts[0]]);
    expect(ui.filterAlerts(alerts, 'ALL', 'ACKNOWLEDGED', '')).toEqual([alerts[1]]);
    expect(alerts[0]!.acknowledgedAtMs).toBeNull();
  });
});
