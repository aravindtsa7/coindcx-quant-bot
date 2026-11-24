/* Shared, dependency-free view model. Also loaded by the navigation/data-quality tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkspaceUI = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const catalog = [
    ['unlock', 'Welcome back', 'Access', 'Open your local research workspace.'],
    ['overview', 'Overview', 'Workspace', 'Your research, paper accounts and system readiness in one place.'],
    ['markets', 'Markets', 'Workspace', 'A focused watchlist for INR-margined perpetual futures.'],
    ['instrument', 'Market Workspace', 'Workspace', 'Closed CoinDCX candles · Quote USDT · Margin INR.'],
    ['data', 'Data Lake', 'Research', 'Find verified datasets, inspect their coverage and understand their source.'],
    ['quality', 'Data Quality', 'Research', 'See what is complete, what is missing and what needs review.'],
    ['backfill', 'Sync & Backfill', 'Research', 'Fetch a bounded history window and retain its integrity evidence.'],
    ['strategies', 'Strategy Library', 'Research', 'Ten shared closed-candle strategy kernels for futures research.'],
    ['builder', 'Strategy Builder', 'Research', 'Configure a named preset with explicit protection and parameters.'],
    ['matrix', 'Research Matrix', 'Research', 'Compare a predeclared strategy, coin and parameter universe.'],
    ['backtest', 'New Backtest', 'Research', 'Choose a strategy, virtual capital and explicit execution costs.'],
    ['results', 'Backtest Results', 'Research', 'Performance, accounting and limitations from a real historical replay.'],
    ['ledger', 'Trade & Event Ledger', 'Research', 'Reconcile every modeled trade to its decision and fill history.'],
    ['validation', 'Research Validation', 'Research', 'Chronological training, out-of-sample evaluation and final holdout.'],
    ['rankings', 'Strategy Rankings', 'Research', 'Pair-local research rankings. Ranking never grants trading permission.'],
    ['paper', 'Paper Accounts', 'Execution', 'Independent virtual balances and ledgers for each research account.'],
    ['paper-workspace', 'Paper Workspace', 'Execution', 'Follow virtual sessions, modeled orders and exposure.'],
    ['paper-deploy', 'Deploy to Paper', 'Execution', 'Inspect research candidates before a future paper deployment.'],
    ['orders', 'Orders', 'Execution', 'Virtual orders remain separate from read-only venue observations.'],
    ['order-detail', 'Order Details', 'Execution', 'Inspect retained paper order state.'],
    ['positions', 'Positions', 'Execution', 'Understand the source and ownership of virtual exposure.'],
    ['risk', 'Risk & Limits', 'Control', 'Inspect M7 decisions and their evidence before new admissions.'],
    ['readiness', 'Sync & Readiness', 'Control', 'Observed agreement is information. It does not grant trading authority.'],
    ['recovery', 'Recovery & Review', 'Control', 'Resolve uncertainty with retained evidence.'],
    ['shadow', 'Shadow Monitor', 'Control', 'Read-only observation cycles with explicit blockers.'],
    ['operations', 'Operations', 'Control', 'Inspect process state and the operator admission latch.'],
    ['alerts', 'Alerts & Notifications', 'Control', 'Actionable workspace issues and their acknowledgement state.'],
    ['audit', 'Audit & Evidence', 'System', 'Trace research decisions to retained evidence.'],
    ['lineage', 'Ownership Diagnostics', 'Control', 'Offline diagnostics do not establish venue ownership.'],
    ['budget', 'Shared Rate Budget', 'Control', 'Managed consumers, pressure and conservative read admission.'],
    ['connections', 'Connections', 'System', 'Inspect the evidence and permissions of each connection.'],
    ['settings', 'Settings', 'System', 'Workspace preferences and display configuration.'],
    ['live-review', 'Live Readiness Review', 'Control', 'Review evidence with all live trading permissions locked.'],
    ['onboarding', 'Coin Onboarding', 'Workspace', 'Instrument discovery, research and separately reviewed execution.'],
    ['allocation', 'Portfolio & Regimes', 'Control', 'Virtual exposure from isolated paper accounts.'],
    ['accounting', 'Accounting & Costs', 'Execution', 'Modeled margin, fees and explicit perpetual funding assumptions.'],
    ['news', 'News & Event Risk', 'Control', 'Event risk requires an explicitly connected source.'],
    ['reports', 'Reports & Exports', 'System', 'Inspect bounded reports with their evidence and limitations.'],
    ['position-detail', 'Position Details', 'Execution', 'Inspect retained virtual position evidence.'],
    ['empty', 'First Run & Empty State', 'Workspace', 'Start with a verified dataset, then configure research.'],
    ['connection-error', 'Connection Lost State', 'Control', 'Recover a workspace connection while live entry stays locked.'],
    ['stop-confirm', 'Emergency Stop Confirmation', 'Control', 'Admission state does not promise an automatic position exit.']
  ];
  const screens = catalog.map(([id, title, section, description], i) => ({ id, title, section, description, number: i + 1 }));
  const nav = [
    ['WORKSPACE', [['overview', 'Overview', 'grid'], ['markets', 'Markets', 'chart']]],
    ['RESEARCH', [['data', 'Data Lake', 'data'], ['strategies', 'Strategies', 'sliders'], ['backtest', 'Backtests', 'chart'], ['validation', 'Validation', 'shield'], ['rankings', 'Rankings', 'bars']]],
    ['EXECUTION', [['paper', 'Paper Trading', 'wallet'], ['orders', 'Orders', 'list'], ['positions', 'Positions', 'bars']]],
    ['CONTROL', [['risk', 'Risk & Limits', 'shield'], ['readiness', 'Sync & Recovery', 'sync'], ['shadow', 'Shadow Monitor', 'chart'], ['operations', 'Operations', 'pulse'], ['alerts', 'Alerts', 'bell']]],
    ['SYSTEM', [['audit', 'Audit & Evidence', 'list'], ['connections', 'Connections', 'plug'], ['settings', 'Settings', 'sliders']]]
  ];
  const families = [
    ['markets', 'instrument', 'onboarding'], ['data', 'quality', 'backfill'], ['strategies', 'builder', 'matrix'],
    ['backtest', 'results', 'ledger'], ['validation', 'rankings'], ['paper', 'paper-workspace', 'paper-deploy'],
    ['orders', 'order-detail'], ['positions', 'position-detail', 'accounting'], ['risk', 'allocation', 'news'],
    ['readiness', 'recovery', 'lineage'], ['operations', 'budget', 'live-review', 'stop-confirm'], ['audit', 'reports'],
    ['connections', 'connection-error'], ['settings'], ['shadow'], ['alerts'], ['overview'], ['unlock'], ['empty']
  ];
  function family(id) { return families.find(group => group.includes(id)) || ['overview']; }
  function parent(id) {
    if (['rankings', 'validation', 'connections'].includes(id)) return id;
    if (id === 'empty') return 'data';
    return family(id)[0];
  }
  const kernels = [
    { id: 'ema-trend', name: 'EMA Trend', description: 'Fast and slow moving-average trend signals.', tag: 'Trend', defaults: { fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' } },
    { id: 'atr-breakout', name: 'ATR Breakout', description: 'Volatility-aware breakouts using true range.', tag: 'Volatility', defaults: { atrPeriod: 14, breakoutMultiplier: '1.5' } },
    { id: 'rsi-momentum', name: 'RSI Momentum', description: 'Directional momentum with explicit RSI thresholds.', tag: 'Momentum', defaults: { period: 14, longThreshold: '55', shortThreshold: '45', priceSource: 'CLOSE' } },
    { id: 'multi-timeframe-trend', name: 'Multi-Timeframe Trend', description: 'Aligned EMA trends across two timeframes.', tag: 'Multi-timeframe', defaults: { fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' } },
    { id: 'supertrend', name: 'SuperTrend', description: 'Wilder ATR bands with persistent trend and deterministic flips.', tag: 'Futures trend', defaults: { atrPeriod: 10, multiplier: '3' } },
    { id: 'vwap-mean-reversion', name: 'VWAP Mean Reversion', description: 'Rolling volume-weighted price and deviation bands; exit at VWAP.', tag: 'Mean reversion', defaults: { vwapPeriod: 24, bandStdDev: '2' } }
  ];
  const futuresKernels = [
    { id: 'liquidity_sweep_sfp', name: 'Liquidity Sweep · SFP', description: 'Swing failure, wick reclaim and volume confirmation. Eligible transitions only.', tag: 'Liquidity reversal',
      defaults: { swingLookback: 20, maxPierceAtr: 1.8, wickRatio: .38, rvolMin: 1.2, rsiPeriod: 14, rsiMaxLong: 60, rsiMinShort: 40 }, gates: { use4hTrend100: false, use4hTrend200: false, costGateMult: 0 } },
    { id: 'liquidity_sweep_mss', name: 'Liquidity Sweep · MSS', description: 'A swept prior swing followed by a closed-candle structure shift.', tag: 'Structure reversal',
      defaults: { swingLookback: 24, sweepWindow: 3, bodyRatio: .48, rvolMin: 1.2 }, gates: { use4hTrend100: false, use4hTrend200: false, costGateMult: 0 } },
    { id: 'vol_climax_reversal', name: 'Volume Climax Reversal', description: 'Bollinger extension and volume absorption with EMA, ADX and causal macro gates.', tag: 'Volume absorption',
      defaults: { bbPeriod: 20, bbStd: 2, rvolClimax: 2.8, rsiPeriod: 14, rsiLongMax: 38, rsiShortMin: 62, wickRatio: .4, emaFilter: 200, adxMax: 45 }, gates: { use4hTrend100: true, use4hTrend200: false, costGateMult: 1.5 } },
    { id: 'bb_squeeze_adx', name: 'BB Squeeze + ADX', description: 'Prior bandwidth compression, expansion and directional ADX breakout.', tag: 'Volatility breakout',
      defaults: { bbPeriod: 20, bbStd: 2, squeezeQ: .6, squeezeLookback: 4, adxMin: 20, adxRising: true, volMult: 1.3, bodyRatio: .45, emaFilter: 50 }, gates: { use4hTrend100: false, use4hTrend200: true, costGateMult: 2 } }
  ];
  kernels.push(...futuresKernels);
  function strategyDefaults(strategy) {
    const k = futuresKernels.find(k => k.id === strategy);
    return k ? { ...k.gates, holdSignalOnZero: true } : { use4hTrend100: false, use4hTrend200: false, costGateMult: 0, holdSignalOnZero: false };
  }
  const resolution = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45', '1h': '60', '2h': '120', '4h': '240' };
  const futuresDefaults = { leverage: 3, marginMode: 'ISOLATED', maintenanceMarginRateBps: 50, liquidationFeeBps: 100,
    slAtrMult: 2, slMinPct: .8, slMaxPct: 4, tpAtrMult: 3, tpRrMultiple: 2, trailingAtrMult: 0, breakevenAt1R: false,
    sizingMode: 'FIXED_NOTIONAL', riskPerTradePct: 2, gstRatePct: 0, cooldownBars: 0, exitOnOppositeSignal: true, holdSignalOnZero: false,
    use4hTrend200: false, use4hTrend100: false, costGateMult: 0, trailingStopPct: 0, trailingActivationPct: 0, fundingMode: 'EXCLUDED', fundingRateBpsPer8h: 1 };
  const starterPresets = [
    { label: 'SFP 45m', strategy: 'liquidity_sweep_sfp', timeframe: '45m', stopLossMode: 'PERCENT', stopLossValue: 3, takeProfitMode: 'PERCENT', takeProfitValue: 2 },
    { label: 'MSS 30m', strategy: 'liquidity_sweep_mss', timeframe: '30m', stopLossMode: 'PERCENT', stopLossValue: 3, takeProfitMode: 'PERCENT', takeProfitValue: 2.5 },
    { label: 'Vol Climax 45m', strategy: 'vol_climax_reversal', timeframe: '45m', stopLossMode: 'PERCENT', stopLossValue: 1.5, takeProfitMode: 'PERCENT', takeProfitValue: 2.2 },
    { label: 'BB Squeeze 1h', strategy: 'bb_squeeze_adx', timeframe: '1h', stopLossMode: 'ATR', stopLossValue: 0, takeProfitMode: 'RR_MULTIPLE', takeProfitValue: 0, slAtrMult: 2, tpRrMultiple: 2 }
  ].map(p => ({ ...futuresDefaults, ...p, ...strategyDefaults(p.strategy), breakevenAt1R: true, gstRatePct: 18, rtCost: '' }));
  function futuresConfig(values = {}) {
    const result = Object.fromEntries(Object.entries(futuresDefaults).map(([key, fallback]) => [key,
      values[key] === undefined || values[key] === '' ? fallback : typeof fallback === 'number' ? Number(values[key])
        : typeof fallback === 'boolean' ? [true, 'true', 'on', '1'].includes(values[key]) : String(values[key])]));
    if (values.rtCost !== undefined && values.rtCost !== '') result.rtCost = Number(values.rtCost);
    return result;
  }
  function futuresPreview(values) {
    const c = futuresConfig(values), notional = Number(values.maxOrderNotionalInr);
    const distance = 100 / c.leverage - c.maintenanceMarginRateBps / 100;
    return { requiredMarginInr: Number.isFinite(notional) && notional > 0 && c.leverage >= 1 && c.leverage <= 20 ? notional / c.leverage : null,
      liquidationDistancePct: distance > 0 && Number.isFinite(distance) ? distance : null };
  }
  function fundingLabel(config = {}) { return config.fundingMode === 'MODELED_FIXED_BPS' ? `Modeled @ ${config.fundingRateBpsPer8h ?? 1} bps/8h` : 'Excluded'; }
  function parameters(strategy, timeframe, values = {}) {
    const kernel = kernels.find(k => k.id === strategy) || kernels[0];
    const minutes = Number(resolution[timeframe] || 15);
    const params = { ...kernel.defaults };
    for (const key of Object.keys(params)) if (values[key] !== undefined) params[key] = typeof params[key] === 'number' ? Number(values[key]) : typeof params[key] === 'boolean' ? [true, 'true', 'on', '1'].includes(values[key]) : String(values[key]);
    if (strategy === 'multi-timeframe-trend') params.timeframes = [minutes, minutes * 4];
    else params.timeframeMinutes = minutes;
    return params;
  }
  function coverage(dataset, count = 28) {
    if (!dataset || !Array.isArray(dataset.candles)) return Array.from({ length: count }, () => ({ status: 'unknown', expected: 0, received: 0 }));
    const step = Number(dataset.resolution) * 60000;
    const n = Math.max(0, Math.floor((dataset.toMs - dataset.fromMs) / step));
    const times = new Map();
    for (const bar of dataset.candles) {
      const [o, h, l, c, v] = ['open', 'high', 'low', 'close', 'volume'].map(k => Number(bar[k]));
      const valid = [o, h, l, c, v].every(Number.isFinite) && Math.min(o, h, l, c) > 0 && v >= 0 && h >= Math.max(o, l, c) && l <= Math.min(o, h, c);
      const previous = times.get(bar.timeMs);
      times.set(bar.timeMs, previous === undefined ? valid : false); // Duplicates are never verified.
    }
    return Array.from({ length: count }, (_, i) => {
      const fromIndex = Math.floor(i * n / count), toIndex = Math.floor((i + 1) * n / count);
      let received = 0, invalid = 0;
      for (let j = fromIndex; j < toIndex; j++) { const status = times.get(dataset.fromMs + j * step); if (status === true) received++; else if (status === false) invalid++; }
      const expected = toIndex - fromIndex;
      return { status: expected === 0 ? 'unknown' : received === expected ? 'verified' : 'gap', expected, received, invalid,
        fromMs: dataset.fromMs + fromIndex * step, toMs: dataset.fromMs + toIndex * step };
    });
  }
  function paperSummary(workspace, now = Date.now()) {
    const sessions = workspace?.paperSessions || [], zone = workspace?.settings?.timezone || 'Asia/Calcutta';
    const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
    const today = day(now);
    const fills = sessions.flatMap(s => s.fills || []);
    const fundingToday = sessions.flatMap(fundingEvents).filter(e => day(e.timestampMs) === today).reduce((sum, e) => sum + Number(e.details.fundingCashflowInr || 0), 0);
    return { equity: sessions.reduce((n, s) => n + Number(s.equityInr || 0), 0),
      capital: sessions.reduce((n, s) => n + Number(s.config.capitalInr || 0), 0),
      active: sessions.filter(s => s.status === 'RUNNING').length,
      todayPnl: fills.filter(f => day(f.timestampMs) === today).reduce((n, f) => n + Number(f.grossPnlInr || 0) - Number(f.feeInr || 0), fundingToday),
      fees: fills.reduce((n, f) => n + Number(f.feeInr || 0), 0) };
  }
  function paperCurve(workspace) {
    const sessions = workspace?.paperSessions || [];
    if (!sessions.length) return [];
    // Cash events only; never interpolate marks or invent a paper equity history.
    const events = sessions.flatMap(s => [{ timestampMs: s.createdAtMs, delta: Number(s.config.capitalInr) },
      ...(s.fills || []).map(f => ({ timestampMs: f.timestampMs, delta: Number(f.grossPnlInr || 0) - Number(f.feeInr || 0) })),
      ...fundingEvents(s).map(e => ({ timestampMs: e.timestampMs, delta: Number(e.details.fundingCashflowInr || 0) }))]).sort((a, b) => a.timestampMs - b.timestampMs);
    let cash = 0;
    return events.map(e => ({ timestampMs: e.timestampMs, equityInr: (cash += e.delta) }));
  }
  function tradeMatches(trade, query) {
    return JSON.stringify(trade).toLowerCase().includes(String(query).toLowerCase().trim());
  }
  function fundingEvents(session) { return [...(session.book?.trades || []).flatMap(t => t.events || []), ...(session.book?.position?.events || [])].filter(e => e.type === 'FUNDING_SETTLEMENT'); }
  function closedDayChange(candles) {
    if (!candles?.length) return null;
    const last = candles[candles.length - 1], previous = candles.find(c => c.timeMs === last.timeMs - 86400000);
    return previous && Number(previous.close) > 0 ? (Number(last.close) / Number(previous.close) - 1) * 100 : null;
  }
  function positionExposure(position, mark, fx) {
    if (!position || [position.quantity, position.contractMultiplier, mark, fx].some(v => v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0)) return null;
    return Number(position.quantity) * Number(position.contractMultiplier) * Number(mark) * Number(fx);
  }
  function sessionAccounting(session) {
    const fills = session?.fills || [];
    return { realizedGross: fills.reduce((n, f) => n + Number(f.grossPnlInr || 0), 0), fees: fills.reduce((n, f) => n + Number(f.feeInr || 0), 0),
      unrealized: session?.unrealizedPnlInr == null ? null : Number(session.unrealizedPnlInr),
      funding: session?.config?.fundingMode === 'MODELED_FIXED_BPS' ? (session.book?.trades || []).reduce((n, t) => n + Number(t.fundingInr || 0), Number(session.book?.position?.fundingInr || 0)) : null,
      transfers: null, executionCosts: 'EMBEDDED_IN_FILL_PRICES' };
  }
  function sessionCurve(session) {
    if (!session) return [];
    const points = paperCurve({ paperSessions: [session] });
    if (session.updatedAtMs != null && session.equityInr != null && session.updatedAtMs >= (points.at(-1)?.timestampMs || 0)) points.push({ timestampMs: session.updatedAtMs, equityInr: Number(session.equityInr) });
    return points;
  }
  function allOrders(workspace) {
    const paper = (workspace?.paperSessions || []).flatMap(s => (s.orders || []).map(o => ({ ...o, sessionId: s.id, sessionName: s.name, pair: `B-${s.config.coin}_USDT`, source: 'PAPER', displayId: o.id })));
    const account = workspace?.shadowReport?.account;
    const observed = (account?.records?.orders || []).map(o => ({ ...o, id: o.exchangeOrderId, displayId: `OBS-${o.exchangeOrderId}`, source: 'OBSERVED',
      status: o.venueStatus, quantity: o.orderedQuantity, updatedAtMs: o.providerEventTimeMs, sessionId: null }));
    return [...paper, ...observed];
  }
  function orderTimeline(session, order) {
    if (!session || !order) return [];
    const timeline = [];
    if (order.decisionId) timeline.push({ timestampMs: order.createdAtMs, title: 'Strategy target recorded', detail: `Decision reference: ${order.decisionId}` });
    if (order.riskDecisionId) timeline.push({ timestampMs: order.createdAtMs, title: 'M7 risk approval reference', detail: order.riskDecisionId });
    const groups = [session.book?.position?.events || [], ...(session.book?.trades || []).map(t => t.events || [])];
    // Only actual linked fill/arming events; a working order is never shown as protected.
    groups.filter(events => events.some(e => e.type === 'DECISION_RECORDED' && e.details?.decisionId === order.decisionId))
      .flatMap(events => events.filter(e => e.type === 'SL_TP_ARMED'))
      .forEach(e => timeline.push({ timestampMs: e.timestampMs, title: 'SL/TP armed', detail: JSON.stringify(e.details) }));
    for (const fill of session.fills || []) if (fill.orderId === order.id) timeline.push({ timestampMs: fill.timestampMs, title: `Virtual ${fill.kind.toLowerCase()} fill`, detail: `${fill.quantity} @ ${fill.price} · ${fill.reason}` });
    timeline.push({ timestampMs: order.updatedAtMs, title: `Virtual order ${order.status.toLowerCase()}`, detail: order.reason || 'Retained state · no venue mutation' });
    return timeline.sort((a, b) => a.timestampMs - b.timestampMs);
  }
  function filterAlerts(alerts, severity, acknowledgement, query) {
    return (alerts || []).filter(a => (severity === 'ALL' || a.severity === severity)
      && (acknowledgement === 'ALL' || (acknowledgement === 'OPEN' ? !a.acknowledgedAtMs : Boolean(a.acknowledgedAtMs)))
      && `${a.code} ${a.message} ${a.scope}`.toLowerCase().includes(String(query || '').toLowerCase()));
  }
  function preferences(workspace) {
    return { language: 'en', timezone: 'Asia/Kolkata', defaultCoin: 'SOL', defaultEquityInr: 5000, defaultMaxOrderNotionalInr: 700,
      defaultSlPct: 1, defaultTpPct: 2, notifications: { researchCompletion: true, routineStatus: true }, ...workspace?.settings };
  }
  function protectionDefaults(workspace) {
    const p = preferences(workspace); return { stopLossMode: p.defaultSlPct > 0 ? 'PERCENT' : 'NONE', stopLossValue: p.defaultSlPct,
      takeProfitMode: p.defaultTpPct > 0 ? 'PERCENT' : 'NONE', takeProfitValue: p.defaultTpPct };
  }
  const tamilTitles = ['மீண்டும் வருக', 'மேலோட்டம்', 'சந்தைகள்', 'சந்தைப் பணியிடம்', 'தரவுக் களஞ்சியம்', 'தரவுத் தரம்', 'ஒத்திசைவு மற்றும் வரலாற்றுத் தரவு',
    'உத்தி நூலகம்', 'உத்தி வடிவமைப்பு', 'ஆராய்ச்சி அணி', 'புதிய வரலாற்றுச் சோதனை', 'சோதனை முடிவுகள்', 'வர்த்தகம் மற்றும் நிகழ்வுப் பதிவேடு', 'ஆராய்ச்சி சரிபார்ப்பு', 'உத்தி தரவரிசைகள்',
    'மெய்நிகர் கணக்குகள்', 'மெய்நிகர் பணியிடம்', 'மெய்நிகர் இயக்கம்', 'ஆர்டர்கள்', 'ஆர்டர் விவரங்கள்', 'நிலைகள்', 'இடர் மற்றும் வரம்புகள்', 'ஒத்திசைவு மற்றும் தயார் நிலை',
    'மீட்பு மற்றும் ஆய்வு', 'நிழல் கண்காணிப்பு', 'செயல்பாடுகள்', 'எச்சரிக்கைகள்', 'தணிக்கை மற்றும் ஆதாரம்', 'உரிமை ஆய்வு', 'பகிர்ந்த கோரிக்கை வரம்பு',
    'இணைப்புகள்', 'அமைப்புகள்', 'நேரடி இயக்கத் தயார்நிலை', 'நாணயச் சேர்ப்பு', 'மூலதன ஒதுக்கீடு', 'கணக்கியல் மற்றும் செலவுகள்', 'செய்தி மற்றும் நிகழ்வு இடர்', 'அறிக்கைகள் மற்றும் ஏற்றுமதி', 'நிலை விவரங்கள்', 'முதல் இயக்க வழிகாட்டி', 'இணைப்பு துண்டிப்பு', 'அவசர நிறுத்த உறுதிப்படுத்தல்'];
  const tamil = { WORKSPACE: 'பணியிடம்', RESEARCH: 'ஆராய்ச்சி', EXECUTION: 'செயலாக்கம்', CONTROL: 'கட்டுப்பாடு', SYSTEM: 'அமைப்பு',
    Access: 'அணுகல்', Workspace: 'பணியிடம்', Research: 'ஆராய்ச்சி', Execution: 'செயலாக்கம்', Control: 'கட்டுப்பாடு', System: 'அமைப்பு',
    'Open screen index': 'அனைத்துத் திரைகளும்', 'Refresh': 'புதுப்பி', 'Personal workspace': 'தனிப்பட்ட பணியிடம்' };
  function screenTitle(id, language) { const screen = screens.find(s => s.id === id); return language === 'ta' ? tamilTitles[(screen?.number || 2) - 1] : screen?.title || id; }
  function translate(text, language) { return language === 'ta' ? tamil[text] || text : text; }
  return { trackedCoins: workspace => workspace?.trackedCoins || ['BTC', 'ETH', 'SOL'], screens, nav, families, family, parent, kernels, parameters, resolution, coverage, paperSummary, paperCurve, tradeMatches, closedDayChange,
    futuresKernels, strategyDefaults, starterPresets, futuresDefaults, futuresConfig, futuresPreview, fundingLabel, positionExposure, sessionAccounting, sessionCurve, allOrders, orderTimeline, filterAlerts, preferences, protectionDefaults, screenTitle, translate };
});
