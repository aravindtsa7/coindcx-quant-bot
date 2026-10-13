'use strict';
// One durable admission around the EXISTING supervisor. Importing this file does nothing operational.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Separate attempt-2 record; the expired pending authorization is retained unchanged.
const authorizationRelativePath = 'operator/collection-authorization.attempt-2.json';
function durableNew(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
// Dependencies are supplied only by in-process offline tests; the CLI has no overrides or test flags.
async function runOnce(files, hooks) {
  if (!hooks.interactive) return { code: 3, outcome: 'INTERACTIVE_OPERATOR_CONSOLE_REQUIRED' };
  try {
    durableNew(files.claim, { kind: 'ONE_USE_COLLECTION_ADMISSION', attempt: 2,
      recordedAt: new Date().toISOString(), automaticRetry: false, reusableAfterFailure: false });
  } catch (error) {
    return { code: error.code === 'EEXIST' ? 4 : 3,
      outcome: error.code === 'EEXIST' ? 'COLLECTION_ATTEMPT_ALREADY_CONSUMED' : 'COLLECTION_ADMISSION_FAILED' };
  }
  hooks.emit({ outcome: 'COLLECTION_ATTEMPT_ADMITTED', attempt: 2, claim: files.claim });
  let stopped = false;
  const stop = () => { stopped = true; hooks.emit({ outcome: 'COLLECTION_STOP_REQUESTED' }); };
  hooks.signals.on('SIGINT', stop); hooks.signals.on('SIGTERM', stop);
  let result;
  try {
    await hooks.validate();
    if (stopped) result = { code: 130, outcome: 'COLLECTION_CANCELLED_BEFORE_SUPERVISOR', taskChildExited: true };
    else {
      hooks.emit({ outcome: 'COLLECTION_SUPERVISOR_ONCE', automaticRetry: false });
      const supervisor = await hooks.supervise({ onChild: () => { if (stopped) throw Error('OPERATOR_STOP'); } });
      durableNew(files.supervisor, supervisor);
      result = { code: stopped && supervisor.taskChildExited ? 130 : supervisor.code === 0 && supervisor.taskChildExited ? 0 : 1,
        outcome: supervisor.startupFailure ? 'SUPERVISOR_CHILD_STARTUP_FAILED' : supervisor.taskChildExited ? 'COLLECTION_SUPERVISOR_EXITED' : 'COLLECTION_CHILD_EXIT_UNRESOLVED',
        supervisorCode: supervisor.code, supervisorSignal: supervisor.signal, taskChildExited: supervisor.taskChildExited,
        childCreated: supervisor.childCreated, killed: supervisor.killed, ...(supervisor.spawnErrorCode ? { spawnErrorCode: supervisor.spawnErrorCode } : {}) };
    }
  } catch (error) {
    const safe = ['RECORDED_PROVIDER_AUTHORIZATION_REQUIRED', 'RECORDED_PROVIDER_AUTHORIZATION_MISMATCH_OR_EXPIRED',
      'COLLECTION_REVIEW_BINDING_MISMATCH', 'COLLECTION_NAMESPACE_NOT_UNTOUCHED', 'SUPERVISOR_CUSTODY_PREFLIGHT_FAILED'];
    result = { code: 3, outcome: safe.includes(error.message) ? error.message : 'COLLECTION_HANDOFF_REFUSED' };
  } finally {
    hooks.signals.removeListener('SIGINT', stop); hooks.signals.removeListener('SIGTERM', stop);
  }
  result = { ...result, attempt: 2, endedAt: new Date().toISOString(), automaticRetry: false, claimRetained: true };
  try { durableNew(files.exit, result); }
  catch { result = { ...result, code: 1, outcome: 'COLLECTION_EXIT_REPORT_FAILED' }; }
  hooks.emit(result);
  return result;
}
function validateHandoff(root) {
  const inputFile = path.join(root, 'operator/campaign-input.pending.json');
  const authorization = path.join(root, authorizationRelativePath);
  const { validateCampaignInvocation, requireRecordedAuthorization, campaignDigest } = require('./campaign-input.ts');
  const input = validateCampaignInvocation(read(inputFile), Date.now());
  requireRecordedAuthorization(input, read(authorization), Date.now()); // Before any credential loading or supervisor launch.
  const { validateCampaignHostInput } = require('./campaign-host.ts');
  const { openStateStore } = require('../../src/integration/coindcx/rate-limit/runtime/state-store.ts');
  const { campaignLaunchPlan } = require('./identity-supervisor.cjs');
  const inventory = read(path.join(root, 'runtime-inventory.json'));
  const reviewFile = path.join(root, 'operator/collection-attempt-2.review.json');
  const review = read(reviewFile);
  const cfg = validateCampaignHostInput(input.host);
  if (review.kind !== 'ONE_FURTHER_SUPERVISED_COLLECTION_REVIEW' || review.attempt !== 2
    || review.invocationSha256 !== campaignDigest(input) || review.namespace !== cfg.coordinator.stateDirectory
    || review.credentialSource !== 'protected-dpapi'
    || !inventory.files.some(entry => path.resolve(root, entry.path) === reviewFile && entry.sha256 === sha(fs.readFileSync(reviewFile)))
    || JSON.stringify(review.namespaceFiles.map(entry => entry.path).sort()) !== JSON.stringify([
      'CAMPAIGN.json', 'INSTALLATION.json', 'reports/REPORT_OWNER.json', 'state.slot-a', 'state.slot-b'])) throw Error('COLLECTION_REVIEW_BINDING_MISMATCH');
  campaignLaunchPlan(inputFile, input, inventory, { action: 'run-provider', authorization,
    keyFile: path.join(root, 'operator/ipc-keys.dpapi'), credentialSource: 'protected-dpapi' });
  for (const entry of review.namespaceFiles) {
    if (path.isAbsolute(entry.path) || entry.path.includes('..')
      || sha(fs.readFileSync(path.join(cfg.coordinator.stateDirectory, entry.path))) !== entry.sha256) throw Error('COLLECTION_NAMESPACE_NOT_UNTOUCHED');
  }
  const opened = openStateStore(cfg.coordinator.stateDirectory, cfg.coordinator.pipePath, cfg.coordinator.maxStateBytes);
  if (review.namespaceFiles.length !== 5 || opened.kind !== 'OPEN' || opened.recoveredFrom !== 'BOTH'
    || opened.record.journalSeq !== 0 || opened.record.scheduler !== null || opened.record.clients.length !== 0
    || fs.existsSync(path.join(cfg.coordinator.stateDirectory, 'OWNER.lock'))
    || fs.existsSync(path.join(cfg.reportDirectory, 'campaign-report.json'))
    || fs.existsSync(path.join(cfg.reportDirectory, 'shutdown.json'))) throw Error('COLLECTION_NAMESPACE_NOT_UNTOUCHED');
}
function production(root) {
  const inputFile = path.join(root, 'operator/campaign-input.pending.json');
  const authorization = path.join(root, authorizationRelativePath);
  const evidence = path.join(root, 'offline/interactive-collection-attempt-2');
  const files = { claim: path.join(root, 'operator/collection-attempt-2.claim.json'),
    supervisor: path.join(evidence, 'supervisor-result.json'), exit: path.join(evidence, 'collection-exit.json') };
  return runOnce(files, {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true && process.argv.length === 2,
    signals: process, emit: value => console.log(JSON.stringify(value)), validate: () => validateHandoff(root),
    supervise: options => require('./identity-supervisor.cjs').supervise(inputFile, { ...options, campaign: {
      action: 'run-provider', authorization, keyFile: path.join(root, 'operator/ipc-keys.dpapi'), credentialSource: 'protected-dpapi' } }),
  });
}
module.exports = { runOnce, durableNew, validateHandoff, authorizationRelativePath };
if (require.main === module) void production(path.resolve(__dirname, '../..'))
  .then(result => { process.exitCode = result.code; })
  .catch(() => { console.error('COLLECTION_HANDOFF_REFUSED'); process.exitCode = 1; });
