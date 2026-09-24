import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HmacSha256Signer } from '../../../../src/integration/coindcx/signer';
import * as allowlist from '../../../../scripts/provider-probe/allowlist';
import { PROBE_JOIN_SIGNED_BODY, productionProbeSocketFactory } from '../../../../scripts/provider-probe/ws-probe';

// Fully offline: `socket.io-client` is replaced by an in-memory double, so the
// REAL production probe socket factory runs without any network. The allowlist
// guard is wrapped in a spy that calls through, to prove it runs before the
// single raw emission.

const fake = vi.hoisted(() => {
  class FakeRawIoSocket {
    public readonly emitted: { event: string; args: unknown[] }[] = [];
    public readonly delivered: unknown[] = [];
    public readonly id = 'raw-socket-id';
    public readonly io = { engine: { id: 'raw-engine-id' } };
    public constructor(public readonly url: string, public readonly options: unknown) {}
    public connect(): void {}
    public disconnect(): void {}
    public on(): void {}
    public emit(event: string, ...args: unknown[]): void { this.emitted.push({ event, args }); }
    public onevent(packet: unknown): void { this.delivered.push(packet); }
  }
  const created: FakeRawIoSocket[] = [];
  return { created, io: (url: string, options: unknown) => { const socket = new FakeRawIoSocket(url, options); created.push(socket); return socket; } };
});

vi.mock('socket.io-client', () => ({ default: fake.io }));
vi.mock('../../../../scripts/provider-probe/allowlist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../scripts/provider-probe/allowlist')>();
  return { ...actual, assertReadOnlySocketEmit: vi.fn(actual.assertReadOnlySocketEmit) };
});

const API_KEY = 'fake-ws-api-key-0123456789';
const signer = new HmacSha256Signer('fake-ws-api-secret-0123456789');
const guard = vi.mocked(allowlist.assertReadOnlySocketEmit);

describe('[probe ws] PROBE-01: the production socket exposes no generic emit', () => {
  beforeEach(() => {
    fake.created.length = 0;
    guard.mockClear();
  });

  it('creates exactly one raw socket at the fixed origin with reconnection off, autoConnect off, and forceNew', () => {
    productionProbeSocketFactory(allowlist.PROBE_SOCKET_ORIGIN);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.url).toBe('wss://stream.coindcx.com');
    expect(fake.created[0]!.options).toEqual({ transports: ['websocket'], reconnection: false, autoConnect: false, forceNew: true });
  });

  it('refuses any other origin before creating a socket', () => {
    const factory = productionProbeSocketFactory as (origin: string) => unknown;
    for (const origin of ['wss://stream.coindcx.com/', 'wss://evil.example', 'https://api.coindcx.com']) {
      expect(() => factory(origin)).toThrow(/PROBE_SOCKET_OPERATION_REJECTED/);
    }
    expect(fake.created).toHaveLength(0);
  });

  it('returns only receive-side operations plus the semantic join: no emit, no raw socket', () => {
    const socket = productionProbeSocketFactory(allowlist.PROBE_SOCKET_ORIGIN);
    expect(Object.keys(socket).sort()).toEqual(['connect', 'disconnect', 'engineId', 'joinPrivateAccountChannel', 'on', 'onAnyServerEvent', 'socketId']);
    expect('emit' in socket).toBe(false);
    for (const value of Object.values(socket)) expect(value).not.toBe(fake.created[0]);
  });

  it('joinPrivateAccountChannel emits exactly the fixed coindcx join, after the allowlist guard', () => {
    const socket = productionProbeSocketFactory(allowlist.PROBE_SOCKET_ORIGIN);
    socket.joinPrivateAccountChannel(API_KEY, signer);
    const payload = { channelName: 'coindcx', authSignature: signer.sign(PROBE_JOIN_SIGNED_BODY), apiKey: API_KEY };
    expect(fake.created[0]!.emitted).toEqual([{ event: 'join', args: [payload] }]);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith('join', payload);
  });

  it('the guard dominates the raw emit: if it throws, nothing reaches the socket', () => {
    const socket = productionProbeSocketFactory(allowlist.PROBE_SOCKET_ORIGIN);
    guard.mockImplementationOnce(() => { throw new allowlist.ProbeSafetyError('PROBE_SOCKET_OPERATION_REJECTED', 'test'); });
    expect(() => socket.joinPrivateAccountChannel(API_KEY, signer)).toThrow(/PROBE_SOCKET_OPERATION_REJECTED/);
    expect(fake.created[0]!.emitted).toEqual([]);
  });

  it('the catch-all hook still observes server events and forwards them to socket.io', () => {
    const socket = productionProbeSocketFactory(allowlist.PROBE_SOCKET_ORIGIN);
    const seen: [string, readonly unknown[]][] = [];
    socket.onAnyServerEvent((event, args) => seen.push([event, args]));
    const raw = fake.created[0]!;
    raw.onevent({ data: ['df-order-update', { x: 1 }] });
    expect(seen).toEqual([['df-order-update', [{ x: 1 }]]]);
    expect(raw.delivered).toHaveLength(1);
    expect(socket.socketId()).toBe('raw-socket-id');
    expect(socket.engineId()).toBe('raw-engine-id');
    expect(raw.emitted).toEqual([]);
  });
});
