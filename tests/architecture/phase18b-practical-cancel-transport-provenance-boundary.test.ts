import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable, extractImportSpecifiers, listSourceFiles, resolveLocalSpecifier } from './support/import-graph';

const ROOT = path.resolve(__dirname, '../..');
const NEUTRAL = 'src/execution/live/practical-cancel-transport-evidence.ts';
const BOUNDARY = 'src/execution/live/practical-cancel/gateway-boundary.ts';
const TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const GATEWAY = 'src/integration/coindcx/live/order-gateway.ts';
const { graph, files } = buildImportGraph(path.join(ROOT, 'src'), ROOT);
const sourceCache = new Map<string, string>();
const code = (file: string) => {
  let source = sourceCache.get(file);
  if (source === undefined) { source = readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1'); sourceCache.set(file, source); }
  return source;
};

describe('unwired practical cancel transport provenance', () => {
  it('pins neutral importers and privileged operations to exact modules', () => {
    expect(files.filter(file => (graph.get(file) ?? []).includes(NEUTRAL)).sort()).toEqual([BOUNDARY, TRANSPORT, GATEWAY].sort());
    const callers = (symbol: string) => files.filter(file => file !== NEUTRAL && new RegExp(`\\b${symbol}\\s*\\(`).test(code(file))).sort();
    for (const symbol of ['hasCancelTransportSource', 'reserveCancelTransportInvocation', 'invokeCancelTransport', 'settleCancelTransportInvocation', 'closeCancelTransportInvocation']) expect(callers(symbol)).toEqual([BOUNDARY]);
    for (const symbol of ['installCancelTransportBrand', 'registerCancelTransportSource', 'beginCancelTransportPreparation', 'markCancelTransmissionPossible', 'issueCancelTransportNoWrite']) expect(callers(symbol)).toEqual([TRANSPORT]);
    for (const symbol of ['installCancelGatewayBrand', 'registerCancelGatewaySource', 'propagateCancelTransportResult']) expect(callers(symbol)).toEqual([GATEWAY]);
    expect(callers('readCancelTransportRequest')).toEqual([GATEWAY, TRANSPORT].sort());
    expect(callers('executePracticalCancel')).toEqual([GATEWAY, TRANSPORT].sort());
    const existing = new Set(files.map(file => path.join(ROOT, file)));
    const testImporters = listSourceFiles(path.join(ROOT, 'tests')).filter(file => extractImportSpecifiers(readFileSync(file, 'utf8'), file)
      .some(specifier => resolveLocalSpecifier(file, specifier, existing) === path.join(ROOT, NEUTRAL)));
    expect(testImporters.map(file => path.relative(ROOT, file).replaceAll('\\', '/'))).toEqual(['tests/unit/execution/live/practical-cancel/service.test.ts']);
  });
  it('keeps execution neutral and the orchestration service operationally unreachable', () => {
    expect([...computeReachable(graph, NEUTRAL)].filter(file => file.startsWith('src/integration/'))).toEqual([]);
    const service = 'src/execution/live/practical-cancel/service.ts';
    expect(files.filter(file => !file.startsWith('src/execution/live/practical-cancel/') && computeReachable(graph, file).has(service))).toEqual([]);
    expect(code(NEUTRAL)).not.toMatch(/process\.env|http|https|fetch\(|public\s+barrel/);
  });
  it('uses genuine private producer associations and defining-module protected lookups', () => {
    expect(code(TRANSPORT)).toContain("static { installCancelTransportBrand(value => typeof value === 'object' && value !== null && #practicalSecret in value); }");
    expect(code(GATEWAY)).toContain('gateway.#transport === transport');
    expect(code(GATEWAY)).toContain('invocation => this.#cancelWithProvenance(invocation)');
    expect(code(TRANSPORT)).toContain('return transport.#executePracticalCancel(invocation, timestamp)');
    expect(code(TRANSPORT)).toContain("Object.defineProperty(CoinDcxOrderMutationTransport, 'executePracticalCancel'");
    for (const file of [NEUTRAL, TRANSPORT, GATEWAY]) {
      expect(code(file)).toContain('descriptor.get === undefined || descriptor.set !== undefined');
      expect(code(file)).toMatch(/get: \(\) => (?:value|CoinDcxOrderMutationTransport|CoinDcxLiveFuturesOrderGateway), configurable: false/);
    }
    for (const name of ['CancelTransportInvocation', 'CancelTransportNoWriteEvidence']) expect(code(NEUTRAL)).toContain(name);
    expect(code(NEUTRAL)).toContain('Object.freeze(value.prototype); Object.freeze(value)');
  });
  it('places the irreversible marker directly before the factory, outside preparation catch', () => {
    const transport = code(TRANSPORT);
    expect(transport).toContain('if (invocation !== undefined) markCancelTransmissionPossible(invocation, this);\n      const request = requestModule.request');
    const start = transport.indexOf('async #executePracticalCancel');
    const preparation = transport.slice(start, transport.indexOf('const wire = await this.#executePrepared', start));
    expect(preparation).toContain('issueCancelTransportNoWrite(invocation, this)');
    expect(preparation).toContain("createHmac('sha256', secret)");
    expect(preparation).not.toMatch(/#signer|\.request\(|\.execute\(/);
    const following = transport.slice(transport.indexOf('const wire = await this.#executePrepared', start), transport.indexOf('public async execute', start));
    expect(following).not.toContain('issueCancelTransportNoWrite');
  });
  it('validates primitive snapshots outside proof catch and before preparation without coercion', () => {
    const transport = code(TRANSPORT);
    const method = transport.slice(transport.indexOf('async #executePracticalCancel'), transport.indexOf('public async execute'));
    const begin = method.indexOf('beginCancelTransportPreparation(invocation, this)'), proofTry = method.indexOf('try {');
    const validation = method.slice(0, begin);
    expect(begin).toBeGreaterThan(0); expect(proofTry).toBeGreaterThan(begin);
    expect(validation).toContain("typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0");
    for (const name of ['baseUrl', 'apiKey', 'secret', 'id', 'cancelPath']) expect(validation).toContain(`typeof ${name} !== 'string'`);
    expect(validation).toContain("throw new Error('CANCEL_LOCAL_INPUT_INVALID')");
    expect(validation).not.toMatch(/String\(|Number\(|\.toString\(|\.toJSON\(|\.valueOf\(|Symbol\.toPrimitive|JSON\.stringify/);
    const proof = method.slice(proofTry, method.indexOf('} catch {'));
    expect(proof).toContain('JSON.stringify({ timestamp, id })'); expect(proof).toContain('new URL(cancelPath, baseUrl)');
    expect(proof).not.toMatch(/request\.exchangeOrderId|this\.#(?:baseUrl|apiKey|practicalSecret)|options\.|#clock/);
    const constructor = transport.slice(transport.indexOf('public constructor'), transport.indexOf('public static executePracticalCancel'));
    for (const name of ['apiKey', 'apiSecret', 'baseUrl', 'maxResponseBytes']) expect(constructor.match(new RegExp(`options\\.${name}\\b`, 'g'))).toHaveLength(1);
    expect(constructor).toContain('this.#practicalSecret = apiSecret'); expect(constructor).toContain('this.#apiKey = apiKey');
    expect(constructor).toContain('this.#practicalBaseUrl = baseUrl === undefined ? COINDCX_LIVE_BASE_URL : baseUrl');
  });
  it('reserves context before final guard and terminal settlement before proof or reflection', () => {
    const boundary = code(BOUNDARY);
    expect(boundary.indexOf('const context = reserveCancelTransportInvocation')).toBeLessThan(boundary.indexOf('const guard = checkPracticalCancelGuard', boundary.indexOf('public async invoke')));
    const finish = boundary.slice(boundary.indexOf('const finish ='), boundary.indexOf('const timer ='));
    expect(finish.indexOf('if (settled) return')).toBeLessThan(finish.indexOf('settled = true'));
    expect(finish.indexOf('settled = true')).toBeLessThan(finish.indexOf('settleCancelTransportInvocation'));
    expect(finish.indexOf('settled = true')).toBeLessThan(finish.indexOf('projectResult'));
    expect(finish).toContain("const noWire = issuePracticalCancelTransportNoWire(attempt);\n          resolve(issuePracticalCancelOutcome(attempt, { kind: 'PRE_DISPATCH_FAILURE', noWire }))");
    expect(boundary).not.toMatch(/completeUnenteredCancelDispatch|issueCancelTransportNoWrite/);
    const entry = boundary.indexOf('enterPracticalCancelGateway(attempt);');
    expect(boundary.lastIndexOf('PracticalCancelLifecycle.open', entry)).toBeGreaterThan(boundary.indexOf('const guard = checkPracticalCancelGuard', boundary.indexOf('public async invoke')));
    expect(boundary.slice(entry, boundary.indexOf('invokeCancelTransport(context)', entry))).not.toMatch(/\bawait\b|drain\(|requestStop\(|setTimeout/);
  });
});
