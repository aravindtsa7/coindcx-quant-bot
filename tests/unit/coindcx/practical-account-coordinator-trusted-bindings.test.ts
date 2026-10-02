import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Genuine application owners and genuine credential-source construction.
// Native HTTPS/stock Socket.IO are isolated dependency doubles: no provider access.
// Application-owned bindings/graphs/values alone are attacked after initialization.
const OWNER_LIST = [
  [
    "execution/live/reconciliation/account-identity",
    [
      "isProviderAccountFingerprint",
      "verifyProviderAccountIdentity",
      "accountIdentityFinding",
      "accountIdentityGateSnapshotSha256",
      "requireExpectedProviderAccountFingerprint",
      "providerAccountFingerprint",
      "LIVE_PROVIDER_ACCOUNT_FINGERPRINT_PATTERN"
    ]
  ],
  [
    "execution/live/practical-recovery/observation",
    [
      "PRACTICAL_PASS_READ_PLAN",
      "assemblePracticalPass",
      "evaluatePracticalCertificationEvidence",
      "observeIdentityRead",
      "observeOrderRead",
      "observePositionRead",
      "practicalBracketDisagreement"
    ]
  ],
  [
    "execution/live/practical-recovery/timing",
    [
      "PRACTICAL_RECOVERY_HARD_CEILINGS"
    ]
  ],
  [
    "execution/live/practical-mutation/ticket",
    [
      "PracticalAcquiredCancel",
      "PracticalArmedCancel",
      "PracticalCancelDispatchOwner",
      "readPracticalUnknownAcquireReceipt",
      "enterPracticalCancelGateway",
      "issuePracticalCancelOutcome",
      "issuePracticalCancelTransportNoWire",
      "reservePracticalCancelPermitCreation",
      "restorePracticalCancelPermitCreation",
      "markPracticalCancelPermitCreationUnknown",
      "issuePracticalCancelDispatchPermit",
      "issuePracticalCancelDispatchAttempt",
      "issuePracticalCancelCreationCleanup",
      "transitionPracticalCancelDispatchOwner",
      "beginPracticalAcquiredCancelAbandon",
      "beginPracticalArmedCancelNoWireCompletion",
      "beginPracticalUnknownAcquireResolution",
      "finishPracticalAcquiredCancelAbandon",
      "finishPracticalArmedCancelNoWireCompletion",
      "finishPracticalUnknownAcquireResolution",
      "issuePracticalAcquiredCancel",
      "issuePracticalArmedCancel",
      "issuePracticalUnknownAcquire",
      "markPracticalAcquiredCancelAbandonOutcomeUnknown",
      "markPracticalAcquiredCancelArmOutcomeUnknown",
      "markPracticalArmedCancelCommitUnknown",
      "refusePracticalUnknownAcquire",
      "releasePracticalAcquiredCancel",
      "reservePracticalAcquiredCancel",
      "restorePracticalAcquiredCancelAbandon",
      "restorePracticalArmedCancel",
      "restorePracticalUnknownAcquire",
      "spendPracticalAcquiredCancel",
      "PracticalUnknownAcquire",
      "PRACTICAL_ARMED_CANCEL_TRANSITIONS",
      "PRACTICAL_CANCEL_DISPATCH_TRANSITIONS"
    ]
  ],
  [
    "execution/live/practical-mutation/preflight",
    [
      "practicalCancelDwellMs",
      "classifyPracticalReconciliationMismatch",
      "isClassifiedPreWriteClaimFailure",
      "PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES"
    ]
  ],
  [
    "execution/live/practical-persistence/rows",
    [
      "evaluatePracticalLatch",
      "isPracticalCertificateBoundToLease",
      "isPracticalLeaseBoundToFence",
      "parsePracticalCertificateRow",
      "parsePracticalLeaseRow",
      "singleRowOrNull",
      "toPracticalAccountLoad",
      "toPracticalRecordLoad",
      "PRACTICAL_RECOVERING_STATES"
    ]
  ],
  [
    "execution/live/practical-persistence/plan",
    [
      "planPracticalAccountChange"
    ]
  ],
  [
    "execution/live/practical/fence",
    [
      "adoptPracticalFenceForNewRuntime",
      "beginPracticalCertification",
      "beginPracticalMutationLease",
      "finishPracticalCertification",
      "initialPracticalFence",
      "releasePracticalMutationLease",
      "readPracticalAccountFence"
    ]
  ],
  [
    "execution/live/practical/state-machine",
    [
      "PracticalManualReviewResolution",
      "practicalAccountStateOnStartup",
      "practicalStateAfterTransitionFailure",
      "transitionPracticalAccountState",
      "PRACTICAL_ALLOWED_TRANSITIONS"
    ]
  ],
  [
    "execution/live/practical/invalidation",
    [
      "classifyPracticalInvalidation",
      "practicalStateForSeverity",
      "PRACTICAL_INVALIDATION_SEVERITY"
    ]
  ],
  [
    "execution/live/practical/types",
    [
      "PRACTICAL_AUTHORIZATION_BASIS",
      "PRACTICAL_DIGEST_PATTERN",
      "PracticalLiveSafetyError",
      "isExactId",
      "isNonNegativeSafeInteger",
      "isPositiveSafeInteger",
      "isPracticalInvalidationReason",
      "isPracticalMutationAction",
      "PRACTICAL_MUTATION_OUTCOMES",
      "PRACTICAL_INVALIDATION_REASONS",
      "isPracticalAccountStateName",
      "PRACTICAL_ACCOUNT_STATES",
      "PRACTICAL_MUTATION_ACTIONS"
    ]
  ],
  [
    "execution/live/reconciliation/evidence",
    [
      "dedupeOrderEvidence",
      "dedupePositionEvidence",
      "rawOrderSetSha256",
      "rawPositionSetSha256",
      "assertEvidenceSetUsable",
      "evidenceSnapshotSha256",
      "evidenceWindowIsSeparable",
      "mergeEvidenceProvenance",
      "rawEvidenceSnapshotSha256"
    ]
  ],
  [
    "execution/live/reconciliation/findings",
    [
      "buildFinding",
      "findingSha256",
      "isFindingBlocking",
      "countBlocking",
      "sortFindings",
      "LIVE_FINDING_IDENTITY_SCHEMA"
    ]
  ],
  [
    "execution/live/reconciliation/types",
    [
      "isBlockingCategory",
      "NON_BLOCKING_FINDING_CATEGORIES"
    ]
  ],
  [
    "execution/live/reconciliation/order-reconciliation",
    [
      "detectOrphanVenueOrders",
      "planClaimRecovery",
      "reconcileIdentifiedOrder",
      "requiresAmbiguousCreateResolution",
      "resolveAmbiguousCreate"
    ]
  ],
  [
    "execution/live/reconciliation/position-attribution",
    [
      "reconcilePosition"
    ]
  ],
  [
    "execution/live/state-machine",
    [
      "applyLiveOrderObservation",
      "reclaimCancelAfterCrash",
      "reclaimDispatchAfterCrash"
    ]
  ],
  [
    "execution/live/practical-cancel-binding",
    [
      "classifyPracticalCancelBinding",
      "currentPracticalCancelBinding"
    ]
  ],
  [
    "execution/live/identity",
    [
      "LIVE_CLIENT_ORDER_ID_PATTERN"
    ]
  ],
  [
    "execution/live/decimal",
    [
      "canonicalPositiveLiveDecimal",
      "canonicalLiveDecimalString",
      "liveDecimal",
      "canonicalNonNegativeLiveDecimal",
      "LiveCalcDecimal",
      "MAX_LIVE_SCALE",
      "MAX_LIVE_INTEGER_DIGITS",
      "MAX_LIVE_PRECISION",
      "canonicalPersistedLiveDecimal"
    ]
  ],
  [
    "risk/index",
    [
      "sha256CanonicalJson"
    ]
  ],
  [
    "risk/canonical",
    [
      "sha256CanonicalJson"
    ]
  ],
  [
    "backtest/canonical-json",
    [
      "sha256CanonicalJson"
    ]
  ],
  [
    "integration/coindcx/normalizers",
    [
      "normalizeUserInfo",
      "normalizeOrder",
      "normalizePosition"
    ]
  ],
  [
    "core/decimal/decimal",
    [
      "Decimal",
      "zeroDecimal"
    ]
  ],
  [
    "integration/coindcx/websocket/schemas",
    [
      "validateAndFilterOrderNotification",
      "validateAndFilterPositionNotification",
      "validateBalanceNotification"
    ]
  ],
  [
    "integration/coindcx/live/endpoints",
    [
      "COINDCX_ORDER_MUTATION_ENDPOINTS",
      "COINDCX_LIVE_MAX_RESPONSE_BYTES"
    ]
  ],
  [
    "execution/live/practical-recovery/tripwire",
    [
      "practicalDurableSafetyProblem",
      "PRACTICAL_REVOCATION_MAX_ATTEMPTS"
    ]
  ],
  [
    "execution/live/practical-persistence/repository",
    [
      "withLockedPracticalAccountWithinCallerTransaction",
      "PRACTICAL_TRANSACTION_MAX_ATTEMPTS"
    ]
  ],
  [
    "execution/live/repository",
    [
      "claimCancelWithinCallerFencedTransaction",
      "armCancelWireWithinCallerFencedTransaction",
      "consumeCancelDispatchWithinCallerFencedTransaction",
      "reproveCancelOrderWithinCallerFencedTransaction",
      "completeCancelAttemptWithinCallerFencedTransaction",
      "releaseUnarmedCancelClaimWithinCallerFencedTransaction",
      "releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction"
    ]
  ],
  [
    "execution/live/errors",
    [
      "LiveExecutionError",
      "LIVE_AMBIGUOUS_CODES",
      "assertCredentialFree"
    ]
  ],
  [
    "execution/live/practical-persistence/ports",
    [
      "PracticalPersistenceError",
      "PracticalDurableContradictionError",
      "PRACTICAL_DURABLE_STATE_MALFORMED"
    ]
  ],
  [
    "execution/live/practical-mutation/ports",
    [
      "PracticalMutationError",
      "PracticalAcquireCommitUnknownError",
      "PRACTICAL_CANCEL_ACQUIRE_INPUT_KEYS",
      "PRACTICAL_CANCEL_ARM_INPUT_KEYS",
      "PRACTICAL_CANCEL_ABANDON_INPUT_KEYS",
      "PRACTICAL_UNKNOWN_ACQUIRE_RESOLUTION_INPUT_KEYS",
      "PRACTICAL_UNDISPATCHED_COMPLETION_INPUT_KEYS",
      "PRACTICAL_NO_DISPATCH_REASONS",
      "PRACTICAL_NOT_DISPATCHED_REPORT_KEYS",
      "PRACTICAL_PREVIOUS_RUNTIME_ESCALATING_REASONS",
      "PRACTICAL_RECOVERY_REFUSAL_REASONS",
      "PRACTICAL_PREVIOUS_RUNTIME_RECOVERY_INPUT_KEYS"
    ]
  ],
  [
    "core/errors/app-error",
    [
      "AppError",
      "CoinDcxConfigError",
      "CoinDcxAuthError",
      "CoinDcxTimeoutError",
      "CoinDcxRateLimitError",
      "CoinDcxProviderError",
      "CoinDcxResponseValidationError",
      "CoinDcxSocketError",
      "CoinDcxSocketValidationError",
      "ValidationError"
    ]
  ],
  [
    "monitoring/logger",
    [
      "isSensitiveKey",
      "redactSensitiveData",
      "isAppError"
    ]
  ],
  [
    "execution/live/practical-cancel/service",
    [
      "PracticalCancelService"
    ]
  ],
  [
    "integration/coindcx/live/reconciliation-evidence-adapter",
    [
      "COINDCX_RECONCILIATION_MAX_PAGES",
      "COINDCX_RECONCILIATION_MAX_PAGES_CEILING",
      "CoinDcxReconciliationEvidenceAdapter"
    ]
  ],
  [
    "backtest/decimal",
    [
      "BacktestDecimal"
    ]
  ],
  [
    "backtest/errors",
    [
      "BacktestError"
    ]
  ],
  [
    "integration/coindcx/transport",
    [
      "DEFAULT_TIMEOUT_MS",
      "DEFAULT_MAX_RESPONSE_BYTES"
    ]
  ],
  [
    "integration/coindcx/websocket/private-stream",
    [
      "PRIVATE_CHANNEL_NAME",
      "CANONICAL_AUTH_BODY"
    ]
  ],
  [
    "integration/coindcx/websocket/backoff",
    [
      "DEFAULT_BACKOFF_CONFIG",
      "calculateBackoffWithJitter"
    ]
  ],
  [
    "integration/coindcx/websocket/types",
    [
      "categorizeDisconnectReason"
    ]
  ],
  [
    "integration/coindcx/websocket/candle-json",
    [
      "EXACT_CANDLE_SOCKET_PARSER"
    ]
  ],
  [
    "execution/live/practical-recovery/private-events",
    [
      "PRACTICAL_PRIVATE_STREAM_ID",
      "PRACTICAL_PRIVATE_NOISE_EVENT_TYPES",
      "PRACTICAL_PRIVATE_STATE_EVENT_TYPES",
      "PRACTICAL_PRIVATE_BINDABLE_STATES"
    ]
  ],
  [
    "execution/live/practical/policy",
    [
      "PRACTICAL_ROLLOUT_STAGES"
    ]
  ],
  [
    "execution/live/practical-mutation/repository",
    [
      "PRACTICAL_MUTATION_TRANSACTION_MAX_ATTEMPTS"
    ]
  ],
  [
    "execution/live/reconciliation/repository",
    [
      "CLAIM_GENERATION_MAX_ATTEMPTS"
    ]
  ]
];
const PROGRAM = String.raw`
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const [base,extension,timing,order]=process.argv.slice(1);
const load=n=>require(path.join(base,n+'.'+extension));
let sockets=0,requests=0,raw,body='{"coindcx_id":"synthetic-provider-id"}',status=200;
const socketPath=require.resolve('socket.io-client');require(socketPath);
require.cache[socketPath].exports=()=>{sockets++;raw=new EventEmitter();raw.connected=false;
raw.connect=()=>{raw.connected=true;raw.emit('connect')};raw.disconnect=()=>{raw.connected=false};
const emit=raw.emit.bind(raw);raw.emit=(event,...args)=>event==='join'?true:emit(event,...args);return raw;};
const https=require('node:https');https.request=(url,options,callback)=>{requests++;const req=new EventEmitter();req.destroy=()=>{};req.write=()=>{};req.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=status;response.headers={};response.destroy=()=>{};callback(response);response.emit('data',Buffer.from(body));response.emit('end')});return req;};
const app=order==='app-first'?load('core/errors/app-error'):null;
const logger=load('monitoring/logger'),errors=app||load('core/errors/app-error');
const rest=load('integration/coindcx/schemas'),wire=load('integration/coindcx/live/wire-schemas'),ws=load('integration/coindcx/websocket/schemas');
const decimal=load('execution/live/decimal'),core=load('core/decimal/decimal'),originalCorePrecision=core.Decimal.precision;
const identity=load('execution/live/reconciliation/account-identity'),rows=load('execution/live/practical-persistence/rows'),pt=load('execution/live/practical/types');
const live=load('execution/live/errors'),persist=load('execution/live/practical-persistence/ports'),mutation=load('execution/live/practical-mutation/ports'),ticket=load('execution/live/practical-mutation/ticket');
const originalClasses=[live.LiveExecutionError,persist.PracticalPersistenceError,mutation.PracticalMutationError,errors.AppError];
const originalPublicSchema=rest.UserInfoResponseSchema;
function substitute(target,name){const old=target[name];for(const kind of ['reflect','define','delete']){
try{if(kind==='reflect')Reflect.set(target,name,()=>{throw Error('APP_LOOKUP_REPLACED')});else if(kind==='define')Object.defineProperty(target,name,{value:()=>({kind:'PROVEN_READY'}),configurable:true});else Reflect.deleteProperty(target,name);}catch{}
}assert.strictEqual(target[name],old);return old;}
function mutateGraph(graph,seen=new Set()){
if(!graph||typeof graph!=='object'||seen.has(graph))return;seen.add(graph);
if(typeof graph.safeParse==='function'){
graph.safeParse=()=>({success:true,data:{coindcx_id:'ATTACKED'}});
graph._parse=()=>({status:'valid',value:{coindcx_id:'ATTACKED'}});
const def=graph._def;if(def){if(typeof def.shape==='function')for(const child of Object.values(def.shape()))mutateGraph(child,seen);
for(const [key,value]of Object.entries(def)){if(key==='checks'&&Array.isArray(value))value.length=0;
else if(Array.isArray(value))for(const child of value)mutateGraph(child,seen);else mutateGraph(value,seen);}}}
}
let selectedBindings=0;
function attackOwners(){for(const [owner,names]of OWNER_LIST){const m=load(owner);for(const name of names){substitute(m,name);selectedBindings++;}}
for(const name of ['UserInfoResponseSchema','UserInfoItemWireSchema','WireNumericSchema','FuturesOrdersResponseSchema','FuturesPositionsResponseSchema','ListInrOrdersRequestSchema','ListInrPositionsRequestSchema'])mutateGraph(rest[name]);
for(const name of ['RawOrderUpdateSchema','RawPositionUpdateSchema','RawBalanceUpdateSchema'])mutateGraph(ws[name]);
for(const name of ['LiveCancelResponseSchema','LiveErrorResponseSchema','LiveWireNumericSchema'])mutateGraph(wire[name]);
rest.VALID_ORDER_STATUSES.push('evil');
rows.PRACTICAL_RECOVERING_STATES.clear();rows.PRACTICAL_RECOVERING_STATES.add('HEALTHY');
for(const re of [identity.LIVE_PROVIDER_ACCOUNT_FINGERPRINT_PATTERN,pt.PRACTICAL_DIGEST_PATTERN]){re.compile('.*');re.test=()=>true;re.exec=()=>['true'];}
decimal.LiveCalcDecimal.precision=1;decimal.LiveCalcDecimal.rounding=decimal.LiveCalcDecimal.ROUND_DOWN;decimal.LiveCalcDecimal.toExpNeg=-1;decimal.LiveCalcDecimal.toExpPos=1;
}
if(timing==='before')attackOwners();
const factory=load('integration/coindcx/live/practical-credential-sources');
const configuration={apiKey:'synthetic-process-key',apiSecret:'synthetic-process-secret',configuredAccountId:'synthetic-process-account',expectedProviderAccountFingerprint:'a'.repeat(64)};
const made=factory.createCoinDcxPracticalCredentialSources(configuration);assert.equal(made.kind,'CONSTRUCTED');
const tuple=factory.readCoinDcxPracticalCredentialSources(made.association);assert.equal(sockets,0);assert.equal(requests,0);
if(timing==='after')attackOwners();
const coordinatorModule=load('integration/coindcx/live/practical-account-coordinator');
const policy={liveExecutionEnabled:'true',practicalSafetyEnabled:'true',pairAllowlist:'B-BTC_USDT',maxOrderNotionalInr:'100',requestTimeoutMs:1000};
const constructed=coordinatorModule.createCoinDcxPracticalAccountCoordinator({prisma:{},credentials:configuration,association:made.association,policy});
assert.equal(constructed.kind,'CONSTRUCTED');assert.equal(sockets,0);assert.equal(requests,0);
assert.equal(coordinatorModule.createCoinDcxPracticalAccountCoordinator({prisma:{},credentials:configuration,association:made.association,policy}).code,'ASSOCIATION_OWNED');
assert.equal(coordinatorModule.createCoinDcxPracticalAccountCoordinator({prisma:{},credentials:configuration,association:{},policy}).code,'INVALID_ASSOCIATION');
let hooks=0;const proxy=new Proxy({}, {get(){hooks++;throw Error('INPUT_GETTER')}});
assert.equal(coordinatorModule.createCoinDcxPracticalAccountCoordinator(proxy).code,'INVALID_INPUT');
assert.equal(coordinatorModule.createCoinDcxPracticalAccountCoordinator({get prisma(){hooks++;return{}},credentials:configuration,policy}).code,'INVALID_INPUT');assert.equal(hooks,0);
assert.throws(()=>new coordinatorModule.CoinDcxPracticalAccountCoordinator({},{}),/COORDINATOR_CONSTRUCTION_REFUSED/);
assert.strictEqual(rest.UserInfoResponseSchema,originalPublicSchema);
assert.deepEqual(rest.parseOwnedUserInfoResponse({coindcx_id:' A ',email:null}).data,{coindcx_id:' A ',email:null});
assert.equal(rest.parseOwnedUserInfoResponse({coindcx_id:12}).success,false);
assert.equal(rest.parseOwnedOrdersRequest({status:'evil',side:'buy',page:'1',size:'200'}).success,false);
assert.equal(rest.parseOwnedOrdersRequest({status:'open, filled',side:'buy',page:'1',size:'200'}).success,true);
assert.equal(rest.parseOwnedOrdersRequest({status:'open',side:'buy',page:'0',size:'200'}).success,false);
assert.equal(rest.parseOwnedPositionsRequest({page:'1',size:'200',pairs:'B-BTC_USDT',extra:'strip'}).data.extra,undefined);
assert.equal(rest.parseOwnedOrdersResponse([]).success,true);assert.equal(rest.parseOwnedPositionsResponse([]).success,true);
const {LosslessNumber}=require('lossless-json');
assert.equal(wire.parseOwnedCancelResponse({message:'success',status:new LosslessNumber('200'),code:new LosslessNumber('200'),extra:'passthrough'}).data.status.value,'200');
assert.equal(wire.parseOwnedCancelResponse({message:'success',status:new LosslessNumber('2e2'),code:200}).success,false);
assert.equal(wire.parseOwnedCancelResponse({message:'bad',status:200,code:200}).success,false);
assert.equal(wire.parseOwnedCancelError({message:'failure',code:'provider-code',extra:7}).data.extra,7);
assert.equal(ws.parseOwnedPositionNotification([]).success,true);assert.equal(ws.parseOwnedOrderNotification([]).success,true);assert.equal(ws.parseOwnedBalanceNotification([]).success,true);
assert.equal(ws.parseOwnedOrderNotification([{id:'bad'}]).success,false);
for(const parse of [rest.parseOwnedUserInfoResponse,rest.parseOwnedOrdersRequest,wire.parseOwnedCancelResponse,ws.parseOwnedOrderNotification]){
const failure=parse({}), expected=JSON.stringify(failure.error.issues);assert.equal(failure.success,false);assert(failure.error instanceof require('zod').ZodError);
function poison(v,seen=new Set()){if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);for(const child of Object.values(v))poison(child,seen);
if(Array.isArray(v))v.push('ATTACKED');else{try{v.message='ATTACKED'}catch{}}}
poison(failure.error.issues);assert.equal(JSON.stringify(parse({}).error.issues),expected);
}
for(const s of ['QUARANTINED','CERTIFYING','PROVIDER_UNAVAILABLE'])assert.equal(rows.isPracticalRecoveringState(s),true);
for(const s of ['HEALTHY','quarantined',null,proxy])assert.equal(rows.isPracticalRecoveringState(s),false);
assert.equal(identity.isProviderAccountFingerprint('a'.repeat(64)),true);assert.equal(identity.isProviderAccountFingerprint('anything'),false);assert.equal(pt.isPracticalDigest('anything'),false);
for(const s of [' A ','A','a'])assert.equal(identity.providerAccountFingerprint(s),crypto.createHash('sha256').update(s,'utf8').digest('hex'));
assert.throws(()=>identity.providerAccountFingerprint(''));
assert.equal(decimal.trustedLiveSubtract('1.000000000000000001','0.000000000000000001'),'1');
assert.equal(decimal.trustedLiveAdd('999999999999999999.999999999999999999','0.000000000000000001'),'1000000000000000000');
assert.equal(decimal.trustedLiveCompare('1.000000000000000001','1'),1);assert.equal(decimal.trustedLiveAbsolute('-0.1'),'0.1');assert.equal(decimal.trustedLiveNegate('-0'),'0');
assert.equal(decimal.canonicalPersistedLiveDecimal('999999999999999999.999999999999999999','quantity'),'999999999999999999.999999999999999999');
for(const bad of ['1000000000000000000','0.0000000000000000001'])assert.throws(()=>decimal.canonicalPersistedLiveDecimal(bad,'quantity'),e=>live.readLiveExecutionError(e).code==='LIVE_OVERFLOW');
for(const bad of [proxy,{get d(){hooks++;return[]}},()=>{},1,new decimal.LiveCalcDecimal(1)])assert.throws(()=>decimal.trustedLiveSubtract(bad,'0'),e=>live.readLiveExecutionError(e).code==='LIVE_NUMERIC_FAILURE');
assert.equal(hooks,0);assert.equal(decimal.LiveCalcDecimal.precision,128);assert.equal(decimal.LiveCalcDecimal.rounding,decimal.LiveCalcDecimal.ROUND_HALF_UP);assert.equal(decimal.LiveCalcDecimal.toExpNeg,-160);assert.equal(decimal.LiveCalcDecimal.toExpPos,160);assert.equal(core.Decimal.precision,originalCorePrecision);
for(const [Ctor,read,code]of [[live.LiveExecutionError,live.readLiveExecutionError,'LIVE_ORDER_STATE_CONFLICT'],[persist.PracticalPersistenceError,persist.readPracticalPersistenceError,'PRACTICAL_PERSISTENCE_CONFLICT'],[mutation.PracticalMutationError,mutation.readPracticalMutationError,'PRACTICAL_MUTATION_FAULT'],[pt.PracticalLiveSafetyError,pt.readPracticalLiveSafetyError,'PRACTICAL_POLICY_INVALID']]){
assert.equal(read(new Ctor('ARBITRARY_CODE','RAW_DYNAMIC')),null);class Foreign extends Ctor{}assert.equal(read(new Foreign(code,'RAW_DYNAMIC')),null);
assert.equal(read(Object.create(Ctor.prototype)),null);assert.equal(read(new Proxy(new Ctor(code,'RAW_DYNAMIC'),{})),null);
const genuine=new Ctor(code,'RAW_DYNAMIC');assert(genuine instanceof Ctor);const record=read(genuine);assert(record);genuine.code='ARBITRARY_CODE';assert.equal(read(genuine).code,code);
}
const noReceipt=new mutation.PracticalAcquireCommitUnknownError('synthetic-account',Error('cause'));
assert.equal(ticket.readPracticalUnknownAcquireReceipt(noReceipt),null);assert.equal(ticket.readPracticalUnknownAcquireReceipt(Object.create(Object.getPrototypeOf(noReceipt))),null);
const details={apiKey:'SYNTHETIC_ONLY',get hostile(){hooks++;return'SYNTHETIC_ONLY'}};details.self=details;
const appErr=new errors.AppError('INTERNAL_ERROR','SYNTHETIC_PRIVATE_DYNAMIC_MESSAGE',500,details);
const safe=logger.redactSafetyData(appErr);assert.equal(safe.message,'[UNHANDLED_ERROR]');assert.equal(safe.details.apiKey,'[REDACTED]');assert.equal(safe.details.hostile,'[UNSAFE_VALUE]');assert.equal(safe.details.self,'[CIRCULAR]');assert.equal(hooks,0);
assert.equal(logger.redactSafetyData(new errors.AppError('UNKNOWN_CODE','RAW_PRIVATE')).name,'Error');
assert.equal(logger.redactSafetyData(new errors.AppError('INTERNAL_ERROR','RAW_PRIVATE',NaN)).name,'Error');
class ForeignApp extends errors.AppError{}assert.equal(logger.redactSafetyData(new ForeignApp('INTERNAL_ERROR','RAW_PRIVATE')).name,'Error');
assert.equal(logger.redactSafetyData(proxy),'[UNSAFE_VALUE]');assert.equal(hooks,0);
assert.throws(()=>live.assertCredentialFree({get ignored(){hooks++;return'private'}}));assert.equal(hooks,0);
const canonical=load('risk/canonical'),risk=load('risk/index'),backtest=load('backtest/canonical-json');
assert.strictEqual(risk.sha256CanonicalJson,canonical.sha256CanonicalJson);assert.equal(typeof backtest.canonicalJson,'function');
(async()=>{
for(const id of [' A ','A','a']){body=JSON.stringify({coindcx_id:id,email:'synthetic-pii@example.invalid'});const r=await tuple.reader.readAccountIdentity({accountId:configuration.configuredAccountId,timeoutMs:100});assert.equal(r.kind,'OBSERVED');assert.equal(r.fingerprint,crypto.createHash('sha256').update(id,'utf8').digest('hex'));assert(!JSON.stringify(r).includes('synthetic-pii'));}
for(const payload of [{coindcx_id:''},[],[{coindcx_id:'a'},{coindcx_id:'b'}]]){body=JSON.stringify(payload);const r=await tuple.reader.readAccountIdentity({accountId:configuration.configuredAccountId,timeoutMs:100});assert.notEqual(r.kind,'OBSERVED');}
const seen=[];tuple.privateStream.subscribe(e=>{for(const key of ['generationId','eventType','channel','stream','source'])try{e[key]='ATTACKED'}catch{};if(e.payload)try{e.payload.generationId='ATTACKED'}catch{}});tuple.privateStream.subscribe(e=>seen.push(e));
await tuple.privateStream.start();assert(seen.some(e=>e.eventType==='PRIVATE_STREAM_CONNECTED'&&Object.isFrozen(e)&&Object.isFrozen(e.payload)));
assert.equal(load('execution/live/practical-recovery/private-events').practicalPrivateStreamReadiness(tuple.privateStream.getHealthSnapshot()).kind,'UNPROVEN');
const beforeInvalid=tuple.privateStream.getHealthSnapshot().invalidEventCount;raw.emit('df-order-update',[{bad:true}]);
const health=tuple.privateStream.getHealthSnapshot();assert.equal(health.reconciliationRequired,false);assert.equal(health.invalidEventCount,beforeInvalid+1);
tuple.privateStream.stop();await tuple.privateStream.start();assert.equal(tuple.privateStream.getHealthSnapshot().reconciliationRequired,true);
body='{"message":"success","status":200,"code":200}';status=200;assert.equal((await tuple.gateway.cancelOrder({clientOrderId:'synthetic-client',exchangeOrderId:'synthetic-exchange',pair:'B-BTC_USDT',timeoutMs:100})).kind,'CANCEL_ACCEPTED');
body='{"message":"unexpected","status":200,"code":200}';assert.notEqual((await tuple.gateway.cancelOrder({clientOrderId:'synthetic-client',exchangeOrderId:'synthetic-exchange',pair:'B-BTC_USDT',timeoutMs:100})).kind,'CANCEL_ACCEPTED');
tuple.privateStream.stop();
const parser=load('integration/coindcx/websocket/candle-json').EXACT_CANDLE_SOCKET_PARSER,decoder=new parser.Decoder();
assert.equal(Object.getOwnPropertyDescriptor(decoder,'add').writable,false);substitute(decoder,'add');substitute(parser,'Decoder');substitute(parser.Decoder.prototype,'add');
let decoded;decoder.on('decoded',v=>{decoded=v});decoder.add('2["private-message",{"value":"safe"}]');assert.equal(decoded.data[0],'private-message');decoder.destroy();
assert(originalClasses.every(v=>Object.isFrozen(v)&&Object.isFrozen(v.prototype)));
Object.freeze(decimal.LiveCalcDecimal);assert.throws(()=>decimal.trustedLiveAdd('1','2'),e=>live.readLiveExecutionError(e).code==='LIVE_NUMERIC_FAILURE');assert.equal(core.Decimal.precision,originalCorePrecision);
console.log('RESULT:'+JSON.stringify({selectedBindings,requests,sockets,providerProof:'UNPROVEN',constructorIO:0,format:extension,timing,order}));
})().catch(error=>{console.error(error.stack);try{tuple.privateStream.stop()}catch{}process.exitCode=1});
`;
describe('reviewed genuine trusted dependency closure under CommonJS and tsx', () => {
  let compiled: string;
  beforeAll(() => {
    mkdirSync(path.resolve('.local'), { recursive: true });
    compiled = path.join(mkdtempSync(path.resolve('.local/coordinator-trusted-cjs-')), 'dist');
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json', '--outDir', compiled,
      '--declaration', 'false', '--sourceMap', 'false'], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
  }, 150_000);
  it.each(['tsc', 'tsx'].flatMap(format => ['before', 'after'].flatMap(timing => ['app-first', 'logger-first'].map(order => [format, timing, order] as const))))(
    '%s %s genuine construction, circular imports %s: binding/content/parser/error/arithmetic/routing/decoder compatibility',
    (format, timing, order) => {
      const output = execFileSync(process.execPath, [...(format === 'tsx' ? ['--require', 'tsx/cjs'] : []), '-e',
        'const OWNER_LIST = '+JSON.stringify(OWNER_LIST)+';'+PROGRAM,
        format === 'tsc' ? compiled : path.resolve('src'), format === 'tsc' ? 'js' : 'ts', timing, order],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4*1024*1024 });
      expect(output).toContain('RESULT:'); expect(output).toContain('"providerProof":"UNPROVEN"');
      expect(output).toContain('"constructorIO":0');
    }, 65_000,
  );
});
