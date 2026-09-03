import http from 'node:http';
import { AddressInfo } from 'node:net';
import { LosslessNumber } from 'lossless-json';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CoinDcxAuthError,
  CoinDcxProviderError,
  CoinDcxRateLimitError,
  CoinDcxResponseValidationError,
  CoinDcxTimeoutError,
} from '../../../src/core/errors/app-error';
import { HmacSha256Signer } from '../../../src/integration/coindcx/signer';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';

describe('CoinDCX Transport', () => {
  let server: http.Server;
  let serverUrl: string;
  const testApiKey = 'fake-test-api-key-999';
  const testApiSecret = 'fake-test-api-secret-888';
  const signer = new HmacSha256Signer(testApiSecret);

  let lastReceivedMethod = '';
  let lastReceivedPath = '';
  let lastReceivedHeaders: http.IncomingHttpHeaders = {};
  let lastReceivedBody = '';
  let mockStatusCode = 200;
  let mockResponseBody: string | null = JSON.stringify({ success: true });
  let mockHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  let mockDelayMs = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastReceivedMethod = req.method ?? '';
      lastReceivedPath = req.url ?? '';
      lastReceivedHeaders = req.headers;

      let bodyData = '';
      req.on('data', (chunk: Buffer) => {
        bodyData += chunk.toString('utf8');
      });

      req.on('end', () => {
        lastReceivedBody = bodyData;

        const sendResponse = (): void => {
          res.writeHead(mockStatusCode, mockHeaders);
          if (mockResponseBody !== null) {
            res.end(mockResponseBody);
          } else {
            res.end();
          }
        };

        if (mockDelayMs > 0) {
          setTimeout(sendResponse, mockDelayMs);
        } else {
          sendResponse();
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        serverUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const resetMock = (): void => {
    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({ success: true });
    mockHeaders = { 'Content-Type': 'application/json' };
    mockDelayMs = 0;
    lastReceivedMethod = '';
    lastReceivedPath = '';
    lastReceivedHeaders = {};
    lastReceivedBody = '';
  };

  it('strictly rejects any endpoint not in CoinDcxReadEndpoint union', async () => {
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });

    // Attempting to pass an unlisted/mutating endpoint ID
    await expect(
      (transport as unknown as { executeRead: (opts: unknown) => Promise<unknown> }).executeRead({
        endpoint: 'ORDERS_CREATE',
      })
    ).rejects.toThrow(CoinDcxProviderError);

    await expect(
      (transport as unknown as { executeRead: (opts: unknown) => Promise<unknown> }).executeRead({
        endpoint: 'ORDERS_CANCEL',
      })
    ).rejects.toThrow(CoinDcxProviderError);
  });

  it('does NOT provide any public method accepting arbitrary URL paths', () => {
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });
    const proto = Object.getPrototypeOf(transport) as Record<string, unknown>;

    expect(proto['request']).toBeUndefined();
    expect(proto['executeWireRequest']).toBeUndefined();
    expect(typeof transport.executeRead).toBe('function');
  });

  it('GET-with-signed-body wire invariant: transmits GET with exact body and signature', async () => {
    resetMock();
    const transport = new CoinDcxTransport({
      baseUrl: serverUrl,
      apiKey: testApiKey,
      signer,
    });

    const bodyPayload = '{"timestamp":1700000000123}';
    const expectedSig = signer.sign(bodyPayload);

    mockResponseBody = JSON.stringify([
      { id: 'wallet-1', currency_short_name: 'INR', locked_balance: '500.0' },
    ]);

    const response = await transport.executeRead({
      endpoint: 'FUTURES_WALLETS',
      body: bodyPayload,
    });

    expect(response.status).toBe(200);
    expect(lastReceivedMethod).toBe('GET');
    expect(lastReceivedPath).toBe('/exchange/v1/derivatives/futures/wallets');
    expect(lastReceivedBody).toBe(bodyPayload);
    expect(lastReceivedHeaders['x-auth-apikey']).toBe(testApiKey);
    expect(lastReceivedHeaders['x-auth-signature']).toBe(expectedSig);
    expect(lastReceivedHeaders['content-type']).toBe('application/json');
    expect(lastReceivedHeaders['content-length']).toBe(String(Buffer.byteLength(bodyPayload)));

    const verifySig = signer.sign(lastReceivedBody);
    expect(verifySig).toBe(lastReceivedHeaders['x-auth-signature']);
  });

  it('lossless JSON parsing preserves exact high-precision numeric tokens', async () => {
    resetMock();
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });

    // Exact high-precision tokens that standard JavaScript Number / JSON.parse would corrupt
    const preciseToken = '0.011572734637194769';
    const largePreciseToken = '987654321012345.12345678901234';
    mockResponseBody = `{"precise":${preciseToken},"large":${largePreciseToken}}`;

    const response = await transport.executeRead<{ precise: LosslessNumber; large: LosslessNumber }>({
      endpoint: 'ACTIVE_INSTRUMENTS',
    });

    expect(response.status).toBe(200);
    expect(response.data.precise.value).toBe(preciseToken);
    expect(response.data.precise.toString()).toBe(preciseToken);
    expect(response.data.large.value).toBe(largePreciseToken);
    expect(response.data.large.toString()).toBe(largePreciseToken);
  });

  it('serializes query parameters correctly for public requests', async () => {
    resetMock();
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });
    mockResponseBody = JSON.stringify(['B-BTC_USDT', 'B-ETH_USDT']);

    await transport.executeRead({
      endpoint: 'ACTIVE_INSTRUMENTS',
      queryParams: {
        'margin_currency_short_name[]': 'INR',
      },
    });

    expect(lastReceivedMethod).toBe('GET');
    expect(lastReceivedPath).toContain('/exchange/v1/derivatives/futures/data/active_instruments?');
    expect(decodeURIComponent(lastReceivedPath)).toContain('margin_currency_short_name[]=INR');
    expect(lastReceivedHeaders['x-auth-apikey']).toBeUndefined();
  });

  it('maps HTTP 401 and 403 to CoinDcxAuthError without reflecting provider messages or secrets', async () => {
    resetMock();
    const transport = new CoinDcxTransport({
      baseUrl: serverUrl,
      apiKey: testApiKey,
      signer,
    });

    mockStatusCode = 401;
    mockResponseBody = JSON.stringify({
      message: 'AUTH_CANARY_SECRET_401',
      secret_data: 'leak_api_secret_401',
    });

    try {
      await transport.executeRead({
        endpoint: 'USER_INFO',
        body: '{"timestamp":1700000000000}',
      });
      expect.unreachable('Should have thrown CoinDcxAuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(CoinDcxAuthError);
      const authErr = err as CoinDcxAuthError;
      expect(authErr.statusCode).toBe(401);
      expect(authErr.message).toBe('CoinDCX authentication request failed');
      expect(authErr.message).not.toContain('AUTH_CANARY_SECRET_401');
      expect(JSON.stringify(authErr.details)).not.toContain('AUTH_CANARY_SECRET_401');
      expect(JSON.stringify(authErr.details)).not.toContain('leak_api_secret_401');
      expect(authErr.details?.['statusCode']).toBe(401);
    }

    mockStatusCode = 403;
    mockResponseBody = JSON.stringify({
      message: 'FORBIDDEN_CANARY_SECRET_403',
    });

    try {
      await transport.executeRead({
        endpoint: 'USER_INFO',
        body: '{"timestamp":1700000000000}',
      });
      expect.unreachable('Should have thrown CoinDcxAuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(CoinDcxAuthError);
      const authErr = err as CoinDcxAuthError;
      expect(authErr.statusCode).toBe(403);
      expect(authErr.message).toBe('CoinDCX authentication request failed');
      expect(authErr.message).not.toContain('FORBIDDEN_CANARY_SECRET_403');
      expect(JSON.stringify(authErr.details)).not.toContain('FORBIDDEN_CANARY_SECRET_403');
    }
  });

  it('maps HTTP 429 to CoinDcxRateLimitError without reflecting provider message', async () => {
    resetMock();
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });

    mockStatusCode = 429;
    mockHeaders = {
      'Content-Type': 'application/json',
      'Retry-After': '45',
    };
    mockResponseBody = JSON.stringify({ message: 'RATE_CANARY_SECRET_429' });

    try {
      await transport.executeRead({
        endpoint: 'ACTIVE_INSTRUMENTS',
      });
      expect.unreachable('Should have thrown CoinDcxRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(CoinDcxRateLimitError);
      const rateLimitErr = err as CoinDcxRateLimitError;
      expect(rateLimitErr.statusCode).toBe(429);
      expect(rateLimitErr.retryAfterMs).toBe(45000);
      expect(rateLimitErr.message).toBe('CoinDCX rate limit exceeded');
      expect(rateLimitErr.message).not.toContain('RATE_CANARY_SECRET_429');
      expect(JSON.stringify(rateLimitErr.details)).not.toContain('RATE_CANARY_SECRET_429');
    }
  });

  it('maps HTTP 500, 502, 503 to CoinDcxProviderError without reflecting provider message or internal trace', async () => {
    resetMock();
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });

    mockStatusCode = 502;
    mockResponseBody = JSON.stringify({
      message: 'SERVER_CANARY_SECRET_502',
      stack_trace: 'internal database password leak',
    });

    try {
      await transport.executeRead({
        endpoint: 'ACTIVE_INSTRUMENTS',
      });
      expect.unreachable('Should have thrown CoinDcxProviderError');
    } catch (err) {
      expect(err).toBeInstanceOf(CoinDcxProviderError);
      const providerErr = err as CoinDcxProviderError;
      expect(providerErr.statusCode).toBe(502);
      expect(providerErr.message).toBe('CoinDCX provider request failed');
      expect(providerErr.message).not.toContain('SERVER_CANARY_SECRET_502');
      expect(JSON.stringify(providerErr.details)).not.toContain('SERVER_CANARY_SECRET_502');
      expect(JSON.stringify(providerErr.details)).not.toContain('database password');
    }
  });

  it('maps request timeout to CoinDcxTimeoutError', async () => {
    resetMock();
    const transport = new CoinDcxTransport({
      baseUrl: serverUrl,
      timeoutMs: 50,
    });

    mockDelayMs = 200;

    await expect(
      transport.executeRead({
        endpoint: 'ACTIVE_INSTRUMENTS',
      })
    ).rejects.toThrow(CoinDcxTimeoutError);
  });

  it('maps invalid JSON responses to CoinDcxResponseValidationError without reflecting raw body', async () => {
    resetMock();
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });

    mockStatusCode = 200;
    mockResponseBody = '<html><body>CANARY_HTML_SECRET_BODY_999</body></html>';

    try {
      await transport.executeRead({
        endpoint: 'ACTIVE_INSTRUMENTS',
      });
      expect.unreachable('Should have thrown CoinDcxResponseValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(CoinDcxResponseValidationError);
      const valErr = err as CoinDcxResponseValidationError;
      expect(valErr.message).toBe('CoinDCX response validation failed: invalid JSON received');
      expect(valErr.message).not.toContain('CANARY_HTML_SECRET_BODY_999');
      expect(JSON.stringify(valErr.details)).not.toContain('CANARY_HTML_SECRET_BODY_999');
    }
  });


  it('enforces maximum response byte limits', async () => {
    resetMock();
    const transport = new CoinDcxTransport({
      baseUrl: serverUrl,
      maxResponseBytes: 50,
    });

    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({ data: 'A'.repeat(200) });

    await expect(
      transport.executeRead({
        endpoint: 'ACTIVE_INSTRUMENTS',
      })
    ).rejects.toThrow(CoinDcxProviderError);
  });

  it('throws CoinDcxAuthError if authentication is required but API key or signer is missing', async () => {
    const transportNoKey = new CoinDcxTransport({ baseUrl: serverUrl, signer });
    await expect(
      transportNoKey.executeRead({
        endpoint: 'USER_INFO',
        body: '{}',
      })
    ).rejects.toThrow(CoinDcxAuthError);

    const transportNoSigner = new CoinDcxTransport({ baseUrl: serverUrl, apiKey: 'my-key' });
    await expect(
      transportNoSigner.executeRead({
        endpoint: 'USER_INFO',
        body: '{}',
      })
    ).rejects.toThrow(CoinDcxAuthError);
  });
});
