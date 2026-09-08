import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../../src/core/decimal/decimal';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { ProductionCoinDcxSocket } from '../../../../src/integration/coindcx/websocket/socket-adapter';
import { validateAndNormalizeCandleEvent } from '../../../../src/integration/coindcx/websocket/schemas';
import { CoinDcxFuturesCandleRestReader } from '../../../../src/market-data/rest-candle-reader';
import { PublicCandleUpdatePayload } from '../../../../src/integration/coindcx/websocket/types';
import { createTestStreamContext } from './test-helpers';
import { setup, P, T, M, flushQueues } from '../../market-data/audit-a1-helpers';

function raw(token: string, t = T, quote = 'null') {
  return `{"data":[{"open":${token},"high":${token},"low":${token},"close":${token},"volume":${token},"quote_volume":${quote},"open_time":${t},"close_time":${t + 59999},"pair":"${P}","duration":"1m"}],"Ets":${t + 1000},"i":"1m","channel":"${P}_1m-futures","pr":"futures"}`;
}
type Packet = { data: [string, unknown] };
function productionDecoder() {
  const socket = new ProductionCoinDcxSocket('http://127.0.0.1:1'); // autoConnect:false: no network access
  const manager = (socket.getRawSocketForTesting() as unknown as {
    io: { decoder: { add(packet: string): void; on(event: string, listener: (packet: Packet) => void): void; destroy(): void }; opts: Record<string, unknown> };
  }).io;
  return { socket, decoder: manager.decoder, options: manager.opts };
}

describe('A-F19 exact public WebSocket financial evidence', () => {
  it.each(['12345678.123456789', '9007199254740993', '0.000000000000000001', '1.2345678123456789e7'])(
    'numeric token and decimal string retain identical exact OHLCV: %s', token => {
      const numeric = validateAndNormalizeCandleEvent(raw(token, T, token), P);
      const string = validateAndNormalizeCandleEvent(raw(JSON.stringify(token), T, JSON.stringify(token)), P);
      for (const field of ['open', 'high', 'low', 'close', 'volume', 'quoteVolume'] as const) {
        expect(numeric[field]?.equals(new Decimal(token))).toBe(true);
        expect(numeric[field]?.equals(string[field]!)).toBe(true);
      }
    },
  );

  it('unavailable quoteVolume stays null', () => {
    expect(validateAndNormalizeCandleEvent(raw('1'), P).quoteVolume).toBeNull();
  });

  it.each(['NaN', '{}', '"0x10"', '"1e99999999"', '1e-19', '1000000000000000000'])(
    'malformed or canonically unrepresentable financial token rejects: %s', token => {
      expect(() => validateAndNormalizeCandleEvent(raw(token), P)).toThrow();
    },
  );

  it('already rounded numeric object evidence is rejected, never repaired from Number.toString', () => {
    expect(() => validateAndNormalizeCandleEvent(JSON.parse(raw('12345678.123456789')), P)).toThrow(/exact wire/);
  });

  it.each(['array', 'envelope'])('nested JSON %s preserves financial tokens', shape => {
    const exact = '12345678.123456789';
    const text = raw(exact);
    const outer = shape === 'array'
      ? { ...JSON.parse(raw('1')), data: text.slice(text.indexOf('['), text.indexOf(']') + 1) }
      : { data: text };
    expect(validateAndNormalizeCandleEvent(JSON.stringify(outer), P).close.toFixed()).toBe(exact);
  });

  it.each(['2', '2/market,17'])('production Socket.IO decoder preserves exactness before native decode: prefix %s', prefix => {
    const { socket, decoder, options } = productionDecoder();
    try {
      const packets: Packet[] = []; decoder.on('decoded', packet => packets.push(packet));
      decoder.add(prefix + '["candlestick",' + raw('12345678.123456789') + ']');
      expect(validateAndNormalizeCandleEvent(packets[0]!.data[1], P).close.toFixed()).toBe('12345678.123456789');
      expect(Object.isFrozen(options.parser)).toBe(true);
      expect(options.forceNew).toBe(true);
    } finally { decoder.destroy(); socket.disconnect(); }
  });

  it('private/control packet numeric types retain their existing contract', () => {
    const { socket, decoder } = productionDecoder();
    try {
      const packets: Packet[] = []; decoder.on('decoded', packet => packets.push(packet));
      decoder.add('2["balance-update",{"balance":123.5}]');
      expect(packets[0]!.data[1]).toEqual({ balance: 123.5 });
    } finally { decoder.destroy(); socket.disconnect(); }
  });

  it.each(['2["candlestick",{"open":NaN}]', '51-["candlestick",{}]'])(
    'malformed/unsupported wire frame emits a socket error without uncaught decoder failure: %s', frame => {
      const { socket, decoder } = productionDecoder();
      try {
        const packets: unknown[] = []; decoder.on('decoded', packet => packets.push(packet));
        expect(() => decoder.add(frame)).not.toThrow();
        expect(packets).toEqual([expect.objectContaining({ type: 4 })]);
      } finally { decoder.destroy(); socket.disconnect(); }
    },
  );

  it.each(['1788868800000.1', '9007199254740992', '-1', '1700000000.000000000000000000000000000000001'])('unsafe/fractional-millisecond provider timestamp rejects: %s', ets => {
    expect(() => validateAndNormalizeCandleEvent(raw('1').replace(`"Ets":${T + 1000}`, `"Ets":${ets}`), P)).toThrow();
  });

  it('fractional seconds representing exact milliseconds normalize without flooring', () => {
    const text = raw('1').replace(`"close_time":${T + 59999}`, `"close_time":${(T + 59999) / 1000}`);
    expect(validateAndNormalizeCandleEvent(text, P).closeTimeMs).toBe(T + 59999);
  });

  it('raw Socket.IO frame -> public stream -> canonical persistence -> REST reconciliation is exact', async () => {
    const c = setup(T + M + 1000), ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({ ...ctx, clock: c.clock });
    const { socket, decoder } = productionDecoder();
    const pending: Promise<void>[] = [], normalized: string[] = [];
    stream.subscribe(envelope => {
      if (envelope.eventType === 'PUBLIC_CANDLE_UPDATE') normalized.push((envelope.payload as PublicCandleUpdatePayload).close.toFixed());
      pending.push(c.engine.handleStreamEnvelope(envelope));
    });
    try {
      await stream.start([{ underlying: 'BTC', pair: P, requiresOneMinuteCandles: true, requiresTrades: false }]);
      decoder.on('decoded', packet => ctx.socketFactory.latestSocket!.trigger(packet.data[0], packet.data[1]));
      const exact = '12345678.123456789';
      for (const t of [T, T + M]) {
        decoder.add('2["candlestick",' + raw(exact, t, exact) + ']');
        await Promise.all(pending);
      }
      c.scheduler.advanceTime(1000); await flushQueues();
      expect(normalized).toEqual([exact, exact]);
      expect(c.repository.insertCalls.map(candle => candle.close.value)).toEqual([exact]);
      const rest = new CoinDcxFuturesCandleRestReader({ clock: c.clock, httpTransport: async () =>
        `{"s":"ok","data":[{"time":${T},"open":${exact},"high":${exact},"low":${exact},"close":${exact},"volume":${exact},"quote_volume":${exact}}]}` });
      c.rest.recordsToReturn = [...await rest.fetchClosedCandles({ pair: P, fromMs: T, toMs: T })];
      expect(c.rest.recordsToReturn[0]!.close.toFixed()).toBe(exact);
      await c.engine.executeRecovery(P, T, T);
      expect(c.engine.getPairHealth(P)).toMatchObject({ truthFault: 'NONE', recoveryRequired: false });
      expect(c.repository.insertCalls).toHaveLength(1);
    } finally { decoder.destroy(); socket.disconnect(); stream.stop(); c.engine.stop(); }
  });
});
