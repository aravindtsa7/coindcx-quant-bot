import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable } from './support/import-graph';

const ROOT = path.resolve(__dirname, '../..');
const TREE = 'src/execution/live/practical-cancel/';
const SERVICE = `${TREE}service.ts`;
const BOUNDARY = `${TREE}gateway-boundary.ts`;
const { graph, files } = buildImportGraph(path.join(ROOT, 'src'), ROOT);
const code = (file: string) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('unwired practical cancel orchestration', () => {
  it('has exactly four modules, no barrel and zero outside source importers', () => {
    expect(readdirSync(path.join(ROOT, TREE)).sort()).toEqual(['gateway-boundary.ts', 'lifecycle.ts', 'ports.ts', 'service.ts']);
    expect(files.filter(file => !file.startsWith(TREE) && (graph.get(file) ?? []).some(dependency => dependency.startsWith(TREE)))).toEqual(['src/integration/coindcx/live/practical-account-coordinator.ts']);
  });
  it('has no concrete network, operational composition or Phase17 service dependency', () => {
    for (const file of files.filter(file => file.startsWith(TREE))) {
      const reach = [...computeReachable(graph, file)];
      expect(reach.filter(node => node.startsWith('src/integration/') || node.startsWith('src/dispatch/') || node.startsWith('src/coin-runtime/'))).toEqual([]);
      expect(reach).not.toContain('src/execution/live/service.ts');
      expect(code(file)).not.toMatch(/cancelDurable|issuePracticalRecoveryCertificate|issuePracticalLiveSafetyEnablement|requireCurrentReconciliation|ACCOUNT_CONTINUITY_PROVEN|process\.env|fetch\(/);
    }
  });
  it('uses the genuine static checker and synchronous entry before the sole invocation', () => {
    const boundary = code(BOUNDARY);
    expect(boundary).toContain('PracticalRecoveryService.checkOriginalCertificateWatch(dependencies.recovery');
    const entry = boundary.indexOf('enterPracticalCancelGateway(attempt);');
    const invocation = boundary.indexOf('this.#invoke!(request)', entry);
    expect(entry).toBeGreaterThan(0); expect(invocation).toBeGreaterThan(entry);
    expect(boundary.slice(entry, invocation)).not.toMatch(/\bawait\b|telemetry|setTimeout|queueMicrotask/);
    expect(boundary.match(/this\.#invoke!\(request\)/g)).toHaveLength(1);
    expect(boundary).not.toMatch(/fetchOrder|\.observation\b|\.reasonCode\b/);
  });
  it('pins both trusted lookup identities in the defining CommonJS module without freezing unrelated recovery APIs', () => {
    const recovery = code('src/execution/live/practical-recovery/service.ts');
    const pin = recovery.lastIndexOf("Object.defineProperty(PracticalRecoveryService, 'checkOriginalCertificateWatch'");
    expect(pin).toBeGreaterThan(recovery.indexOf('export class PracticalRecoveryService'));
    expect(recovery.slice(pin)).toMatch(/value: PracticalRecoveryService\.checkOriginalCertificateWatch,\s*writable: false,\s*configurable: false/);
    expect(recovery.slice(pin)).toMatch(/Object\.defineProperty\(module\.exports, 'PracticalRecoveryService',\s*\{\s*get: \(\) => PracticalRecoveryService,\s*configurable: false/);
    expect(recovery).not.toMatch(/Object\.freeze\(PracticalRecoveryService(?:\.prototype)?\)|Object\.freeze\(module\.exports\)/);
    expect(recovery.slice(pin)).toContain('descriptor.get === undefined || descriptor.set !== undefined');
    expect(recovery.slice(pin)).toContain('module.exports.PracticalRecoveryService !== PracticalRecoveryService');
    expect(code(BOUNDARY)).not.toMatch(/const\s+\w+\s*=\s*PracticalRecoveryService\.checkOriginalCertificateWatch\s*;|dependencies\.recovery\.checkOriginalCertificateWatch/);
  });
  it('bookkeeping contains no acquisition, arm, permission, consumption or entry route', () => {
    const service = code(SERVICE);
    const retry = service.slice(service.indexOf('public async retryBookkeeping'), service.indexOf('#cleanupNow():'));
    expect(retry).not.toMatch(/acquireCancelLease|armCancelLease|createCancelDispatchPermission|consumeCancelDispatchPermission|\.invoke\(|enterPractical/);
    expect(retry).toContain('resolveUnknownAcquire');
    expect(service).toContain('readPracticalUnknownAcquireReceipt(error)');
    expect(service).toContain('#service: PracticalCancelService');
    expect(service).toContain("#status: 'READY' | 'RUNNING' | 'SPENT'");
  });
  it('protects the complete new dispatch lookup chain in its defining modules', () => {
    const boundary = code(BOUNDARY), service = code(SERVICE);
    for (const [source, name] of [[boundary, 'PracticalCancelGatewayBoundary'], [service, 'PracticalCancelService']]) {
      expect(source).toContain(`Object.freeze(${name}.prototype)`);
      expect(source).toContain(`Object.freeze(${name})`);
      expect(source).toContain('Object.freeze(this)');
      expect(source).toContain('descriptor.get === undefined || descriptor.set !== undefined');
      expect(source).toContain('module.exports[name] !== value');
      expect(source).toContain('Object.defineProperty(module.exports, name, { get: () => value, configurable: false })');
    }
    expect(boundary).toContain('Object.entries({ PracticalCancelGatewayBoundary, checkPracticalCancelGuard })');
    expect(service).toContain('Object.entries({ PracticalCancelService, PracticalCancelBookkeeping })');
    expect(service).toContain('this.#boundary = new PracticalCancelGatewayBoundary(this.#dependencies, this.#lifecycle, this)');
    expect(service).toContain('await this.#boundary.invoke(consumed.attempt, certificate, time)');
    expect(boundary).toContain('this.#invoke = hasCancelTransportSource(dependencies.gateway) ? null : dependencies.gateway.cancelOrder.bind(dependencies.gateway)');
    expect(boundary).toContain('const guard = checkPracticalCancelGuard(this.#dependencies, certificate, time)');
    expect(boundary).not.toMatch(/dependencies\.(?:invoke|checkPracticalCancelGuard)|this\.invoke\s*=/);
  });
  it('durable writers and owner lifecycle issuers remain outside orchestration', () => {
    for (const file of [SERVICE, BOUNDARY, `${TREE}ports.ts`]) {
      expect(code(file)).not.toMatch(/\$transaction|\$queryRaw|\$executeRaw|WithinCallerFencedTransaction|transitionPracticalCancelDispatchOwner|issuePracticalCancelDispatchPermit|issuePracticalCancelDispatchAttempt/);
    }
  });
  it('pins native lifecycle issuance/closure, exact associations and the final revocation-only observation', () => {
    const lifecycle = `${TREE}lifecycle.ts`, source = code(lifecycle);
    expect(files.filter(file => (graph.get(file) ?? []).includes(lifecycle)).sort()).toEqual([BOUNDARY, SERVICE].sort());
    const callers = (symbol: string) => files.filter(file => file !== lifecycle && new RegExp(`\\b${symbol}\\s*\\(`).test(code(file))).sort();
    for (const symbol of ['createPracticalCancelLifecycle', 'installPracticalCancelLifecycleBrand']) expect(callers(symbol)).toEqual([SERVICE]);
    expect(callers('PracticalCancelLifecycle.close')).toEqual([SERVICE]);
    expect(callers('PracticalCancelLifecycle.open')).toEqual([BOUNDARY, SERVICE].sort());
    expect(callers('PracticalCancelLifecycle.matches')).toEqual([BOUNDARY]);
    expect(source).toContain('value.#owner === owner && value.#dependencies === dependencies');
    expect(source).toContain('associations.get(value.#owner) === value');
    expect(source).toContain('Object.freeze(PracticalCancelLifecycle.prototype)'); expect(source).toContain('Object.freeze(PracticalCancelLifecycle)');
    expect(source).toContain('Object.freeze(this)'); expect(source).toContain('get: () => value, configurable: false');
    expect(source).not.toMatch(/reopen|reset|process\.env|gateway|Prisma|certif/i);
    const boundary = code(BOUNDARY), entry = boundary.indexOf('enterPracticalCancelGateway(attempt);');
    const last = boundary.lastIndexOf('PracticalCancelLifecycle.open', entry);
    expect(last).toBeGreaterThan(boundary.indexOf('const guard = checkPracticalCancelGuard', boundary.indexOf('public async invoke')));
    expect(boundary.slice(last, entry)).not.toMatch(/\bawait\b|checkPracticalCancelGuard|telemetry|setTimeout/);
    const service = code(SERVICE), drain = service.slice(service.indexOf('public async drain'), service.indexOf('#admissionOpen():'));
    expect(drain.match(/setTimeout\(/g)).toHaveLength(1); expect(drain).toContain('30_000');
    expect(drain.match(/this\.#retryBookkeeping\(/g)).toHaveLength(1);
    expect(drain).not.toMatch(/acquireCancelLease|armCancelLease|consumeCancelDispatchPermission|\.invoke\(|stopWatch|while\s*\(/);
  });
});
