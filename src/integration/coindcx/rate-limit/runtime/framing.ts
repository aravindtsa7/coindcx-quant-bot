/**
 * M2 W2: bounded length-prefixed framing for the limiter IPC (4-byte big-endian length + UTF-8 JSON).
 * A zero-length, oversized or non-JSON frame is a protocol error; the caller disconnects the peer.
 */
export type FrameResult = Readonly<{ kind: 'FRAMES'; frames: readonly unknown[] }> | Readonly<{ kind: 'PROTOCOL_ERROR'; reason: 'FRAME_TOO_LARGE' | 'EMPTY_FRAME' | 'INVALID_JSON' | 'BUFFER_OVERFLOW' }>;

export function encodeFrame(message: unknown, maxFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > maxFrameBytes) throw new RangeError(`frame of ${payload.length} bytes exceeds ${maxFrameBytes}`);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder. After a protocol error it stays failed. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #failed = false;
  readonly #maxFrameBytes: number;
  constructor(maxFrameBytes: number) { this.#maxFrameBytes = maxFrameBytes; }

  push(chunk: Buffer): FrameResult {
    if (this.#failed) return Object.freeze({ kind: 'PROTOCOL_ERROR', reason: 'BUFFER_OVERFLOW' });
    if (this.#buffer.length + chunk.length > this.#maxFrameBytes + 4) return this.#fail('BUFFER_OVERFLOW');
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0) return this.#fail('EMPTY_FRAME');
      if (length > this.#maxFrameBytes) return this.#fail('FRAME_TOO_LARGE');
      if (this.#buffer.length < 4 + length) break;
      const text = this.#buffer.subarray(4, 4 + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(4 + length);
      try { frames.push(JSON.parse(text)); } catch { return this.#fail('INVALID_JSON'); }
    }
    return Object.freeze({ kind: 'FRAMES', frames: Object.freeze(frames) });
  }

  #fail(reason: 'FRAME_TOO_LARGE' | 'EMPTY_FRAME' | 'INVALID_JSON' | 'BUFFER_OVERFLOW'): FrameResult {
    this.#failed = true;
    this.#buffer = Buffer.alloc(0);
    return Object.freeze({ kind: 'PROTOCOL_ERROR', reason });
  }
}
