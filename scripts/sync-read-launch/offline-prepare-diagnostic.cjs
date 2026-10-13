'use strict';
// Diagnostic only: exactly one existing-supervisor prepare, synthetic input, no collection admission.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { durableNew } = require('./collection-once.cjs');
const safeError = error => ({ code: /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : null,
  message: /^[A-Z_0-9]+$/.test(error?.message ?? '') ? error.message : 'UNCLASSIFIED_DIAGNOSTIC_ERROR' });
function boundedOutput() {
  let text = '', bytes = 0;
  return { append(chunk) { bytes += Buffer.byteLength(chunk); text = (text + chunk.toString()).slice(0, 131072); },
    value() { return { text, bytes, truncated: bytes > 131072 }; } };
}
async function capturePrepare({ supervise, inputFile, nodePath, guard, output, transport = cp }) {
  const record = { kind: 'SYNTHETIC_OFFLINE_PREPARE_DIAGNOSTIC', startedAt: new Date().toISOString(),
    automaticRetry: false, action: 'prepare', spawnCalls: 0, preflight: null,
    child: { pid: null, spawnCallReturned: false, spawnThrew: false, spawnAcknowledged: false, exitObserved: false, closeObserved: false,
      exitCode: null, signal: null, error: null, heartbeatWrites: 0, stopWrites: 0, killCalls: [] },
    outerTimeout: false, supervisorTimeout: 'NOT_EXPOSED_BY_EXISTING_SUPERVISOR', result: null, error: null };
  const stdout = boundedOutput(), stderr = boundedOutput();
  const originalSpawn = transport.spawn, originalSync = transport.spawnSync;
  // CreateNew before invocation; a failed diagnostic is not silently rerun in the same destination.
  durableNew(path.join(output, 'diagnostic-start.json'), { kind: record.kind, startedAt: record.startedAt, inputFile });
  transport.spawnSync = function(...args) {
    record.preflight = { startedAt: new Date().toISOString(), status: null, signal: null, error: null };
    try {
      const value = originalSync.apply(this, args);
      Object.assign(record.preflight, { status: value.status, signal: value.signal, error: value.error ? safeError(value.error) : null,
        stdout: String(value.stdout ?? ''), stderr: String(value.stderr ?? ''), endedAt: new Date().toISOString() });
      return value;
    } catch (error) { record.preflight.error = safeError(error); throw error; }
  };
  transport.spawn = function(executable, args, options) {
    record.spawnCalls++;
    if (record.spawnCalls !== 1 || executable !== nodePath || !args.includes('prepare')
      || args.includes('run-provider') || args.includes('initialize-campaign')
      || JSON.stringify(options.stdio) !== JSON.stringify(['pipe', 'pipe', 'pipe'])
      || !args.some(value => value.endsWith('protected-module-guard.cjs'))) throw Error('DIAGNOSTIC_PREPARE_ONLY_REQUIRED');
    let child;
    try { child = originalSpawn.call(this, executable, ['--require', guard, ...args], options); }
    catch (error) { record.child.spawnThrew = true; record.child.error = safeError(error); throw error; }
    record.child.spawnCallReturned = true;
    record.child.pid = child.pid ?? null;
    child.once('spawn', () => { record.child.spawnAcknowledged = true; record.child.pid = child.pid ?? null; });
    child.once('error', error => { record.child.error = safeError(error); });
    child.once('exit', (code, signal) => { Object.assign(record.child, { exitObserved: true, exitCode: code, signal }); });
    child.once('close', (code, signal) => { Object.assign(record.child, { closeObserved: true, exitCode: code, signal }); });
    child.stdout.on('data', chunk => stdout.append(chunk)); child.stderr.on('data', chunk => stderr.append(chunk));
    for (const name of ['write', 'end']) {
      const original = child.stdin[name];
      child.stdin[name] = function(chunk, ...rest) {
        if (String(chunk) === 'HEARTBEAT\n') record.child.heartbeatWrites++;
        if (String(chunk) === 'STOP\n') record.child.stopWrites++;
        return original.call(this, chunk, ...rest);
      };
    }
    const kill = child.kill;
    child.kill = function(signal) { const accepted = kill.call(this, signal);
      record.child.killCalls.push({ signal: signal ?? 'SIGTERM', accepted }); return accepted; };
    return child;
  };
  try { record.result = await supervise(inputFile, { campaign: { action: 'prepare' } }); }
  catch (error) { record.error = safeError(error); }
  finally { transport.spawn = originalSpawn; transport.spawnSync = originalSync; }
  record.endedAt = new Date().toISOString();
  record.stdout = stdout.value(); record.stderr = stderr.value();
  record.cleanupStatus = record.child.closeObserved ? 'CHILD_CLOSE_CONFIRMED'
    : record.child.spawnThrew ? 'SPAWN_THROW_NO_CHILD_RETURNED'
    : record.child.pid ? 'CHILD_EXIT_UNRESOLVED' : record.spawnCalls ? 'NO_CHILD_PID_RECORDED' : 'NO_TASK_CHILD_SPAWN_CALLED';
  const valid = record.result?.events?.some(event => event.outcome === 'CAMPAIGN_CONFIGURATION_VALID'
    && event.maximumRequests === 39 && event.readyToContactProvider === false);
  record.passed = record.result?.code === 0 && record.result.taskChildExited === true
    && record.child.closeObserved && record.child.exitCode === 0 && valid;
  record.failureStage = record.passed ? null : record.preflight?.status !== 0 ? 'PREFLIGHT_OR_INVOCATION'
    : record.child.error ? 'CHILD_STARTUP' : record.child.exitCode !== 0 ? 'CHILD_EXECUTION' : 'SUPERVISOR_OR_REPORTING';
  // Persist ALL results before evaluating success. Unexpected failures are evidence, never replaced by a generic catch.
  durableNew(path.join(output, 'diagnostic-result.json'), record);
  return record;
}
async function main() {
  const root = path.resolve(__dirname, '../..'), [inputFile, output, guard, ...rest] = process.argv.slice(2);
  const inside = file => typeof file === 'string' && path.isAbsolute(file) && path.resolve(file).startsWith(root + path.sep);
  if (rest.length || ![inputFile, output, guard].every(inside)) throw Error('DIAGNOSTIC_PROTECTED_PATHS_REQUIRED');
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  if (!input.accountMapping?.accountId?.startsWith('OFFLINE-') || input.credentialProvenance?.sourceBinding
    || input.accountMapping.sourceReference !== 'SYNTHETIC_ONLY_NOT_ACCOUNT_EVIDENCE'
    || input.credentialProvenance.sourceReference !== 'SYNTHETIC_ONLY_NO_CREDENTIALS') throw Error('DIAGNOSTIC_SYNTHETIC_INPUT_REQUIRED');
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'runtime-inventory.json'), 'utf8'));
  const { createHash } = require('node:crypto');
  for (const file of [inputFile, guard, __filename]) {
    const entry = inventory.files.find(value => path.resolve(root, value.path) === path.resolve(file));
    if (!entry || entry.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw Error('DIAGNOSTIC_INVENTORY_BINDING_REQUIRED');
  }
  if (!output.startsWith(path.join(root, 'offline', 'prepare-diagnostic-') )
    || output.includes('interactive-collection-attempt-')) throw Error('DIAGNOSTIC_OUTPUT_DIRECTORY_REQUIRED');
  const { supervise } = require('./identity-supervisor.cjs');
  const result = await capturePrepare({ supervise, inputFile, output, guard, nodePath: inventory.node.path });
  console.log(JSON.stringify({ outcome: 'OFFLINE_PREPARE_DIAGNOSTIC_RECORDED', passed: result.passed,
    failureStage: result.failureStage, cleanupStatus: result.cleanupStatus }));
  process.exitCode = result.passed ? 0 : 1;
}
module.exports = { capturePrepare };
if (require.main === module) void main().catch(error => { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; });
