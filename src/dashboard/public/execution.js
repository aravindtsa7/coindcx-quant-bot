/* Execution and control views. Virtual books and read-only observations never share authority. */
window.WorkspaceExecution = function (C) {
  'use strict';
  const { S, U, h, n, money, pct, date, sign, badge, panel, table, kpi, metrics, empty, link, select, field,
    options, kernelName, pairName, protectionLabel, protectionFields, parameterFields, savedOptions, lineChart, candleChart } = C;
  const E = { sessionId: null, orderId: null, orderSource: 'PAPER', orderStatus: 'ALL', orderSourceFilter: 'ALL', orderQuery: '',
    alertSeverity: 'ALL', alertState: 'OPEN', alertQuery: '', auditQuery: '', reportQuery: '', reportMode: 'ALL', exportId: null,
    controlPending: false, instruments: null, instrumentError: null, triedDiscovery: false };
  const sessions = () => S.workspace?.paperSessions || [];
  const selected = () => E.sessionId ? sessions().find(s => s.id === E.sessionId) : sessions()[0];
  const account = () => S.workspace?.shadowReport?.account;
  const pairs = () => S.workspace?.shadowReport?.cycles?.at(-1)?.pairSummaries || [];
  const b = (text, action, id = '', primary = false, disabled = false, extra = '') => `<button type="button" data-exec="${action}" data-id="${h(id)}" class="${primary ? 'primary' : ''}" ${disabled ? 'disabled' : ''} ${extra}>${h(text)}</button>`;
  const stopped = () => Boolean(S.workspace?.operations?.admissionStopped);
  const runDisabled = () => S.busy || Boolean(S.workspace?.busy) || E.controlPending || !S.connected;
  const sessionUrl = (route, s) => `${route}?session=${encodeURIComponent(s.id)}`;
  const sessionSelector = () => `<div class="toolbar"><label for="paper-session-select">Paper session</label><select id="paper-session-select" data-exec-change="session">${options(sessions().map(s => [s.id, `${s.name} · ${s.config.coin}`]), selected()?.id)}</select>${link('New paper session', 'paper-deploy', true)}</div>`;
  const sessionRisk = s => badge(s.lastRisk ? `${s.lastRisk.status} · ${s.lastRisk.action}` : 'NOT EVALUATED', s.lastRisk?.status === 'ACCEPTED' ? 'teal' : 'amber');
  const missingSession = () => empty('No paper session selected', 'Create an isolated virtual INR account, or select an existing account.', link('Deploy to paper →', 'paper-deploy', true));
  const controls = s => `<div class="toolbar">${b('Step 1 Candle', 'step', s.id, true, runDisabled() || s.status !== 'RUNNING')}${b(s.status === 'RUNNING' ? 'Pause' : 'Resume', 'toggle', s.id, false, E.controlPending || !S.connected || (s.status !== 'RUNNING' && stopped()))}${link('Open workspace →', sessionUrl('paper-workspace', s))}</div>`;
  const funding = '<div class="callout">PAPER ONLY · Funding is excluded or explicitly modeled per session. Virtual balances, fills and P&L do not establish complete venue economics or live trading permission.</div>';
  function sessionSummary(s) {
    const p = s.book?.position;
    return metrics([['Strategy', kernelName(s.config.strategy)], ['Timeframe', s.config.timeframe], ['Stop loss', protectionLabel(s.config.stopLossMode, s.config.stopLossValue)],
      ['Take profit', protectionLabel(s.config.takeProfitMode, s.config.takeProfitValue)], ['Current position', p ? `${p.side} ${n(p.quantity, 6)} ${s.config.coin}` : 'FLAT'], ['M7', s.lastRisk?.primaryReasonCode || 'Not evaluated']]);
  }
  function paper() {
    const summary = U.paperSummary(S.workspace);
    return `<div class="kpis">${kpi('Virtual accounts', n(sessions().length, 0), 'Isolated balances and ledgers')}${kpi('Combined virtual equity ₹', money(summary.equity), 'Current retained paper marks')}${kpi('Active sessions', n(summary.active, 0), 'Running · manually stepped', 'positive')}${kpi('Economic status', sessions().some(s => s.config.fundingMode === 'MODELED_FIXED_BPS') ? 'Modeled funding' : 'Funding excluded', 'Complete net economics unestablished', 'amber-text', true)}</div><div class="toolbar">${link('New paper session', 'paper-deploy', true)}${badge('No venue orders', 'blue')}</div>${sessions().length ? `<div class="equal-columns">${sessions().map(s => panel(s.name, `<div class="session-value">${money(s.equityInr)}</div><p class="small muted">Initial capital ${money(s.config.capitalInr)} · ${s.config.coin} / USDT</p>${lineChart(U.sessionCurve(s), 'equityInr', 'Recorded cash / latest equity INR')}<p class="small muted">Recorded cash events + latest retained mark. No interpolated mark history.</p>${sessionSummary(s)}<div class="divider"></div>${controls(s)}`, `${kernelName(s.config.strategy)} · ${s.config.timeframe}`, badge(s.status, s.status === 'RUNNING' ? 'teal' : 'amber'))).join('')}</div>` : missingSession()}${panel('Paper safeguards', checklist([['Virtual capital only', 'No private wallet or venue order submission.'], ['M7 decisions required', 'Entries are checked against this virtual account’s SAFE policy.'], ['Restartable state', 'Working orders, positions and fill history persist locally.'], ['Manual stepping', 'Step catches up newly closed bars. Repeating the same window is idempotent.']]))}`;
  }
  function checklist(items) { return `<ul class="list">${items.map(([title, detail]) => `<li><div><b>${h(title)}</b><small>${h(detail)}</small></div>${badge('EXPLICIT', 'blue')}</li>`).join('')}</ul>`; }
  function positionRows(list) {
    return table(['Account / instrument', 'Side', 'Quantity', 'Entry USDT', 'Mark USDT', 'Exposure ₹', 'Modeled P&L ₹', 'Inspect'], list.map(s => {
      const p = s.book?.position; return [h(s.name) + `<small>${h(s.config.coin)} / USDT</small>`, badge(p.side, p.side === 'LONG' ? 'teal' : 'red'), n(p.quantity, 6), n(p.entryPrice, 4), n(s.lastMarkPriceUsdt, 4), money(U.positionExposure(p, s.lastMarkPriceUsdt, s.lastFxInrPerUsdt)), `<span class="${sign(s.unrealizedPnlInr)}">${money(s.unrealizedPnlInr)}</span>`, link('Position →', sessionUrl('position-detail', s))];
    }), 'No open virtual positions.');
  }
  function fillTable(fills) {
    return table(['Time', 'Fill', 'Side', 'Qty', 'Price USDT', 'Gross ₹', 'Fee ₹', 'Reason'], fills.map(f => [h(date(f.timestampMs)), h(f.kind), badge(f.side, f.side === 'LONG' ? 'teal' : 'red'), n(f.quantity, 6), n(f.price, 4), money(f.grossPnlInr), money(f.feeInr), h(f.reason)]), 'No attributable fills have been recorded.');
  }
  function sessionChart(s, levels = []) {
    const key = `${s.config.coin}:${s.config.timeframe}`, data = S.market[key];
    return panel(`${s.config.coin} / USDT · ${s.config.timeframe}`, `${S.marketErrors[key] ? `<div class="callout error">${h(S.marketErrors[key])}</div>` : ''}<div class="legend"><span class="amber">EMA 9</span><span class="blue">EMA 21</span><span>Closed candles + volume</span></div>${candleChart(data, levels)}<div class="chart-caption"><span>${data ? `Provider window fetched ${h(date(data.fetchedAtIso))}` : 'No market window loaded.'} · Independent of retained session marks</span>${b('Refresh candles', 'session-candles', s.id, false, runDisabled())}</div>`, 'Real CoinDCX closed candles · hover / keyboard inspection', badge('LIVE DATA', 'blue'));
  }
  function paperWorkspace() {
    const s = selected(); if (!s) return sessionSelector() + missingSession();
    const p = s.book?.position, exposure = p ? U.positionExposure(p, s.lastMarkPriceUsdt, s.lastFxInrPerUsdt) : 0;
    return `${sessionSelector()}<div class="kpis">${kpi('Virtual equity ₹', money(s.equityInr), s.name)}${kpi('Modeled unrealized ₹', money(s.unrealizedPnlInr), 'Retained price P&L · funding settles in cash', sign(s.unrealizedPnlInr))}${kpi('Current exposure ₹', money(exposure), 'Quantity × contract multiplier × mark × FX')}${kpi('Session status', s.status, 'Manual closed-candle stepping', s.status === 'RUNNING' ? 'positive' : 'amber-text', true)}</div><div class="two-column"><div>${sessionChart(s)}</div><div>${panel('Strategy & protection controls', `${badge('SAFE · PAPER', 'teal')} ${sessionRisk(s)}${sessionSummary(s)}<div class="divider"></div><div class="toolbar">${b('Step Cycle', 'step', s.id, true, runDisabled() || s.status !== 'RUNNING')}${b(s.status === 'RUNNING' ? 'Pause session' : 'Resume session', 'toggle', s.id, false, E.controlPending || !S.connected || (s.status !== 'RUNNING' && stopped()))}${b('Review session evidence', 'session-evidence', s.id)}</div><p class="small muted" style="margin-top:12px">Last processed close: ${s.lastProcessedOpenMs == null ? 'Not stepped' : h(date(s.lastProcessedOpenMs + Number(U.resolution[s.config.timeframe]) * 60000))}. Stepping catches up available closed bars; paused positions retain their last mark.</p>`)}</div></div>${panel('Virtual orders', orderTable(U.allOrders(S.workspace).filter(o => o.source === 'PAPER' && o.sessionId === s.id)), '', '', true)}${panel('Virtual position', positionRows(p ? [s] : []), '', '', true)}${funding}`;
  }
  function deploy() {
    const c = U.protectionDefaults(S.workspace);
    return `<div class="two-column"><div>${panel('Deploy a strategy to paper', `<form id="paper-deploy-form"><div class="form-grid two">${field('Session name', 'name', '', 'text', 'required maxlength="100" placeholder="e.g. SOL trend research"')}${select('Saved strategy / kernel', 'selection', savedOptions(), 'ema-trend', 'data-preset-select')}${select('Instrument', 'coin', U.trackedCoins(S.workspace).map(coin => [coin, `B-${coin}_USDT`]), S.coin)}${select('Timeframe', 'timeframe', ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '4h'], S.timeframe)}${field('Initial virtual capital INR', 'capitalInr', U.preferences(S.workspace).defaultEquityInr, 'number', 'min="1" max="1000000000" required')}${field('Max order notional INR', 'maxOrderNotionalInr', U.preferences(S.workspace).defaultMaxOrderNotionalInr, 'number', 'min="1" max="1000000000" required')}${field('Bootstrap closed bars', 'bars', 200, 'number', 'min="30" max="1000" required')}<label>Risk profile<input value="SAFE · M7" disabled></label></div><div class="form-section"><h3>Kernel parameters</h3><div class="form-grid" data-parameters>${parameterFields('ema-trend')}</div></div><div class="form-section"><h3>Stop loss & take profit</h3>${protectionFields(c)}<p class="small muted" style="margin-top:10px">NONE supplies no fictitious stop proposal; M7 may refuse an unprotected entry.</p></div>${C.futuresFields(c)}<div class="form-section"><h3>Explicit modeled costs</h3><div class="form-grid">${field('Taker fee bps', 'takerFeeBps', 5, 'number', 'min="0" max="100" step="any" required')}${field('Spread bps', 'spreadBps', 1, 'number', 'min="0" max="100" step="any" required')}${field('Market slippage bps', 'slippageBps', 2, 'number', 'min="0" max="100" step="any" required')}${field('Stop slippage bps', 'stopSlippageBps', 5, 'number', 'min="0" max="100" step="any" required')}</div></div><div class="form-actions"><button type="submit" class="primary">Start Paper Session →</button><p>Virtual capital only · Explicit funding model</p></div></form>`)}</div><div>${panel('Pre-deployment checklist', checklist([['Isolated virtual capital', 'This account has its own balances, fills and order ledger.'], ['SAFE risk policy', 'The actual M7 engine evaluates entry, exposure and protection.'], ['Venue minimum & lot checks', 'Discovered metadata and current conversion are checked when stepping.'], ['Manual progression', 'A new session must be stepped to warm the kernel and evaluate a signal.'], ['No automatic promotion', 'Paper research never unlocks live trading.']]), '', badge('LIVE LOCKED', 'amber'))}</div></div>`;
  }
  function orderTable(orders) {
    return table(['Order / source', 'Instrument / account', 'Action / side', 'Quantity', 'Status', 'Updated', 'Inspect'], orders.map(o => [h(o.displayId) + `<small>${badge(o.source === 'PAPER' ? 'VIRTUAL PAPER' : 'READ-ONLY OBSERVED', o.source === 'PAPER' ? 'blue' : 'amber')}</small>`, h(pairName(o.pair)) + `<small>${h(o.sessionName || 'Venue observation · ownership unavailable')}</small>`, `${h(o.action || o.wireOrderType)} · ${h(o.side)}`, n(o.quantity, 6), badge(o.status, o.status === 'Filled' || o.status === 'filled' ? 'teal' : o.status === 'Cancelled' ? 'amber' : ''), h(date(o.updatedAtMs)), link('Order →', `order-detail?order=${encodeURIComponent(o.id)}&source=${o.source}${o.sessionId ? `&session=${encodeURIComponent(o.sessionId)}` : ''}`)]), 'No matching retained records.');
  }
  function filteredOrders() {
    return U.allOrders(S.workspace).filter(o => (E.orderSourceFilter === 'ALL' || o.source === E.orderSourceFilter)
      && (E.orderStatus === 'ALL' || o.status.toLowerCase() === E.orderStatus.toLowerCase()) && JSON.stringify(o).toLowerCase().includes(E.orderQuery.toLowerCase()));
  }
  function ordersBody() {
    const list = filteredOrders(); return `${panel('Virtual paper orders', orderTable(list.filter(o => o.source === 'PAPER')), 'Working, filled and cancelled virtual state', '', true)}${panel('Read-only observed venue records', orderTable(list.filter(o => o.source === 'OBSERVED')), 'OBS-* identifiers · no ownership or execution authority', badge('READ ONLY', 'amber'), true, account()?.records ? `Last REST pass retained up to 500 records. ${account().records.truncated ? 'Display is truncated; hashes cover the original read.' : 'No display truncation recorded.'}` : 'This archive retained hashes / counts without individual records. Run a new observation to retain bounded records; no missing records are fabricated.')}`;
  }
  function orders() {
    const statuses = [...new Set(['Working', 'Filled', 'Cancelled', ...U.allOrders(S.workspace).map(o => o.status)])];
    return `<div class="toolbar"><label class="search-field search">Find order<input type="search" value="${h(E.orderQuery)}" data-exec-input="order-query" placeholder="Order ID, pair, account…"></label><label>Source<select data-exec-change="order-source">${options(['ALL', ['PAPER', 'Virtual paper'], ['OBSERVED', 'Observed venue']], E.orderSourceFilter)}</select></label><label>Status<select data-exec-change="order-status">${options(['ALL', ...statuses], E.orderStatus)}</select></label></div><div id="execution-orders">${ordersBody()}</div>`;
  }
  function orderDetail() {
    const all = U.allOrders(S.workspace), o = E.orderId ? all.find(o => o.id === E.orderId && o.source === E.orderSource && (o.source !== 'PAPER' || !E.sessionId || o.sessionId === E.sessionId)) : all[0];
    if (!o) return empty('Order evidence unavailable', 'Choose a retained virtual or observed record from Orders.', link('View orders', 'orders'));
    const s = sessions().find(s => s.id === o.sessionId), observed = o.source === 'OBSERVED';
    const history = observed ? [{ timestampMs: o.providerCreatedAtMs, title: 'Provider creation timestamp', detail: 'Venue clock · read-only record' }, { timestampMs: o.providerEventTimeMs, title: `Observed venue status: ${o.status}`, detail: 'No local strategy, M7 approval or ownership is implied.' }] : U.orderTimeline(s, o);
    return `<div class="two-column"><div>${panel(o.displayId, `<div class="badge-row">${badge(o.source, observed ? 'amber' : 'blue')}${badge(o.side, 'teal')}${badge(o.status)}</div>${metrics([['Instrument', o.pair], ['Quantity', n(o.quantity, 6)], ['Decision reference', o.decisionId || 'Not attributable'], ['M7 approval reference', o.riskDecisionId || 'Not attributable']])}<div class="divider"></div><h3>Recorded order timeline</h3><ol class="timeline" style="margin-top:18px">${history.map(e => `<li><time>${h(date(e.timestampMs))}</time>${h(e.title)}<small>${h(e.detail)}</small></li>`).join('')}</ol>`, 'References and retained events only; absent lifecycle steps are not inferred.')}</div><div>${panel('Source & ownership', checklist(observed ? [['Source', 'Latest retained normalized REST observation.'], ['Ownership', 'UNAVAILABLE. Venue observation is not strategy ownership proof.'], ['Permission', 'Read only. No cancel, amend or resubmit control.']] : [['Source', `Isolated virtual account: ${s?.name || o.sessionId}`], ['Ownership', 'Attributable only to this virtual book.'], ['Protection', 'SL/TP is armed only after an actual virtual entry fill.']]), '', badge('LIVE LOCKED', 'amber'))}</div></div>${panel('Attributable fill history', observed ? empty('Provider fill history not retained', `Observed aggregate filled quantity: ${n(o.filledQuantity, 6)}. This is not an individual-fill ledger.`) : fillTable((s?.fills || []).filter(f => f.orderId === o.id)), '', '', true)}<div class="toolbar">${link('Back to orders', 'orders')}${b('Inspect order JSON', 'order-evidence', `${o.source}:${o.id}`)}</div>`;
  }
  function exposures() {
    return U.trackedCoins(S.workspace).map(coin => {
      const values = sessions().filter(s => s.config.coin === coin && s.book?.position).map(s => U.positionExposure(s.book.position, s.lastMarkPriceUsdt, s.lastFxInrPerUsdt));
      return { coin, value: values.some(v => v === null) ? null : values.reduce((sum, v) => sum + v, 0) };
    });
  }
  function exposureBars() {
    const rows = exposures(), total = rows.reduce((sum, r) => sum + (r.value || 0), 0);
    return `<div class="exposure-bars">${rows.map(r => `<div><div class="exposure-label"><span>${r.coin} / USDT</span><strong>${money(r.value)} · ${r.value === null ? 'Unknown valuation' : pct(total > 0 ? r.value / total * 100 : 0)}</strong></div><progress value="${r.value || 0}" max="${total || 1}" aria-label="${r.coin} proportion of known virtual exposure"></progress></div>`).join('')}</div><p class="small muted">Shares of known virtual notional. Missing FX / mark / multiplier remains unknown.</p>`;
  }
  function positions() {
    const open = sessions().filter(s => s.book?.position), total = exposures().reduce((sum, r) => sum + (r.value || 0), 0);
    return `<div class="kpis">${kpi('Virtual positions', n(open.length, 0), 'Attributable to isolated paper books')}${kpi('Known gross exposure', money(total), 'Unknown valuations are excluded')}${kpi('Modeled unrealized', money(open.reduce((sum, s) => sum + Number(s.unrealizedPnlInr), 0)), 'Retained session marks')}${kpi('Venue ownership', 'UNAVAILABLE', 'Read-only observation boundary', 'amber-text', true)}</div>${panel('Virtual paper positions', positionRows(open), 'Click a position to inspect entry, protection and event evidence.', '', true)}<div class="equal-columns">${panel('Exposure by instrument', exposureBars())}${panel('Venue position ownership', checklist([['Ownership status: UNAVAILABLE', 'Observed venue quantity never proves local strategy ownership.'], ['Venue observations', `${account()?.records?.positions?.length ?? 'No'} bounded last-pass records retained.`], ['Mutation permission', 'No close, reduce or cancel operation is composed for venue positions.']]), '', badge('READ-ONLY BOUNDARY', 'amber'))}</div>`;
  }
  function eventTable(events) {
    return table(['Timestamp', 'Event', 'Retained details'], events.map(e => [h(date(e.timestampMs)), badge(e.type, e.type === 'EXIT_FILL' ? 'amber' : 'blue'), `<pre class="event-json">${h(JSON.stringify(e.details, null, 2))}</pre>`]), 'No linked position event evidence retained.');
  }
  function positionDetail() {
    const s = selected(); if (!s) return sessionSelector() + missingSession();
    const p = s.book?.position, closed = s.book?.trades?.at(-1), events = p?.events || closed?.events || [];
    const levels = p ? [{ price: p.entryPrice, label: 'Entry', color: '#7caaed' }, { price: p.stopPrice, label: 'SL', color: '#ee7482' }, { price: p.takeProfitPrice, label: 'TP', color: '#4bd6b7' }].filter(l => l.price !== null) : [];
    return `${sessionSelector()}<div class="badge-row">${badge(p ? `${p.side} · VIRTUAL POSITION` : 'NO OPEN POSITION', p ? 'teal' : 'amber')}${badge(`${s.config.coin} / USDT`, 'blue')}${badge(U.fundingLabel(s.config))}</div><div class="two-column"><div>${sessionChart(s, levels)}</div><div>${panel('Position & protection', metrics([['Account', s.name], ['Direction', p?.side || 'FLAT'], ['Quantity', p ? n(p.quantity, 6) : '—'], ['Entry USDT', n(p?.entryPrice, 4)], ['Session mark USDT', n(s.lastMarkPriceUsdt, 4)], ['Stop-loss USDT', n(p?.stopPrice, 4)], ['Take-profit USDT', n(p?.takeProfitPrice, 4)], ['Unrealized INR', money(s.unrealizedPnlInr)]]), 'Virtual protection levels are not venue protective orders.', b('Inspect session evidence', 'session-evidence', s.id))}</div></div>${panel(p ? 'Open position event history' : 'Latest closed trade event history', eventTable(events), closed && !p ? `Exit: ${closed.exitReason} · ${date(closed.exitTimeIso)}` : 'Actual decision, entry and protection events.', '', true)}${panel('Session fill history', fillTable((s.fills || []).slice(-15).reverse()), 'Most recent 15 fills · full history in session evidence.', '', true)}${funding}`;
  }
  function accounting() {
    const rows = sessions().map(s => ({ s, a: U.sessionAccounting(s) })), gross = rows.reduce((sum, r) => sum + r.a.realizedGross, 0), fees = rows.reduce((sum, r) => sum + r.a.fees, 0), modeledFunding = rows.some(r => r.a.funding !== null), totalFunding = rows.reduce((sum, r) => sum + (r.a.funding || 0), 0);
    return `<div class="callout">Funding, transfers and ADL are not reconstructed. Unknown economic components remain unknown; no zero is substituted.</div><div class="kpis">${kpi('Realized gross P&L', money(gross), 'Virtual exit fills', sign(gross))}${kpi('Modeled fees', money(fees), 'Actual virtual entry + exit fee ledger')}${kpi('Funding', modeledFunding ? money(totalFunding) : 'Unknown / Excluded', 'Fixed-rate model; historical rates unknown', 'amber-text', true)}${kpi('Complete net P&L', 'Not established', 'Transfers / ADL unresolved', 'amber-text', true)}</div>${panel('Accounting decomposition', table(['Component', 'Retained amount / treatment', 'Evidence source', 'Economic status'], [
      ['Realized gross P&L', money(gross), 'Virtual fill ledger', badge('MODELED', 'blue')],
      ['Terminal unrealized', money(rows.reduce((sum, r) => sum + (r.a.unrealized || 0), 0)), 'Latest retained virtual marks', badge('MODELED', 'blue')],
      ['Modeled fees', money(fees), 'Per-fill fee assumptions', badge('MODELED', 'blue')],
      ['Spread + slippage', 'Embedded in modeled fill prices · not independently itemized', 'Configured bps; no additional subtraction', badge('EMBEDDED')],
      ['Funding', modeledFunding ? money(totalFunding) : 'Unknown / Excluded', 'Per-session fixed-rate model or excluded; historical rates unknown', badge(modeledFunding ? 'MODELED' : 'INCOMPLETE', 'amber')],
      ['Transfers / ADL', 'Unresolved', 'No authoritative source composed', badge('UNRESOLVED', 'amber')]
    ]), 'Separate modeled components; no claim of venue account reconciliation.', link('Paper accounts', 'paper'), true)}${panel('By virtual account', table(['Account', 'Gross realized ₹', 'Terminal unrealized ₹', 'Fees ₹', 'Spread / market / stop bps', 'Inspect'], rows.map(({ s, a }) => [h(s.name), money(a.realizedGross), money(a.unrealized), money(a.fees), `${n(s.config.spreadBps)} / ${n(s.config.slippageBps)} / ${n(s.config.stopSlippageBps)}`, link('Account →', sessionUrl('paper-workspace', s))])), '', '', true)}`;
  }
  function risk() {
    const s = selected(), policy = S.workspace.paperPolicies?.find(p => p.sessionId === s?.id)?.policy, mode = policy?.modeConfig;
    const now = S.workspace.observedAtMs || Date.now(), today = new Date(now).toISOString().slice(0, 10);
    const daily = (s?.fills || []).filter(f => new Date(f.timestampMs).toISOString().slice(0, 10) === today).reduce((sum, f) => sum + Number(f.grossPnlInr) - Number(f.feeInr), 0);
    const obs = pairs().find(p => p.pair === `B-${s?.config.coin || S.coin}_USDT`);
    const audit = [...pairs().map(p => ({ title: `${p.pair} · shadow`, decision: p.riskDecision })), ...sessions().filter(s => s.lastRisk).map(s => ({ title: `${s.config.coin} · ${s.name} · PAPER`, decision: s.lastRisk }))];
    const rows = [
      ['Per-trade risk', mode ? `${mode.riskPerTradePercent}% virtual equity` : 'Select a paper session', s && mode ? money(Number(s.equityInr) * Number(mode.riskPerTradePercent) / 100) : 'Not evaluated', 'M7 sizing'],
      ['Gross exposure cap', mode ? money(mode.maxConcurrentExposureInr) : 'Policy unavailable', s?.book?.position ? money(U.positionExposure(s.book.position, s.lastMarkPriceUsdt, s.lastFxInrPerUsdt)) : 'Flat', 'Per isolated account'],
      ['Concurrent positions', mode ? String(mode.maxConcurrentPositions) : 'Policy unavailable', s?.book?.position ? '1' : '0', 'Per isolated account'],
      ['Daily INR loss cap', mode ? money(mode.maxDailyLossInr) : 'Policy unavailable', s ? money(daily) : 'No session', 'UTC realized gross less fees'],
      ['Min notional check', 'Discovered instrument × current conversion', obs?.minNotionalInr ? money(obs.minNotionalInr) : 'Not observed', 'Checked on paper step'],
      ['Venue ownership', 'Reconciled attribution required for live', 'UNAVAILABLE', 'LIVE LOCKED']
    ];
    return `${sessionSelector()}<div class="two-column"><div>${panel('Hard risk controls', table(['Control', 'Current SAFE policy', 'Retained paper state', 'Scope'], rows.map(r => r.map(h))), policy ? `Current engine policy ${policy.riskPolicyId} · not a live authorization` : 'No current paper policy available.', badge('SAFE · PAPER', 'teal'), true)}</div><div>${panel('Current admission decision', `<div class="admission-ring ${stopped() ? 'halted' : ''}"><div><strong>${stopped() ? 'STOPPED' : 'SAFE · PAPER'}</strong><small>LIVE ADMISSION · LOCKED</small></div></div><p class="small muted">${stopped() ? h(S.workspace.operations.reason) : 'SAFE describes the virtual policy. Each new virtual entry still needs its own M7 acceptance.'}</p><div class="form-actions">${link('Operations', 'operations')}${link('Readiness evidence', 'readiness')}</div>`)}</div></div>${panel('Latest M7 audit by pair / paper account', audit.length ? audit.map(({ title, decision }) => `<details><summary>${h(title)} · ${h(decision?.status || 'NO DECISION')} · ${(decision?.auditTrail || []).length} recorded steps</summary><div class="details-body"><div class="badge-row">${badge(decision?.primaryReasonCode || 'Not evaluated', 'amber')}${badge(decision?.action || '—', 'blue')}</div>${table(['Step', 'Check', 'Outcome', 'Reasons'], (decision?.auditTrail || []).map((a, i) => [h(a.step || i + 1), h(a.name || 'Retained audit'), badge(a.outcome || 'UNKNOWN', a.outcome === 'PASS' ? 'teal' : 'amber'), h((a.reasonCodes || []).join(' · '))]))}</div></details>`).join('') : empty('No M7 evaluation retained', 'Step a paper account or run a read-only shadow evaluation.'))}`;
  }
  function allocation() {
    const total = sessions().reduce((sum, s) => sum + Number(s.config.capitalInr), 0);
    return `<div class="kpis">${kpi('Declared virtual capital', money(total), 'Sum of independent paper account capital')}${kpi('Virtual equity', money(U.paperSummary(S.workspace).equity), 'Retained marks')}${kpi('Strategy instances', n(sessions().length, 0), 'No shared capital pool')}${kpi('Promotion', 'PAPER ONLY', 'No automatic allocation / live permission', 'amber-text', true)}</div>${panel('Multi-strategy virtual capital', table(['Strategy', 'Accounts', 'Declared capital ₹', 'Share of declared capital', 'Current virtual equity ₹'], [...U.kernels.map(k => {
      const list = sessions().filter(s => s.config.strategy === k.id), capital = list.reduce((sum, s) => sum + Number(s.config.capitalInr), 0), share = total ? capital / total * 100 : 0;
      return [h(k.name), n(list.length, 0), money(capital), `<progress max="100" value="${share}" aria-label="${h(k.name)} capital share"></progress> ${pct(share)}`, money(list.reduce((sum, s) => sum + Number(s.equityInr), 0))];
    }), ['Unallocated reserve', '—', 'Not modeled', 'No shared reserve / capital pool', 'Not established']]), 'Display-only aggregation of independent virtual accounts.', '', true)}${panel('Retained regime observations', table(['Pair', 'Kernel signal', 'EMA fast', 'EMA slow', 'RSI', 'Source'], pairs().map(p => [h(p.pair), badge(p.signal, 'blue'), n(p.indicators?.['ema.fast']), n(p.indicators?.['ema.slow']), n(p.indicators?.rsi), 'Latest shadow closed-candle observation'])), 'Signals are observations; no regime classifier or allocation automation is configured.', '', true)}${funding}`;
  }
  function pauseControls(scope) {
    return `<label class="field">Operator reason<input id="${scope}-reason" maxlength="400" value="" placeholder="Reason retained in the workspace audit"></label><div class="form-actions">${b('Stop admission', 'stop', scope, true, E.controlPending || !S.connected)}${b('Resume admission', 'resume', scope, false, E.controlPending || !S.connected || !stopped())}</div><p class="small muted" style="margin-top:12px">Stops new workspace admissions and virtual OPEN orders. It does not flatten positions, cancel venue orders or enable live trading.</p>`;
  }
  function news() {
    return `<div class="callout info">ROADMAP · No news calendar or automatic event-aware circuit breaker is connected. Event source, schedule and impact remain unknown.</div><div class="equal-columns">${panel('Operator event pause', `${badge(stopped() ? 'ADMISSION STOPPED' : 'MANUAL CONTROL AVAILABLE', stopped() ? 'amber' : 'blue')}<div class="divider"></div>${pauseControls('event')}`, 'Use a documented operator reason when pausing new entries.')}${panel('Event policy boundary', checklist([['Event source', 'Not configured. No calendar dates or synthetic impact scores are shown.'], ['Automatic action', 'Not implemented. No automatic pause or resume scheduler exists.'], ['Current operator latch', S.workspace.operations.reason || 'No operator reason recorded.'], ['Recovery', 'Manual review and explicit workspace resume; live remains locked.']]))}</div>`;
  }
  function shadowControls(label = 'Run Live Observation') {
    return `<div class="toolbar"><label class="sr-only" for="shadow-control-strategy">Shadow strategy</label><select id="shadow-control-strategy">${options([['ema-trend', 'EMA Trend'], ['rsi-momentum', 'RSI Momentum']], 'ema-trend')}</select>${b(label, 'shadow-run', '', true, runDisabled() || stopped())}<span class="small muted">SHADOW | ${h(U.trackedCoins(S.workspace).join(' / '))} | No venue orders</span></div>`;
  }
  function readiness() {
    const a = account(), passes = a?.passes || [], first = passes[0], second = passes[1];
    const rows = ['Orders', 'Positions'].map((name, i) => {
      const key = i === 0 ? 'ordersSha256' : 'positionsSha256', count = i === 0 ? 'orderCount' : 'positionCount';
      return [name, first ? `${n(first[count], 0)} records<div class="hash">${h(first[key])}</div>` : 'Not observed', second ? `${n(second[count], 0)} records<div class="hash">${h(second[key])}</div>` : 'Not observed', first && second ? badge(first.complete && second.complete && first[key] === second[key] ? 'MATCH · DECLARED SCOPE' : 'UNRESOLVED', first.complete && second.complete && first[key] === second[key] ? 'teal' : 'amber') : badge('NOT ESTABLISHED', 'amber')];
    });
    rows.push(['User Identity', a?.fingerprint ? `<span class="mono">${h(a.fingerprint)}</span>` : 'No fingerprint retained', 'Identity read scoped to the observation cycle', badge(a?.fingerprint ? 'OBSERVED HASH' : 'UNAVAILABLE', 'blue')]);
    rows.push(['Private Stream', h(a?.streamState || 'Not observed'), `${a?.streamConnected ? 'Connected during retained cycle' : 'No connection proven in retained cycle'}<small>No persistent stream is running after the cycle.</small>`, badge('HISTORICAL EVIDENCE', 'amber')]);
    return `<div class="kpis">${kpi('Observed convergence', a?.status || 'NOT OBSERVED', 'Latest retained account observation', a?.status === 'OBSERVED_CONVERGENCE' ? 'positive' : 'amber-text', true)}${kpi('REST passes', n(passes.length, 0), 'Two complete agreeing reads required')}${kpi('Ownership lineage', 'UNAVAILABLE', 'Observation is not ownership proof', 'amber-text', true)}${kpi('Authority granted', 'No', 'LIVE LOCKED', 'negative', true)}</div>${shadowControls()}${panel('Two-pass REST synchronization', table(['Component', 'Pass 1 / retained evidence', 'Pass 2 / current boundary', 'Observed state'], rows), 'Exact retained SHA-256 digests; never regenerated from displayed rows.', link('Recovery queue', 'recovery'), true)}<div class="callout">Two agreeing reads establish OBSERVED_CONVERGENCE within the declared scan scope. They do not establish an atomic snapshot, complete history, uninterrupted continuity or live authority.</div>${a?.error ? `<div class="callout error">${h(a.error)}</div>` : ''}`;
  }
  function reviewItems() {
    const list = (S.workspace.alerts || []).filter(a => !a.acknowledgedAtMs).map(a => ({ scope: a.scope, issue: a.code, reason: a.message, route: 'alerts' }));
    if (account()?.status !== 'OBSERVED_CONVERGENCE') list.push({ scope: 'Private account', issue: account()?.status || 'NOT_OBSERVED', reason: account()?.error || 'No converged account snapshot retained.', route: 'readiness' });
    if (S.workspace.rateBudget?.unknown || S.workspace.rateBudget?.blockedScopes?.length) list.push({ scope: 'M2 read budget', issue: 'LIMITER_REVIEW', reason: (S.workspace.rateBudget.blockedScopes || []).join(', ') || 'Coordinator state is unknown.', route: 'budget' });
    for (const job of (S.workspace.jobs || []).filter(j => j.status === 'FAILED').slice(-10)) list.push({ scope: job.id, issue: job.type, reason: job.error || 'Failed job retained for review.', route: 'audit' });
    return list;
  }
  function recovery() {
    const queue = reviewItems(), budget = S.workspace.rateBudget;
    return `<div class="kpis">${kpi('Manual review queue', n(queue.length, 0), 'Retained unresolved workspace items')}${kpi('Automatic retries', '0', 'No dashboard recovery retry scheduler')}${kpi('Reconnect latch', budget?.unknown ? 'UNKNOWN' : 'No persistent latch', 'Private stream is scoped to each shadow cycle', 'amber-text', true)}${kpi('Operator admission', stopped() ? 'STOPPED' : 'OPEN · PAPER', 'Live execution remains locked', 'amber-text', true)}</div>${panel('Review queue', table(['Scope', 'Unresolved item', 'Evidence / next review', 'Open'], queue.map(i => [h(i.scope), h(i.issue), h(i.reason), link('Review →', i.route)]), 'No unresolved items in the retained workspace. Live permissions remain locked.'), 'Review before re-observing; no blind replay.', '', true)}${panel('Conservative recovery checklist', `<div class="recovery-steps">${[['1', 'Stop new admission', 'Preserve positions and evidence. Do not assume a stop flattens exposure.'], ['2', 'Inspect retained evidence', 'Review identity, complete REST passes, private stream scope and M2 blocks.'], ['3', 'Run a fresh observation', 'Use the same managed read path. A read failure stays unresolved.'], ['4', 'Review, then resume paper', 'Manual resume affects workspace admission only. Live stays locked.']].map(([id, title, description]) => `<article><span class="step-number">${id}</span><h3>${title}</h3><p>${description}</p></article>`).join('')}</div><div class="form-actions">${link('Operations controls', 'operations')}${link('Re-observe account', 'readiness')}</div>`)}`;
  }
  function lineage() {
    return `<div class="callout">OFFLINE DIAGNOSTIC ONLY · No ownership resolver, durable lineage reconciliation or live-authority adapter is composed in this dashboard.</div><div class="equal-columns">${panel('Policy-empty ownership fields', table(['Field', 'Retained value', 'Authority'], [['Ownership policy ID', 'Not established', 'None'], ['Quantity attribution', 'Unavailable', 'None'], ['Durable lineage proof', 'Unavailable', 'None'], ['Live dispatch permission', 'LOCKED', 'None']]), 'Empty fields are intentionally not filled with synthetic proof.', '', true)}${panel('Integrity checklist', checklist([['Observed records', 'Order identity and account fingerprint do not prove strategy ownership.'], ['Virtual ownership', 'Attributable only within its isolated paper account.'], ['Offline boundary', 'Diagnostics cannot reconcile or mutate venue positions.'], ['Automatic promotion', 'Disabled; no ownership or execution authority is minted.']]))}</div>${link('Inspect sync evidence', 'readiness')}`;
  }
  function shadow() {
    const history = S.workspace.shadowHistory || [], points = history.flatMap(run => (run.passes || []).filter(p => p.readLatencyMs != null && p.observedAtMs != null).map(p => ({ timestampMs: p.observedAtMs, latency: p.readLatencyMs }))).sort((a, b) => a.timestampMs - b.timestampMs);
    return `${shadowControls('Run Shadow Evaluation')}<div class="kpis">${kpi('Retained campaigns', n(history.length, 0), 'Most recent 30 archived runs')}${kpi('Latest account state', account()?.status || 'NOT OBSERVED', 'Historical cycle evidence', 'amber-text', true)}${kpi('Orders submitted', n(S.workspace.shadowReport?.ordersSubmitted ?? 0, 0), 'Dashboard composes no live executor')}${kpi('Stream now', 'Not persistent', 'Cycle-scoped observation only', '', true)}</div><div class="two-column"><div>${panel('Read latency · REST pass', points.length ? lineChart(points, 'latency', 'REST pass duration ms') : empty('No measured REST timings', 'Run a new private observation to retain actual REST-pass timing. Older archives contain no latency samples.'), 'Measured end-to-end Orders + Positions reads, including managed budget wait. Older runs have no timings.')}</div><div>${panel('Observation boundary', checklist([['SHADOW only', 'No live enablement or executor is constructed.'], ['Recorded latency', 'Only measured REST-pass durations are plotted. No synthetic history.'], ['Private stream', 'Connection state describes the completed cycle, not current health.']]))}</div></div>${panel('Latest pair signals & M7 risk', table(['Pair', 'Signal', 'M7 status / action', 'Min notional ₹', 'Reasons'], pairs().map(p => [h(p.pair), badge(p.signal, 'blue'), badge(p.riskDecision ? `${p.riskDecision.status} · ${p.riskDecision.action}` : 'NO DECISION', p.riskDecision?.status === 'ACCEPTED' ? 'teal' : 'amber'), money(p.minNotionalInr), h((p.riskReasonCodes || []).join(' · '))])), '', '', true)}${panel('Shadow campaign history', table(['Saved', 'Run', 'Mode', 'Status', 'Account', 'Strategy', 'Inspect'], history.map(run => [h(date(run.savedAtIso)), `<span class="mono">${h(run.runId)}</span>`, badge(run.mode, 'blue'), h(run.summary?.status), badge(run.accountStatus || 'UNKNOWN', 'amber'), h(kernelName(run.summary?.strategy)), b('JSON evidence', 'shadow-evidence', run.runId)])), 'Real archive history; no generated campaigns.', '', true)}`;
  }
  function operations() {
    const budget = S.workspace.rateBudget || {}, busy = S.workspace.busy;
    return `<div class="health-grid">${health('Market-data worker', busy === 'INSTRUMENT_DISCOVERY' ? 'Reading instruments' : 'ON DEMAND', 'Reads occur on explicit UI requests; no background market worker.', 'blue')}${health('Research worker', busy || (S.busy ? 'UI JOB IN PROGRESS' : 'IDLE'), 'One server-managed job at a time.', busy ? 'amber' : 'teal')}${health('M2 Read coordinator', budget.connected ? 'CONNECTED' : 'UNAVAILABLE', `Admission ${budget.admission || 'UNKNOWN'} · ${(budget.blockedScopes || []).join(', ') || 'no reported blocked scopes'}`, budget.connected ? 'teal' : 'amber')}${health('Private stream', 'CYCLE SCOPED', `Last recorded: ${account()?.streamState || 'Not observed'}. No persistent stream.`, 'amber')}</div><div class="equal-columns">${panel('Operator admission control', `${badge(stopped() ? 'ADMISSION STOPPED' : 'PAPER ADMISSION OPEN', stopped() ? 'red' : 'teal')}<p class="small muted" style="margin:14px 0">${h(S.workspace.operations.reason || 'No operator reason retained.')} · ${h(date(S.workspace.operations.updatedAtMs))}</p>${pauseControls('operations')}`, 'The stop control remains usable during an in-flight research / paper job.')}${panel('Lifecycle & safety', checklist([['Order boundary', 'No venue order create, amend or cancel route exists.'], ['Admission stop', 'Cancels virtual working OPEN orders and blocks new entries / research.'], ['Risk reduction', 'Existing virtual protection can advance when running sessions are stepped.'], ['Shutdown', 'SIGINT / SIGTERM drain the server and close the shared read lifecycle.']]), '', link('Shared rate budget', 'budget'))}</div>${panel('Operational event log', table(['When', 'Action', 'Scope', 'Retained details'], (S.workspace.auditLog || []).slice(-50).reverse().map(a => [h(date(a.timestampMs)), h(a.action), h(a.scope), `<span class="mono">${h(JSON.stringify(a.details))}</span>`])), 'Latest 50 workspace audit events.', '', true)}`;
  }
  function health(title, state, note, color) { return `<article class="health-card"><p class="eyebrow">${h(title)}</p>${badge(state, color)}<p>${h(note)}</p></article>`; }
  function budget() {
    const r = S.workspace.rateBudget || {}, pacing = r.pacing || {}, points = (r.traffic || []).map(p => ({ timestampMs: p.timestampMs, starts: p.starts }));
    return `<div class="kpis">${kpi('Managed request starts', r.started == null ? '—' : n(r.started, 0), 'This dashboard process · cumulative')}${kpi('In flight', r.inFlight == null ? '—' : `${r.inFlight} / ${pacing.concurrency ?? '?'}`, 'Actual started permits awaiting completion')}${kpi('Pending acquisitions', r.pending == null ? '—' : n(r.pending, 0), 'Actual budget acquisition waiters')}${kpi('External IP consumers', 'UNKNOWN', 'Unmanaged processes are not observed', 'amber-text', true)}</div><div class="two-column"><div>${panel('Managed request traffic', points.length ? lineChart(points, 'starts', 'Cumulative managed starts') : empty('No request starts recorded', 'The traffic chart uses actual permit-start samples from this server process.'), 'Actual permit-start samples; bounded in-memory telemetry. Refresh to update.', b('Refresh budget', 'refresh'))}</div><div>${panel('Coordinator state', metrics([['Connection', r.connected === true ? 'Connected' : 'Unavailable / unknown'], ['Admission stop', stopped() ? 'Workspace stopped' : `Workspace open · M2 ${r.admission || 'UNKNOWN'}`], ['Throttle / blocked scopes', r.blockedScopes?.length ? r.blockedScopes.join(', ') : r.unknown ? 'Unknown' : 'None reported'], ['Throttles observed', r.throttled == null ? 'Unknown' : String(r.throttled)], ['Outbox size', r.outboxSize == null ? 'Unknown' : String(r.outboxSize)], ['Telemetry scope', r.telemetryScope || 'Not instrumented']]))}</div></div>${panel('Effective pacing and reference', table(['Window', 'Starts', 'Status'], [['1 second', pacing.startsPerSecond == null ? 'Unavailable' : h(pacing.startsPerSecond), badge('EFFECTIVE LOCAL POLICY', 'teal')], ['60 seconds', pacing.startsPerMinute == null ? 'Unavailable' : h(pacing.startsPerMinute), badge('EFFECTIVE LOCAL POLICY', 'teal')], ['10 seconds · requested reference', '1000 req / 10s', badge('REFERENCE · NOT CONFIGURED', 'amber')]]), 'The stricter active local policy remains in force. This display is not a provider quota or shared-IP guarantee.', '', true)}${panel('Managed consumers by read scope', table(['Consumer scope', 'Managed operations', 'Acquisitions', 'Started', 'In flight', 'Pending', 'Refused'], [['PUBLIC', 'Historical / chart / paper candle reads'], ['API_AUTH', 'Instrument discovery, conversion and private observation reads']].map(([scope, detail]) => { const c = r.scopes?.[scope]; return [h(scope), h(detail), n(c?.acquisitions, 0), n(c?.started, 0), n(c?.inFlight, 0), n(c?.pending, 0), n(c?.refused, 0)]; })), 'Transport scopes are measured. Individual strategies are not separately metered.', '', true)}`;
  }
  function alertsBody() {
    return table(['Impact', 'Issue / scope', 'Actionable message', 'Created', 'State', 'Action'], U.filterAlerts(S.workspace.alerts, E.alertSeverity, E.alertState, E.alertQuery).slice().reverse().map(a => [badge(a.severity, a.severity === 'CRITICAL' ? 'red' : a.severity === 'WARNING' ? 'amber' : 'blue'), h(a.code) + `<small>${h(a.scope)}</small>`, h(a.message), h(date(a.createdAtMs)), a.acknowledgedAtMs ? `Acknowledged<small>${h(date(a.acknowledgedAtMs))}</small>` : badge('NEEDS REVIEW', 'amber'), a.acknowledgedAtMs ? 'Recorded' : b('Acknowledge', 'ack', a.id, false, E.controlPending || !S.connected)]), 'No alerts match the current filters. Acknowledgement never resolves the underlying condition.');
  }
  function alerts() {
    let toastEnabled = true; try { toastEnabled = localStorage.getItem('workspace-alert-toasts') !== 'off'; } catch { /* Browser storage may be unavailable. */ }
    return `<div class="toolbar"><label class="search-field search">Find alert<input data-exec-input="alert-query" value="${h(E.alertQuery)}" type="search" placeholder="Code, message or scope…"></label><label>Impact<select data-exec-change="alert-severity">${options(['ALL', 'CRITICAL', 'WARNING', 'INFO'], E.alertSeverity)}</select></label><label>State<select data-exec-change="alert-state">${options(['OPEN', 'ACKNOWLEDGED', 'ALL'], E.alertState)}</select></label></div>${panel('Actionable alert inbox', `<div id="execution-alerts">${alertsBody()}</div>`, 'Persisted workspace issues and operator acknowledgements.', '', true)}<div class="equal-columns">${panel('Delivery preferences', `<label class="check-field"><input type="checkbox" data-exec-change="alert-toasts" ${toastEnabled ? 'checked' : ''}> In-app acknowledgement feedback</label><p class="small muted" style="margin-top:10px">Stored in this browser only. The retained inbox is always available.</p>${metrics([['Workspace inbox', 'Enabled · persisted'], ['Email / webhook / push', 'Not configured']])}`)}${panel('Alert policy checklist', checklist([['Actionable evidence', 'Alerts retain issue code, scope and creation time.'], ['Explicit acknowledgement', 'Acknowledging is audited; the underlying risk remains independently evaluated.'], ['No automatic execution', 'No alert action changes venue exposure or unlocks live trading.']]))}</div>`;
  }
  function onboarding() {
    const fresh = E.instruments?.instruments, retained = S.workspace.shadowReport?.cycles?.at(-1)?.markets || [];
    const rows = U.trackedCoins(S.workspace).map(coin => {
      const live = fresh?.find(i => i.underlying === coin), market = retained.find(m => m.underlying === coin), summary = pairs().find(p => p.pair === `B-${coin}_USDT`);
      const tiers = live?.leverageTiers || summary?.observedLeverageTiers || [], eligibility = live?.eligibility;
      return [h(coin), h(live?.pair || market?.pair || `B-${coin}_USDT`) + `<small>${live?.pair ? 'Discovered mapping' : live ? 'Expected / retained mapping · latest discovery unavailable' : market ? 'Retained discovered mapping' : 'Expected mapping · not yet discovered'}</small>`, badge(live?.error || live?.status || market?.status || 'NOT OBSERVED', live ? live.status === 'active' ? 'teal' : 'amber' : market?.status === 'OBSERVED' ? 'teal' : 'amber'), tiers.length ? tiers.map(t => `${h(t.leverage)}× ≤ ${n(t.maxPositionSizeUsdt)} USDT`).join('<br>') : 'Not observed', live ? money(live.minNotionalInr) : money(summary?.minNotionalInr) + '<small>Retained shadow conversion</small>', eligibility ? Object.entries(eligibility).filter(([key, value]) => key !== 'live' && value).map(([key]) => badge(key.toUpperCase(), 'blue')).join(' ') : 'Profile eligibility not loaded', badge('LIVE LOCKED', 'amber')];
    });
    return `<div class="toolbar">${b('Refresh discovered profiles', 'discover', '', true, runDisabled())}${E.instruments ? badge(`Observed ${date(fresh?.[0]?.observedAtMs)}`, 'blue') : badge('RETAINED SHADOW / NOT YET OBSERVED', 'amber')}</div>${E.instrumentError ? `<div class="callout error">${h(E.instrumentError)}</div>` : ''}${panel('Coin onboarding & instrument constraints', table(['Coin', 'Pair', 'Venue state', 'Dynamic leverage tiers', 'Min notional INR', 'Configured modes', 'Live boundary'], rows), 'Real configured profiles and discovered INR perpetual metadata.', '', true)}${panel('Onboarding path', `<div class="recovery-steps">${[['1', 'Discover', 'Resolve an active INR perpetual and its current constraints.'], ['2', 'Verify data', 'Inspect actual closed candle coverage and gaps.'], ['3', 'Research', 'Backtest and validate with explicit costs and protection.'], ['4', 'Paper only', 'Deploy an isolated virtual session; live remains locked.']].map(([i, title, note]) => `<article><span class="step-number">${i}</span><h3>${title}</h3><p>${note}</p></article>`).join('')}</div><div class="form-actions">${link('Verify data', 'data')}${link('New backtest', 'backtest')}${link('Deploy to paper', 'paper-deploy')}</div>`)}`;
  }
  function auditBody() {
    return table(['Time', 'Action', 'Scope', 'Evidence', 'Inspect'], (S.workspace.auditLog || []).filter(a => JSON.stringify(a).toLowerCase().includes(E.auditQuery.toLowerCase())).slice().reverse().map(a => [h(date(a.timestampMs)), h(a.action), `<span class="mono">${h(a.scope)}</span>`, h(JSON.stringify(a.details)), b('Details', 'audit-evidence', a.id)]), 'No operator audit events match this search.');
  }
  function audit() {
    return `<div class="kpis">${kpi('Retained audit events', n(S.workspace.auditLog?.length || 0, 0), 'Bounded persistent workspace history')}${kpi('Shadow archives', n(S.reports.filter(r => r.mode !== 'BACKTEST').length, 0), 'Read-only observations')}${kpi('Backtest reports', n(S.reports.filter(r => r.mode === 'BACKTEST').length, 0), 'Historical simulation evidence')}${kpi('Trading authority', 'NONE', 'Audit evidence never authorizes live', 'amber-text', true)}</div><div class="toolbar"><label class="search-field search">Find audit evidence<input type="search" value="${h(E.auditQuery)}" data-exec-input="audit-query" placeholder="Action, scope, reference…"></label>${link('Reports & exports →', 'reports')}</div>${panel('Operator audit trail', `<div id="execution-audit">${auditBody()}</div>`, 'Retained operator events, policy decisions and job references.', '', true)}`;
  }
  function reportEntries() {
    return [...S.reports.map(r => ({ ...r, id: r.runId, kind: r.mode === 'BACKTEST' ? 'BACKTEST' : 'SHADOW', time: r.savedAtIso, name: r.runId, note: r.mode === 'BACKTEST' ? `${money(r.summary?.netPnlInr)} modeled net` : r.summary?.status || r.mode })),
      ...(S.workspace.researchRuns || []).map(r => ({ id: r.id, kind: r.type, time: r.createdAtMs, name: r.id, note: r.type === 'MATRIX' ? `${r.result?.cells?.length || 0} grid cells` : `${r.result?.byPair?.length || 0} pair folds` })),
      ...sessions().map(s => ({ id: s.id, kind: 'PAPER', time: s.updatedAtMs || s.createdAtMs, name: s.name, note: `${money(s.equityInr)} virtual equity` }))].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }
  function reportBody() {
    return table(['Saved / updated', 'Report', 'Source', 'Retained summary', 'Inspect', 'Download'], reportEntries().filter(r => (E.reportMode === 'ALL' || r.kind === E.reportMode) && `${r.id} ${r.name} ${r.note}`.toLowerCase().includes(E.reportQuery.toLowerCase())).map(r => [h(date(r.time)), h(r.name) + `<small class="mono">${h(r.id)}</small>`, badge(r.kind, r.kind === 'SHADOW' ? 'amber' : 'blue'), h(r.note), b('Inspect JSON', 'report-evidence', r.id), `<div class="toolbar"><a class="button" download href="/api/reports/export?id=${encodeURIComponent(r.id)}&amp;format=json">JSON ↓</a>${['BACKTEST', 'PAPER'].includes(r.kind) ? `<a class="button" download href="/api/reports/export?id=${encodeURIComponent(r.id)}&amp;format=csv">CSV ledger ↓</a>` : ''}</div>`]), 'No matching saved reports.');
  }
  function reports() {
    return `<div class="callout info">JSON packages retain source evidence and scoped audit events. CSV is available for actual backtest / paper trade ledgers. Funding stays excluded; every package is research or paper only.</div><div class="toolbar"><label class="search-field search">Find a report<input type="search" value="${h(E.reportQuery)}" data-exec-input="report-query" placeholder="Run ID, name or summary…"></label><label>Source<select data-exec-change="report-mode">${options(['ALL', 'BACKTEST', 'SHADOW', 'MATRIX', 'VALIDATION', 'PAPER'], E.reportMode)}</select></label>${b('Refresh reports', 'refresh')}</div>${panel('Reports & exports', `<div id="execution-reports">${reportBody()}</div>`, 'Saved local evidence · one-click inspection and native downloads.', '', true)}`;
  }
  const views = { paper, 'paper-workspace': paperWorkspace, 'paper-deploy': deploy, orders, 'order-detail': orderDetail, positions, 'position-detail': positionDetail,
    accounting, risk, allocation, news, readiness, recovery, lineage, shadow, operations, budget, alerts, onboarding, audit, reports };
  async function discover() {
    E.triedDiscovery = true; E.instrumentError = null;
    try { E.instruments = await C.api('/api/instruments'); }
    catch (error) { E.instrumentError = C.errorText(error); }
  }
  async function hydrate() {
    if (['paper-workspace', 'position-detail'].includes(S.route)) { const s = selected(); if (s) await C.fetchMarket(s.config.coin, s.config.timeframe); }
    if (S.route === 'onboarding' && !E.triedDiscovery) await discover();
  }
  function onRoute(params) {
    if (params.has('session')) E.sessionId = params.get('session');
    if (params.has('order')) { E.orderId = params.get('order'); E.orderSource = params.get('source') === 'OBSERVED' ? 'OBSERVED' : 'PAPER'; }
  }
  async function control(el, work, success) {
    if (E.controlPending) return;
    E.controlPending = true; el.disabled = true;
    try { await work(); await C.refreshAfterMutation(); let feedback = true; try { feedback = el.dataset.exec !== 'ack' || localStorage.getItem('workspace-alert-toasts') !== 'off'; } catch { /* Storage unavailable. */ } if (feedback) C.toast(success, el.dataset.exec === 'resume' ? 'operator' : 'routine'); }
    catch (error) { C.notice(C.errorText(error), true); }
    finally { E.controlPending = false; C.render(); }
  }
  function click(el) {
    const name = el.dataset.exec, id = el.dataset.id;
    if (name === 'session-evidence') { C.evidence('Virtual session evidence', sessions().find(s => s.id === id)); return; }
    if (name === 'order-evidence') { const split = id.indexOf(':'); C.evidence('Order source evidence', U.allOrders(S.workspace).find(o => o.source === id.slice(0, split) && o.id === id.slice(split + 1))); return; }
    if (name === 'audit-evidence') { C.evidence('Operator audit event', S.workspace.auditLog.find(a => a.id === id)); return; }
    if (name === 'stop') { window.openStop(C.$(`#${id}-reason`)?.value.trim() || ''); return; }
    if (name === 'resume') {
      const reason = C.$(`#${id}-reason`)?.value.trim() || `Operator ${name === 'stop' ? 'stop' : 'resume'} from ${id}`;
      // Independent from the long-job UI lock, so a stop can invalidate in-flight admission.
      void control(el, () => C.api(`/api/operations/${name}`, { reason }), name === 'stop' ? 'Workspace admission stopped. Positions are not automatically closed.' : 'Workspace paper admission resumed. Live remains locked.'); return;
    }
    if (name === 'ack') {
      void control(el, async () => { await C.api(`/api/alerts/${encodeURIComponent(id)}/ack`, {}); }, 'Acknowledgement retained. The underlying condition remains independently evaluated.'); return;
    }
    if (name === 'toggle') {
      const s = sessions().find(s => s.id === id); if (!s) return;
      void control(el, () => C.api(`/api/paper/sessions/${encodeURIComponent(id)}/toggle`, { running: s.status !== 'RUNNING' }), s.status === 'RUNNING' ? 'Paper session paused. Virtual positions retain their last mark.' : 'Paper session resumed. Step to evaluate the next closed window.'); return;
    }
    void C.perform(el, name === 'shadow-run' ? 'Running read-only shadow observation' : 'Loading workspace evidence', async () => {
      if (name === 'step') {
        await C.api(`/api/paper/sessions/${encodeURIComponent(id)}/step`, {}); await C.refreshAfterMutation(); C.render();
        C.notice('Paper step completed against available closed candles. Repeated windows do not duplicate fills; new admissions still require M7 acceptance.');
      } else if (name === 'shadow-run') {
        await C.api('/api/shadow/run', { coins: U.trackedCoins(S.workspace), strategy: C.$('#shadow-control-strategy')?.value || 'ema-trend', equityInr: U.preferences(S.workspace).defaultEquityInr, maxOrderNotionalInr: U.preferences(S.workspace).defaultMaxOrderNotionalInr, mode: 'SHADOW' });
        await C.refreshAfterMutation(); C.render(); C.notice('Read-only observation retained. Review convergence and blockers; live trading remains locked.');
      } else if (name === 'session-candles') {
        const s = sessions().find(s => s.id === id); if (s) await C.fetchMarket(s.config.coin, s.config.timeframe, true); C.render();
      } else if (name === 'discover') { await discover(); C.render(); }
      else if (name === 'refresh') { await C.refreshAfterMutation(); C.render(); }
      else if (name === 'shadow-evidence') C.evidence('Read-only shadow campaign', await C.api(`/api/reports/${encodeURIComponent(id)}`));
      else if (name === 'report-evidence') {
        const local = sessions().find(s => s.id === id) || S.workspace.researchRuns.find(r => r.id === id);
        C.evidence('Retained report evidence', local || await C.api(`/api/reports/${encodeURIComponent(id)}`));
      }
    });
  }
  function change(el) {
    const name = el.dataset.execChange; if (!name) return false;
    if (name === 'session') { E.sessionId = el.value; location.hash = `${S.route}?session=${encodeURIComponent(el.value)}`; }
    else if (name === 'order-source') { E.orderSourceFilter = el.value; C.render(); }
    else if (name === 'order-status') { E.orderStatus = el.value; C.render(); }
    else if (name === 'alert-severity') { E.alertSeverity = el.value; C.render(); }
    else if (name === 'alert-state') { E.alertState = el.value; C.render(); }
    else if (name === 'report-mode') { E.reportMode = el.value; C.render(); }
    else if (name === 'alert-toasts') { try { localStorage.setItem('workspace-alert-toasts', el.checked ? 'on' : 'off'); } catch { C.notice('Browser preference storage unavailable.', true); } }
    return true;
  }
  function input(el) {
    const name = el.dataset.execInput; if (!name) return false;
    const handlers = { 'order-query': ['orderQuery', '#execution-orders', ordersBody], 'alert-query': ['alertQuery', '#execution-alerts', alertsBody], 'audit-query': ['auditQuery', '#execution-audit', auditBody], 'report-query': ['reportQuery', '#execution-reports', reportBody] };
    const target = handlers[name]; if (target) { E[target[0]] = el.value; C.$(target[1]).innerHTML = target[2](); }
    return true;
  }
  function submit(event) {
    if (event.target.id !== 'paper-deploy-form') return false;
    event.preventDefault(); const form = event.target;
    void C.perform(event.submitter, 'Creating isolated virtual account', async () => {
      const config = C.backtestPayload(form), name = C.formValues(form).name.trim();
      const result = await C.api('/api/paper/sessions', { ...config, name }); E.sessionId = result.id;
      await C.refreshAfterMutation(); location.hash = sessionUrl('paper-workspace', result); C.toast('Virtual paper session created. Step to warm and evaluate; no venue orders are submitted.');
    });
    return true;
  }
  function updateButtons() {
    document.querySelectorAll('[data-exec]').forEach(el => {
      const name = el.dataset.exec, s = sessions().find(s => s.id === el.dataset.id);
      if (name === 'step') el.disabled = runDisabled() || s?.status !== 'RUNNING';
      else if (name === 'toggle') el.disabled = E.controlPending || !S.connected || (s?.status !== 'RUNNING' && stopped());
      else if (name === 'stop' || name === 'ack') el.disabled = E.controlPending || !S.connected;
      else if (name === 'resume') el.disabled = E.controlPending || !S.connected || !stopped();
      else if (name === 'shadow-run') el.disabled = runDisabled() || stopped();
      else if (name === 'session-candles' || name === 'discover') el.disabled = runDisabled();
      else if (name === 'refresh') el.disabled = S.busy || !S.connected;
    });
  }
  return { E, views, hydrate, onRoute, click, change, input, submit, updateButtons };
};
