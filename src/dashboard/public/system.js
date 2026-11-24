/* Final system/state screens and native, accessible local confirmation dialogs. */
window.WorkspaceSystem = function (C) {
  'use strict';
  const { S, U, h, n, money, date, badge, panel, table, kpi, metrics, empty, link, field, select, options } = C;
  const E = { catalog: null, stale: true, error: null, kind: 'ALL', query: '', exportId: 'workspace-audit', exportFormat: 'json', stopping: false, reason: '' };
  const button = (text, action, primary = false, disabled = false, id = '') => `<button type="button" data-system="${action}" data-id="${h(id)}" class="${primary ? 'primary' : ''}" ${disabled ? 'disabled' : ''}>${h(text)}</button>`;
  const checkList = rows => `<ul class="list">${rows.map(([title, text]) => `<li><div><b>${h(title)}</b><small>${h(text)}</small></div>${badge('EXPLICIT', 'blue')}</li>`).join('')}</ul>`;
  const download = (id, format = 'json', label = 'Download') => `<a class="button" href="/api/reports/export?id=${encodeURIComponent(id)}&amp;format=${format}" download>${h(label)} ↓</a>`;
  function evidenceRows() {
    const entries = (E.catalog?.entries || []).filter(e => (E.kind === 'ALL' || e.kind === E.kind) && `${e.id} ${e.title} ${e.source}`.toLowerCase().includes(E.query.toLowerCase()));
    return table(['Evidence / type', 'Timestamp', 'SHA-256 / integrity', 'Source', 'Inspect', 'Download'], entries.map(e => [h(e.title) + `<small>${badge(e.kind, 'blue')} ${h(e.id)}</small>`, h(date(e.timestamp)), `${badge(e.integrity, e.integrity === 'VERIFIED' ? 'teal' : e.integrity === 'FAILED' ? 'red' : 'amber')}<div class="hash">${h(e.sha256 || 'No verifiable digest')}</div>`, `<span class="mono">${h(e.source)}</span>`, button('Inspect JSON', 'inspect', false, e.integrity === 'FAILED', e.id), e.integrity === 'FAILED' ? 'Review required' : download(e.id)]), E.error || 'No matching retained evidence packages.');
  }
  function audit() {
    const entries = E.catalog?.entries || [], complete = E.catalog && E.catalog.persistence?.status === 'VERIFIED' && entries.every(e => e.integrity === 'VERIFIED');
    const shadow = S.workspace?.shadowReport?.cycles?.at(-1)?.pairSummaries?.[0], session = S.workspace?.paperSessions?.[0], order = session?.orders?.at(-1);
    const trace = [['Strategy decision', order?.decisionId || shadow?.strategyDecision?.decisionId || 'Not yet recorded'], ['M7 risk assessment', order?.riskDecisionId || shadow?.riskDecision?.riskDecisionId || 'Not yet recorded'],
      ['Paper / Shadow execution intent', order ? `${order.id} · ${order.status}` : shadow?.execution?.status || 'No execution intent retained'], ['Retained ledger', session?.id || S.report?.runId || 'No selected virtual ledger']];
    return `<div class="kpis">${kpi('Evidence packages', E.catalog ? n(entries.length, 0) : '—', 'Saved reports, strategy configs and paper sessions')}${kpi('Integrity checks', E.catalog ? complete ? 'Verified' : 'Review needed' : 'Pending', 'Local SHA-256 / workspace envelope checks', complete ? 'positive' : 'amber-text', true)}${kpi('Source links', E.catalog ? entries.some(e => e.integrity === 'FAILED') ? 'Partial' : 'Available' : 'Pending', 'Scoped source and download references', 'blue-text', true)}${kpi('Authority changes', n(E.catalog?.authorityChanges ?? 0, 0), 'This dashboard composes no live authority')}</div><div class="toolbar"><label class="search-field search">Find evidence<input data-system-input="evidence-query" type="search" value="${h(E.query)}" placeholder="Report, strategy, account or source…"></label><label>Type<select data-system-change="evidence-kind">${options(['ALL', 'BACKTEST', 'SHADOW', 'STRATEGY', 'PAPER'], E.kind)}</select></label>${button('Verify evidence again', 'verify')}${link('Reports & exports', 'reports')}</div>${E.error ? `<div class="callout error">${h(E.error)}</div>` : ''}${panel('Evidence & audit trail', `<div id="system-evidence-table">${evidenceRows()}</div>`, 'VERIFIED means a retained local digest / envelope matched. DIGEST_ONLY has no prior seal.', '', true)}<div class="two-column"><div>${panel('Decision trace', `<div class="decision-trace">${trace.map(([title, value], i) => `<article><span class="step-number">${i + 1}</span><h3>${h(title)}</h3><p class="mono">${h(value)}</p></article>`).join('')}</div>`, 'Actual references from a retained paper account or shadow evaluation.')}</div><div>${panel('Evidence limitations', checkList([['Integrity scope', 'Local hashes detect content changes; they are not external signatures or proof of correctness.'], ['Older reports', 'Unsealed archives remain DIGEST_ONLY. Missing history is not reconstructed.'], ['Economics', 'Funding is excluded; venue transfers and ADL remain unresolved.'], ['Authority', 'Evidence does not unlock OPEN, CLOSE or CANCEL.']]))}</div></div>`;
  }
  function connections() {
    const c = S.workspace?.connections, rest = c?.rest, stream = c?.stream, storage = c?.storage;
    return `<div class="three-column">${panel('CoinDCX REST', `${badge(rest?.credentialsConfigured ? 'CREDENTIALS CONFIGURED' : 'NO CREDENTIALS CONFIGURED', 'blue')}${metrics([['Credentials', rest?.credentialsConfigured ? 'Server environment only' : 'Not configured / unavailable'], ['Masked account fingerprint', rest?.fingerprintPrefix || 'Not observed'], ['Last recorded HTTP status', rest?.http?.lastHttpStatus ?? 'Unknown'], ['HTTP source', rest?.http?.source || 'No status captured'], ['Last HTTP observation', rest?.http?.observedAtMs ? date(rest.http.observedAtMs) : 'Not recorded'], ['Private account', rest?.accountStatus || 'NOT_OBSERVED']])}${rest?.error ? `<p class="small amber-text" style="margin-top:12px">${h(rest.error)}</p>` : ''}`)}${panel('Private Account Stream', `${badge(stream?.currentState || 'STOPPED', 'amber')}${metrics([['Last observed state', stream?.lastObservedState || 'NOT_OBSERVED'], ['Persistent connection', 'Not composed'], ['Connection epoch', stream?.epoch ?? 'Unknown'], ['Reconnection policy', stream?.reconnectPolicy || 'Explicit cycle only']])}<div class="form-actions">${link('Sync & readiness', 'readiness')}</div>`)}${panel('Local Workspace & MySQL Store', `${badge(storage?.local?.status === 'VERIFIED' ? 'LOCAL STORE ACTIVE' : 'LOCAL STORE UNVERIFIED', storage?.local?.status === 'VERIFIED' ? 'teal' : 'amber')}${metrics([['Local source', '.local/workspace-state.json'], ['Local integrity', storage?.local?.status || 'Unknown'], ['MySQL configured', storage?.mysqlConfigured ? 'Yes · server environment' : 'No / unavailable'], ['Prisma schema', storage?.prismaSchemaPresent ? 'Present' : 'Not detected'], ['MySQL connection', 'Not composed by this dashboard']])}`)}</div>${panel('Read-only connection test', `<div class="toolbar">${select('Observation mode', 'connection-mode', [['DRY_RUN', 'DRY_RUN · public data only'], ['SHADOW', 'SHADOW · scoped private observation']], rest?.credentialsConfigured ? 'SHADOW' : 'DRY_RUN', 'id="connection-test-mode"')}${button('Test Read-Only Connection', 'connection-test', true, S.busy || Boolean(S.workspace?.busy) || Boolean(S.workspace?.operations?.admissionStopped))}</div><p class="small muted">A test refreshes retained connection evidence through the existing managed read path. Keys, secrets and database URLs are never displayed.</p>`, 'Configured credentials are not proof of authentication or live permission.', badge('LIVE LOCKED', 'amber'))}`;
  }
  function settings() {
    const p = U.preferences(S.workspace), tamil = p.language === 'ta';
    const label = (en, ta) => tamil ? ta : en;
    return `<div class="two-column"><div>${panel(label('Workspace preferences', 'பணியிட அமைப்புகள்'), `<form id="settings-form"><div class="form-grid two">${select(label('Display language', 'காட்சி மொழி'), 'language', [['en', 'English'], ['ta', 'தமிழ்'], ...(p.language === 'hi' ? [['hi', 'Hindi · legacy preference']] : [])], p.language)}${select(label('Timezone', 'நேர மண்டலம்'), 'timezone', [['Asia/Kolkata', 'Asia/Kolkata'], ['UTC', 'UTC']], p.timezone === 'Asia/Calcutta' ? 'Asia/Kolkata' : p.timezone)}${select(label('Default instrument', 'இயல்பு நாணயம்'), 'defaultCoin', U.trackedCoins(S.workspace).map(c => [c, `B-${c}_USDT`]), p.defaultCoin)}${field(label('Default Equity INR', 'இயல்பு மூலதனம் ₹'), 'defaultEquityInr', p.defaultEquityInr, 'number', 'min="1" max="1000000000" step="any" required')}${field(label('Default Max Order Notional INR', 'ஆர்டர் மதிப்பு வரம்பு ₹'), 'defaultMaxOrderNotionalInr', p.defaultMaxOrderNotionalInr, 'number', 'min="1" max="1000000000" step="any" required')}${field(label('Default SL %', 'இயல்பு SL %'), 'defaultSlPct', p.defaultSlPct, 'number', 'min="0" max="99.999" step="any" required')}${field(label('Default TP %', 'இயல்பு TP %'), 'defaultTpPct', p.defaultTpPct, 'number', 'min="0" max="99.999" step="any" required')}</div><p class="small muted" style="margin-top:12px">Tamil applies to navigation and system labels. Zero SL / TP disables that default protection. Defaults apply to new configurations; retained sessions keep their saved configuration.</p><div class="form-section"><h3>${label('In-app notifications', 'செயலிக்குள் அறிவிப்புகள்')}</h3><label class="check-field"><input name="researchCompletion" type="checkbox" ${p.notifications.researchCompletion ? 'checked' : ''}> ${label('Research completion feedback', 'ஆராய்ச்சி நிறைவு அறிவிப்பு')}</label><label class="check-field" style="margin-top:12px"><input name="routineStatus" type="checkbox" ${p.notifications.routineStatus ? 'checked' : ''}> ${label('Routine status feedback', 'சாதாரண நிலை அறிவிப்பு')}</label><p class="small muted" style="margin-top:12px">Critical operator and error messages remain visible. Email, webhook and push delivery are not configured.</p></div><div class="form-actions"><button type="submit" class="primary">${label('Save workspace settings', 'அமைப்புகளைச் சேமி')}</button></div></form>`)}</div><div>${panel('Safety & Evidence invariants', checkList([['Live enablement', 'Settings never grant trading authority. LIVE LOCKED is permanent in this dashboard.'], ['Funding exclusion', 'Remains visible in all modeled results.'], ['Exact sources', 'Missing data and unobserved economics remain unknown.'], ['Persistence', 'Preferences use the checksum-verified atomic workspace store.']]), '', link('Live readiness review', 'live-review'))}</div></div>`;
  }
  function liveReview() {
    const w = S.workspace, report = w?.shadowReport, summaries = report?.cycles?.at(-1)?.pairSummaries || [], budget = w?.rateBudget;
    const discovered = report?.discovery?.instruments || [];
    const minimum = U.trackedCoins(S.workspace).map(coin => { const p = summaries.find(p => p.pair === `B-${coin}_USDT`); return p?.minNotionalInr != null ? `${money(p.minNotionalInr)} ${coin}` : `${coin}: not observed`; }).join(' / ');
    const m7Observed = summaries.some(p => p.riskDecision) || w?.paperSessions?.some(s => s.lastRisk);
    const rows = [['Coin Discovery', discovered.length ? `Ready · ${discovered.length} discovered mappings` : 'Pending · no retained discovery', 'Latest retained shadow discovery'], ['M2 Rate Limiter', budget?.connected && !budget.unknown ? 'Active · shared coordinator' : 'Pending / unavailable', 'Current server read-budget snapshot'], ['M7 Risk Engine', m7Observed ? 'Active · evaluations retained' : 'Composed · no evaluation retained', 'Per-decision checks still apply'], ['Account Convergence', report?.account?.status === 'OBSERVED_CONVERGENCE' ? 'Observed · historical cycle' : `Pending · ${report?.account?.status || 'NOT_OBSERVED'}`, 'No continuity or ownership authority'], ['Min Notional Check', minimum, 'Observed instrument minimum × observed INR conversion'], ['Explicit Live Authorization', 'Locked', 'No enablement or execution route composed']];
    return `<div class="callout error"><strong>LIVE REMAINS LOCKED</strong> · Readiness observations never grant permission to trade. This screen has no activation control.</div>${panel('Activation prerequisites', table(['Prerequisite', 'Actual retained state', 'Evidence boundary'], rows.map(r => r.map(h))), 'Venue minimums are displayed only after observation; reference amounts are never substituted.', '', true)}<div class="equal-columns">${panel('Permissions', table(['Operation', 'Granted'], [['OPEN', badge('False', 'red')], ['CLOSE', badge('False', 'red')], ['CANCEL', badge('False', 'red')]]), 'All live permissions remain false.', '', true)}${panel('Tiny-live review roadmap', checkList([['1 · Observe and review', 'Review complete reads, identity binding, instrument limits and source freshness.'], ['2 · Resolve ownership and authority', 'Separate implementation and review are required; observations cannot mint permission.'], ['3 · Explicit authorization', 'A separately authorized live composition would require explicit confirmation and observed convergence. This dashboard stays locked.']]))}</div>`;
  }
  function reports() {
    const entries = [{ id: 'workspace-audit', kind: 'WORKSPACE', title: 'Workspace Audit Bundle', integrity: E.catalog?.persistence?.status || 'UNKNOWN' }, ...(E.catalog?.entries || []),
      ...(S.workspace?.researchRuns || []).map(r => ({ id: r.id, kind: r.type, title: r.id, integrity: 'WORKSPACE' }))];
    if (!entries.some(e => e.id === E.exportId)) E.exportId = 'workspace-audit';
    const chosen = entries.find(e => e.id === E.exportId), csv = chosen?.kind === 'BACKTEST' || chosen?.kind === 'PAPER';
    if (!csv) E.exportFormat = 'json';
    const latestBt = entries.find(e => e.kind === 'BACKTEST' && e.integrity !== 'FAILED'), latestShadow = entries.find(e => e.kind === 'SHADOW' && e.integrity !== 'FAILED');
    return `<div class="three-column">${reportCard('Research Backtest Report', 'KPIs, modeled fills, closed-candle inputs and assumptions.', latestBt)}${reportCard('Shadow Observation Report', 'Read-only account, signal, synchronization and M7 evidence.', latestShadow)}${reportCard('Workspace Audit Bundle', 'Workspace state, audit history and all report digest/source references.', entries[0])}</div>${panel('Prepare & Download Export', `<form id="export-form" action="/api/reports/export" method="get"><div class="form-grid two">${select('Selected evidence package', 'id', entries.filter(e => e.integrity !== 'FAILED').map(e => [e.id, `${e.kind} · ${e.title}`]), E.exportId, 'required data-system-change="export-id"')}${select('File format', 'format', [['json', 'JSON · Redacted evidence package'], ...(csv ? [['csv', 'CSV · Chronological trade ledger']] : [])], E.exportFormat, 'required data-system-change="export-format"')}</div><div class="form-actions"><button type="submit" class="primary">Download Report ↓</button>${button('Inspect selected JSON', 'inspect', false, false, E.exportId)}</div></form><div class="divider"></div><p class="small muted">Native browser download from GET /api/reports/export. CSV is offered for actual backtest and paper trade ledgers. Credentials are redacted from JSON and CSV; funding remains excluded.</p>`, chosen?.id || '', badge('PAPER · no promotion', 'amber'))}${E.error ? `<div class="callout error">${h(E.error)}</div>` : ''}${panel('Retained evidence packages', evidenceRows(), 'All saved reports, presets and paper sessions.', button('Refresh exports', 'verify'), true)}`;
  }
  function reportCard(title, text, entry) { return panel(title, `<p class="small muted">${h(text)}</p><div class="form-actions">${entry ? button('Select report', 'select-export', false, false, entry.id) : '<span class="small muted">No report retained yet</span>'}</div>`, '', badge(entry ? 'AVAILABLE' : 'EMPTY', entry ? 'blue' : 'amber')); }
  function firstRun() {
    return `<div class="welcome-state"><span class="state-icon">Q</span><p class="eyebrow">YOUR FIRST EVIDENCE TRAIL</p><h2>Start with data. Build a reviewable result.</h2><p>Use verified closed candles, an explicit strategy and bounded virtual capital.</p><div class="three-column">${panel('1. Prepare data', `<p class="small muted">Fetch a bounded window and inspect actual timestamp coverage.</p><div class="form-actions">${link('Prepare data →', 'backfill', true)}</div>`)}${panel('2. Run a backtest', `<p class="small muted">Choose a kernel, SL / TP and explicit execution costs.</p><div class="form-actions">${link('Strategy library', 'strategies')}${link('Run a backtest →', 'backtest', true)}</div>`)}${panel('3. Review before paper', `<p class="small muted">Inspect the ledger and validation evidence before creating a virtual account.</p><div class="form-actions">${link('Review validation', 'validation')}${link('Paper accounts', 'paper')}</div>`)}</div><div class="badge-row">${badge('LIVE LOCKED', 'amber')}${badge(`${S.workspace?.datasets?.length || 0} datasets`)}${badge(`${S.workspace?.savedStrategies?.length || 0} presets`)}${badge(`${S.workspace?.paperSessions?.length || 0} virtual accounts`)}</div></div>`;
  }
  function connectionError() {
    const w = S.workspace, budget = w?.rateBudget;
    return `<div class="callout error"><strong>Connection lost / recovery review</strong><br>New live admissions remain blocked. No automatic mutation retry will occur.</div><div class="two-column"><div>${panel('Transport, epoch & latch evidence', metrics([['Dashboard API', S.connected ? 'Reachable now · review retained provider evidence' : 'Disconnected · retained values may be stale'], ['REST account', w?.connections?.rest?.accountStatus || 'Not observed'], ['Connection epoch', w?.connections?.stream?.epoch ?? 'Unknown / not retained'], ['M2 coordinator', budget?.connected ? 'Connected at last refresh' : 'Unavailable / unknown'], ['M2 admission', budget?.admission || 'UNKNOWN'], ['Operator latch', w?.operations ? w.operations.admissionStopped ? 'STOPPED' : 'Open for paper only' : 'Unknown'], ['Automatic mutation retries', '0'], ['Live permissions', 'OPEN / CLOSE / CANCEL: False']]), 'This state view does not invent a transport outage when the dashboard is reachable.')}</div><div>${panel('Conservative next step', checkList([['Preserve evidence', 'Keep pending outcomes and connection scope visible.'], ['Review before re-observation', 'A repeated read is not an automatic mutation retry.'], ['Resume deliberately', 'Only the workspace admission latch can be resumed here.']]))}</div></div><div class="toolbar">${link('Open recovery steps', 'recovery')}${button('Re-check connection', 'recheck', true)}</div>`;
  }
  function stopConfirm() {
    return `<div class="callout error">Emergency admission control · Live execution remains locked.</div>${panel('Stop new admissions?', `<p class="small muted">Confirmation stops new workspace admissions and virtual OPEN orders. Existing exposure is not guaranteed to close automatically.</p>${metrics([['Current workspace admission', S.workspace?.operations ? S.workspace.operations.admissionStopped ? 'STOPPED' : 'OPEN · PAPER ONLY' : 'Unknown'], ['Automatic venue flattening', 'Not composed'], ['Mutation retries', '0'], ['Live authority', 'None']])}<div class="form-actions">${button('Open stop confirmation', 'open-stop', true)}${link('Operations', 'operations')}</div>`, 'Use the confirmation dialog to retain the operator reason.')}`;
  }
  async function loadCatalog(force = false) {
    if (E.loading) return E.loading;
    if (!force && !E.stale) return;
    E.loading = (async () => {
      try { E.catalog = await C.api('/api/evidence'); E.error = null; E.stale = false; }
      catch (error) { E.error = C.errorText(error); }
      finally { E.loading = null; }
    })();
    return E.loading;
  }
  async function hydrate() { if (S.connected && ['audit', 'reports'].includes(S.route)) await loadCatalog(); }
  function openStop(reason = '') {
    const dialog = C.$('#stop-dialog'); E.reason = reason;
    C.$('#stop-reason').value = reason; C.$('#stop-dialog-status').textContent = '';
    if (!dialog.open) dialog.showModal(); C.$('#stop-cancel').focus(); updateButtons();
  }
  async function confirmStop(el) {
    if (E.stopping || !S.connected) return;
    const reason = C.$('#stop-reason').value.trim() || E.reason || 'Operator confirmed emergency admission stop';
    E.stopping = true; el.disabled = true; C.$('#stop-dialog-status').textContent = 'Stopping new workspace admission…';
    try {
      const result = await C.api('/api/operations/stop', { reason });
      if (S.workspace) S.workspace.operations = result;
      C.$('#stop-dialog').close(); C.render(); C.toast('STOPPED · New workspace admissions are blocked. Existing exposure is not automatically closed.', 'operator');
      await C.refreshAfterMutation(); C.render();
    } catch (error) { C.$('#stop-dialog-status').textContent = C.errorText(error); C.notice(C.errorText(error), true); }
    finally { E.stopping = false; updateButtons(); }
  }
  function click(el) {
    const action = el.dataset.system;
    if (action === 'open-stop') { openStop(); return; }
    if (action === 'confirm-stop') { void confirmStop(el); return; }
    if (action === 'cancel-stop') { C.$('#stop-dialog').close(); return; }
    if (action === 'select-export') { E.exportId = el.dataset.id; E.exportFormat = 'json'; C.render(); C.$('#export-form')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); return; }
    void C.perform(el, action === 'connection-test' ? 'Running read-only connection test' : 'Loading system evidence', async () => {
      if (action === 'verify') { await loadCatalog(true); C.render(); }
      else if (action === 'inspect') C.evidence('Redacted evidence package', await C.api(`/api/evidence/${encodeURIComponent(el.dataset.id)}`));
      else if (action === 'connection-test') {
        const p = U.preferences(S.workspace);
        await C.api('/api/shadow/run', { coins: U.trackedCoins(S.workspace), strategy: 'ema-trend', mode: C.$('#connection-test-mode')?.value || 'DRY_RUN', equityInr: p.defaultEquityInr, maxOrderNotionalInr: p.defaultMaxOrderNotionalInr });
        await C.refreshAfterMutation(); C.render(); C.notice('Read-only connection evidence refreshed. Live execution remains locked.');
      } else if (action === 'recheck') {
        try { await C.refresh(); C.render(); C.notice('Dashboard connection checked. Review retained provider status before resuming paper admission.'); }
        catch (error) { C.connectionError(error); C.render(); C.notice(C.errorText(error), true); }
      }
    });
  }
  function submit(event) {
    const form = event.target;
    // Keep the native GET submission: Content-Disposition triggers the real file download.
    if (form.id === 'export-form') return true;
    if (form.id !== 'settings-form') return false;
    event.preventDefault();
    void C.perform(event.submitter, 'Saving local workspace preferences', async () => {
      const v = C.formValues(form), payload = { language: v.language, timezone: v.timezone, defaultCoin: v.defaultCoin,
        defaultEquityInr: Number(v.defaultEquityInr), defaultMaxOrderNotionalInr: Number(v.defaultMaxOrderNotionalInr), defaultSlPct: Number(v.defaultSlPct), defaultTpPct: Number(v.defaultTpPct),
        notifications: { researchCompletion: v.researchCompletion !== undefined, routineStatus: v.routineStatus !== undefined } };
      const saved = await C.api('/api/settings', payload);
      if (S.workspace) S.workspace.settings = saved;
      S.coin = saved.defaultCoin; await C.refreshAfterMutation(); C.render();
      C.toast(saved.language === 'ta' ? 'அமைப்புகள் சேமிக்கப்பட்டன · LIVE LOCKED' : 'Workspace settings saved. Live remains locked.', 'operator');
    });
    return true;
  }
  function change(el) {
    const name = el.dataset.systemChange; if (!name) return false;
    if (name === 'evidence-kind') { E.kind = el.value; C.render(); }
    else if (name === 'export-id') { E.exportId = el.value; C.render(); }
    else if (name === 'export-format') E.exportFormat = el.value;
    return true;
  }
  function input(el) {
    if (el.dataset.systemInput !== 'evidence-query') return false;
    E.query = el.value; C.$('#system-evidence-table').innerHTML = evidenceRows(); return true;
  }
  function updateButtons() {
    const confirm = C.$('#confirm-stop'); confirm.disabled = E.stopping || !S.connected;
    document.querySelectorAll('[data-system="connection-test"]').forEach(el => { el.disabled = S.busy || Boolean(S.workspace?.busy) || Boolean(S.workspace?.operations?.admissionStopped) || !S.connected; });
  }
  function init() {
    const dialog = C.$('#stop-dialog');
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    // Native <dialog> handles Escape, modal focus containment and focus restoration.
    window.openStop = openStop;
  }
  const views = { audit, connections, settings, 'live-review': liveReview, reports, empty: firstRun, 'connection-error': connectionError, 'stop-confirm': stopConfirm };
  return { E, views, init, hydrate, click, submit, change, input, openStop, updateButtons,
    invalidate: () => { E.stale = true; },
    afterRoute: () => { if (S.route === 'stop-confirm') openStop(); else if (C.$('#stop-dialog').open) C.$('#stop-dialog').close(); } };
};
