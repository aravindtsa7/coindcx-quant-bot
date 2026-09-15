/**
 * Zero-network harness for the genuine production instrument authority.
 *
 * Interception is deliberately below the repository authority boundary at
 * Node's native `https.request`. No exported CoinDCX transport, reader,
 * callback, acquisition token, or production test seam participates.
 */
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { vi } from 'vitest';

export interface ProductionInstrumentAcquisitionInterception {
  readonly urls: readonly string[];
  readonly calls: number;
}

export function interceptProductionInstrumentAcquisition(
  ...instrumentResponses: readonly Record<string, unknown>[]
): ProductionInstrumentAcquisitionInterception {
  const urls: string[] = [];
  let index = 0;

  vi.spyOn(https, 'request').mockImplementation(((
    url: string | URL,
    _options: unknown,
    callback?: (response: unknown) => void,
  ): unknown => {
    const requestedUrl = new URL(String(url));
    if (requestedUrl.origin !== 'https://api.coindcx.com'
      || requestedUrl.pathname !== '/exchange/v1/derivatives/futures/data/instrument'
      || !/^B-[A-Z0-9]+_[A-Z0-9]+$/.test(requestedUrl.searchParams.get('pair') ?? '')
      || requestedUrl.searchParams.get('margin_currency_short_name') !== 'INR') {
      throw new Error(`Unexpected production instrument request URL: ${requestedUrl.toString()}`);
    }
    urls.push(requestedUrl.toString());
    const instrument = instrumentResponses[index] ?? instrumentResponses.at(-1);
    index += 1;

    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    request.end = (): void => {
      setImmediate(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; destroy(): void };
        response.statusCode = instrument === undefined ? 502 : 200;
        response.destroy = (): void => { /* no underlying socket */ };
        callback?.(response);
        if (instrument !== undefined) {
          response.emit('data', Buffer.from(JSON.stringify({ instrument }), 'utf8'));
        }
        response.emit('end');
      });
    };
    request.destroy = (): void => { /* no underlying socket */ };
    return request;
  }) as unknown as typeof https.request);

  return {
    urls,
    get calls(): number { return urls.length; },
  };
}
