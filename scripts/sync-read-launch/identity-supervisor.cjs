'use strict';
// Task-owned supervisor. Absolute executable, minimal environment, bounded lifetime, piped HEARTBEAT/STOP.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
function campaignLaunchPlan(inputFile, input, inventory, campaign) {
  const inside = file => typeof file === 'string' && path.isAbsolute(file)
    && !path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root, file));
  const inventoried = file => inside(file) && inventory.files.some(entry => path.resolve(root, entry.path) === path.resolve(file));
  if (!['prepare', 'initialize-campaign', 'run-provider'].includes(campaign.action)
    || input.kind !== 'COINDCX_READ_ONLY_CAMPAIGN_INPUT' || input.target?.kind !== 'COINDCX_PROVIDER'
    || input.target.origin !== 'https://api.coindcx.com' || input.valuesStatus !== 'PROPOSED_NOT_APPROVED'
    || input.host?.networkAccess !== 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED'
    || !inventoried(inputFile) || !inside(input.host.coordinator.stateDirectory) || !inside(input.host.reportDirectory)
    || input.proposal?.configuration?.reportDestination?.path !== path.join(input.host.reportDirectory, 'campaign-report.json')) throw Error('CAMPAIGN_SUPERVISOR_INPUT_OR_CUSTODY_INVALID');
  const duration = input.proposal.configuration.campaign.durationMs;
  const readBound = input.proposal.configuration.thresholds.maxTotalReadDurationMs;
  const shutdown = input.host.supervision.shutdownWaitMs;
  if (![duration, readBound, shutdown].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(duration + readBound + shutdown)) throw Error('CAMPAIGN_SUPERVISOR_DEADLINE_INVALID');
  if (campaign.action === 'prepare') {
    if (campaign.authorization || campaign.keyFile || campaign.credentialSource) throw Error('PREPARE_HAS_NO_AUTHORIZATION_OR_KEYS');
    return { entry: path.join(root, 'scripts/coindcx-sync-read-bootstrap.ts'), args: ['prepare', '--input', inputFile], deadlineMs: 120000 };
  }
  if (!inventoried(campaign.authorization) || !inventoried(campaign.keyFile)) throw Error('CAMPAIGN_AUTHORIZATION_AND_KEY_CUSTODY_REQUIRED');
  if (!['authorized-env-file', 'protected-dpapi'].includes(campaign.credentialSource)) throw Error('EXPLICIT_CREDENTIAL_SOURCE_REQUIRED');
  const binding = input.credentialProvenance?.sourceBinding;
  if (campaign.credentialSource === 'protected-dpapi' ? !binding || binding.kind !== 'protected-dpapi'
    || path.resolve(binding.path) !== path.join(root, 'operator-credentials/coindcx-api.dpapi')
    || !inventory.files.some(entry => path.resolve(root, entry.path) === path.resolve(binding.path) && entry.sha256 === binding.ciphertextSha256)
    : binding !== undefined) throw Error('CREDENTIAL_SOURCE_INVOCATION_BINDING_REQUIRED');
  return { entry: path.join(root, 'scripts/coindcx-sync-read-operator.ts'), args: [campaign.action, '--ipc-key-file', campaign.keyFile,
    '--credential-source', campaign.credentialSource,
    '--input', inputFile, '--authorization', campaign.authorization,
    ...(campaign.action === 'initialize-campaign' ? ['--confirm', 'NEW_READ_ONLY_CAMPAIGN'] : [])], deadlineMs: duration + readBound + shutdown };
}
function cleanEnvironment() {
  return { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), NODE_ENV: 'production', TSX_DISABLE_CACHE: '1',
    TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'), ESBUILD_BINARY_PATH: path.join(root, 'node_modules/@esbuild/win32-x64/esbuild.exe'),
    PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' };
}
async function supervise(inputFile, options = {}) {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'runtime-inventory.json'))), input = JSON.parse(fs.readFileSync(inputFile));
  const campaign = options.campaign;
  const plan = campaign ? campaignLaunchPlan(inputFile, input, inventory, campaign)
    : { entry: path.join(__dirname, 'identity-diagnostic-entry.ts'), args: ['--input', inputFile], deadlineMs: 120000 };
  const custodyCommand = `& { ${fs.readFileSync(path.join(__dirname, 'identity-custody.ps1'), 'utf8')} } -RuntimeRoot '${root.replaceAll("'", "''")}'`;
  const preflight = cp.spawnSync(inventory.powershell.path, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(custodyCommand, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, cwd: root, env: cleanEnvironment(), timeout: 120000 });
  if (preflight.status !== 0) throw Error('SUPERVISOR_CUSTODY_PREFLIGHT_FAILED');
  const custody = JSON.parse(preflight.stdout);
  return superviseChild(() => cp.spawn(inventory.node.path, ['--require', path.join(__dirname, campaign ? 'protected-module-guard.cjs' : 'identity-request-guard.cjs'), '--import', pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href,
    plan.entry, ...plan.args], { cwd: root, env: cleanEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), input.host.supervision, plan.deadlineMs, options, custody);
}
// Same lifecycle used by production and synthetic tests. No alternate launcher or automatic retry.
async function superviseChild(spawnChild, supervision, deadlineMs, options = {}, custody = undefined) {
  let child;
  try { child = spawnChild(); }
  catch (error) {
    return { custody, code: 1, signal: null, startupFailure: true, outcome: 'SUPERVISOR_CHILD_STARTUP_FAILED',
      spawnErrorCode: ['EPERM', 'EACCES', 'ENOENT'].includes(error.code) ? error.code : 'SPAWN_FAILED',
      taskChildExited: true, childCreated: false, killed: false, stderrBytes: 0, events: [] };
  }
  const events = []; let pending = '', stderrBytes = 0, killed = false;
  let timer, stopTimer, deadline, killTimer, settleTimer, startupTimer, started = false, startupFailure = false, spawnErrorCode;
  let settled = false;
  const heartbeat = () => { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write('HEARTBEAT\n'); };
  const stop = () => {
    clearInterval(timer);
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('STOP\n');
    if (!killTimer) killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) { killed = child.kill(); }
      settleTimer = setTimeout(() => finish({ code: 1, signal: null, taskChildExited: false }), supervision.shutdownWaitMs);
    }, supervision.shutdownWaitMs);
  };
  let finish;
  const outcome = new Promise(resolve => {
    finish = result => { if (!settled) { settled = true; resolve(result); } };
    child.once('error', error => {
      startupFailure = !started;
      spawnErrorCode = ['EPERM', 'EACCES', 'ENOENT'].includes(error.code) ? error.code : 'SPAWN_FAILED';
      if (!child.pid) finish({ code: 1, signal: null, taskChildExited: true });
      else stop();
    });
    child.once('close', (code, signal) => finish({ code: startupFailure ? 1 : code, signal, taskChildExited: true }));
    child.once('spawn', () => {
      started = true; clearTimeout(startupTimer);
      try { options.onChild?.(child); }
      catch { startupFailure = true; stop(); return; }
      heartbeat(); timer = setInterval(heartbeat, supervision.heartbeatIntervalMs);
      if (options.stopAfterMs !== undefined) stopTimer = setTimeout(stop, options.stopAfterMs);
      if (options.loseSupervisorAfterMs !== undefined) stopTimer = setTimeout(() => { clearInterval(timer); child.stdin.end(); }, options.loseSupervisorAfterMs);
    });
  });
  child.stdout.on('data', chunk => { pending += chunk.toString(); const rows = pending.split(/\r?\n/); pending = rows.pop();
    for (const row of rows) { try { const event = JSON.parse(row); if (['IDENTITY_DIAGNOSTIC_RESULT', 'IDENTITY_DIAGNOSTIC_SHUTDOWN', 'READ_ONLY_CAMPAIGN_SHUTDOWN'].includes(event.kind)
      || ['CAMPAIGN_CONFIGURATION_VALID', 'CAMPAIGN_NAMESPACE_INITIALIZED', 'SUPERVISED_CAMPAIGN_READY', 'READ_ONLY_COLLECTION_ENDED', 'CAMPAIGN_PHYSICAL_REQUEST_ATTEMPT'].includes(event.outcome)) events.push(event); } catch { /* Never forward unexpected/raw output. */ } } });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; }); child.stdin.on('error', () => {});
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  startupTimer = setTimeout(() => { startupFailure = true; stop(); }, supervision.shutdownWaitMs);
  deadline = setTimeout(stop, deadlineMs);
  try {
    const result = await outcome;
    return { custody, ...result, code: startupFailure || spawnErrorCode ? 1 : result.code, startupFailure, ...(startupFailure ? { outcome: 'SUPERVISOR_CHILD_STARTUP_FAILED', spawnErrorCode } : {}),
      childCreated: Boolean(child.pid), killed, stderrBytes, events };
  } finally {
    clearInterval(timer);
    for (const timeout of [startupTimer, deadline, stopTimer, killTimer, settleTimer]) clearTimeout(timeout);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (!child.pid) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  }
}
module.exports = { supervise, superviseChild, cleanEnvironment, campaignLaunchPlan };
if (require.main === module) {
  const args = process.argv.slice(2);
  let inputFile, options = {};
  if (args[0] === '--campaign') {
    const fields = new Map();
    for (let i = 2; i < args.length; i += 2) {
      if (!['--input', '--authorization', '--ipc-key-file', '--credential-source'].includes(args[i]) || fields.has(args[i])
        || (args[i] === '--credential-source' ? !['authorized-env-file', 'protected-dpapi'].includes(args[i + 1]) : !path.isAbsolute(args[i + 1] ?? ''))) throw Error('SUPERVISOR_EXPLICIT_INPUT_REQUIRED');
      fields.set(args[i], args[i + 1]);
    }
    inputFile = fields.get('--input');
    options.campaign = { action: args[1], authorization: fields.get('--authorization'), keyFile: fields.get('--ipc-key-file'), credentialSource: fields.get('--credential-source') };
    if (!inputFile) throw Error('SUPERVISOR_EXPLICIT_INPUT_REQUIRED');
  } else {
    if (args.length !== 2 || args[0] !== '--input' || !path.isAbsolute(args[1])) throw Error('SUPERVISOR_EXPLICIT_INPUT_REQUIRED');
    inputFile = args[1];
  }
  void supervise(inputFile, options).then(result => { console.log(JSON.stringify(result)); process.exitCode = result.code === 0 ? 0 : 1; })
    .catch(() => { console.error('PROTECTED_IDENTITY_SUPERVISOR_REFUSED'); process.exitCode = 1; });
}
