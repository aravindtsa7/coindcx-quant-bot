/**
 * [F14-02 4A.1] The prototype-patch production trust bypass.
 *
 * An independent verifier showed that ordinary application code — no Vitest, no
 * test helper, no acquisition token — could deep-import `CoinDcxTransport` and
 * `ProductionCoinDcxSocketFactory`, patch their writable/configurable prototype
 * methods, then call `createProductionPaperEvidenceProvider` and receive fully
 * trusted execution AND valuation evidence for fabricated values with zero
 * genuine CoinDCX acquisition.
 *
 * These tests attack the same way, in both patch orderings, and assert the
 * attacker's implementations are never reached by the privileged path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async () => (await import('../../helpers/fake-socket-io')).socketIoClientMock());

import { getTrustedPaperExecutionEvidence } from '../../../src/integration/coindcx/execution-evidence-adapter';
import {
  CoinDcxPaperEvidence, createProductionPaperEvidenceProvider, readProductionAcquiredPaperValuationEvidence,
  type PaperEvidenceInstrument,
} from '../../../src/integration/coindcx/paper-evidence';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';
import { ProductionCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';
import {
  acquireConversionOverRest, acquireMarkOverWebSocket, acquireOrderbookOverWebSocket,
  interceptProductionAcquisition, type ProductionAcquisitionInterception,
} from '../../helpers/production-acquisition-harness';

const NOW = 1_700_000_000_000;
const PAIR = 'B-BTC_USDT';
const INSTRUMENTS: readonly PaperEvidenceInstrument[] = Object.freeze([
  Object.freeze({ pair: PAIR, underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'btc-spec-v1' }),
]);
const POLICY = { orderbookFreshnessMs: 30_000, markFreshnessMs: 30_000, conversionLocalPollFreshnessMs: 60_000, allowedProviderFutureSkewMs: 5_000 };
const BOOK_FRAME = { data: JSON.stringify({ type: 'depth-snapshot', pr: 'futures', s: 'BTCUSDT', ts: String(NOW), vs: '1', bids: [['999998', '1000000']], asks: [['999999', '1000000']] }) };
const MARK_FRAME = { data: JSON.stringify({ ts: String(NOW), vs: '1', BTCUSDT: { mp: '999999', bmST: String(NOW) } }) };
const CONVERSION_BODY = [{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '80', last_updated_at: String(NOW) }];

let interception: ProductionAcquisitionInterception;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  interception = interceptProductionAcquisition();
});
afterEach(() => vi.restoreAllMocks());

/** The attacker's replacement implementations, plus the counters that prove they were never reached. */
interface AttackerPatch {
  transportCalls(): number;
  socketCalls(): number;
  socketsHandedOut(): number;
}

function patchExportedPrototypes(): AttackerPatch {
  let transportCalls = 0;
  let socketCalls = 0;
  const handedOut: object[] = [];

  // Exactly the properties the verifier reported as writable/configurable.
  const executeReadDescriptor = Object.getOwnPropertyDescriptor(CoinDcxTransport.prototype, 'executeRead');
  const createSocketDescriptor = Object.getOwnPropertyDescriptor(ProductionCoinDcxSocketFactory.prototype, 'createSocket');
  expect(executeReadDescriptor?.writable, 'the exploit premise: executeRead is patchable').toBe(true);
  expect(createSocketDescriptor?.writable, 'the exploit premise: createSocket is patchable').toBe(true);

  vi.spyOn(CoinDcxTransport.prototype, 'executeRead').mockImplementation(async () => {
    transportCalls += 1;
    return { status: 200, headers: {}, durationMs: 0, data: CONVERSION_BODY } as never;
  });
  vi.spyOn(ProductionCoinDcxSocketFactory.prototype, 'createSocket').mockImplementation(() => {
    socketCalls += 1;
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const socket = {
      connected: false,
      connect(): void { socket.connected = true; for (const fn of listeners.get('connect') ?? []) fn(undefined); },
      disconnect(): void { socket.connected = false; },
      on(event: string, fn: (payload: unknown) => void): void {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)?.push(fn);
      },
      off(): void { /* noop */ },
      emit(): void { /* noop */ },
      fire(event: string, payload: unknown): void { for (const fn of listeners.get(event) ?? []) fn(payload); },
    };
    handedOut.push(socket);
    return socket as never;
  });

  return {
    transportCalls: () => transportCalls,
    socketCalls: () => socketCalls,
    socketsHandedOut: () => handedOut.length,
  };
}

describe('F14-02 4A.1 prototype-patch production trust bypass', () => {
  it('§13 post-import patch: a patched transport and socket factory are never reached by the privileged path', async () => {
    const attacker = patchExportedPrototypes();

    const provider = createProductionPaperEvidenceProvider({ instruments: INSTRUMENTS, policy: POLICY });
    provider.startOrderbookWebSocket();
    provider.startMarkWebSocket();
    // The privileged GET does not go through the exported transport; the
    // attacker's body is therefore never seen, and the read fails closed.
    await expect(provider.readConversion()).rejects.toBeDefined();

    expect(attacker.transportCalls(), 'fake transport privileged calls').toBe(0);
    expect(attacker.socketCalls(), 'fake socket factory privileged calls').toBe(0);
    expect(attacker.socketsHandedOut(), 'the attacker never got to supply a socket').toBe(0);

    expect(getTrustedPaperExecutionEvidence(provider, PAIR).state).toBe('UNAVAILABLE');
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]).state).toBe('UNAVAILABLE');
  });

  it('§12 pre-import patch: patching before the production module is even loaded changes nothing', async () => {
    vi.resetModules();
    const transportModule = await import('../../../src/integration/coindcx/transport');
    const socketModule = await import('../../../src/integration/coindcx/websocket/socket-adapter');

    let transportCalls = 0;
    let socketCalls = 0;
    vi.spyOn(transportModule.CoinDcxTransport.prototype, 'executeRead').mockImplementation(async () => {
      transportCalls += 1;
      return { status: 200, headers: {}, durationMs: 0, data: CONVERSION_BODY } as never;
    });
    vi.spyOn(socketModule.ProductionCoinDcxSocketFactory.prototype, 'createSocket').mockImplementation(() => {
      socketCalls += 1;
      return { connected: false, connect: () => undefined, disconnect: () => undefined, on: () => undefined, off: () => undefined, emit: () => undefined } as never;
    });

    // Only NOW is the privileged module loaded. A fix that merely captured the
    // prototype methods at module initialization would fail here.
    const evidenceModule = await import('../../../src/integration/coindcx/paper-evidence');
    const adapterModule = await import('../../../src/integration/coindcx/execution-evidence-adapter');

    const provider = evidenceModule.createProductionPaperEvidenceProvider({ instruments: INSTRUMENTS, policy: POLICY });
    provider.startOrderbookWebSocket();
    provider.startMarkWebSocket();
    await expect(provider.readConversion()).rejects.toBeDefined();

    expect(transportCalls, 'fake transport privileged calls').toBe(0);
    expect(socketCalls, 'fake socket factory privileged calls').toBe(0);
    expect(adapterModule.getTrustedPaperExecutionEvidence(provider, PAIR).state).toBe('UNAVAILABLE');
    expect(evidenceModule.readProductionAcquiredPaperValuationEvidence(provider, [PAIR]).state).toBe('UNAVAILABLE');
  });

  it('§17/§18 a prototype-patched attacker obtains no trusted quote, depth, mark or conversion', async () => {
    const attacker = patchExportedPrototypes();
    const provider = createProductionPaperEvidenceProvider({ instruments: INSTRUMENTS, policy: POLICY });

    // Every route the attacker still has is the public, permanently
    // caller-supplied ingestion surface.
    const bookGeneration = provider.startOrderbookWebSocket();
    provider.ingestOrderbookWebSocket(BOOK_FRAME, bookGeneration);
    const markGeneration = provider.startMarkWebSocket();
    provider.ingestMarkWebSocket(MARK_FRAME, markGeneration);
    provider.ingestConversionRest(CONVERSION_BODY);

    // The fabricated data is genuinely stored and passes every ordinary gate…
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(provider.getLatestMark(PAIR).state).toBe('AVAILABLE');
    expect(provider.getLatestConversion().state).toBe('AVAILABLE');
    // …and is worthless to both trusted issuers.
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
    expect(attacker.socketCalls()).toBe(0);
  });

  it('§14 no privileged acquisition dependency is reachable or mutable from a caller', () => {
    const provider = createProductionPaperEvidenceProvider({ instruments: INSTRUMENTS, policy: POLICY });
    provider.startOrderbookWebSocket();

    const ownNames = Object.getOwnPropertyNames(provider);
    expect(ownNames, 'a production provider exposes no own data properties at all').toEqual([]);
    expect(Object.keys(provider)).toEqual([]);

    // No accessor named for an internal dependency exists…
    const surface = new Map<string, PropertyDescriptor>();
    for (let proto: object | null = provider; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
        if (!surface.has(name)) surface.set(name, descriptor);
      }
    }
    const forbiddenExactNames = [
      'transport', 'conversionTransport', 'orderbookRestTransport', 'markRestTransport',
      'socket', 'socketFactory', 'orderbookSocket', 'markSocket',
      'clock', 'registry', 'providers', 'capability', 'acquisitionCapability',
    ];
    for (const name of forbiddenExactNames) {
      expect(surface.has(name), `no member may expose the privileged ${name}`).toBe(false);
    }

    // …and behaviourally, every readable accessor hands back a primitive, so
    // there is no route to a live privileged object to reference or mutate.
    for (const [name, descriptor] of surface) {
      if (typeof descriptor.get !== 'function') continue;
      const value: unknown = (provider as unknown as Record<string, unknown>)[name];
      expect(typeof value, `getter ${name} must not hand back an object`).not.toBe('object');
      expect(typeof value, `getter ${name} must not hand back a function`).not.toBe('function');
    }
  });

  it('§8 replacing Date.now cannot by itself fabricate production provenance', () => {
    // A caller-built provider whose entire notion of time is attacker-chosen.
    const provider = new CoinDcxPaperEvidence({ instruments: INSTRUMENTS, policy: POLICY });
    const generation = provider.startOrderbookWebSocket();
    provider.ingestOrderbookWebSocket(BOOK_FRAME, generation);
    provider.ingestConversionRest(CONVERSION_BODY);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1);

    // Freshness is satisfied — the clock is fully under the attacker's control —
    // yet provenance is untouched by it, so nothing mints.
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_NOT_PRODUCTION_ACQUIRED' });
  });

  it('positive control: the genuine privileged path still mints trusted execution and valuation evidence', async () => {
    const provider = createProductionPaperEvidenceProvider({ instruments: INSTRUMENTS, policy: POLICY });
    acquireOrderbookOverWebSocket(provider, interception, BOOK_FRAME);
    acquireMarkOverWebSocket(provider, interception, MARK_FRAME);
    await acquireConversionOverRest(provider, interception, CONVERSION_BODY);

    // Proof it really travelled the privileged primitives.
    expect(interception.restCalls).toEqual(['FUTURES_CONVERSIONS']);
    expect(interception.sockets).toHaveLength(2);
    expect(getTrustedPaperExecutionEvidence(provider, PAIR).state).toBe('AVAILABLE');
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]).state).toBe('AVAILABLE');
  });
});
