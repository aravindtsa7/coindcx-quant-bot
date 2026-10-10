'use strict';
// Explicit offline preparation checks. No credentials, state initialization or physical HTTP is permitted.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
let credentialReads = 0, physicalAttempts = 0;
const originalRead = fs.readFileSync, originalStream = fs.createReadStream;
function rejectCredentials(file) { if (typeof file === 'string' && (file.endsWith('.env') || /operator-credentials[\\/]coindcx-api\.dpapi$/i.test(file))) { credentialReads++; throw Error('OFFLINE_CREDENTIAL_READ_FORBIDDEN'); } }
fs.readFileSync = function (file, ...rest) { rejectCredentials(file); return originalRead.call(this, file, ...rest); };
fs.createReadStream = function (file, ...rest) { rejectCredentials(file); return originalStream.call(this, file, ...rest); };
for (const protocol of ['node:http', 'node:https']) {
  const transport = require(protocol);
  transport.request = transport.get = () => { physicalAttempts++; throw Error('OFFLINE_PHYSICAL_HTTP_FORBIDDEN'); };
}
globalThis.fetch = () => { physicalAttempts++; throw Error('OFFLINE_FETCH_FORBIDDEN'); };
async function checks() {
  const { campaignEntry } = require('./campaign-entry.ts');
  const { campaignLaunchPlan, supervise, cleanEnvironment } = require('./identity-supervisor.cjs');
  const { validateCampaignInvocation, requireRecordedAuthorization, campaignDigest, campaignParameters, SHARED_USE_PARAMETERS_SHA256 } = require('./campaign-input.ts');
  const { inspectLaunchProposal } = require('./proposal.ts');
  const { CoinDcxClient } = require('../../src/integration/coindcx/client.ts');
  const inputFile = path.join(root, 'operator/campaign-input.pending.json');
  const input = JSON.parse(fs.readFileSync(inputFile)), inventory = JSON.parse(fs.readFileSync(path.join(root, 'runtime-inventory.json')));
  const state = input.host.coordinator.stateDirectory;
  assert.equal(fs.existsSync(state), false);
  assert.equal(input.accountMapping.independentlyEstablished, true);
  assert.equal(input.accountMapping.verifiedAt, '2026-10-09T09:06:07.287Z');
  assert.notEqual(input.credentialProvenance.establishedAt, '2026-10-09T00:00:00Z');
  assert.ok(input.credentialProvenance.sourceReference.includes('exact time unknown'));
  assert.deepEqual(input.host.coordinator.limiter, input.proposal.configuration.budget.limiter);
  const policy = input.host.coordinator.limiter.retryAfter;
  assert.equal(policy.providerStatedBlockMs, 10000);
  assert.equal(policy.noHeaderDefaultMs, 60000); assert.equal(policy.localBackoffBaseMs, 60000);
  const { serverWaitBound, fullRetainedWaitMs } = require('../../src/integration/coindcx/rate-limit/retry-after.ts');
  for (const retryAfter of [undefined, '10', '120', 'invalid']) {
    const context = { retryAfter, serverDate: undefined, receiptWallMs: null, localClockTrusted: false };
    const bound = serverWaitBound(context, policy);
    assert.equal(fullRetainedWaitMs(bound, 0, policy), retryAfter === 'invalid' ? Infinity : retryAfter === '120' ? 120000 : 60000);
  }
  assert.equal(campaignDigest(campaignParameters(input.proposal)), SHARED_USE_PARAMETERS_SHA256);
  assert.equal(inspectLaunchProposal(input.proposal).requestBounds.maximumRequests, 39);
  assert.equal(validateCampaignInvocation(input, Date.now()).accountMapping.independentlyEstablished, true);
  const missingMapping = structuredClone(input); missingMapping.accountMapping.independentlyEstablished = null;
  assert.throws(() => validateCampaignInvocation(missingMapping, Date.now()), /CAMPAIGN_INPUT_INVALID/);
  let environmentLookups = 0;
  const forbiddenEnvironment = () => { environmentLookups++; throw Error('OFFLINE_ENVIRONMENT_FORBIDDEN'); };
  assert.equal(await campaignEntry(['prepare', '--input', inputFile], forbiddenEnvironment), 0);
  await assert.rejects(campaignEntry(['run-provider', '--input', inputFile], forbiddenEnvironment), /ABSOLUTE_CAMPAIGN_JSON_INPUT_REQUIRED/);
  assert.throws(() => requireRecordedAuthorization(input, {}, Date.now()), /RECORDED_PROVIDER_AUTHORIZATION_REQUIRED/);
  // A separately identified, in-memory synthetic mapping verifies parameter shape, never real mapping readiness.
  const synthetic = structuredClone(input);
  synthetic.accountMapping.independentlyEstablished = true;
  synthetic.accountMapping.sourceReference = 'SYNTHETIC_OFFLINE_SHAPE_ONLY_NOT_OPERATOR_ATTESTATION';
  assert.equal(validateCampaignInvocation(synthetic, Date.now()).proposal.valuesStatus, 'PROPOSED_NOT_APPROVED');
  const plan = campaignLaunchPlan(inputFile, input, inventory, { action: 'prepare' });
  assert.deepEqual(plan.args, ['prepare', '--input', inputFile]);
  assert.throws(() => campaignLaunchPlan(inputFile, input, inventory, { action: 'run-provider', authorization: path.join(root, 'operator/collection-authorization.pending.json'), keyFile: path.join(root, 'operator/ipc-keys.dpapi') }), /AUTHORIZATION_AND_KEY_CUSTODY_REQUIRED/);
  assert.throws(() => campaignLaunchPlan('C:\\TSA\\unprotected.json', input, inventory, { action: 'prepare' }), /CUSTODY_INVALID/);
  const escaped = structuredClone(input); escaped.host.reportDirectory = 'C:\\TSA\\reports';
  assert.throws(() => campaignLaunchPlan(inputFile, escaped, inventory, { action: 'prepare' }), /CUSTODY_INVALID/);
  // Plan calculation with a non-existent, in-memory inventory entry proves deadline/arguments only, not authorization.
  const pendingAuth = path.join(root, 'operator/collection-authorization.pending.json');
  const hypotheticalInventory = { ...inventory, files: [...inventory.files, { path: 'operator/collection-authorization.pending.json' }] };
  for (const action of ['initialize-campaign', 'run-provider']) {
    const future = campaignLaunchPlan(inputFile, input, hypotheticalInventory, { action, authorization: pendingAuth, keyFile: path.join(root, 'operator/ipc-keys.dpapi'), credentialSource: 'protected-dpapi' });
    assert.equal(future.deadlineMs, 1055000);
    assert.equal(future.args.includes('--confirm'), action === 'initialize-campaign');
    assert.equal(path.basename(future.entry), 'coindcx-sync-read-operator.ts');
  }
  const env = cleanEnvironment();
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'COINDCX_API_KEY', 'COINDCX_API_SECRET', 'COINDCX_CAMPAIGN_API_KEY', 'COINDCX_CAMPAIGN_API_SECRET']) assert.equal(env[name], undefined);
  assert.ok(env.ESBUILD_BINARY_PATH.startsWith(root));
  // Instrument children too; no provider/credential fallback can hide behind the real supervisor path.
  const spawn = cp.spawn;
  cp.spawn = function (executable, args, options) { return spawn.call(this, executable, ['--require', __filename, ...args], options); };
  let outcome;
  try { outcome = await supervise(inputFile, { campaign: { action: 'prepare' } }); }
  finally { cp.spawn = spawn; }
  assert.equal(outcome.code, 0); // Input validity is independent of credential custody and provider authorization.
  assert.equal(outcome.taskChildExited, true); assert.equal(outcome.killed, false); assert.equal(outcome.events.length, 1);
  assert.equal(outcome.events[0].outcome, 'CAMPAIGN_CONFIGURATION_VALID');
  assert.equal(outcome.custody.fileIntegrity, true);
  assert.equal(fs.existsSync(state), false); assert.equal(fs.existsSync(pendingAuth), false);
  // Synthetic boundary calls only: no provider identity, credentials or transport.
  const { campaignReadBoundary } = require('./campaign-read-boundary.ts');
  const { providerAccountFingerprint } = require('../../src/execution/live/reconciliation/account-identity.ts');
  const boundedProposal = structuredClone(input.proposal);
  boundedProposal.configuration.account.expectedProviderAccountFingerprint = providerAccountFingerprint('OFFLINE-ACCOUNT');
  const callCounts = { USER_INFO: 0, FUTURES_ORDERS: 0, FUTURES_POSITIONS: 0 };
  const reads = { getUserInfoSafe: async () => { callCounts.USER_INFO++; return { coindcxId: 'OFFLINE-ACCOUNT' }; },
    listInrFuturesOrders: async () => { callCounts.FUTURES_ORDERS++; return []; },
    listInrFuturesPositions: async () => { callCounts.FUTURES_POSITIONS++; return []; } };
  const order = { side: 'buy', status: input.proposal.configuration.scope.orderStatuses.join(','), page: '1', size: '25' };
  let errorStops = 0;
  const boundary = campaignReadBoundary(reads, boundedProposal, () => errorStops++);
  await assert.rejects(async () => boundary.client.listInrFuturesOrders(order), /READ_GATE_CLOSED/);
  for (let evaluation = 0; evaluation < 3; evaluation++) {
    await boundary.client.getUserInfoSafe();
    for (let pass = 0; pass < 2; pass++) {
      for (const side of ['buy', 'sell']) for (const page of ['1', '2']) await boundary.client.listInrFuturesOrders({ ...order, side, page });
      for (const page of ['1', '2']) await boundary.client.listInrFuturesPositions({ page, size: '25' });
    }
  }
  assert.deepEqual(callCounts, { USER_INFO: 3, FUTURES_ORDERS: 24, FUTURES_POSITIONS: 12 });
  assert.equal(boundary.inspect().started, 39);
  await assert.rejects(async () => boundary.client.getUserInfoSafe(), /READ_GATE_CLOSED/);
  assert.equal(boundary.inspect().started, 39); assert.equal(errorStops, 0);
  let failedReads = 0;
  const failed = campaignReadBoundary({ ...reads, getUserInfoSafe: async () => { failedReads++; throw Error('OFFLINE-FIRST-ERROR'); } }, boundedProposal, () => errorStops++);
  await assert.rejects(failed.client.getUserInfoSafe(), /OFFLINE-FIRST-ERROR/);
  await assert.rejects(async () => failed.client.getUserInfoSafe(), /READ_GATE_CLOSED/);
  assert.equal(failedReads, 1); assert.equal(errorStops, 1);
  const mismatch = campaignReadBoundary({ ...reads, getUserInfoSafe: async () => ({ coindcxId: 'OFFLINE-MISMATCH' }) }, boundedProposal, () => errorStops++);
  await mismatch.client.getUserInfoSafe();
  await assert.rejects(async () => mismatch.client.listInrFuturesOrders(order), /READ_GATE_CLOSED/);
  assert.throws(() => boundary.client.listInrFuturesOrders({ ...order, status: 'open' }), /ORDER_FILTER_NOT_ALLOWED/);
  assert.throws(() => boundary.client.listInrFuturesPositions({ page: '3', size: '25' }), /PAGE_NOT_ALLOWED/);
  let acquisitions = 0;
  const client = new CoinDcxClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'OFFLINE-KEY', apiSecret: 'OFFLINE-SECRET',
    allowedReadEndpoints: ['USER_INFO', 'FUTURES_ORDERS', 'FUTURES_POSITIONS'],
    readBudget: { scope: 'API_AUTH', budget: { acquire: async () => { acquisitions++; return { kind: 'REFUSED', reason: 'OFFLINE' }; } } } });
  await assert.rejects(client.getUserInfoSafe());
  assert.equal(acquisitions, 1); assert.equal(typeof client.createOrder, 'undefined');
  assert.equal(physicalAttempts, 0); assert.equal(credentialReads, 0); assert.equal(environmentLookups, 0);
  assert.throws(() => require('C:/TSA/coindcx-m2-w1/scripts/sync-read-launch/campaign-host.ts'), /UNPROTECTED_MODULE_RESOLUTION/);
  const modulePaths = Object.keys(require.cache).map(file => fs.realpathSync(file));
  assert.ok(modulePaths.every(file => !path.relative(root, file).startsWith('..')));
  const result = { kind: 'OFFLINE_COLLECTION_PREPARATION_CHECKS', exit: 0, checkedAt: new Date().toISOString(), physicalHttpAttempts: 0,
    credentialReads: 0, environmentLookups: 0, proposalMaximumRequests: 39, realInputStatus: 'CONFIGURATION_VALID_CREDENTIAL_CUSTODY_SEPARATE',
    syntheticShapeValid: true, syntheticShapeIsRealReadinessEvidence: false, plannedNamespaceExists: false, authorizationCreated: false,
    supervisedPrepareExpectedExit: outcome.code, custody: outcome.custody, actualResolvedTsx: require.resolve('tsx'), modulePaths,
    checks: ['import-without-network-or-credentials', 'real-prepare-valid-run-refuses-missing-authorization-before-environment', '39-request-validation-and-missing-mapping-refusal', '10000-provider-block-60000-client-waits-retry-after-preserved',
      'protected-paths-and-inventoried-authorization-required', 'campaign-deadline-and-deliberate-initialization-arguments', 'minimal-environment',
      'actual-supervised-prepare-valid-no-network-or-credentials', 'budget-refusal-before-http-no-mutation', 'protected-module-resolution', 'synthetic-3-24-12-boundary-ceiling-no-fortieth-call', 'identity-gate-first-error-no-fallback-combined-filter-pagination'] };
  fs.writeFileSync(path.join(root, `collection-preparation-checks-${Date.now()}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ exit: 0, checks: result.checks.length, physicalHttpAttempts: 0, credentialReads: 0, realCampaignStatus: 'CONFIGURATION_VALID_CREDENTIAL_CUSTODY_SEPARATE' }));
}
if (require.main === module) void checks().catch(error => { console.error(error); process.exitCode = 1; });
