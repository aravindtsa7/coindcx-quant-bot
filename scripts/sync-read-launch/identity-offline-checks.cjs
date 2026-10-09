'use strict';
// Standalone synthetic checks, executed only inside the protected snapshot. Never loads operational credentials.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), hash = x => crypto.createHash('sha256').update(x).digest('hex');
async function checks() {
  if (fs.existsSync(path.join(root, 'offline-checks-passed.json'))) throw Error('OFFLINE_CHECKS_ALREADY_RECORDED');
  const guard = require('./identity-request-guard.cjs'), before = guard.inspect();
  const stream = fs.createReadStream; let credentialReads = 0;
  fs.createReadStream = function (file, ...args) { if (String(file).endsWith('.env')) { credentialReads++; throw Error('TEST_OPERATIONAL_CREDENTIAL_READ_FORBIDDEN'); } return stream.call(this, file, ...args); };
  const { identityEntry, validateIdentityInput } = require('./identity-diagnostic-entry.ts');
  const { CoinDcxClient } = require('../../src/integration/coindcx/client.ts');
  const { supervise } = require('./identity-supervisor.cjs');
  assert.deepEqual(guard.inspect(), before); assert.equal(credentialReads, 0);
  assert.throws(() => require('C:/TSA/coindcx-m2-w1/scripts/sync-read-launch/campaign-host.ts'), /UNPROTECTED_MODULE_RESOLUTION/);
  const realInputFile = path.join(root, 'operator/identity-input.json'), real = JSON.parse(fs.readFileSync(realInputFile));
  assert.throws(() => validateIdentityInput({ ...real, maximumPhysicalRequests: 2 }, root), /IDENTITY_INPUT_INVALID/);
  await assert.rejects(identityEntry(['--input', realInputFile])); // Missing completed offline checks refuses before any key/credential load or initialization.
  assert.equal(fs.existsSync(real.host.coordinator.stateDirectory), false); assert.equal(credentialReads, 0);
  let acquired = 0;
  const readOnly = new CoinDcxClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'OFFLINE-KEY', apiSecret: 'OFFLINE-SECRET', allowedReadEndpoints: ['USER_INFO'],
    readBudget: { scope: 'API_AUTH', budget: { acquire: async () => { acquired++; return { kind: 'REFUSED', reason: 'OFFLINE' }; } } } });
  await assert.rejects(readOnly.listInrFuturesOrders({ side: 'buy', status: 'open', page: '1', size: '25' }), /READ_ENDPOINT_NOT_ALLOWED/);
  await assert.rejects(readOnly.listInrFuturesPositions({ page: '1', size: '25' }), /READ_ENDPOINT_NOT_ALLOWED/);
  assert.equal(acquired, 0); assert.equal(typeof readOnly.createOrder, 'undefined');
  const results = [{ name: 'import-preflight-deferred-credentials-and-closed-identity-capability', exit: 0, credentialReads: 0, providerRequests: 0 }];
  const identifier = 'OFFLINE-IDENTITY-ONLY-ACCOUNT';
  for (const name of ['match', 'mismatch', '429', 'timeout', 'stop-before-read', 'supervisor-loss', 'stop-active', 'report-no-overwrite']) {
    const parent = path.join(root, 'offline', name); fs.mkdirSync(parent);
    const campaignId = `readonly-campaign-OFFLINE-${name}`, installationId = `t${crypto.randomBytes(16).toString('hex')}`, stateDirectory = path.join(parent, campaignId), pipePath = `\\\\.\\pipe\\coindcx-readonly-campaign-${installationId}`;
    let hits = 0, child;
    const server = http.createServer((req, res) => {
      assert.equal(req.url, '/exchange/v1/users/info'); assert.equal(req.method, 'POST'); hits++;
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        assert.equal(typeof JSON.parse(body).timestamp, 'number');
        if (name === 'stop-active') child.stdin.end('STOP\n');
        if (name === 'report-no-overwrite') fs.writeFileSync(path.join(stateDirectory, 'reports/identity.json'), 'OFFLINE-DO-NOT-OVERWRITE', { flag: 'wx' });
        const answer = () => { res.writeHead(name === '429' ? 429 : 200, { 'content-type': 'application/json', ...(name === '429' ? { 'retry-after': '60' } : {}) }); res.end(JSON.stringify({ coindcx_id: identifier })); };
        if (name === 'timeout' || name === 'stop-active') setTimeout(answer, 1500); else answer();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const input = { ...real, target: 'LOOPBACK_FIXTURE', origin, authorization: null, ipcCiphertext: '', journal: path.join(parent, 'http-attempt.json'),
      transportTimeoutMs: name === 'timeout' ? 250 : 10000,
      historical: { expectedFingerprint: hash(name === 'mismatch' ? 'OFFLINE-DIFFERENT' : identifier), observedAt: '2026-09-24T13:11:41.439Z', source: 'SYNTHETIC_LOOPBACK_REFERENCE' },
      offlineInputs: { apiKey: 'OFFLINE-KEY', apiSecret: 'OFFLINE-SECRET', read: crypto.randomBytes(32).toString('hex'), operatorStop: crypto.randomBytes(32).toString('hex') },
      host: { ...real.host, networkAccess: 'LOOPBACK_ONLY', campaignId, installationId, reportDirectory: path.join(stateDirectory, 'reports'),
        coordinator: { ...real.host.coordinator, stateDirectory, pipePath }, client: { ...real.host.client, pipePath } } };
    const file = path.join(parent, 'input.json'); fs.writeFileSync(file, JSON.stringify(input));
    try {
      const options = { onChild: instance => { child = instance; }, ...(name === 'stop-before-read' ? { stopAfterMs: 10 } : {}), ...(name === 'supervisor-loss' ? { loseSupervisorAfterMs: 10 } : {}) };
      const outcome = await supervise(file, options), result = outcome.events.find(x => x.kind === 'IDENTITY_DIAGNOSTIC_RESULT'), shutdown = outcome.events.find(x => x.kind === 'IDENTITY_DIAGNOSTIC_SHUTDOWN');
      if (['match', 'mismatch'].includes(name)) { assert.equal(outcome.code, 0, JSON.stringify(outcome)); assert.equal(result.comparison, name === 'match' ? 'MATCH' : 'MISMATCH'); }
      else assert.equal(outcome.code, 1, JSON.stringify(outcome));
      const expected = ['stop-before-read', 'supervisor-loss'].includes(name) ? 0 : 1;
      assert.equal(hits, expected, JSON.stringify(outcome));
      assert.equal(fs.existsSync(input.journal) ? JSON.parse(fs.readFileSync(input.journal)).attempts : 0, expected);
      if (name === 'stop-active') { assert.equal(result.comparison, 'NOT_OBSERVED'); assert.equal(result.failure, 'LATE_RESULT_DISCARDED'); }
      if (name === 'report-no-overwrite') assert.equal(fs.readFileSync(path.join(stateDirectory, 'reports/identity.json'), 'utf8'), 'OFFLINE-DO-NOT-OVERWRITE');
      assert.ok(shutdown, JSON.stringify(outcome)); assert.equal(shutdown.capacityRefunded, false); assert.equal(shutdown.unknownRecoveryAttempted, false);
      assert.equal(shutdown.delivery, 'WRITTEN'); assert.equal(shutdown.stopAcknowledged, true); assert.equal(shutdown.unresolved.length, 0);
      assert.equal(fs.existsSync(path.join(stateDirectory, 'OWNER.lock')), false);
      if (result) assert.ok(Object.values(result.grants).every(value => value === false));
      results.push({ name, exit: 0, expectedChildExit: outcome.code, actualLoopbackRequests: hits, comparison: result?.comparison ?? 'NOT_OBSERVED', stderrBytes: outcome.stderrBytes, shutdown });
      console.log(JSON.stringify({ offlineCase: name, passed: true, loopbackRequests: hits }));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  // Exercise the physical boundary's single-use ceiling in a separate synthetic process.
  const server = http.createServer((req, res) => { req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { cleanEnvironment } = require('./identity-supervisor.cjs'), origin = `http://127.0.0.1:${server.address().port}`, journal = path.join(root, 'offline/guard-journal.json');
    const child = cp.spawn(process.execPath, ['--require', path.join(__dirname, 'identity-request-guard.cjs'), __filename, '--guard-check', origin, journal], { env: cleanEnvironment(), cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', x => { stderr += x; });
    assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0, stderr);
    results.push({ name: 'creation-boundary-rejects-other-endpoints-and-second-attempt', exit: 0, actualLoopbackRequests: 1 });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(credentialReads, 0); assert.equal(guard.inspect().physicalRequestCreationAttempts, 0);
  const modulePaths = Object.keys(require.cache).map(file => fs.realpathSync(file));
  assert.ok(modulePaths.every(file => !path.relative(root, file).startsWith('..')));
  const result = { passed: true, checksExitCode: 0, inventorySha256: hash(fs.readFileSync(path.join(root, 'runtime-inventory.json'))), providerRequests: 0, realCredentialReads: 0,
    actualResolvedTsx: require.resolve('tsx'), modulePaths, cases: results, completedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, 'offline-checks-passed.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ offlineChecks: results.length, exit: 0, providerRequests: 0, realCredentialReads: 0 }));
}
async function guardCheck() {
  const guard = require('./identity-request-guard.cjs'), origin = process.argv[3], journal = process.argv[4];
  assert.throws(() => http.request(new URL(`${origin}/exchange/v1/users/info`), { method: 'POST' }), /NOT_ARMED/);
  guard.arm(origin, journal);
  for (const endpoint of ['/exchange/v1/derivatives/futures/orders', '/exchange/v1/derivatives/futures/positions', '/exchange/v1/users/info?probe=1']) assert.throws(() => http.request(new URL(origin + endpoint), { method: 'POST' }), /ENDPOINT_NOT_ALLOWED/);
  await new Promise((resolve, reject) => { const req = http.request(new URL(`${origin}/exchange/v1/users/info`), { method: 'POST' }, res => { res.resume(); res.on('end', resolve); }); req.on('error', reject); req.end('{}'); });
  assert.throws(() => http.request(new URL(`${origin}/exchange/v1/users/info`), { method: 'POST' }), /ONE_PHYSICAL_REQUEST_CEILING/);
  assert.equal(guard.inspect().physicalRequestCreationAttempts, 1);
}
if (require.main === module) void (process.argv[2] === '--guard-check' ? guardCheck() : checks()).catch(error => {
  // Offline-only diagnostics; all inputs and response identifiers in this program are synthetic.
  console.error(error); process.exitCode = 1;
});
