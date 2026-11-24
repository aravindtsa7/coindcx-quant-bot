import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { FUTURES_STRATEGY_DEFAULTS } from '../../../src/integration/coindcx/live/futures-strategies';

const ui = createRequire(path.resolve('package.json'))('./src/dashboard/public/ui-core.js');
/** Exercise the actual application handlers with a small DOM boundary and no network. */
function fixture() {
  const listeners: Record<string, (event: any) => void> = {}, elements = new Map<string, any>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', value: '', hidden: false, dataset: {},
      setAttribute() {}, addEventListener() {}, classList: { toggle() {}, remove() {} }, focus() {} });
    return elements.get(selector);
  };
  const window: any = { WorkspaceUI: ui, addEventListener() {} };
  const document = { querySelector: element, querySelectorAll: () => [], documentElement: { lang: 'en' },
    addEventListener: (name: string, fn: (event: any) => void) => { listeners[name] = fn; } };
  class FormData { constructor(readonly form: { values: Record<string, string> }) {} entries() { return Object.entries(this.form.values); } }
  const context = vm.createContext({ window, document, location: { hash: '#backtest' }, Intl, Date, URLSearchParams, FormData,
    setTimeout: () => 0, clearTimeout() {}, fetch: vi.fn(() => { throw new Error('UNEXPECTED_FETCH'); }) });
  vm.runInContext(fs.readFileSync('src/dashboard/public/execution.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/dashboard/public/system.js', 'utf8'), context);
  let C: any, execution: any;
  const factory = window.WorkspaceExecution;
  window.WorkspaceExecution = (input: any) => { C = input; execution = factory(input); return execution; };
  // Startup network hydration is covered by the existing rendering suite; retain every actual handler.
  vm.runInContext(fs.readFileSync('src/dashboard/public/app.js', 'utf8').replace('  void start();', ''), context);
  C.S.workspace = { settings: { defaultCoin: 'ETH', timezone: 'UTC' }, savedStrategies: [], paperSessions: [], datasets: [],
    auditLog: [], alerts: [], researchRuns: [], operations: { admissionStopped: false }, backtestReports: [] };
  C.S.connected = true;
  const form = (strategy = 'ema-trend') => {
    const values: Record<string, string> = Object.fromEntries(Object.entries({ ...ui.futuresDefaults, selection: strategy, strategy,
      timeframe: '15m', coin: 'ETH', bars: 300, capitalInr: 5000, maxOrderNotionalInr: 20000, stopLossMode: 'PERCENT', stopLossValue: 1,
      takeProfitMode: 'PERCENT', takeProfitValue: 2, takerFeeBps: 5, spreadBps: 1, stopSlippageBps: 5 }).map(([k, v]) => [k, String(v)]));
    const parameters = { innerHTML: '' }, preview = { innerHTML: '' }, controls = new Map<string, any>();
    const result: any = { id: 'backtest-form', values, querySelector: (selector: string) => selector === '[data-parameters]' ? parameters : preview,
      querySelectorAll: () => [], elements: { namedItem: (key: string) => {
        if (!Object.hasOwn(values, key)) return null;
        if (!controls.has(key)) controls.set(key, { get value() { return values[key]; }, set value(v) { values[key] = String(v); }, disabled: false, required: false });
        return controls.get(key);
      } } };
    return { ...result, parameters };
  };
  const click = (index: number, form: any) => listeners['click']!({ target: { closest: (selector: string) => selector === '[data-action]'
    ? { dataset: { action: 'starter-preset', index: String(index) }, closest: () => form } : null } });
  const selectKernel = (strategy: string, form: any) => listeners['change']!({ target: { value: strategy, form, dataset: {},
    matches: (selector: string) => selector === '[data-preset-select]' } });
  return { C, execution, element, form, click, selectKernel };
}

describe('Four futures strategies in the dependency-free dashboard', () => {
  it('registers identical defaults in the library and all research/paper selectors with dynamic parameter controls', () => {
    const f = fixture();
    for (const [id, defaults] of Object.entries(FUTURES_STRATEGY_DEFAULTS)) {
      const k = ui.kernels.find((k: any) => k.id === id); expect(k).toBeDefined();
      expect({ ...k.defaults, ...k.gates }).toEqual(defaults);
      const markup = f.C.parameterFields(id);
      for (const key of Object.keys(k.defaults)) expect(markup).toContain(`name="${key}"`);
      expect(ui.strategyDefaults(id).holdSignalOnZero).toBe(true);
      for (const route of ['strategies', 'builder', 'backtest', 'matrix', 'validation']) {
        f.C.S.route = route; f.C.render(); expect(f.element('#view').innerHTML).toContain(id);
      }
      expect(f.execution.views['paper-deploy']()).toContain(id);
    }
    f.C.S.route = 'backtest'; f.C.render();
    for (const p of ui.starterPresets) expect(f.element('#view').innerHTML).toContain(p.label);
    expect(f.element('#view').innerHTML).toContain('LIVE LOCKED');
  });
  it.each([0, 1, 2, 3])('starter %s fills actual form values and submits its exact protection, parameters and gates', index => {
    const f = fixture(), form = f.form(), preset = ui.starterPresets[index];
    f.click(index, form);
    const payload = f.C.backtestPayload(form);
    expect(payload).toMatchObject({ strategy: preset.strategy, timeframe: preset.timeframe, stopLossMode: preset.stopLossMode,
      stopLossValue: preset.stopLossValue, takeProfitMode: preset.takeProfitMode, takeProfitValue: preset.takeProfitValue,
      holdSignalOnZero: true, breakevenAt1R: true, gstRatePct: 18, use4hTrend100: preset.use4hTrend100,
      use4hTrend200: preset.use4hTrend200, costGateMult: preset.costGateMult });
    expect(payload.parameters).toMatchObject(ui.kernels.find((k: any) => k.id === preset.strategy).defaults);
    if (index === 3) expect(payload).toMatchObject({ slAtrMult: 2, tpRrMultiple: 2 });
    expect(payload.coin).toBe('ETH'); expect(payload.capitalInr).toBe(5000);
    expect(form.parameters.innerHTML).toContain('name=');
  });
  it('kernel selection applies neutral holding and macro/cost defaults, and parses boolean ADX inputs correctly', () => {
    const f = fixture(), form = f.form();
    for (const k of ui.futuresKernels) {
      f.selectKernel(k.id, form);
      expect(ui.futuresConfig(form.values)).toMatchObject({ ...k.gates, holdSignalOnZero: true });
      for (const key of Object.keys(k.defaults)) expect(form.parameters.innerHTML).toContain(`name="${key}"`);
    }
    expect(ui.parameters('bb_squeeze_adx', '1h', { adxRising: 'false' }).adxRising).toBe(false);
    f.selectKernel('ema-trend', form); expect(form.values.holdSignalOnZero).toBe('false');
  });
});
