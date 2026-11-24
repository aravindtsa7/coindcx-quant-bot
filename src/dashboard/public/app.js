/* Local-only application. All prices, research outcomes and evidence come from /api/. */
(() => {
  'use strict';
  const U = window.WorkspaceUI, $ = selector => document.querySelector(selector);
  const S = { workspace: null, status: null, reports: [], route: 'overview', connected: false, busy: false,
    coin: 'SOL', timeframe: '15m', market: {}, marketErrors: {}, datasets: {}, datasetId: null,
    report: null, matrix: null, validation: null, chartTab: 'equity', visibleBars: 80, chartOffset: 0,
    builder: null, backtestDraft: null, ledgerQuery: '', rankingCoin: 'ALL', loading: new Set(), syncJob: null, syncCancelling: false };
  let plots = new Map(), plotSequence = 0, routeVersion = 0, toastTimer;
  let syncPollTimer, syncPolling = false, syncInventoryPending = false, syncVersion = 0, activeSyncJobId = null, syncToastKey = null;
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const n = (value, digits = 2) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const money = value => value === null || value === undefined ? '—' : `₹${n(value)}`;
  const pct = value => value === null || value === undefined ? '—' : `${n(value)}%`;
  const sign = value => Number(value) < 0 ? 'negative' : 'positive';
  const zone = () => S.workspace?.settings?.timezone || 'Asia/Calcutta';
  function date(value, time = true) {
    const d = new Date(value); if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('en-IN', { timeZone: zone(), day: '2-digit', month: 'short', ...(time ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }) });
  }
  const badge = (text, color = '') => `<span class="pill ${color}">${h(text)}</span>`;
  const link = (text, route, primary = false) => `<a class="button${primary ? ' primary' : ''}" href="#${h(route)}">${h(text)}</a>`;
  const action = (text, name, attributes = '', primary = false) => `<button type="button" data-action="${h(name)}" ${attributes} class="${primary ? 'primary' : ''}">${h(text)}</button>`;
  const empty = (title, text = '', cta = '') => `<div class="empty"><h2>${h(title)}</h2><p>${h(text)}</p>${cta}</div>`;
  function panel(title, body, subtitle = '', tools = '', flush = false, note = '') {
    return `<section class="panel"><div class="panel-head"><div><h2>${h(title)}</h2>${subtitle ? `<p>${h(subtitle)}</p>` : ''}</div>${tools}</div><div class="panel-body${flush ? ' flush' : ''}">${body}</div>${note ? `<div class="note">${note}</div>` : ''}</section>`;
  }
  function table(headers, rows, emptyText = 'No records in this workspace yet.') {
    return rows.length ? `<div class="table-wrap"><table><thead><tr>${headers.map(t => `<th>${h(t)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(t => `<td>${t}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('No records yet', emptyText);
  }
  const kpi = (label, value, note, color = '', compact = false) => `<article class="kpi"><div class="kpi-label">${h(label)}</div><div class="kpi-value ${color} ${compact ? 'compact' : ''}">${h(value)}</div><div class="kpi-note">${h(note)}</div></article>`;
  const metrics = rows => `<dl class="metric-list">${rows.map(([label, value]) => `<div><dt>${h(label)}</dt><dd>${h(value)}</dd></div>`).join('')}</dl>`;
  const options = (items, selected) => items.map(item => { const [value, text] = Array.isArray(item) ? item : [item, item]; return `<option value="${h(value)}"${String(value) === String(selected) ? ' selected' : ''}>${h(text)}</option>`; }).join('');
  const field = (label, name, value = '', type = 'text', attrs = '') => `<label>${h(label)}<input name="${h(name)}" type="${type}" value="${h(value)}" ${attrs}></label>`;
  const select = (label, name, items, selected, attrs = '') => `<label>${h(label)}<select name="${h(name)}" ${attrs}>${options(items, selected)}</select></label>`;
  const coinOptions = [], timeOptions = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '4h'];
  const kernelName = id => U.kernels.find(k => k.id === id)?.name || id;
  const pairName = pair => String(pair || '').replace('B-', '').replace('_', ' / ');
  function coinLabel(coin) { return `<span class="coin"><span class="coin-mark ${coin.toLowerCase()}">${coin === 'BTC' ? '₿' : coin === 'ETH' ? 'Ξ' : '◎'}</span><span><strong>${h(coin)} / USDT</strong><small>INR collateral · Perpetual</small></span></span>`; }
  const latestCycle = () => S.workspace?.shadowReport?.cycles?.at(-1);
  const savedResearch = type => (S.workspace?.researchRuns || []).filter(r => r.type === type).at(-1)?.result;
  function errorText(error) { return error instanceof Error ? error.message : String(error); }
  async function api(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    let result; try { result = await response.json(); } catch { throw new Error(`HTTP ${response.status}: the server did not return JSON.`); }
    if (!response.ok) {
      const reasons = { RUN_IN_PROGRESS: 'Another workspace job is running. Wait for it to finish and retry.', OPERATOR_STOPPED: 'The operator admission latch is stopped. Review Operations before running research.', PROVIDER_READ_FAILED: 'CoinDCX could not supply complete data. Check connection evidence and retry.' };
      throw new Error(reasons[result.error] || `${result.error || 'Request failed'}${result.fields?.length ? ': ' + result.fields.map(f => typeof f === 'string' ? f : JSON.stringify(f)).join(', ') : ''} (HTTP ${response.status})`);
    }
    return result;
  }
  function notice(text = '', error = false) { const el = $('#notice'); el.hidden = !text; el.className = error ? 'error' : ''; el.textContent = text; }
  function toast(text, category = 'routine') { const p = U.preferences(S.workspace); if (category !== 'operator' && !p.notifications[category === 'research' ? 'researchCompletion' : 'routineStatus']) return; $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
  function evidence(title, data) { $('#evidence-title').textContent = title; $('#evidence-content').textContent = JSON.stringify(data, null, 2); $('#evidence-dialog').showModal(); }
  async function refresh() {
    const version = syncVersion;
    const [workspace, status, reports] = await Promise.all([api('/api/workspace'), api('/api/status'), api('/api/reports')]);
    if ((S.workspace?.operations?.generation ?? -1) > (workspace.operations?.generation ?? -1)) workspace.operations = S.workspace.operations;
    coinOptions.splice(0, coinOptions.length, ...U.trackedCoins(workspace)); S.workspace = workspace; S.status = status; S.reports = reports.reports; S.connected = true;
    system.invalidate();
    S.matrix ||= savedResearch('MATRIX'); S.validation ||= savedResearch('VALIDATION');
    if (!S.datasetId) S.datasetId = workspace.datasets.at(-1)?.id || null;
    $('#connection-notice').hidden = true;
    if (version === syncVersion && workspace.syncJobStatus) acceptSyncJob(workspace.syncJobStatus);
    else if (S.syncJob) { workspace.syncJobStatus = S.syncJob; if (S.syncJob.status === 'RUNNING') workspace.busy = 'DATA_SYNC'; else if (workspace.busy === 'DATA_SYNC') workspace.busy = null; }
  }
  function connectionError(error) {
    S.connected = false; const el = $('#connection-notice'); el.hidden = false;
    el.textContent = `Workspace connection unavailable: ${errorText(error)} Retained values may be stale. Use Refresh to reconnect. Live execution remains locked.`;
    shell();
  }
  function shell() {
    const page = U.screens.find(p => p.id === S.route) || U.screens[1];
    const language = S.workspace?.settings?.language || 'en', title = U.screenTitle(page.id, language);
    document.documentElement.lang = language;
    document.title = `${title} · CoinDCX Quant`;
    $('#page-title').textContent = title;
    $('#page-description').textContent = page.description;
    $('#screen-label').textContent = `${page.section.toUpperCase()} / SCREEN ${String(page.number).padStart(2, '0')} OF 42`;
    $('#footer-screen').textContent = `Screen ${String(page.number).padStart(2, '0')} / 42 · ${zone()}`;
    $('#screen-jumper').value = page.id;
    const family = U.family(page.id);
    $('#subtabs').innerHTML = family.length > 1 ? family.map(id => `<a href="#${id}"${id === page.id ? ' class="active" aria-current="page"' : ''}>${h(U.screenTitle(id, language))}</a>`).join('') : '';
    initNavigation(language);
    document.querySelectorAll('.nav-link').forEach(el => { const active = el.dataset.route === U.parent(page.id); el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
    const source = $('#source-badge'); source.textContent = !S.connected ? 'OFFLINE · RETAINED' : S.status?.readiness?.shadowReady ? 'SHADOW READY' : S.status?.budget?.connected ? 'LIVE DATA' : 'WORKSPACE DATA';
    source.className = `pill ${S.connected ? 'blue' : 'amber'}`;
    $('#connection-dot').classList.toggle('connected', S.connected);
    $('#connection-label').textContent = S.connected ? 'Workspace connected' : 'Workspace disconnected';
    const admission = $('#admission-badge'), stopped = S.workspace?.operations?.admissionStopped;
    admission.textContent = stopped ? 'ADMISSION STOPPED' : S.connected ? 'PAPER ADMISSION OPEN' : 'ADMISSION UNKNOWN';
    admission.className = `pill ${stopped ? 'red' : S.connected ? 'teal' : 'amber'}`;
  }
  const paths = { grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', chart: '<path d="M3 3v18h18M6 15l5-5 4 3 6-9"/>', data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v13c0 4 16 4 16 0V5M4 11c0 4 16 4 16 0"/>', sliders: '<path d="M3 5h18M3 12h18M3 19h18"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="19" r="2"/>', shield: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>', bars: '<path d="M4 20h17M5 17V9h3v8M11 17V4h3v13M17 17v-5h3v5"/>', list: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>', wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 13h5M16 16h2"/>', sync: '<path d="M20 7A8 8 0 0 0 6 5L3 8M3 3v5h5M4 17a8 8 0 0 0 14 2l3-3M21 21v-5h-5"/>', pulse: '<path d="M2 13h5l4-9 4 16 3-7h4"/>', bell: '<path d="M6 17v-7a6 6 0 0 1 12 0v7l2 2H4zM10 22h4"/>', plug: '<path d="M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-14 0zM12 18v4"/>' };
  function initNavigation(language = S.workspace?.settings?.language || 'en') {
    $('#navigation').innerHTML = U.nav.map(([group, links]) => `<div class="nav-group"><p class="nav-label">${h(U.translate(group, language))}</p>${links.map(([id, name, icon]) => `<a class="nav-link" href="#${id}" data-route="${id}"><svg viewBox="0 0 24 24" aria-hidden="true">${paths[icon]}</svg>${h(U.translate(name, language))}</a>`).join('')}</div>`).join('');
    $('#screen-jumper').innerHTML = options(U.screens.map(p => [p.id, `${String(p.number).padStart(2, '0')} / ${U.screenTitle(p.id, language)}`]), S.route);
    renderIndex($('#index-search').value || '');
  }
  function renderIndex(query = '') {
    const language = S.workspace?.settings?.language || 'en', matches = U.screens.filter(p => `${String(p.number).padStart(2, '0')} ${p.title} ${U.screenTitle(p.id, language)} ${p.section}`.toLowerCase().includes(query.toLowerCase()));
    $('#screen-index-list').innerHTML = [...new Set(matches.map(p => p.section))].map(section => `<section class="screen-index-group"><h3>${h(U.translate(section, language))}</h3>${matches.filter(p => p.section === section).map(p => `<a class="screen-index-link" href="#${p.id}"><span class="screen-number">${String(p.number).padStart(2, '0')}</span><span>${h(U.screenTitle(p.id, language))}<small>${h(p.description)}</small></span></a>`).join('')}</section>`).join('') || empty('No matching screens');
  }
  function openIndex() { $('#screen-index').showModal(); $('#index-search').focus(); }
  function svgLine(points, x, y) { return points.map((p, i) => `${i ? 'L' : 'M'}${x(p, i).toFixed(2)},${y(p, i).toFixed(2)}`).join(' '); }
  function spark(candles) {
    if (!candles?.length) return '<span class="muted">No candle history</span>';
    const values = candles.slice(-30).map(c => Number(c.close)), low = Math.min(...values), high = Math.max(...values), span = high - low || high * .01 || 1;
    return `<svg class="spark" viewBox="0 0 110 35" role="img" aria-label="Last 30 closed hourly prices"><path d="${svgLine(values, (_, i) => 2 + i / Math.max(1, values.length - 1) * 106, v => 31 - (v - low) / span * 27)}" fill="none" stroke="${values.at(-1) >= values[0] ? '#4bd6b7' : '#ee7482'}" stroke-width="1.5"/></svg>`;
  }
  function lineChart(points, fieldName = 'equityInr', label = 'Equity INR') {
    if (!points?.length) return empty('No curve to plot', 'A saved backtest or paper cash event will appear here.');
    const width = 800, height = 280, left = 12, right = 85, top = 24, bottom = 37;
    const values = points.map(p => Number(p[fieldName])), min = Math.min(...values), max = Math.max(...values), pad = (max - min) * .12 || Math.abs(max) * .01 || 1;
    const lo = min - pad, hi = max + pad;
    const x = (_, i) => left + i / Math.max(1, points.length - 1) * (width - left - right), y = p => top + (hi - Number(p[fieldName])) / (hi - lo) * (height - top - bottom);
    const color = fieldName === 'drawdownPct' ? '#ee7482' : '#4bd6b7', id = `plot-${++plotSequence}`;
    plots.set(id, { points, label, fieldName, x, width, left, right });
    const grid = Array.from({ length: 4 }, (_, i) => { const v = lo + (hi - lo) * i / 3, yy = top + (hi - v) / (hi - lo) * (height - top - bottom); return `<line class="grid-line" x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}"/><text x="${width - right + 10}" y="${yy + 3}">${h(n(v, fieldName === 'drawdownPct' ? 2 : 0))}${fieldName === 'drawdownPct' ? '%' : ''}</text>`; }).join('');
    const path = svgLine(points, x, y);
    return `<div class="chart" data-plot="${id}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${h(label)} over ${points.length} recorded points" tabindex="0">${grid}<path d="${path} L${x(points.at(-1), points.length - 1)},${height - bottom} L${left},${height - bottom} Z" fill="${color}" opacity=".05"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2"/><text x="${left}" y="${height - 10}">${h(date(points[0].timestampMs))}</text><text x="${width - right}" text-anchor="end" y="${height - 10}">${h(date(points.at(-1).timestampMs))}</text><line class="hover-cursor" y1="${top}" y2="${height - bottom}" hidden/></svg><div class="chart-tooltip" hidden></div></div>`;
  }
  function candleChart(data, levels = []) {
    const full = data?.candles || [];
    if (!full.length) return empty('No market candles loaded', 'Use Refresh candles to request a closed candle window.');
    const count = Math.min(S.visibleBars, full.length), end = Math.max(count, full.length - S.chartOffset), start = Math.max(0, end - count), candles = full.slice(start, end), overlays = data.overlays.slice(start, end);
    const width = 900, height = 360, left = 8, right = 85, top = 22, bottom = 40, priceHeight = 220;
    levels = levels.filter(l => l.price !== null && l.price !== undefined && Number.isFinite(Number(l.price)) && Number(l.price) > 0);
    const prices = [...candles.flatMap((c, i) => [c.low, c.high, overlays[i]?.emaFast, overlays[i]?.emaSlow].filter(v => v !== null && v !== undefined).map(Number)), ...levels.map(l => Number(l.price))];
    const min = Math.min(...prices), max = Math.max(...prices), pad = (max - min) * .1 || max * .01, lo = min - pad, hi = max + pad;
    const plotWidth = width - left - right, step = plotWidth / count, x = (_, i) => left + step * (i + .5), y = value => top + (hi - Number(value)) / (hi - lo || 1) * priceHeight;
    const volumeMax = Math.max(...candles.map(c => Number(c.volume)), 1);
    const grid = Array.from({ length: 5 }, (_, i) => { const value = lo + (hi - lo) * i / 4, yy = y(value); return `<line class="grid-line" x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}"/><text x="${width - right + 10}" y="${yy + 3}">${h(n(value, value < 10 ? 4 : 2))}</text>`; }).join('');
    const bodies = candles.map((c, i) => { const xx = x(c, i), color = c.close >= c.open ? '#4bd6b7' : '#ee7482', volHeight = Number(c.volume) / volumeMax * 44; return `<line x1="${xx}" x2="${xx}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${color}"/><rect x="${xx - step * .3}" y="${Math.min(y(c.open), y(c.close))}" width="${Math.max(.8, step * .6)}" height="${Math.max(1, Math.abs(y(c.open) - y(c.close)))}" fill="${color}"/><rect x="${xx - step * .3}" y="${height - bottom - volHeight}" width="${Math.max(.8, step * .6)}" height="${volHeight}" fill="${color}" opacity=".28"/>`; }).join('');
    function overlayPath(key, color) { const parts = []; let active = false; overlays.forEach((o, i) => { if (o?.[key] == null) { active = false; return; } parts.push(`${active ? 'L' : 'M'}${x(o, i)},${y(o[key])}`); active = true; }); return `<path d="${parts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>`; }
    const id = `plot-${++plotSequence}`; plots.set(id, { points: candles, overlays, candle: true, width, left, right, x });
    const levelLines = levels.map(l => `<line x1="${left}" x2="${width - right}" y1="${y(l.price)}" y2="${y(l.price)}" stroke="${l.color}" stroke-dasharray="4 4"/><text x="${left + 4}" y="${y(l.price) - 5}" style="fill:${l.color}">${h(l.label)} ${n(l.price, 4)}</text>`).join('');
    return `<div class="chart" data-plot="${id}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${h(data.pair)} candlesticks, EMA 9, EMA 21 and volume" tabindex="0">${grid}${bodies}${overlayPath('emaFast', '#f2b861')}${overlayPath('emaSlow', '#7caaed')}${levelLines}<text x="${left}" y="${height - 10}">${h(date(candles[0].timeMs))}</text><text x="${width - right}" text-anchor="end" y="${height - 10}">${h(date(candles.at(-1).timeMs))}</text><text x="${width - right + 10}" y="${height - bottom - 12}">Volume</text><line class="hover-cursor" y1="${top}" y2="${height - bottom}" hidden/></svg><div class="chart-tooltip" hidden></div></div>`;
  }
  function connectCharts() {
    document.querySelectorAll('[data-plot]').forEach(container => {
      const plot = plots.get(container.dataset.plot), svg = container.querySelector('svg'), cursor = container.querySelector('.hover-cursor'), tooltip = container.querySelector('.chart-tooltip');
      if (!plot) return; let index = plot.points.length - 1;
      function show(i) {
        index = Math.min(plot.points.length - 1, Math.max(0, i)); const p = plot.points[index], xx = plot.x(p, index);
        cursor.setAttribute('x1', xx); cursor.setAttribute('x2', xx); cursor.removeAttribute('hidden'); tooltip.hidden = false;
        tooltip.textContent = plot.candle ? `${date(p.timeMs)} · O ${n(p.open)} H ${n(p.high)} L ${n(p.low)} C ${n(p.close)} · Vol ${n(p.volume)} · EMA9 ${n(plot.overlays[index]?.emaFast)} EMA21 ${n(plot.overlays[index]?.emaSlow)}` : `${date(p.timestampMs)} · ${plot.label}: ${n(p[plot.fieldName])}${plot.fieldName === 'drawdownPct' ? '%' : ''}`;
      }
      svg.addEventListener('pointermove', e => { const rect = svg.getBoundingClientRect(), xx = (e.clientX - rect.left) / rect.width * plot.width; show(Math.round((xx - plot.left) / (plot.width - plot.left - plot.right) * (plot.points.length - 1))); });
      svg.addEventListener('pointerleave', () => { tooltip.hidden = true; cursor.setAttribute('hidden', ''); });
      svg.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); show(e.key === 'Home' ? 0 : e.key === 'End' ? plot.points.length - 1 : index + (e.key === 'ArrowRight' ? 1 : -1)); } });
      svg.addEventListener('focus', () => show(index));
    });
  }
  function protectionFields(config = {}, short = false) {
    const slMode = config.stopLossMode || config.slMode || 'NONE', tpMode = config.takeProfitMode || config.tpMode || 'NONE';
    return `<div class="form-grid ${short ? 'two' : 'four'}">${select('Stop-loss mode', 'stopLossMode', [['NONE', 'NONE · Off'], ['PERCENT', 'PERCENT · % price move'], ['INR', 'INR · ₹ gross loss'], ['ATR', 'ATR · Clamped distance']], slMode, 'data-protection="stopLossValue"')}${field('Stop-loss value', 'stopLossValue', config.stopLossValue ?? config.slValue ?? 0, 'number', `min="0.001" step="any" ${['PERCENT', 'INR'].includes(slMode) ? 'required' : 'disabled'}`)}${select('Take-profit mode', 'takeProfitMode', [['NONE', 'NONE · Off'], ['PERCENT', 'PERCENT · % price move'], ['INR', 'INR · ₹ gross profit'], ['ATR', 'ATR · Signal ATR'], ['RR_MULTIPLE', 'R:R · Multiple of original SL']], tpMode, 'data-protection="takeProfitValue"')}${field('Take-profit value', 'takeProfitValue', config.takeProfitValue ?? config.tpValue ?? 0, 'number', `min="0.001" step="any" ${['PERCENT', 'INR'].includes(tpMode) ? 'required' : 'disabled'}`)}</div>`;
  }
  function parameterFields(strategy, params = {}) {
    const p = { ...U.kernels.find(k => k.id === strategy)?.defaults, ...params };
    if (U.futuresKernels.some(k => k.id === strategy)) {
      const labels = { swingLookback: 'Swing Lookback', maxPierceAtr: 'Max Pierce ATR', wickRatio: 'Wick / Range Ratio', rvolMin: 'Minimum RVOL20',
        rsiPeriod: 'RSI Period', rsiMaxLong: 'Long RSI Maximum', rsiMinShort: 'Short RSI Minimum', sweepWindow: 'Sweep Window', bodyRatio: 'Minimum Body Ratio',
        bbPeriod: 'Bollinger Period', bbStd: 'Bollinger StdDev', rvolClimax: 'Climax RVOL20', rsiLongMax: 'Long RSI Maximum', rsiShortMin: 'Short RSI Minimum',
        emaFilter: 'EMA Filter Period', adxMax: 'Maximum ADX14', squeezeQ: 'Squeeze Quantile', squeezeLookback: 'Prior Squeeze Lookback', adxMin: 'Minimum ADX14', adxRising: 'Require ADX Rising', volMult: 'Minimum RVOL20' };
      const defaults = U.kernels.find(k => k.id === strategy).defaults;
      return Object.keys(defaults).map(key => typeof defaults[key] === 'boolean'
        ? select(labels[key], key, [['true', 'On'], ['false', 'Off']], String(p[key]))
        : field(labels[key], key, p[key], 'number', `min="0" step="any" required`)).join('');
    }
    if (strategy === 'supertrend') return field('ATR Period', 'atrPeriod', p.atrPeriod, 'number', 'min="1" max="500" required') + field('Multiplier', 'multiplier', p.multiplier, 'number', 'min="0.01" step="any" required');
    if (strategy === 'vwap-mean-reversion') return field('VWAP Period', 'vwapPeriod', p.vwapPeriod, 'number', 'min="2" max="500" required') + field('StdDev Band', 'bandStdDev', p.bandStdDev, 'number', 'min="0.01" step="any" required');
    if (strategy === 'rsi-momentum') return field('RSI period', 'period', p.period, 'number', 'min="2" max="200" required') + field('Long RSI threshold', 'longThreshold', p.longThreshold, 'number', 'min="1" max="99" step="any" required') + field('Short RSI threshold', 'shortThreshold', p.shortThreshold, 'number', 'min="1" max="99" step="any" required');
    if (strategy === 'atr-breakout') return field('ATR period', 'atrPeriod', p.atrPeriod, 'number', 'min="2" max="200" required') + field('Breakout multiplier', 'breakoutMultiplier', p.breakoutMultiplier, 'number', 'min="0.01" max="20" step="any" required');
    return field('Fast EMA period', 'fastPeriod', p.fastPeriod, 'number', 'min="2" max="200" required') + field('Slow EMA period', 'slowPeriod', p.slowPeriod, 'number', 'min="3" max="500" required') + `<div class="field">Price source<input value="CLOSE${strategy === 'multi-timeframe-trend' ? ' · 1× / 4× timeframes' : ''}" disabled></div>`;
  }
  function positionsTable(limit) {
    const positions = S.workspace?.paperPositions || [];
    return table(['Instrument', 'Side', 'Quantity', 'Entry USDT', 'Mark USDT', 'Unrealized ₹', 'Source'], positions.slice(0, limit).map(p => [h(pairName(p.pair)), badge(p.side, p.side === 'LONG' ? 'teal' : 'red'), n(p.quantity, 6), n(p.entryPrice), n(p.markPriceUsdt), `<span class="${sign(p.unrealizedPnlInr)}">${money(p.unrealizedPnlInr)}</span>`, badge('PAPER', 'blue')]), 'No open virtual positions. Paper accounts are isolated from the venue.');
  }
  function engineFields(c) {
    const toggle = (label, name) => select(label, name, [['true', 'On'], ['false', 'Off']], String(c[name]));
    const number = (label, name, extra = '') => field(label, name, c[name], 'number', `min="0" step="any" required ${extra}`);
    return `<div class="form-section"><h3>Position Sizing &amp; Fees</h3><div class="form-grid two">${select('Position Sizing', 'sizingMode', [['FIXED_NOTIONAL', 'Fixed Notional ₹'], ['RISK_PERCENT', 'Risk % of Equity']], c.sizingMode)}${number('Risk per trade %', 'riskPerTradePct', 'max="100"')}${number('GST on Fees %', 'gstRatePct', 'max="100"')}${number('Cooldown Bars', 'cooldownBars', 'max="1000"')}</div></div><div class="form-section"><h3>ATR Protection &amp; Breakeven</h3><div class="form-grid two">${number('ATR SL Multiplier', 'slAtrMult')}${number('SL Minimum %', 'slMinPct')}${number('SL Maximum %', 'slMaxPct')}${number('ATR TP Multiplier', 'tpAtrMult')}${number('R:R TP Multiple', 'tpRrMultiple')}${number('ATR Trailing Multiplier', 'trailingAtrMult')}${toggle('Breakeven at 1R', 'breakevenAt1R')}${toggle('Exit on opposite signal', 'exitOnOppositeSignal')}${toggle('Hold on neutral signal', 'holdSignalOnZero')}</div><p class="small muted">ATR14 is frozen at the signal close. ATR SL is clamped to the selected range; R:R uses the original SL. Breakeven and tightening apply from the next protection candle. Risk sizing requires an active SL.</p></div><div class="form-section"><h3>Macro &amp; Cost Gates</h3><div class="form-grid two">${toggle('4h EMA200 Gate', 'use4hTrend200')}${toggle('4h EMA100 Gate', 'use4hTrend100')}${number('Cost Gate Mult', 'costGateMult')}${field('Round-trip fractional cost (optional)', 'rtCost', c.rtCost ?? '', 'number', 'min="0" max="1" step="any" placeholder="Derived from fees, GST and slippage"')}</div><p class="small muted">Only closed 4h UTC candles are available to a signal. Retain at least 200 closed 4h bars for G200 warmup. A zero cost multiplier disables CG.</p></div>`;
  }
  function futuresFields(config = {}, includeNotional = false) {
    const c = U.futuresConfig({ gstRatePct: 18, breakevenAt1R: true, ...U.strategyDefaults(config.strategy), ...config }), notional = config.maxOrderNotionalInr ?? U.preferences(S.workspace).defaultMaxOrderNotionalInr;
    const preview = U.futuresPreview({ ...c, maxOrderNotionalInr: notional });
    return `${engineFields(c)}<div class="form-section futures-section"><h3>Futures Margin &amp; Leverage</h3><div class="form-grid two">${select('Leverage', 'leverage', Array.from({ length: 20 }, (_, i) => [i + 1, `${i + 1}x`]), c.leverage, 'data-futures-input')}${select('Margin Mode', 'marginMode', ['ISOLATED'], 'ISOLATED')}${field('Maintenance Margin (bps)', 'maintenanceMarginRateBps', c.maintenanceMarginRateBps, 'number', 'min="0" max="1000" step="any" required data-futures-input')}${field('Liquidation Fee (bps)', 'liquidationFeeBps', c.liquidationFeeBps, 'number', 'min="0" max="1000" step="any" required')}${includeNotional ? field('Max order notional ₹', 'maxOrderNotionalInr', notional, 'number', 'min="1" max="1000000000" step="any" required data-futures-input') : ''}</div><div class="futures-preview" data-futures-preview>${marginPreview(preview)}</div></div><div class="form-section"><h3>Trailing Stop-Loss</h3><div class="form-grid two">${field('Trailing SL %', 'trailingStopPct', c.trailingStopPct, 'number', 'min="0" max="99.999" step="any" required')}${field('Activation %', 'trailingActivationPct', c.trailingActivationPct, 'number', 'min="0" max="1000" step="any" required')}</div><p class="small muted">Zero trail disables it. Closed-candle extremes tighten the stop for the following candle.</p></div><div class="form-section"><h3>Perpetual Funding Model</h3><div class="form-grid two">${select('Funding', 'fundingMode', [['EXCLUDED', 'Excluded'], ['MODELED_FIXED_BPS', 'Modeled 8h Rate (bps)']], c.fundingMode, 'data-futures-input')}${field('Modeled 8h Rate (bps)', 'fundingRateBpsPer8h', c.fundingRateBpsPer8h, 'number', `min="-100" max="100" step="any" ${c.fundingMode === 'EXCLUDED' ? 'disabled' : 'required'}`)}</div><p class="small muted">Fixed rate at 00:00, 08:00 and 16:00 UTC. Positive: longs pay, shorts receive. Historical funding and mark prices are not reconstructed. LIVE LOCKED.</p></div>`;
  }
  function marginPreview(preview) {
    return `<span>Required Margin ₹ <strong>${money(preview.requiredMarginInr)}</strong></span><span>Est. Liq Distance <strong>${pct(preview.liquidationDistancePct)}</strong></span><small>Before entry fees · modeled symmetric distance</small>`;
  }
  function updateFuturesPreview(form) {
    const preview = form?.querySelector('[data-futures-preview]'); if (!preview) return;
    preview.innerHTML = marginPreview(U.futuresPreview(formValues(form)));
    const mode = form.elements.namedItem('fundingMode'), rate = form.elements.namedItem('fundingRateBpsPer8h');
    if (mode && rate) { rate.disabled = mode.value === 'EXCLUDED'; rate.required = !rate.disabled; }
  }
  function renderOverview() {
    const w = S.workspace, summary = U.paperSummary(w), ready = S.status?.readiness;
    const blockers = (w.alerts || []).filter(a => !a.acknowledgedAtMs).slice(-4).reverse().map(a => `<li><div><b>${h(a.code.replaceAll('_', ' '))}</b><small>${h(a.message)}</small></div>${badge(a.severity, a.severity === 'CRITICAL' ? 'red' : 'amber')}</li>`);
    if (w.operations.admissionStopped) blockers.unshift(`<li><div><b>Operator admission stopped</b><small>${h(w.operations.reason)}</small></div>${badge('STOPPED', 'red')}</li>`);
    if (w.shadowReport?.account?.status !== 'OBSERVED_CONVERGENCE') blockers.push(`<li><div><b>Account continuity</b><small>${h(w.shadowReport?.account?.error || 'No converged private observation retained.')}</small></div>${badge('UNRESOLVED', 'amber')}</li>`);
    return `<div class="kpis">${kpi('Virtual paper equity', money(summary.equity), `${w.paperSessions.length} isolated virtual account(s)`)}${kpi('Modeled P&L · today', money(summary.todayPnl), `Realized fills less fees · ${zone()}`, sign(summary.todayPnl))}${kpi('Active paper strategies', `${summary.active} / ${w.paperSessions.length}`, 'Running sessions · manually stepped')}${kpi('Live readiness / shadow', ready?.shadowReady ? 'Shadow ready' : 'Blocked', 'Live execution stays locked', 'amber-text', true)}</div>
      <div class="two-column"><div>${panel('Paper cash over time', lineChart(U.paperCurve(w), 'equityInr', 'Paper cash INR'), 'Actual capital and fill events · excludes unrealized marks', link('Paper accounts', 'paper'))}</div><div>${panel('What needs your attention', `<ul class="list">${blockers.join('') || '<li><div>No unacknowledged workspace alerts.<small>Live permissions remain locked.</small></div></li>'}</ul><div class="form-actions">${link('Review readiness →', 'readiness')}</div>`)}</div></div>
      <div class="two-column"><div>${panel('Active paper positions', positionsTable(6), 'Virtual exposure only', link('View all', 'positions'), true)}${panel('Read-only shadow cycle', `<form id="shadow-form"><div class="form-grid">${select('Strategy', 'strategy', [['ema-trend', 'EMA Trend'], ['rsi-momentum', 'RSI Momentum']], 'ema-trend')}${field('Reference equity ₹', 'equityInr', U.preferences(S.workspace).defaultEquityInr, 'number', 'min="1" required')}${field('Max order notional ₹', 'maxOrderNotionalInr', U.preferences(S.workspace).defaultMaxOrderNotionalInr, 'number', 'min="1" required')}</div><div class="form-actions"><button class="primary" type="submit">Run Shadow Cycle</button><p>BTC · ETH · SOL · Read-only · No venue orders</p></div></form>`)}</div><div>${panel('Recent activity', activityTimeline(w.auditLog))}</div></div>`;
  }
  function activityTimeline(rows) { return rows?.length ? `<ol class="timeline">${rows.slice(-7).reverse().map(r => `<li><time>${h(date(r.timestampMs))}</time>${h(r.action.replaceAll('_', ' '))}<small>${h(r.scope)}</small></li>`).join('')}</ol>` : empty('A clean starting point', 'Your saved research and paper events will appear here.'); }
  function renderUnlock() {
    const w = S.workspace, p = U.paperSummary(w);
    return `<section class="welcome"><div class="welcome-hero"><p class="eyebrow positive">RESEARCH WITH CLARITY</p><h2>A clear view.<br>A controlled path<br>to every decision.</h2><p>Research, simulate and inspect your futures workspace. Evidence stays visible. Live trading stays locked.</p><div class="welcome-stats"><div><strong>${n(w.datasets.length, 0)}</strong><small>Cached datasets</small></div><div><strong>${n(w.backtestReports.length, 0)}</strong><small>Saved backtests</small></div><div><strong>${n(w.paperSessions.length, 0)}</strong><small>Paper accounts</small></div></div></div><div class="welcome-card"><p class="eyebrow">PRIVATE LOCAL WORKSPACE</p><h2>Welcome back</h2><p>Open your connected research workspace to continue.</p>${metrics([['Workspace', 'Personal INR Futures'], ['Virtual equity', money(p.equity)], ['Saved presets', w.savedStrategies.length], ['Live execution', 'LOCKED']])}<div class="form-actions">${link('Open workspace →', 'overview', true)}</div><p class="small muted" style="margin-top:22px">This is a local navigation screen. It does not authenticate an account or unlock live execution.</p></div></section>`;
  }
  function renderMarkets() {
    const rows = coinOptions.map(coin => {
      const data = S.market[`${coin}:1h`], bars = data?.candles, last = bars?.at(-1), change = U.closedDayChange(bars);
      const meta = latestCycle()?.markets?.find(m => m.underlying === coin);
      return [coinLabel(coin), last ? `${n(last.close)}<small>USDT · ${h(date(last.timeMs + 3600000))} close</small>` : `<span class="muted">${h(S.marketErrors[`${coin}:1h`] || 'Fetching closed candles…')}</span>`, change === null ? '—' : `<span class="${sign(change)}">${change > 0 ? '+' : ''}${pct(change)}</span><small>24h closed-to-closed</small>`, spark(bars), meta?.maxLeverage ? `${h(meta.maxLeverage)}×<small>Retained shadow metadata</small>` : '<span class="muted">Not yet observed</span>', link('Open chart →', `instrument?coin=${coin}`)];
    });
    return panel('Futures watchlist', table(['Instrument', 'Latest hourly close', '24h change', '30 closed hours', 'Max leverage', 'Workspace'], rows), 'Real historical closes · USDT quote · no synthetic ticker', action('Refresh watchlist', 'refresh-markets'), true, 'Prices update on request. Closed hourly observations are not streaming quotes. Leverage is shown only when a retained shadow instrument observation exists.');
  }
  function renderInstrument() {
    const key = `${S.coin}:${S.timeframe}`, data = S.market[key], last = data?.overlays?.at(-1), latest = data?.candles.at(-1);
    const summaries = latestCycle()?.pairSummaries || [], observation = summaries.find(p => p.pair === `B-${S.coin}_USDT`);
    const controls = `<div class="toolbar"><label class="sr-only" for="instrument-coin">Instrument</label><select id="instrument-coin">${options(coinOptions.map(c => [c, `${c} / USDT`]), S.coin)}</select><div class="chips">${timeOptions.map(t => `<button data-action="timeframe" data-timeframe="${t}" class="${S.timeframe === t ? 'active' : ''}" aria-pressed="${S.timeframe === t}">${t}</button>`).join('')}</div>${action('↻ Refresh candles', 'refresh-candles')}</div>`;
    const chartTools = `<div class="chart-caption"><span>Hover / focus + arrow keys to inspect · USDT</span><div class="toolbar"><label for="chart-bars">Visible bars</label><select id="chart-bars">${options([40, 80, 120], S.visibleBars)}</select><label for="chart-offset">Earlier</label><input id="chart-offset" aria-label="Pan to earlier candles" type="range" min="0" max="${Math.max(0, (data?.candles.length || 120) - S.visibleBars)}" value="${S.chartOffset}" step="1"></div></div>`;
    const error = S.marketErrors[key] ? `<div class="callout error">${h(S.marketErrors[key])}</div>` : '';
    return `<div class="two-column"><div>${panel(`${S.coin} / USDT`, `${controls}${error}<div class="legend"><span class="amber">EMA 9</span><span class="blue">EMA 21</span><span>Closed candles + volume</span></div>${candleChart(data)}${chartTools}`, latest ? `Last close ${n(latest.close)} USDT · ${date(latest.timeMs + Number(U.resolution[S.timeframe]) * 60000)}` : 'Requesting real closed candles…', badge('LIVE DATA', 'blue'))}</div><div>${panel('Instrument context', `${metrics([['Pair', `B-${S.coin}_USDT`], ['Margin', 'INR'], ['Quote', 'USDT'], ['Contract', 'Perpetual'], ['Resolution', S.timeframe], ['Minimum notional ₹', observation?.minNotionalInr ? money(observation.minNotionalInr) : 'Not observed']])}<div class="form-actions">${action('Set up backtest', 'setup-backtest', '', true)}${link('Historical coverage', 'data')}</div>`, '', badge('LIVE LOCKED', 'amber'))}</div></div>
      <div class="equal-columns">${panel('Indicator overlay', metrics([['EMA 9', n(last?.emaFast)], ['EMA 21', n(last?.emaSlow)], ['RSI 14', n(last?.rsi)], ['ATR 14', n(last?.atr)]]), 'Computed by the shared strategy kernels')}${panel('Dynamic leverage tiers', table(['Leverage', 'Max position USDT'], (observation?.observedLeverageTiers || []).map(t => [`${h(t.leverage)}×`, n(t.maxPositionSizeUsdt)]), 'Run a shadow cycle to retain real instrument metadata.'), 'Latest retained shadow observation · may be historical', '', true)}</div>`;
  }
  function datasetSelector() {
    return `<label class="sr-only" for="dataset-select">Inspect dataset</label><select id="dataset-select">${options((S.workspace.datasets || []).map(d => [d.id, `${pairName(d.pair)} · ${d.resolution}m · ${d.bars} bars · ${d.id.slice(-6)}`]), S.datasetId)}</select>`;
  }
  function coveragePanel() {
    const dataset = S.datasets[S.datasetId], cells = U.coverage(dataset);
    const grid = `<div class="coverage-scroll"><div class="coverage-grid" aria-label="28 chronological groups of expected bars">${cells.map((c, i) => `<div tabindex="0" role="img" class="coverage-cell ${c.status}" aria-label="Group ${i + 1}: ${c.status}, ${c.received} of ${c.expected} valid bars" title="${h(c.fromMs === undefined ? 'Dataset not loaded' : `${date(c.fromMs)} – ${date(c.toMs)} · ${c.received}/${c.expected} valid bars · ${c.invalid} invalid or duplicate`)}"></div>`).join('')}</div><div class="coverage-labels"><span>${dataset ? h(date(dataset.fromMs)) : 'No dataset selected'}</span><span>28 chronological bar groups · ${dataset ? h(dataset.resolution) + 'm resolution' : 'not daily estimates'}</span><span>${dataset ? h(date(dataset.toMs)) : '—'}</span></div></div><div class="coverage-key"><span><i></i>Verified bars</span><span><i class="gap"></i>Missing / invalid</span><span><i class="unknown"></i>Unobserved</span></div>`;
    return panel('Coverage inspector', grid, 'Every cell is computed from the stored dataset’s actual timestamps.', `<div class="toolbar">${datasetSelector()}</div>`, false, 'Higher-timeframe bars do not establish minute-level completeness. Missing candles are never fabricated.');
  }

  const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
  function backtestWindowFields(c) {
    const custom = c.fromDate && !c.days, days = c.days || 3, to = c.toDate || isoDay(Date.now()), from = c.fromDate || isoDay(Date.parse(to) - days * 86400000);
    return `${select('Lookback Mode', 'lookbackMode', [['DAYS', 'Days Preset'], ['CUSTOM', 'Custom From / To Date']], custom ? 'CUSTOM' : 'DAYS', 'data-lookback')}${select('Days', 'days', [...[1, 3, 7, 15, 30, 90, 365].map(d => [d, `${d}d`]), ['CUSTOM', 'Custom']], custom ? 'CUSTOM' : days, 'data-days')}${field('From Date (UTC)', 'fromDate', from, 'date', `required max="${isoDay(Date.now())}" ${custom ? '' : 'readonly'}`)}${field('To Date (UTC, exclusive)', 'toDate', to, 'date', `required max="${isoDay(Date.now())}" ${custom ? '' : 'readonly'}`)}<p class="small muted full">UTC [From, To): To Date is excluded. Complete UTC timeframe groups only. Maximum 365 days.</p>`;
  }
  function syncBacktestWindow(form, changedDays) {
    const mode = form.elements.namedItem('lookbackMode'), days = form.elements.namedItem('days');
    if (changedDays) mode.value = days.value === 'CUSTOM' ? 'CUSTOM' : 'DAYS';
    if (mode.value === 'DAYS' && days.value === 'CUSTOM') days.value = '3';
    const custom = mode.value === 'CUSTOM';
    if (custom) days.value = 'CUSTOM';
    for (const key of ['fromDate', 'toDate']) form.elements.namedItem(key).readOnly = !custom;
    if (!custom) {
      const to = isoDay(Date.now()); form.elements.namedItem('toDate').value = to;
      form.elements.namedItem('fromDate').value = isoDay(Date.parse(to) - Number(days.value) * 86400000);
    }
  }
  function inventoryPanel() {
    const lake = S.workspace.dataLake, summary = lake?.summary || {}, rows = lake?.coins || coinOptions.map(underlying => ({ underlying, candleCount: 0, coverageDays: 0, gapCount: 0, sizeMb: 0, syncStatus: 'EMPTY' }));
    const controls = `<div class="toolbar">${action('+ Add Coin from CoinDCX Catalog', 'catalog-open', '', true)}${action('Sync All to Latest', 'history-sync-all', 'data-data-mutation')}<label>Extend History<select id="extend-days">${options([7, 30, 90, 365].map(d => [d, `${d}d`]), 30)}</select></label>${action('Extend History', 'history-extend-all', 'data-data-mutation')}</div>`;
    return `<div class="kpis">${kpi('Coins Tracked', n(summary.coinsTracked ?? coinOptions.length, 0), 'Persistent workspace universe')}${kpi('Total 1m Candles', n(summary.totalCandles || 0, 0), 'Actual archived minute candles')}${kpi('Disk Storage (MB)', n(summary.sizeMb || 0, 3), 'Measured archive file bytes')}${kpi('Global Sync Status', summary.globalSyncStatus || 'EMPTY', S.workspace.busy || 'Closed minutes only', summary.globalSyncStatus === 'SYNCED' ? 'positive' : 'amber-text', true)}</div>${controls}${panel('Historical Data Inventory', table(['Coin / contract', 'Coverage (Days)', 'Date Range (UTC)', '1m Candles', 'Gaps & Health', 'Size (MB)', 'Actions'], rows.map(c => [coinLabel(c.underlying) + `<small>lot ${h(c.lotSize ?? 'not observed')} | tick ${h(c.tickSize ?? 'not observed')} | max leverage ${h(c.maxLeverage ?? 'not observed')}</small>`, badge(n(c.coverageDays, 3), 'blue'), c.dateRangeUtc ? `<span class="mono">${h(c.dateRangeUtc.from)}<small>to ${h(c.dateRangeUtc.to)} (exclusive)</small></span>` : 'No candles archived', n(c.candleCount, 0), `${badge(`${c.gapCount} Gaps`, c.gapCount ? 'amber' : c.candleCount ? 'teal' : '')}<small>${h(c.syncStatus)} | ${n(c.missingMinutes || 0, 0)} missing minutes</small>`, n(c.sizeMb, 3), `${action('Sync', 'history-sync', `data-coin="${h(c.underlying)}" data-data-mutation`)} ${action('Backfill', 'history-backfill', `data-coin="${h(c.underlying)}" data-data-mutation`)} ${action('Repair', 'history-repair', `data-coin="${h(c.underlying)}" data-data-mutation`)}`])), 'Historical 1m Inventory & Backfill Engine | UTC | incremental checkpoints', '', true, 'Archives merge by minute timestamp. Coverage is the observed first-to-last span, including gaps. Repair only re-fetches missing intervals; unavailable minutes stay missing.')}`;
  }
  function historicalInventory() { return `<div data-sync-progress>${syncProgress()}</div><div id="history-inventory">${inventoryPanel()}</div>`; }
  function renderData() { return historicalInventory() + renderSnapshots(); }
  function renderQuality() {
    const gaps = (S.workspace.dataLake?.coins || []).flatMap(c => c.gaps.map(g => [h(c.underlying), h(new Date(g.fromMs).toISOString()), h(new Date(g.toMs).toISOString()), n((g.toMs - g.fromMs) / 60000, 0)]));
    return historicalInventory() + panel('Missing minute intervals', table(['Coin', 'From (UTC)', 'To (UTC, exclusive)', 'Missing minutes'], gaps, 'No internal minute gaps observed in the archived spans.'), 'Repair re-fetches these exact intervals; unavailable candles remain missing.', '', true) + renderSnapshotQuality();
  }
  function renderBackfill() { return historicalInventory() + renderSnapshotBackfill(); }
  function openHistory(coin) {
    $('#history-fields').innerHTML = `${select('Coin', 'coin', coinOptions, coin)}${select('Window', 'historyMode', [['DAYS', 'Days Preset'], ['CUSTOM', 'Custom From / To Date']], 'DAYS')}${select('Days', 'days', [1, 3, 7, 15, 30, 90, 365], 30)}${field('From Date (UTC)', 'fromDate', isoDay(Date.now() - 30 * 86400000), 'date', 'disabled')}${field('To Date (UTC, exclusive)', 'toDate', isoDay(Date.now()), 'date', 'disabled')}`;
    $('#history-dialog').showModal();
    updateSyncProgress(); updateDisabled();
  }
  function syncProgress() {
    const job = S.syncJob;
    if (!job || job.status === 'IDLE') return '';
    const running = job.status === 'RUNNING', percent = Math.max(0, Math.min(100, Number(job.percentComplete) || 0));
    const text = running && job.totalChunks && !S.syncCancelling ? `Downloading ${job.pair || 'tracked coins'} · Chunk ${job.completedChunks} / ${job.totalChunks} (${percent}%) · ${Number(job.candlesFetched).toLocaleString('en-US')} candles` : job.message;
    return `<section class="sync-progress ${job.status === 'FAILED' ? 'failed' : ''}" aria-label="Historical sync job"><div class="sync-progress-heading"><strong role="status" aria-live="polite">${h(text)}</strong>${badge(`${percent}%`, 'teal')}</div><progress value="${percent}" max="100" aria-label="Historical candle download progress">${percent}%</progress><div class="sync-progress-foot"><span>${running ? job.etaSeconds === null ? 'ETA estimating…' : `ETA ${job.etaSeconds}s` : h(job.status)} · ${n(job.candlesFetched, 0)} candles saved${job.error ? ` · ${h(job.error)}` : ''}</span>${running ? action(S.syncCancelling ? 'Cancelling…' : 'Cancel Job', 'sync-cancel', S.syncCancelling ? 'disabled' : '') : ''}</div></section>`;
  }
  function updateSyncProgress() {
    document.querySelectorAll('[data-sync-progress]').forEach(el => { el.innerHTML = syncProgress(); });
  }
  function scheduleSyncPoll() {
    clearTimeout(syncPollTimer);
    if (S.syncJob?.status === 'RUNNING' || syncInventoryPending) syncPollTimer = setTimeout(() => { void pollSyncJob(); }, 800);
  }
  function acceptSyncJob(job) {
    // An older in-flight status response must not regress a terminal job after cancellation.
    if (S.syncJob && job.jobId === S.syncJob.jobId && S.syncJob.status !== 'RUNNING' && job.status === 'RUNNING') return false;
    const previous = S.syncJob, changed = previous?.jobId !== job.jobId || previous?.completedChunks !== job.completedChunks || previous?.status !== job.status;
    if (job.status === 'RUNNING') activeSyncJobId = job.jobId;
    if (previous?.jobId !== job.jobId || job.status !== 'RUNNING') S.syncCancelling = false;
    S.syncJob = job; syncVersion++;
    if (S.workspace) { S.workspace.syncJobStatus = job; if (job.status === 'RUNNING') S.workspace.busy = 'DATA_SYNC'; else if (S.workspace.busy === 'DATA_SYNC') S.workspace.busy = null; }
    if (job.status !== 'RUNNING' && job.status !== 'IDLE' && activeSyncJobId === job.jobId && syncToastKey !== `${job.jobId}:${job.status}`) {
      syncToastKey = `${job.jobId}:${job.status}`; notice(job.message, job.status === 'FAILED');
      toast(job.status === 'CANCELLED' ? 'Sync cancelled. Downloaded chunks are saved.' : job.message, 'operator');
    }
    updateSyncProgress(); updateDisabled(); scheduleSyncPoll();
    return changed;
  }
  async function pollSyncJob() {
    if (syncPolling) return;
    syncPolling = true; const version = syncVersion;
    try {
      const job = S.syncJob?.status === 'RUNNING' ? await api('/api/data/sync/status') : S.syncJob;
      if (!job) return;
      if (version !== syncVersion) return;
      const changed = acceptSyncJob(job);
      if (changed) syncInventoryPending = true;
      if (syncInventoryPending && S.workspace) {
        S.workspace.dataLake = await api('/api/data/inventory');
        syncInventoryPending = false;
        if ($('#history-inventory')) $('#history-inventory').innerHTML = inventoryPanel();
        if (job.status !== 'RUNNING') { await refreshAfterMutation(); if (['data', 'backfill', 'quality'].includes(S.route)) render(); }
        updateDisabled();
      }
    } catch (error) { notice(`Sync progress temporarily unavailable: ${errorText(error)} Retrying automatically.`, true); }
    finally { syncPolling = false; scheduleSyncPoll(); }
  }
  async function startSyncJob(payload) {
    const accepted = await api('/api/data/sync', payload);
    activeSyncJobId = accepted.jobId; syncVersion++;
    acceptSyncJob({ ...accepted, coin: payload.coin || null, pair: payload.coin ? `B-${payload.coin}_USDT` : null,
      operation: 'SYNC', completedChunks: 0, totalChunks: 0, percentComplete: 0, candlesFetched: 0, etaSeconds: null, error: null, message: 'Preparing missing candle chunks…' });
    notice('Historical sync started. Progress updates automatically.');
    void pollSyncJob();
  }
  async function cancelSyncJob() {
    if (S.syncJob?.status !== 'RUNNING' || S.syncCancelling) return;
    const jobId = S.syncJob.jobId;
    S.syncCancelling = true; updateSyncProgress();
    try {
      const job = await api('/api/data/sync/cancel', { jobId });
      if (S.syncJob.jobId !== jobId) return;
      acceptSyncJob(job);
      if (job.status !== 'RUNNING') { await refreshAfterMutation(); if (['data', 'backfill', 'quality'].includes(S.route)) render(); }
    }
    catch (error) { S.syncCancelling = false; updateSyncProgress(); notice(errorText(error), true); }
  }
  let catalogOffset = 0, catalogVersion = 0, catalogTimer;
  async function loadCatalog(query, offset) {
    const version = ++catalogVersion; catalogOffset = offset;
    $('#catalog-results').textContent = 'Reading CoinDCX INR perpetual metadata through the shared M2 budget...';
    const result = await api(`/api/catalog/coins?q=${encodeURIComponent(query)}&offset=${offset}&limit=6`);
    if (version !== catalogVersion) return;
    $('#catalog-results').innerHTML = table(['Coin / INR perpetual', 'Lot', 'Tick', 'Max leverage', 'Workspace'], result.coins.map(c => [h(c.underlying) + `<small class="mono">${h(c.pair)}</small>`, h(c.lotSize), h(c.tickSize), h(c.maxLeverage ?? 'Not observed'), action(c.alreadyTracked ? 'Tracked' : 'Add Coin', 'catalog-add', `data-pair="${h(c.pair)}" data-tracked="${c.alreadyTracked}" data-data-mutation`)]), 'No active INR perpetual contracts match your search.') + `<div class="toolbar"><span>${result.total} matching contracts | ${result.total ? offset + 1 : 0}-${Math.min(offset + result.limit, result.total)}</span>${offset ? action('Previous', 'catalog-page', `data-offset="${Math.max(0, offset - result.limit)}"`) : ''}${result.hasMore ? action('Next', 'catalog-page', `data-offset="${offset + result.limit}"`) : ''}</div>`;
    updateDisabled();
  }

  function renderSnapshots() {
    const datasets = S.workspace.datasets, complete = datasets.filter(d => d.complete).length;
    return `<div class="kpis">${kpi('Cached datasets', n(datasets.length, 0), 'Content-addressed local snapshots')}${kpi('Verified windows', n(complete, 0), 'No missing, duplicate or invalid bars', 'positive')}${kpi('Missing bars', n(datasets.reduce((a, d) => a + d.missingBars, 0), 0), 'Across retained dataset windows', 'amber-text')}${kpi('Source', 'CoinDCX', '.local/datasets · Closed candles', 'blue-text', true)}</div>${panel('Dataset catalog', table(['Dataset / pair', 'Resolution', 'Bars', 'Window', 'Integrity', 'Inspect'], datasets.slice().reverse().map(d => [h(pairName(d.pair)) + `<small class="mono">${h(d.id)}</small>`, `${h(d.resolution)}m`, n(d.bars, 0), `${h(date(d.fromMs))}<small>to ${h(date(d.toMs))}</small>`, badge(d.complete ? 'VERIFIED' : `${d.missingBars} MISSING`, d.complete ? 'teal' : 'amber'), action('Inspect →', 'dataset', `data-id="${h(d.id)}"`)])), 'Persisted windows · verified against their content hash on inspection', link('Sync a dataset', 'backfill', true), true)}${coveragePanel()}`;
  }
  function renderSnapshotQuality() {
    const dataset = S.datasets[S.datasetId], q = dataset?.quality;
    return `${coveragePanel()}<div class="kpis">${kpi('Expected bars', q ? n(q.expectedBars, 0) : '—', 'Bounded requested window')}${kpi('Received bars', q ? n(q.receivedBars, 0) : '—', 'Actual provider rows')}${kpi('Missing bars', q ? n(q.missingBars, 0) : '—', 'Honest timestamp gap detection', 'amber-text')}${kpi('Fabricated candles', q ? n(q.fabricatedCandles, 0) : '—', 'No synthetic gap filling', 'positive')}</div><div class="equal-columns">${panel('Integrity details', q ? metrics([['Duplicate rows', q.duplicateCount], ['Invalid OHLC / timestamps', q.invalidCount], ['Minute coverage', q.missingMinutes === null ? 'Not observable at this resolution' : `${q.missingMinutes} missing minutes`], ['Overall integrity', q.complete ? 'VERIFIED' : 'INCOMPLETE']]) : empty('Select a retained dataset', 'Sync your first bounded window to inspect its quality.', link('Sync & backfill', 'backfill')))}${panel('Detected gaps', table(['From', 'To (exclusive)', 'Missing bars'], (q?.gaps || []).map(g => [h(date(g.fromMs)), h(date(g.toExclusiveMs)), n(g.missingBars, 0)]), q ? 'No timestamp gaps detected in this requested window.' : 'No dataset has been inspected.'), 'Reported at the dataset’s own bar resolution', '', true)}</div>`;
  }
  function renderSnapshotBackfill() {
    const jobs = (S.workspace.jobs || []).filter(j => j.type === 'DATA_SYNC');
    return `<div class="two-column"><div>${panel('Bounded historical sync', `<form id="sync-form"><div class="form-grid">${select('Coin', 'coin', coinOptions, S.coin)}${select('Timeframe', 'timeframe', timeOptions, S.timeframe)}${field('Bars', 'bars', 300, 'number', 'min="30" max="1000" required')}${field(`End time · ${Intl.DateTimeFormat().resolvedOptions().timeZone} (optional)`, 'endLocal', '', 'datetime-local', 'class="full"')}</div><div class="form-actions"><button type="submit" class="primary">Fetch & verify dataset</button><p>30–1000 closed bars · shared M2 read budget</p></div></form>`, 'Blank end time uses the latest closed candle')}${panel('Sync history', table(['Job', 'Started', 'Status', 'Result'], jobs.slice().reverse().map(j => [`<span class="mono">${h(j.id)}</span>`, h(date(j.createdAtMs)), badge(j.status, j.status === 'COMPLETED' ? 'teal' : j.status === 'FAILED' ? 'red' : 'amber'), h(j.error || (j.completedAtMs ? date(j.completedAtMs) : 'In progress'))])), '', '', true)}</div><div>${panel('What this job verifies', `<ul class="list"><li><div><b>Closed candle boundaries</b><small>The active, incomplete candle is excluded.</small></div>${badge('CHECKED', 'teal')}</li><li><div><b>OHLC and timestamp integrity</b><small>Duplicates, invalid values and missing intervals are reported.</small></div>${badge('CHECKED', 'teal')}</li><li><div><b>Local evidence</b><small>Content-addressed snapshots are retained in .local/datasets/.</small></div>${badge('PERSISTED', 'blue')}</li><li><div><b>Funding & minute gaps</b><small>Funding is excluded. Minute completeness needs 1m data.</small></div>${badge('EXPLICIT', 'amber')}</li></ul>`)}</div></div>`;
  }
  function renderStrategies() {
    const presets = S.workspace.savedStrategies;
    return `<div class="strategy-grid">${U.kernels.map(k => `<article class="strategy-card">${badge(k.tag, 'blue')}<h2>${h(k.name)}</h2><p>${h(k.description)}</p><div class="card-foot"><span class="small muted">Shared deterministic kernel</span>${action('Configure →', 'configure-kernel', `data-kernel="${k.id}"`)}</div></article>`).join('')}</div>${panel('Saved strategy presets', table(['Name', 'Kernel', 'Timeframe', 'Stop loss', 'Take profit', 'Updated', 'Actions'], presets.map(p => [h(p.name), h(kernelName(p.strategy)), h(p.timeframe), h(protectionLabel(p.slMode, p.slValue)), h(protectionLabel(p.tpMode, p.tpValue)), h(date(p.updatedAtMs)), `${action('Edit', 'edit-preset', `data-id="${h(p.id)}"`)} ${action('Backtest', 'backtest-preset', `data-id="${h(p.id)}"`)} `])), 'Named configurations are saved locally, including SL / TP.', link('New preset', 'builder', true), true)}`;
  }
  function protectionLabel(mode, value) { return !mode || mode === 'NONE' ? 'Off' : mode === 'PERCENT' ? `${n(value)}%` : mode === 'ATR' ? 'ATR distance' : mode === 'RR_MULTIPLE' ? 'R:R multiple' : `${money(value)} gross`; }
  function renderBuilder() {
    const draft = S.builder || { name: '', strategy: 'ema-trend', timeframe: S.timeframe, parameters: {}, ...U.protectionDefaults(S.workspace) };
    return `<div class="two-column"><div>${panel('Strategy configuration', `<form id="builder-form"><div class="form-grid two">${select('Research coin', 'coin', coinOptions, S.coin, 'data-builder-coin')}${field('Preset name', 'name', draft.name, 'text', 'maxlength="100" required placeholder="e.g. SOL trend · conservative"')}${select('Strategy kernel', 'strategy', U.kernels.map(k => [k.id, k.name]), draft.strategy, 'data-kernel-select')}${select('Timeframe', 'timeframe', timeOptions, draft.timeframe)}</div><div class="form-section"><h3>Kernel parameters</h3><div class="form-grid" data-parameters>${parameterFields(draft.strategy, draft.parameters)}</div></div><div class="form-section"><h3>Stop loss & take profit</h3>${protectionFields(draft)}<p class="small muted" style="margin-top:12px">Percent measures the price move from entry. INR targets gross trade P&L before execution costs.</p></div>${futuresFields(draft, true)}<div class="form-actions"><button type="submit" class="primary">Save strategy preset</button>${link('Strategy library', 'strategies')}</div></form>`)}</div><div>${panel('Configuration contract', `<ul class="list"><li><div><b>Shared strategy logic</b><small>The same kernel powers historical replay and paper evaluation.</small></div>${badge('RESEARCH', 'blue')}</li><li><div><b>Conservative protection</b><small>SL wins when both thresholds trigger in one bar. Gaps and stop slippage can increase realized loss.</small></div>${badge('OHLC', 'amber')}</li><li><div><b>Named preset updates</b><small>Saving an existing name updates that local preset.</small></div>${badge('LOCAL')}</li><li><div><b>Permission boundary</b><small>Saving a configuration never enables live trading.</small></div>${badge('LIVE LOCKED', 'amber')}</li></ul>`)}</div></div>`;
  }
  function savedOptions() { return [...U.kernels.map(k => [k.id, k.name]), ...S.workspace.savedStrategies.map(p => [p.id, `Saved · ${p.name}`])]; }
  function researchBaseForm(kind, config = {}) {
    config = { ...U.protectionDefaults(S.workspace), ...config };
    return `<div class="form-grid">${select('Strategy / saved preset', 'selection', savedOptions(), config.selection || config.strategy || 'ema-trend', 'data-preset-select')}${select('Coin universe', 'universe', [...coinOptions, ['ALL', 'All tracked coins']], S.coin)}${select('Timeframe', 'timeframe', timeOptions, config.timeframe || S.timeframe)}${field('Bars', 'bars', kind === 'validation' ? 600 : 300, 'number', `min="${kind === 'validation' ? 150 : 100}" max="1000" required`)}${field('Virtual capital ₹', 'capitalInr', U.preferences(S.workspace).defaultEquityInr, 'number', 'min="1" required')}${field('Max order notional ₹', 'maxOrderNotionalInr', U.preferences(S.workspace).defaultMaxOrderNotionalInr, 'number', 'min="1" required')}</div><div class="form-section"><h3>Kernel parameters</h3><div data-parameters class="form-grid">${parameterFields(config.strategy || 'ema-trend', config.parameters)}</div><div class="form-grid two" style="margin-top:14px"><label>Fast EMA grid<input name="fastPeriods" value="5, 9" required data-grid-input><small>Comma-separated integers · EMA / MTF kernels only</small></label><label>Slow EMA grid<input name="slowPeriods" value="21, 30" required data-grid-input><small>At most 64 coin × parameter cells</small></label></div></div><div class="form-section"><h3>Trade protection</h3>${protectionFields(config)}</div>${futuresFields(config)}<div class="form-section"><h3>Execution costs</h3><div class="form-grid">${field('Taker fee bps', 'takerFeeBps', 5, 'number', 'min="0" max="100" step="any" required')}${field('Spread bps', 'spreadBps', 1, 'number', 'min="0" max="100" step="any" required')}${field('Stop slippage bps', 'stopSlippageBps', 5, 'number', 'min="0" max="100" step="any" required')}</div></div>`;
  }
  function renderMatrixResult() {
    const run = S.matrix; if (!run) return empty('No matrix run yet', 'Declare your grid and run a bounded deterministic comparison.');
    const coins = [...new Set(run.cells.map(c => c.coin))], fasts = [...new Set(run.cells.map(c => c.parameters.fastPeriod))], slows = [...new Set(run.cells.map(c => c.parameters.slowPeriod))];
    let grid;
    if (fasts[0] !== undefined && slows[0] !== undefined) grid = coins.map(coin => panel(`${coin} · Profit factor / net P&L`, table(['Fast ↓ / Slow →', ...slows.map(n => String(n))], fasts.map(fast => [h(fast), ...slows.map(slow => {
      const cell = run.cells.find(c => c.coin === coin && c.parameters.fastPeriod === fast && c.parameters.slowPeriod === slow);
      return cell?.summary ? `<div class="matrix-cell ${cell.summary.netPnlInr < 0 ? 'loss' : ''}"><strong>${cell.summary.profitFactor === null ? 'N/D' : n(cell.summary.profitFactor)}</strong><small>${money(cell.summary.netPnlInr)} · ${pct(cell.summary.winRatePct)} wins</small>${action('Result →', 'load-report', `data-id="${h(cell.runId)}"`)}</div>` : `<span class="muted">${h(cell?.reason || 'Invalid cell')}</span>`;
    })])), 'Each cell uses the same closed candle window and INR conversion.', '', true)).join('');
    else grid = '';
    return `<div class="badge-row">${badge('PAPER · no promotion', 'amber')}${badge(run.fundingLabel || 'Excluded')}${badge(`${run.cells.length} cells`, 'blue')}</div>${grid}${panel('Ranked cells', table(['Rank', 'Coin', 'Parameters', 'Profit factor', 'Net P&L ₹', 'Win rate', 'Max DD', 'Result'], run.cells.slice().sort((a, b) => (a.rank || 999) - (b.rank || 999)).map(c => [h(c.rank ?? '—'), h(c.coin), `<span class="mono">${h(JSON.stringify(c.parameters))}</span>`, c.summary?.profitFactor == null ? 'N/D' : n(c.summary.profitFactor), `<span class="${sign(c.summary?.netPnlInr)}">${c.summary ? money(c.summary.netPnlInr) : '—'}</span>`, c.summary ? pct(c.summary.winRatePct) : '—', c.summary ? pct(c.summary.maxDrawdownPct) : '—', c.runId ? action('Open', 'load-report', `data-id="${h(c.runId)}"`) : h(c.reason)])), 'Profit factor then net P&L · N/D means no realized losses / undefined factor.', action('Inspect JSON', 'research-json', 'data-kind="matrix"'), true)}`;
  }
  function renderMatrix() {
    return `${panel('Parameter grid search', `<form id="matrix-form">${researchBaseForm('matrix')}<div class="form-actions"><button type="submit" class="primary">Run research matrix</button><p>Predeclared grid · bounded research sizing · no promotion</p></div></form>`, 'A single fetched dataset per coin is replayed for every cell.')}<div id="matrix-result">${renderMatrixResult()}</div>`;
  }
  function renderBacktest() {
    const c = { coin: S.coin, strategy: 'ema-trend', timeframe: S.timeframe, bars: 300, capitalInr: U.preferences(S.workspace).defaultEquityInr, maxOrderNotionalInr: U.preferences(S.workspace).defaultMaxOrderNotionalInr, ...U.protectionDefaults(S.workspace), takerFeeBps: 5, makerFeeBps: 2, slippageBps: 2, spreadBps: 1, stopSlippageBps: 5, ...(S.backtestDraft || {}) };
    return `<div class="two-column"><div>${panel('Backtest configuration', `<form id="backtest-form"><div class="form-section"><h3>Futures starter presets</h3><div class="chips">${U.starterPresets.map((p, i) => action(p.label, 'starter-preset', `data-index="${i}"`)).join('')}</div><p class="small muted">Closed-candle transition signals · Hold on neutral · Breakeven at 1R · 18% GST</p></div><div class="form-grid two">${select('Coin', 'coin', coinOptions, c.coin)}${select('Saved strategy / kernel', 'selection', savedOptions(), c.selection || c.strategy, 'data-preset-select')}${select('Timeframe', 'timeframe', timeOptions, c.timeframe)}${backtestWindowFields(c)}${field('Virtual capital ₹', 'capitalInr', c.capitalInr, 'number', 'min="1" required')}${field('Max order notional ₹', 'maxOrderNotionalInr', c.maxOrderNotionalInr, 'number', 'min="1" required')}</div><div class="form-section"><h3>Kernel parameters</h3><div class="form-grid" data-parameters>${parameterFields(c.strategy, c.parameters)}</div></div><div class="form-section"><h3>Stop loss & take profit</h3>${protectionFields(c, true)}</div>${futuresFields(c)}<div class="form-section"><h3>Explicit execution costs</h3><div class="form-grid">${select('Fill liquidity', 'fillLiquidity', ['TAKER', 'MAKER'], c.fillLiquidity || 'TAKER')}${field('Taker fee bps', 'takerFeeBps', c.takerFeeBps, 'number', 'min="0" max="100" step="any" required')}${field('Maker fee bps', 'makerFeeBps', c.makerFeeBps, 'number', 'min="0" max="100" step="any" required')}${field('Market slippage bps', 'slippageBps', c.slippageBps, 'number', 'min="0" max="100" step="any" required')}${field('Spread bps', 'spreadBps', c.spreadBps, 'number', 'min="0" max="100" step="any" required')}${field('Stop slippage bps', 'stopSlippageBps', c.stopSlippageBps, 'number', 'min="0" max="100" step="any" required')}</div></div><div class="form-actions"><button type="submit" class="primary">Run historical backtest →</button><p>Explicit funding model · PAPER · no promotion</p></div></form>`, 'Local 1m archive first; bounded CoinDCX reads for missing minutes')}${reportPickerPanel()}</div><div>${panel('Replay assumptions', `<ul class="list"><li><div><b>Closed candles only</b><small>Signals are causal; entries are modeled at the next open.</small></div>${badge('HISTORICAL', 'blue')}</li><li><div><b>Bounded research sizing</b><small>Virtual capital and max order notional constrain each replay.</small></div>${badge('RESEARCH')}</li><li><div><b>Conservative OHLC exits</b><small>Liquidation, hard SL, trailing SL and TP precede the next signal. Stops include adverse gap fills.</small></div>${badge('SL / TP', 'amber')}</li><li><div><b>Current conversion snapshot</b><small>Historical FX is not reconstructed. Funding is excluded or modeled at the chosen fixed rate.</small></div>${badge('LIMITATION', 'amber')}</li></ul><div class="divider"></div><div class="callout">A research result cannot establish complete net economics or authorize live trading.</div>${link('Open validation plan', 'validation')}`)}</div></div>`;
  }
  function reportPickerPanel() {
    return panel('Saved backtests', table(['Run', 'Saved', 'Net P&L ₹', 'Open'], S.reports.filter(r => r.mode === 'BACKTEST').slice(0, 8).map(r => [`<span class="mono">${h(r.runId.slice(-12))}</span>`, h(date(r.savedAtIso)), money(r.summary?.netPnlInr), action('View result', 'load-report', `data-id="${h(r.runId)}"`)])), 'Reload an existing result without requesting market data.', '', true);
  }
  const exitColor = reason => ['LIQUIDATION', 'STOP_LOSS'].includes(reason) ? 'red' : reason === 'TRAILING_STOP' ? 'amber' : ['TAKE_PROFIT', 'BREAKEVEN'].includes(reason) ? 'teal' : 'blue';
  function futuresKpis(report) {
    const s = report.summary;
    return `<div class="kpis">${kpi('Leverage', `${report.config.leverage ?? 1}x`, 'ISOLATED · modeled margin', 'blue-text')}${kpi('Total Funding ₹', money(s.totalFundingInr ?? 0), s.fundingLabel || U.fundingLabel(report.config), sign(s.totalFundingInr))}<article class="kpi"><div class="kpi-label">Liquidations</div><div class="kpi-value">${badge(s.liquidationCount ?? 0, s.liquidationCount > 0 ? 'red' : 'teal')}</div><div class="kpi-note">Liquidation precedes protective stops</div></article>${kpi('Avg Margin ROI %', pct(s.avgMarginRoiPct), 'Mean net P&L / initial margin', sign(s.avgMarginRoiPct))}</div><div class="kpis">${kpi('GST on Fees ₹', money(s.gstInr ?? 0), 'Included in total fees')}${kpi('Breakeven Exits', n(s.breakevenExitCount ?? 0, 0), 'Fee-adjusted 1R protection')}${kpi('Ambiguous Candles', n(s.ambiguousCandleCount ?? 0, 0), 'SL precedes TP', 'amber-text')}<article class="kpi"><div class="kpi-label">1m Protection</div><div class="kpi-value">${badge((s.protectionMode || report.protectionMode) === '1M' ? 'Active' : 'HTF', (s.protectionMode || report.protectionMode) === '1M' ? 'teal' : 'amber')}</div><div class="kpi-note">Actual replay resolution</div></article></div>`;
  }
  function tradeTable(trades) {
    return table(['Trade / side', 'Entry time', 'Entry USDT', 'Exit USDT', 'Qty', 'Margin ₹', 'Liq Price', 'Gross ₹', 'Fees ₹', 'Funding ₹', 'Net ₹', 'ROI %', 'Exit reason'], trades.map(t => [
      `<span class="mono">${h(t.tradeId)}</span><small>${badge(t.side, t.side === 'LONG' ? 'teal' : 'red')} ${h(t.leverage == null ? '' : `${t.leverage}x`)}</small>`, h(date(t.entryTimeIso)), n(t.entryPrice, 4), n(t.exitPrice, 4), n(t.quantity, 6),
      money(t.marginUsedInr), n(t.liquidationPrice, 4), money(t.grossPnlInr), money(t.feeInr), money(t.fundingInr ?? 0), `<span class="${sign(t.netPnlInr)}">${money(t.netPnlInr)}</span>`, pct(t.marginRoiPct), badge(t.exitReason, exitColor(t.exitReason))
    ]), 'This replay has no closed trades. Inspect minimum-notional skips, or change the strategy and window.');
  }

  function exportLinks(id) { return id ? `<div class="toolbar"><a class="button" href="/api/reports/export?id=${encodeURIComponent(id)}&amp;format=csv" download>↓ CSV ledger</a><a class="button" href="/api/reports/export?id=${encodeURIComponent(id)}&amp;format=json" download>↓ JSON evidence</a></div>` : ''; }
  function renderResults() {
    const r = S.report;
    if (!r) return `${empty('No backtest selected', 'Run a historical replay or open a retained report.', link('New backtest', 'backtest', true))}${reportPickerPanel()}`;
    const s = r.summary, drawdown = S.chartTab === 'drawdown';
    return `<div class="badge-row">${badge(r.pair, 'blue')}${badge(kernelName(r.config.strategy))}${badge(`${r.config.timeframe} · ${r.candles.length} closed bars`)}${badge(s.fundingLabel || U.fundingLabel(r.config), 'amber')}</div>${futuresKpis(r)}<div class="kpis five">${kpi('Net P&L ₹', money(s.netPnlInr), 'Gross P&L − fees + funding', sign(s.netPnlInr))}${kpi('Profit factor', s.profitFactor === null ? 'N/D' : n(s.profitFactor), s.profitFactor === null ? 'No realized losses / undefined' : `${pct(s.winRatePct)} win rate`)}${kpi('Max drawdown', pct(s.maxDrawdownPct), 'Mark-to-market equity', 'amber-text')}${kpi('Closed trades', n(s.totalTrades, 0), 'Complete round trips')}${kpi('Promotion status', 'PAPER', 'No promotion · Live locked', 'blue-text', true)}</div>
      <div class="two-column"><div>${panel(drawdown ? 'Drawdown over time' : 'Modeled equity over time', lineChart(r.equityCurve, drawdown ? 'drawdownPct' : 'equityInr', drawdown ? 'Drawdown' : 'Equity INR'), `Data end ${date(r.completedAtIso)} · Hover / focus + arrows to inspect`, `<div class="chips"><button data-action="chart-tab" data-tab="equity" class="${drawdown ? '' : 'active'}">Equity</button><button data-action="chart-tab" data-tab="drawdown" class="${drawdown ? 'active' : ''}">Drawdown</button></div>`)}</div><div>${panel('Accounting decomposition', metrics([['Gross P&L', money(s.grossPnlInr)], ['Total fees incl. GST', money(s.totalFeesInr)], ['GST on Fees ₹', money(s.gstInr ?? 0)], ['Breakeven Exits', s.breakevenExitCount ?? 0], ['Ambiguous Candles', s.ambiguousCandleCount ?? 0], ['1m Protection', (s.protectionMode || r.protectionMode) === '1M' ? 'Active' : 'HTF'], ['Net P&L', money(s.netPnlInr)], ['Funding ₹', money(s.totalFundingInr ?? 0)], ['Funding model', s.fundingLabel || U.fundingLabel(r.config)], ['Leverage / margin', `${r.config.leverage ?? 1}x · ISOLATED`], ['Liquidations', s.liquidationCount ?? 'Not retained'], ['Avg Margin ROI %', pct(s.avgMarginRoiPct)], ['Skipped minimum notional', s.skippedMinNotionalCount ?? 'Not retained'], ['INR / USDT', n(r.conversion.inrPerUsdt, 4)], ['Conversion source', r.conversion.source.replaceAll('_', ' ')]]), 'Slippage / spread are embedded in modeled fill prices.')}</div></div>${panel('Recent trades', tradeTable(r.trades.slice(-6).reverse()), `${r.trades.length} chronological trades retained`, link('Full event ledger →', 'ledger'), true)}${panel('Replay evidence & assumptions', `<div class="toolbar">${exportLinks(r.runId)}${action('Inspect JSON', 'report-json')}</div><ul class="list">${(r.assumptions || []).map(a => `<li>${h(a)}</li>`).join('')}</ul><p class="small muted">SL ${h(protectionLabel(r.config.stopLossMode, r.config.stopLossValue))} · TP ${h(protectionLabel(r.config.takeProfitMode, r.config.takeProfitValue))}</p>`, r.runId)}`;
  }
  function ledgerRows() {
    const trades = (S.report?.trades || []).filter(t => U.tradeMatches(t, S.ledgerQuery));
    return `${tradeTable(trades)}<div class="panel-body"><h3 style="margin:20px 0 12px">Per-trade event evidence</h3>${trades.map(t => `<details><summary>${h(t.tradeId)} · ${h(t.side)} · ${h(t.exitReason)} · ${money(t.netPnlInr)} · ${(t.events || []).length} event steps</summary><div class="details-body">${(t.events || []).length ? t.events.map(e => `<div class="event-step"><span>${badge(e.type, ['FUNDING_SETTLEMENT', 'BREAKEVEN_ARMED'].includes(e.type) ? 'teal' : e.type === 'EXIT_FILL' ? exitColor(t.exitReason) : 'blue')}</span><time>${h(date(e.timestampMs))}</time><pre>${h(JSON.stringify(e.details, null, 2))}</pre></div>`).join('') : '<p class="muted small">This older report did not retain per-trade events.</p>'}</div></details>`).join('')}<p class="small muted" style="margin-top:14px">${trades.length} / ${S.report?.trades.length || 0} trades matched. Events retain their original chronological order.</p></div>`;
  }
  function renderLedger() {
    if (!S.report) return renderResults();
    return `${futuresKpis(S.report)}<div class="toolbar"><label class="search-field search">Search trades & event details<input id="ledger-search" type="search" value="${h(S.ledgerQuery)}" placeholder="Trade ID, STOP_LOSS, SL_TP_ARMED…"></label>${exportLinks(S.report.runId)}</div>${panel('Trade & event ledger', `<div id="ledger-records">${ledgerRows()}</div>`, `${S.report.pair} · ${S.report.runId}`, badge('BACKTEST', 'blue'), true)}`;
  }
  function validationResult() {
    const run = S.validation;
    if (!run) return empty('No validation run yet', 'Predeclare the universe, then evaluate chronological folds.');
    return `<div class="badge-row">${badge('PAPER · no promotion', 'amber')}${badge(run.fundingLabel || 'Excluded')}${badge(`${run.costStressMultiplier}× cost stress`, 'blue')}</div><div class="callout info">${h(run.foldPolicy)} Gap / purge: 0 bars. The current engine does not model a purge gap; no gap candles are implied.</div>${run.byPair.map(pair => {
      const first = pair.candidates[0], folds = first?.folds || [], total = folds.reduce((sum, f) => sum + f.bars, 0);
      return panel(`${pairName(pair.pair)} · chronological evaluation`, `<div class="fold-track" aria-label="Actual chronological train, OOS and holdout bar allocation">${folds.map(f => `<div class="${f.name === 'TRAIN' ? 'train' : f.name === 'OOS' ? 'oos' : 'holdout'}" style="flex:${f.bars}">${h(f.name)} · ${n(f.bars, 0)} bars · ${pct(f.bars / total * 100)}</div>`).join('')}</div><p class="small muted">Gap: 0 bars · Each fold starts flat and warms its own indicators · Holdout excluded from selection.</p>${table(['OOS rank', 'Parameters', 'Fold / bars', 'Range', 'Net P&L ₹', 'PF', 'Win rate', 'Max DD', 'Result'], pair.candidates.flatMap(c => c.folds.map(f => [h(c.rank), `<span class="mono">${h(JSON.stringify(c.parameters))}</span>${c.rank === pair.selectedOnTrain ? '<small>Selected on TRAIN net P&L</small>' : ''}`, `${badge(f.name, f.name === 'TRAIN' ? 'teal' : f.name === 'OOS' ? 'blue' : 'amber')}<small>${n(f.bars, 0)} bars</small>`, `${h(date(f.fromMs))}<small>${h(date(f.toMs))}</small>`, `<span class="${sign(f.summary.netPnlInr)}">${money(f.summary.netPnlInr)}</span>`, f.summary.profitFactor == null ? 'N/D' : n(f.summary.profitFactor), pct(f.summary.winRatePct), pct(f.summary.maxDrawdownPct), action('Open', 'load-report', `data-id="${h(f.runId)}"`)])))}<h3 style="margin:20px 0 12px">OOS execution cost stress</h3>${table(['OOS rank', 'Baseline net ₹', 'Stressed net ₹', 'Stressed PF', 'Stressed max DD'], pair.candidates.map(c => [h(c.rank), money(c.folds.find(f => f.name === 'OOS')?.summary.netPnlInr), `<span class="${sign(c.costStress.netPnlInr)}">${money(c.costStress.netPnlInr)}</span>`, c.costStress.profitFactor == null ? 'N/D' : n(c.costStress.profitFactor), pct(c.costStress.maxDrawdownPct)]))}`, 'Selected on TRAIN net P&L; ranked by OOS profit factor then net P&L.', action('Inspect JSON', 'research-json', 'data-kind="validation"'));
    }).join('')}`;
  }
  function renderValidation() {
    return `${panel('Walk-forward validation plan', `<form id="validation-form">${researchBaseForm('validation')}<div class="form-section"><h3>Chronological partition</h3><div class="form-grid four">${field('Train %', 'trainPercent', 60, 'number', 'min="30" max="70" required data-fold-input')}${field('OOS %', 'oosPercent', 20, 'number', 'min="15" max="40" required data-fold-input')}${field('Gap / purge bars', 'gapBars', 0, 'number', 'disabled')}${field('Cost stress multiplier', 'costStressMultiplier', 2, 'number', 'min="1" max="5" step="0.1" required')}</div><div id="fold-preview">${foldPreview(60, 20)}</div><p class="small muted">Train + OOS ≤ 85%. Every fold needs at least 30 bars. Gap is not modeled by the current engine.</p></div><div class="form-actions"><button type="submit" class="primary">Run chronological validation</button><p>Train selection · OOS ranking · Holdout untouched</p></div></form>`, 'Non-overlapping folds with explicit execution cost stress.')}<div id="validation-result">${validationResult()}</div>`;
  }
  function foldPreview(train, oos) {
    const holdout = 100 - Number(train) - Number(oos);
    return `<div class="fold-track"><div class="train" style="flex:${Number(train) || 1}">Train ${h(train)}%</div><div class="oos" style="flex:${Number(oos) || 1}">OOS ${h(oos)}%</div><div class="holdout" style="flex:${Math.max(1, holdout)}">Holdout ${h(holdout)}%</div></div><p class="small muted">Gap: 0 bars · No purge interval</p>`;
  }
  function renderRankings() {
    const validations = (S.workspace.researchRuns || []).filter(r => r.type === 'VALIDATION').slice().reverse();
    const matrices = (S.workspace.researchRuns || []).filter(r => r.type === 'MATRIX').slice().reverse();
    const pairs = new Set(); const rankings = [];
    for (const run of validations) for (const pair of run.result.byPair || []) {
      if (pairs.has(pair.pair)) continue; pairs.add(pair.pair);
      rankings.push(...pair.candidates.map(c => ({ pair: pair.pair, rank: c.rank, parameters: c.parameters, summary: c.folds.find(f => f.name === 'OOS')?.summary, source: 'OOS validation', runId: run.id, reportId: c.folds.find(f => f.name === 'OOS')?.runId })));
    }
    // Matrix results are grouped and ranked only within each coin, never globally across pairs.
    for (const run of matrices) for (const coin of coinOptions) {
      const pair = `B-${coin}_USDT`; if (pairs.has(pair)) continue;
      const cells = (run.result.ranked || []).filter(c => c.coin === coin && c.summary); if (!cells.length) continue; pairs.add(pair);
      cells.forEach((c, i) => rankings.push({ pair, rank: i + 1, parameters: c.parameters, summary: c.summary, source: 'In-sample matrix', runId: run.id, reportId: c.runId }));
    }
    for (const coin of coinOptions) {
      const pair = `B-${coin}_USDT`; if (pairs.has(pair)) continue;
      const score = r => r.summary.profitFactor ?? (r.summary.netPnlInr > 0 && r.summary.totalTrades > 0 ? Number.MAX_SAFE_INTEGER : -1);
      const runs = S.reports.filter(r => r.mode === 'BACKTEST' && r.pair === pair && r.config && r.summary).sort((a, b) => score(b) - score(a) || b.summary.netPnlInr - a.summary.netPnlInr);
      runs.forEach((r, i) => rankings.push({ pair, rank: i + 1, parameters: { strategy: r.config.strategy, timeframe: r.config.timeframe, ...r.config.parameters }, summary: r.summary, source: 'Historical backtest · in-sample', reportId: r.runId }));
    }
    const grouped = coinOptions.filter(c => S.rankingCoin === 'ALL' || S.rankingCoin === c).map(coin => {
      const pair = `B-${coin}_USDT`, rows = rankings.filter(r => r.pair === pair);
      return panel(`${coin} · Pair-local research rankings`, table(['Rank', 'Parameters', 'Evidence', 'PF', 'Net P&L ₹', 'Win rate', 'Max DD', 'Status', 'Result'], rows.map(r => [h(r.rank), `<span class="mono">${h(JSON.stringify(r.parameters))}</span>`, h(r.source), r.summary?.profitFactor == null ? 'N/D' : n(r.summary.profitFactor), money(r.summary?.netPnlInr), pct(r.summary?.winRatePct), pct(r.summary?.maxDrawdownPct), badge('PAPER · no promotion', 'amber'), action('Inspect', 'load-report', `data-id="${h(r.reportId)}"`)]), 'No retained matrix or validation candidates for this pair.'), 'Latest validation per pair; otherwise latest matrix. Holdout never selects rank.', '', true);
    }).join('');
    return `<div class="toolbar"><label for="ranking-coin">Pair</label><select id="ranking-coin">${options(['ALL', ...coinOptions], S.rankingCoin)}</select>${link('Run validation', 'validation', true)}${badge('PAPER · no promotion', 'amber')}</div><div class="callout">Rankings compare candidates within a pair. In-sample results are labeled separately from OOS evidence. Review window, timeframe and cost comparability. Funding is excluded.</div>${grouped}`;
  }
  const execution = window.WorkspaceExecution({ S, U, $, h, n, money, pct, date, sign, badge, panel, table, kpi, metrics, empty, link, select, field,
    options, kernelName, pairName, protectionLabel, protectionFields, parameterFields, savedOptions, lineChart, candleChart,
    api, errorText, evidence, notice, toast, refreshAfterMutation, perform, render, fetchMarket, backtestPayload, formValues, futuresFields });
  const system = window.WorkspaceSystem({ S, U, $, h, n, money, date, badge, panel, table, kpi, metrics, empty, link, field, select, options,
    api, errorText, perform, evidence, notice, toast, refresh, refreshAfterMutation, render, connectionError, formValues });
  const views = { unlock: renderUnlock, overview: renderOverview, markets: renderMarkets, instrument: renderInstrument, data: renderData, quality: renderQuality, backfill: renderBackfill, strategies: renderStrategies, builder: renderBuilder, matrix: renderMatrix, backtest: renderBacktest, results: renderResults, ledger: renderLedger, validation: renderValidation, rankings: renderRankings, ...execution.views, ...system.views };
  function render() {
    shell(); plots = new Map(); plotSequence = 0;
    $('#view').setAttribute('aria-busy', String(!S.workspace));
    $('#view').innerHTML = (S.workspace || system.views[S.route]) ? views[S.route]() : empty('Workspace unavailable', 'Check that the local dashboard server is running, then use Refresh.');
    connectCharts(); updateDisabled();
  }
  function updateDisabled() {
    document.querySelectorAll('#view button[type="submit"], #history-form button[type="submit"]').forEach(b => { const local = ['settings-form', 'export-form'].includes(b.closest('form')?.id); b.disabled = !S.connected || (!local && (S.busy || Boolean(S.workspace?.busy) || Boolean(S.workspace?.operations.admissionStopped))) || (local && b.closest('form')?.id === 'settings-form' && S.busy); });
    document.querySelectorAll('[data-data-mutation]').forEach(b => { b.disabled = !S.connected || S.busy || Boolean(S.workspace?.busy) || Boolean(S.workspace?.operations?.admissionStopped) || b.dataset.tracked === 'true'; });
    $('#refresh-workspace').disabled = S.busy;
    execution.updateButtons(); system.updateButtons();
  }
  async function fetchMarket(coin, timeframe, force = false) {
    const key = `${coin}:${timeframe}`;
    if (S.loading.has(key) || (!force && S.market[key] && !(['instrument', 'paper-workspace', 'position-detail'].includes(S.route) && S.market[key].candles.length < 120))) return;
    S.loading.add(key); delete S.marketErrors[key];
    try { S.market[key] = await api(`/api/candles?pair=B-${coin}_USDT&resolution=${U.resolution[timeframe]}&bars=${timeframe === '1h' && S.route === 'markets' ? 30 : 120}`); }
    catch (error) { S.marketErrors[key] = errorText(error); }
    finally { S.loading.delete(key); }
  }
  async function hydrate(version) {
    if (!S.workspace) return;
    await execution.hydrate(); await system.hydrate();
    if (['data', 'quality', 'backfill'].includes(S.route) && S.syncJob?.status !== 'RUNNING' && !S.metadataTried && S.workspace.dataLake?.coins.some(c => !c.lotSize)) {
      S.metadataTried = true; await api('/api/instruments'); await refresh();
    }
    if (S.route === 'markets') {
      for (const coin of coinOptions) { if (version !== routeVersion) break; await fetchMarket(coin, '1h'); if (version === routeVersion) render(); }
    } else if (S.route === 'instrument') { await fetchMarket(S.coin, S.timeframe); }
    else if (['data', 'quality'].includes(S.route) && S.datasetId && !S.datasets[S.datasetId]) { S.datasets[S.datasetId] = await api(`/api/data/datasets/${encodeURIComponent(S.datasetId)}`); }
    else if (['results', 'ledger'].includes(S.route) && !S.report) {
      const latest = S.reports.find(r => r.mode === 'BACKTEST'); if (latest) S.report = await api(`/api/reports/${encodeURIComponent(latest.runId)}`);
    }
    if (version === routeVersion) render();
  }
  async function route() {
    const hash = location.hash.slice(1), [id, query] = hash.split('?');
    if (id === 'main') { $('#main').focus(); history.replaceState(null, '', `#${S.route}`); return; }
    if (id === 'screen-index') { render(); openIndex(); return; }
    const target = U.screens.find(p => p.id === id);
    if (!target && id && id !== 'main') { history.replaceState(null, '', '#overview'); toast('Screen not found. Opened Overview.'); }
    S.route = target?.id || 'overview';
    const params = new URLSearchParams(query); if (coinOptions.includes(params.get('coin'))) S.coin = params.get('coin');
    execution.onRoute(params);
    if (timeOptions.includes(params.get('timeframe'))) S.timeframe = params.get('timeframe');
    if ($('#screen-index').open) $('#screen-index').close();
    $('#sidebar').classList.remove('open'); $('.mobile-menu').setAttribute('aria-expanded', 'false');
    notice(); render(); system.afterRoute(); const version = ++routeVersion;
    try { await hydrate(version); } catch (error) { if (version === routeVersion) notice(errorText(error), true); }
  }
  function formValues(form) { return Object.fromEntries(new FormData(form).entries()); }
  function selectedKernel(values) { return S.workspace.savedStrategies.find(p => p.id === values.selection)?.strategy || values.selection || values.strategy || 'ema-trend'; }
  function backtestPayload(form) {
    const v = formValues(form), strategy = selectedKernel(v);
    const payload = { coin: v.coin || S.coin, strategy, timeframe: v.timeframe, bars: Number(v.bars), capitalInr: Number(v.capitalInr),
      maxOrderNotionalInr: Number(v.maxOrderNotionalInr), parameters: U.parameters(strategy, v.timeframe, v),
      ...U.futuresConfig({ ...U.strategyDefaults(strategy), ...v }),
      stopLossMode: v.stopLossMode, stopLossValue: ['PERCENT', 'INR'].includes(v.stopLossMode) ? Number(v.stopLossValue) : 0,
      takeProfitMode: v.takeProfitMode, takeProfitValue: ['PERCENT', 'INR'].includes(v.takeProfitMode) ? Number(v.takeProfitValue) : 0,
      takerFeeBps: Number(v.takerFeeBps), spreadBps: Number(v.spreadBps), stopSlippageBps: Number(v.stopSlippageBps) };
    for (const key of ['makerFeeBps', 'slippageBps']) if (v[key] !== undefined) payload[key] = Number(v[key]);
    if (v.fillLiquidity) payload.fillLiquidity = v.fillLiquidity;
    if (form.id === 'backtest-form' && v.lookbackMode) {
      payload.bars = Number(v.bars || 300);
      payload.fromDate = v.fromDate; payload.toDate = v.toDate;
      if (v.lookbackMode === 'DAYS') payload.days = Number(v.days);
    }
    return payload;
  }
  function researchPayload(form) {
    const values = formValues(form), { coin, ...payload } = backtestPayload(form);
    function grid(text) { const parts = String(text).split(',').map(s => s.trim()); if (parts.some(s => !/^\d+$/.test(s) || Number(s) < 2)) throw new Error('Parameter grids require comma-separated positive integer periods (minimum 2).'); return [...new Set(parts.map(Number))]; }
    const coins = values.universe === 'ALL' ? coinOptions : [values.universe];
    const fastPeriods = ['ema-trend', 'multi-timeframe-trend'].includes(payload.strategy) ? grid(values.fastPeriods) : [9];
    const slowPeriods = ['ema-trend', 'multi-timeframe-trend'].includes(payload.strategy) ? grid(values.slowPeriods) : [21];
    if (coins.length * fastPeriods.length * slowPeriods.length > 64) throw new Error('The matrix is bounded to 64 coin × parameter cells. Reduce the grid.');
    return { ...payload, coins, fastPeriods, slowPeriods };
  }
  function updateProtection(selectEl) {
    const input = selectEl.form.elements.namedItem(selectEl.dataset.protection), enabled = ['PERCENT', 'INR'].includes(selectEl.value);
    input.disabled = !enabled; input.required = enabled;
    input.max = selectEl.value === 'PERCENT' ? '99.999' : '1000000000';
    if (enabled && Number(input.value) <= 0) input.value = selectEl.dataset.protection === 'stopLossValue' ? '1' : '2';
  }
  function applyPreset(form, selection) {
    const preset = S.workspace.savedStrategies.find(p => p.id === selection), strategy = preset?.strategy || selection;
    if (preset) {
      form.elements.namedItem('timeframe').value = preset.timeframe;
      for (const [key, value] of Object.entries({ stopLossMode: preset.slMode, stopLossValue: preset.slValue, takeProfitMode: preset.tpMode, takeProfitValue: preset.tpValue })) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
      for (const [key, value] of Object.entries({ ...U.futuresConfig(preset), maxOrderNotionalInr: preset.maxOrderNotionalInr })) if (value !== undefined && form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
    }
    if (!preset) for (const [key, value] of Object.entries(U.strategyDefaults(strategy))) {
      const input = form.elements.namedItem(key); if (input) input.value = String(value);
    }
    form.querySelector('[data-parameters]').innerHTML = parameterFields(strategy, preset?.parameters || {});
    const hasGrid = ['ema-trend', 'multi-timeframe-trend'].includes(strategy);
    form.querySelectorAll('[data-grid-input]').forEach(input => { input.disabled = !hasGrid; });
    form.querySelectorAll('[data-protection]').forEach(updateProtection);
    updateFuturesPreview(form);
  }
  async function perform(button, label, work) {
    if (S.busy) return; S.busy = true; notice(`${label}… Uses real provider data and the shared read budget.`); updateDisabled();
    const before = button?.textContent; if (button) { button.disabled = true; button.textContent = 'Working…'; }
    try { await work(); }
    catch (error) { notice(errorText(error), true); try { await refresh(); } catch (refreshError) { connectionError(refreshError); } }
    finally { S.busy = false; if (button?.isConnected) { button.disabled = false; button.textContent = before; } updateDisabled(); }
  }
  async function refreshAfterMutation() { try { await refresh(); } catch (error) { connectionError(error); } }
  document.addEventListener('submit', event => {
    if (system.submit(event) || execution.submit(event)) return;
    const form = event.target; if (!form.id.endsWith('-form')) return; event.preventDefault();
    void perform(event.submitter, 'Running workspace job', async () => {
      const v = formValues(form);
      if (form.id === 'catalog-search-form') { await loadCatalog(v.query, 0); }
      else if (form.id === 'history-form') {
        const payload = { action: 'backfill', coin: v.coin };
        if (v.historyMode === 'DAYS') payload.days = Number(v.days);
        else { payload.fromDate = v.fromDate; payload.toDate = v.toDate; }
        await startSyncJob(payload);
      } else if (form.id === 'shadow-form') {
        await api('/api/shadow/run', { coins: coinOptions, strategy: v.strategy, equityInr: Number(v.equityInr), maxOrderNotionalInr: Number(v.maxOrderNotionalInr), mode: 'SHADOW' });
        await refreshAfterMutation(); render(); notice('Shadow cycle retained. Review account and M7 evidence; live execution remains locked.');
      } else if (form.id === 'sync-form') {
        const payload = { coin: v.coin, timeframe: v.timeframe, bars: Number(v.bars) };
        if (v.endLocal) { payload.endTimeMs = new Date(v.endLocal).getTime(); if (!Number.isFinite(payload.endTimeMs) || payload.endTimeMs > Date.now()) throw new Error('Choose a valid historical end time.'); }
        await startSyncJob(payload);
      } else if (form.id === 'builder-form') {
        const strategy = v.strategy;
        const result = await api('/api/strategies', { name: v.name.trim(), strategy, timeframe: v.timeframe, parameters: U.parameters(strategy, v.timeframe, v),
          ...U.futuresConfig({ ...U.strategyDefaults(v.strategy), ...v }), maxOrderNotionalInr: Number(v.maxOrderNotionalInr ?? U.preferences(S.workspace).defaultMaxOrderNotionalInr),
          slMode: v.stopLossMode, slValue: ['PERCENT', 'INR'].includes(v.stopLossMode) ? Number(v.stopLossValue) : 0, tpMode: v.takeProfitMode, tpValue: ['PERCENT', 'INR'].includes(v.takeProfitMode) ? Number(v.takeProfitValue) : 0 });
        S.builder = result; await refreshAfterMutation(); location.hash = 'strategies'; toast(`Saved strategy: ${result.name}`);
      } else if (form.id === 'backtest-form') {
        const payload = backtestPayload(form); S.backtestDraft = { ...payload, selection: v.selection };
        S.report = await api('/api/backtest/run', payload); S.chartTab = 'equity'; S.ledgerQuery = '';
        await refreshAfterMutation(); location.hash = 'results'; toast(`Historical replay saved. ${U.fundingLabel(S.report.config)} · PAPER · no promotion.`);
      } else if (form.id === 'matrix-form') {
        S.matrix = await api('/api/matrix/run', researchPayload(form)); await refreshAfterMutation();
        if ($('#matrix-result')) { $('#matrix-result').innerHTML = renderMatrixResult(); $('#matrix-result').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        notice(`Matrix completed: ${S.matrix.cells.length} cells. Rankings are research only.`);
      } else if (form.id === 'validation-form') {
        const trainPercent = Number(v.trainPercent), oosPercent = Number(v.oosPercent), bars = Number(v.bars);
        if (trainPercent + oosPercent > 85 || Math.floor(bars * oosPercent / 100) < 30 || bars - Math.floor(bars * trainPercent / 100) - Math.floor(bars * oosPercent / 100) < 30) throw new Error('Use Train + OOS ≤ 85% and at least 30 bars in every fold.');
        S.validation = await api('/api/validation/run', { ...researchPayload(form), trainPercent, oosPercent, costStressMultiplier: Number(v.costStressMultiplier) });
        await refreshAfterMutation(); if ($('#validation-result')) { $('#validation-result').innerHTML = validationResult(); $('#validation-result').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        notice('Chronological validation completed. Holdout was excluded from selection and ranking.');
      }
      shell();
    });
  });
  document.addEventListener('click', event => {
    const systemButton = event.target.closest('[data-system]');
    if (systemButton) { system.click(systemButton); return; }
    const executionButton = event.target.closest('[data-exec]');
    if (executionButton?.dataset.exec === 'stop') { system.openStop($(`#${executionButton.dataset.id}-reason`)?.value.trim() || ''); return; }
    if (executionButton) { execution.click(executionButton); return; }
    const el = event.target.closest('[data-action]');
    if (!el) { if (event.target.closest('.screen-index-link') && $('#screen-index').open) $('#screen-index').close(); return; }
    const name = el.dataset.action;
    if (name === 'sync-cancel') { void cancelSyncJob(); return; }
    if (name === 'catalog-open') { $('#catalog-dialog').showModal(); void loadCatalog('', 0).catch(e => { $('#catalog-results').textContent = errorText(e); }); return; }
    if (name === 'history-backfill') { openHistory(el.dataset.coin); return; }
    if (name === 'screen-index') { openIndex(); return; }
    if (name === 'close-dialog') { el.closest('dialog').close(); if (location.hash === '#screen-index') history.replaceState(null, '', `#${S.route}`); return; }
    if (name === 'menu') { const open = $('#sidebar').classList.toggle('open'); el.setAttribute('aria-expanded', String(open)); return; }
    if (name === 'chart-tab') { S.chartTab = el.dataset.tab; render(); return; }
    if (name === 'report-json') { evidence('Historical backtest evidence', S.report); return; }
    if (name === 'research-json') { evidence(`${el.dataset.kind} evidence`, S[el.dataset.kind]); return; }
    if (name === 'starter-preset') {
      const preset = U.starterPresets[Number(el.dataset.index)], form = el.closest('form');
      if (!preset || !form) return;
      for (const [key, value] of Object.entries({ ...preset, selection: preset.strategy })) {
        const input = form.elements.namedItem(key); if (input) input.value = String(value);
      }
      applyPreset(form, preset.strategy);
      // Preserve the explicit preset values after the kernel defaults have been applied.
      for (const [key, value] of Object.entries(preset)) {
        const input = form.elements.namedItem(key); if (input) input.value = String(value);
      }
      form.querySelectorAll('[data-protection]').forEach(updateProtection); updateFuturesPreview(form);
      toast(`${preset.label} starter loaded`); return;
    }
    if (name === 'configure-kernel') { S.builder = { name: '', strategy: el.dataset.kernel, timeframe: S.timeframe, parameters: {}, ...U.protectionDefaults(S.workspace) }; location.hash = 'builder'; return; }
    if (name === 'edit-preset') { S.builder = S.workspace.savedStrategies.find(p => p.id === el.dataset.id); location.hash = 'builder'; return; }
    if (name === 'backtest-preset') { const p = S.workspace.savedStrategies.find(p => p.id === el.dataset.id); S.backtestDraft = { ...U.futuresConfig(p), maxOrderNotionalInr: p.maxOrderNotionalInr, strategy: p.strategy, selection: p.id, timeframe: p.timeframe, parameters: p.parameters, stopLossMode: p.slMode, stopLossValue: p.slValue, takeProfitMode: p.tpMode, takeProfitValue: p.tpValue }; location.hash = 'backtest'; return; }
    if (name === 'setup-backtest') { S.backtestDraft = { coin: S.coin, timeframe: S.timeframe }; location.hash = 'backtest'; return; }
    if (name === 'timeframe') { location.hash = `instrument?coin=${S.coin}&timeframe=${el.dataset.timeframe}`; return; }
    void perform(el, 'Loading evidence', async () => {
      if (name === 'catalog-page') { await loadCatalog($('#catalog-query').value, Number(el.dataset.offset)); }
      else if (name === 'catalog-add') {
        await api('/api/catalog/coins', { pair: el.dataset.pair });
        await refreshAfterMutation(); render(); await loadCatalog($('#catalog-query').value, catalogOffset);
        toast('Coin added to all workspace selectors.');
      } else if (['history-sync', 'history-repair', 'history-sync-all', 'history-extend-all'].includes(name)) {
        const all = name.endsWith('-all'), action = name === 'history-extend-all' ? 'extend' : name === 'history-repair' ? 'repair' : 'sync';
        const payload = { action, ...(all ? { all: true } : { coin: el.dataset.coin }) };
        if (action === 'extend') payload.days = Number($('#extend-days').value);
        await startSyncJob(payload);
      } else if (name === 'refresh') {
        await refresh(); render(); notice('Workspace state refreshed.'); await hydrate(++routeVersion);
      } else if (name === 'refresh-markets') {
        for (const coin of coinOptions) { await fetchMarket(coin, '1h', true); } render(); notice('Watchlist refreshed from closed hourly candles.');
      } else if (name === 'refresh-candles') { await fetchMarket(S.coin, S.timeframe, true); render(); notice('Candle request completed. Provider errors are displayed beside the chart.'); }
      else if (name === 'dataset') { S.datasetId = el.dataset.id; location.hash = 'quality'; }
      else if (name === 'load-report') {
        const report = await api(`/api/reports/${encodeURIComponent(el.dataset.id)}`);
        if (report.mode !== 'BACKTEST') throw new Error('This is not a historical backtest report.');
        S.report = report; S.ledgerQuery = ''; S.chartTab = 'equity';
        if (S.route === 'results') render(); else location.hash = 'results';
      } else if (name === 'inspect-report') evidence('Saved run evidence', await api(`/api/reports/${encodeURIComponent(el.dataset.id)}`));
    });
  });
  document.addEventListener('change', event => {
    const el = event.target;
    if (el.form && ['leverage', 'maintenanceMarginRateBps', 'maxOrderNotionalInr', 'fundingMode'].includes(el.name)) updateFuturesPreview(el.form);
    if (system.change(el) || execution.change(el)) return;
    if (el.matches('[data-builder-coin]')) S.coin = el.value;
    else if (el.matches('[data-lookback]') || el.matches('[data-days]')) syncBacktestWindow(el.form, el.matches('[data-days]'));
    else if (el.name === 'historyMode') {
      const custom = el.value === 'CUSTOM';
      ['fromDate', 'toDate'].forEach(k => { const f = el.form.elements.namedItem(k); f.disabled = !custom; f.required = custom; });
      el.form.elements.namedItem('days').disabled = custom;
    }
    else if (el.id === 'screen-jumper') location.hash = el.value;
    else if (el.id === 'instrument-coin') { S.chartOffset = 0; location.hash = `instrument?coin=${el.value}&timeframe=${S.timeframe}`; }
    else if (el.id === 'chart-bars') { S.visibleBars = Number(el.value); S.chartOffset = 0; render(); }
    else if (el.id === 'chart-offset') { S.chartOffset = Number(el.value); render(); }
    else if (el.id === 'dataset-select') { S.datasetId = el.value; void hydrate(++routeVersion).catch(e => notice(errorText(e), true)); }
    else if (el.id === 'ranking-coin') { S.rankingCoin = el.value; render(); }
    else if (el.matches('[data-protection]')) updateProtection(el);
    else if (el.matches('[data-kernel-select]')) applyPreset(el.form, el.value);
    else if (el.matches('[data-preset-select]')) applyPreset(el.form, el.value);
  });
  document.addEventListener('input', event => {
    const el = event.target;
    if (el.form && ['leverage', 'maintenanceMarginRateBps', 'maxOrderNotionalInr'].includes(el.name)) updateFuturesPreview(el.form);
    if (system.input(el) || execution.input(el)) return;
    if (el.id === 'catalog-query') {
      clearTimeout(catalogTimer); catalogTimer = setTimeout(() => { void loadCatalog(el.value, 0).catch(e => { $('#catalog-results').textContent = errorText(e); }); }, 500);
    } else if (el.id === 'index-search') renderIndex(el.value);
    else if (el.id === 'ledger-search') { S.ledgerQuery = el.value; $('#ledger-records').innerHTML = ledgerRows(); }
    else if (el.matches('[data-fold-input]')) $('#fold-preview').innerHTML = foldPreview(el.form.elements.namedItem('trainPercent').value, el.form.elements.namedItem('oosPercent').value);
  });
  $('#screen-index').addEventListener('close', () => { if (location.hash === '#screen-index') history.replaceState(null, '', `#${S.route}`); });
  window.addEventListener('hashchange', () => { void route(); });
  async function start() {
    system.init(); initNavigation();
    try { await refresh(); S.coin = S.workspace.settings.defaultCoin; }
    catch (error) { connectionError(error); }
    await route();
  }
  void start();
})();
