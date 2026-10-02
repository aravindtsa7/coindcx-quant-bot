import { parse } from 'lossless-json';
import { createRequire } from 'node:module';

/** Numeric lexemes become strings before any native JSON decoder can round them. */
function parseExactJson(text: string): unknown {
  return parse(text, undefined, (token: string) => token);
}

export function decodeCandlePayload(raw: unknown): unknown {
  let value = typeof raw === 'string' ? parseExactJson(raw) : raw;
  if (value && typeof value === 'object') {
    const envelope = value as Record<string, unknown>;
    if (typeof envelope.data === 'string') {
      const inner = parseExactJson(envelope.data);
      if (Array.isArray(inner)) value = { ...envelope, data: inner };
      else if (inner && typeof inner === 'object') value = { ...envelope, ...inner };
    }
  }
  return value;
}

// Delegate Socket.IO protocol framing/binary reconstruction to its installed parser.
// Only candlestick event JSON is rewritten; private notifications and control packets
// retain their existing contract. No global parser/configuration is modified.
interface Decoder {
  add(packet: unknown): void;
  destroy(): void;
}
const stockParser = createRequire(__filename)('socket.io-parser') as {
  Encoder: new () => unknown;
  Decoder: new () => Decoder;
};

class ExactCandleDecoder extends stockParser.Decoder {
  public constructor() {
    super();
    Object.defineProperty(this, 'add', { value: Object.freeze(originalExactCandleAdd.bind(this)),
      writable: false, configurable: false });
  }
  public override add(packet: unknown): void {
    if (typeof packet === 'string') {
      // EVENT/BINARY_EVENT, optional attachments, namespace and acknowledgment id.
      const frame = /^([25](?:\d+-)?(?:\/[^,]*,)?\d*)(\[.*)$/s.exec(packet);
      if (frame) {
        let payload: unknown;
        try { payload = parseExactJson(frame[2]!); }
        catch { super.add('4"Malformed event JSON"'); return; }
        if (Array.isArray(payload) && payload[0] === 'candlestick') {
          if (packet[0] === '5') { super.add('4"Binary candlestick evidence is unsupported"'); return; }
          packet = frame[1]! + JSON.stringify(payload);
        }
      }
    }
    super.add(packet);
  }
}

const originalExactCandleAdd = ExactCandleDecoder.prototype.add;
Object.freeze(originalExactCandleAdd);
Object.freeze(ExactCandleDecoder.prototype);
Object.freeze(ExactCandleDecoder);

/** Installed after caller options so exact candle decoding cannot be overridden. */
export const EXACT_CANDLE_SOCKET_PARSER = Object.freeze({ Encoder: stockParser.Encoder, Decoder: ExactCandleDecoder });

// Reviewed defining-owner binding protection.

if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const name of ["EXACT_CANDLE_SOCKET_PARSER"]) {
    const value = module.exports[name] as unknown;
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.set !== undefined || (descriptor.get === undefined && descriptor.writable !== false) || module.exports[name] !== value) throw new Error('OWNED_TRUSTED_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
