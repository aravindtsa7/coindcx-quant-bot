/**
 * [F14-02 4A.1 §9/§10] Zero-network harness for the GENUINE production
 * market-evidence acquisition path.
 *
 * The previous version of this file patched
 * `CoinDcxTransport.prototype.executeRead` and
 * `ProductionCoinDcxSocketFactory.prototype.createSocket`. That was not a test
 * seam — it was the exploit. Both are exported, writable and configurable, so
 * ordinary application code could do exactly the same thing and mint fully
 * trusted execution and valuation evidence with no network and no capability.
 *
 * The production acquisition implementation is now module-private inside
 * `paper-evidence.ts`, so those prototypes no longer sit on the privileged
 * path and patching them proves nothing. This harness intercepts strictly
 * BELOW the production authority, at the external I/O boundary:
 *
 *   REST — `https.request`, the Node builtin the privileged GET calls.
 *   WS   — the `socket.io-client` package the privileged socket calls.
 *
 * Neither is a repository-exported production API, so nothing here shows that
 * a repo module surface is replaceable. Replacing a Node builtin or a
 * third-party package export is a strictly broader capability that defeats
 * every module in the process equally; that boundary is documented rather than
 * overclaimed, and `prototype-trust-bypass.test.ts` asserts the repo-surface
 * boundary directly.
 */
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { vi } from 'vitest';
import {
  createProductionPaperEvidenceProvider,
  type CoinDcxPaperEvidence,
  type PaperEvidenceInstrument,
  type PaperEvidencePolicy,
} from '../../src/integration/coindcx/paper-evidence';
import { createdFakeSockets, type FakeIoSocket } from './fake-socket-io';

export { FakeIoSocket, socketIoClientMock } from './fake-socket-io';

/** Maps a privileged production URL back to the semantic endpoint the test configured. */
function endpointForPath(pathname: string): string {
  if (pathname.startsWith('/api/v1/derivatives/futures/data/conversions')) return 'FUTURES_CONVERSIONS';
  if (pathname.startsWith('/market_data/v3/orderbook/')) return 'FUTURES_ORDERBOOK';
  if (pathname.startsWith('/market_data/v3/current_prices/')) return 'FUTURES_CURRENT_PRICES';
  return pathname;
}

export interface ProductionAcquisitionInterception {
  /** Sockets the privileged socket obtained from the mocked package, in creation order. */
  readonly sockets: readonly FakeIoSocket[];
  latestSocket(): FakeIoSocket;
  /** Body the intercepted `https.request` returns for a semantic endpoint. */
  setRestResponse(endpoint: string, data: unknown): void;
  /** Endpoints the privileged GET actually requested, in order. */
  readonly restCalls: readonly string[];
}

/**
 * Intercepts `https.request`. Callers must `vi.restoreAllMocks()` afterwards
 * (an `afterEach` is enough), exactly as the Wave3-A tests already do.
 */
export function interceptProductionAcquisition(): ProductionAcquisitionInterception {
  createdFakeSockets.length = 0;
  const responses = new Map<string, unknown>();
  const restCalls: string[] = [];

  vi.spyOn(https, 'request').mockImplementation(((
    url: string | URL,
    _options: unknown,
    callback?: (response: unknown) => void,
  ): unknown => {
    const endpoint = endpointForPath(new URL(String(url)).pathname);
    restCalls.push(endpoint);
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    request.end = (): void => {
      // Deliver on a later tick, as a real socket would.
      setImmediate(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; destroy(): void };
        response.statusCode = responses.has(endpoint) ? 200 : 502;
        response.destroy = (): void => { /* no underlying socket */ };
        callback?.(response);
        const body = responses.has(endpoint) ? JSON.stringify(responses.get(endpoint)) : '';
        if (body.length > 0) response.emit('data', Buffer.from(body, 'utf8'));
        response.emit('end');
      });
    };
    request.destroy = (): void => { /* no underlying socket */ };
    return request;
  }) as unknown as typeof https.request);

  return {
    sockets: createdFakeSockets,
    latestSocket(): FakeIoSocket {
      const socket = createdFakeSockets[createdFakeSockets.length - 1];
      if (socket === undefined) throw new Error('No production socket has been created yet');
      return socket;
    },
    setRestResponse(endpoint, data): void { responses.set(endpoint, data); },
    restCalls,
  };
}

/**
 * A provider built by the ONE approved production path. No clock, socket
 * factory or transport is passed — there is no parameter for them.
 */
export function createInterceptedProductionProvider(
  instruments: readonly PaperEvidenceInstrument[],
  policy?: PaperEvidencePolicy,
): CoinDcxPaperEvidence {
  return policy === undefined
    ? createProductionPaperEvidenceProvider({ instruments })
    : createProductionPaperEvidenceProvider({ instruments, policy });
}

/**
 * Drives the provider's REAL orderbook WS acquisition: it starts the genuine
 * privileged socket path and delivers `frame` through the provider's OWN
 * `depth-snapshot` callback.
 */
export function acquireOrderbookOverWebSocket(
  provider: CoinDcxPaperEvidence,
  interception: ProductionAcquisitionInterception,
  frame: unknown,
): number {
  const generation = provider.startOrderbookWebSocket();
  interception.latestSocket().trigger('depth-snapshot', frame);
  return generation;
}

/** The mark counterpart of {@link acquireOrderbookOverWebSocket}. */
export function acquireMarkOverWebSocket(
  provider: CoinDcxPaperEvidence,
  interception: ProductionAcquisitionInterception,
  frame: unknown,
): number {
  const generation = provider.startMarkWebSocket();
  interception.latestSocket().trigger('currentPrices@futures#update', frame);
  return generation;
}

/** Drives the provider's REAL conversion REST acquisition through `readConversion()`. */
export async function acquireConversionOverRest(
  provider: CoinDcxPaperEvidence,
  interception: ProductionAcquisitionInterception,
  body: unknown,
): Promise<void> {
  interception.setRestResponse('FUTURES_CONVERSIONS', body);
  const result = await provider.readConversion();
  if (!result.accepted) throw new Error(`production conversion acquisition rejected: ${result.reason}`);
}
