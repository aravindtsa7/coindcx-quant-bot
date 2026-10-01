/** Privileged internal association machinery. No authority and no public barrel. */
import type { LiveCancelOrderRequest } from './gateway';
import { PracticalCancelDispatchOwner } from './practical-mutation/ticket';

const ISSUER = Object.freeze({ purpose: 'cancel-transport-association' });
const gateways = new WeakMap<object, { readonly source: CancelTransportSource; readonly invoke: (invocation: CancelTransportInvocation) => Promise<unknown> }>();
const transports = new WeakMap<object, CancelTransportSource>();
const reserved = new WeakSet<object>();
let transportBrand: ((value: unknown) => boolean) | null = null;
let gatewayBrand: ((gateway: unknown, transport: unknown) => boolean) | null = null;
type Observation = 'NONE' | 'PREPARING' | 'POSSIBLE' | 'NO_WRITE';

function refuse(): never { throw new Error('CANCEL_TRANSPORT_PROVENANCE_REFUSED'); }

/** Defining-module initialization only. Readers close over native private brands. */
export function installCancelTransportBrand(reader: (value: unknown) => boolean): void {
  if (transportBrand !== null) refuse(); transportBrand = reader;
}
export function installCancelGatewayBrand(reader: (gateway: unknown, transport: unknown) => boolean): void {
  if (gatewayBrand !== null) refuse(); gatewayBrand = reader;
}

class CancelTransportSource {
  readonly #brand = ISSUER;
  public constructor(issuer: unknown) { if (issuer !== ISSUER) refuse(); Object.freeze(this); }
  public static genuine(value: unknown): value is CancelTransportSource {
    return typeof value === 'object' && value !== null && #brand in value;
  }
  public toJSON(): never { return refuse(); }
}

export class CancelTransportInvocation {
  readonly #attempt: object;
  readonly #request: LiveCancelOrderRequest;
  readonly #source: CancelTransportSource;
  readonly #invoke: (invocation: CancelTransportInvocation) => Promise<unknown>;
  #state: 'RESERVED' | 'INVOKING' | 'SETTLED' | 'CLOSED' = 'RESERVED';
  #observation: Observation = 'NONE';
  #evidence: CancelTransportNoWriteEvidence | null = null;
  #result: unknown;
  #propagated = false;
  public constructor(issuer: unknown, attempt: object, request: LiveCancelOrderRequest, source: CancelTransportSource, invoke: (invocation: CancelTransportInvocation) => Promise<unknown>) {
    if (issuer !== ISSUER) refuse(); this.#attempt = attempt; this.#request = request; this.#source = source; this.#invoke = invoke; Object.freeze(this);
  }
  public static read(value: unknown): CancelTransportInvocation | null {
    return typeof value === 'object' && value !== null && #attempt in value ? value as CancelTransportInvocation : null;
  }
  public static request(issuer: unknown, value: unknown): LiveCancelOrderRequest {
    const v = this.read(value); if (issuer !== ISSUER || v === null || v.#state !== 'INVOKING') refuse(); return v.#request;
  }
  public static invoke(issuer: unknown, value: unknown): Promise<unknown> {
    const v = this.read(value);
    if (issuer !== ISSUER || v === null || v.#state !== 'RESERVED' || PracticalCancelDispatchOwner.status(v.#attempt) !== 'ENTERED') refuse();
    v.#state = 'INVOKING'; return v.#invoke(v);
  }
  public static observe(issuer: unknown, value: unknown, source: unknown, action: 'BEGIN' | 'POSSIBLE' | 'NO_WRITE'): CancelTransportNoWriteEvidence | null {
    const v = this.read(value);
    // Timeout may close the boundary while transport is still pending. Never mint late evidence.
    if (issuer !== ISSUER || v === null || v.#source !== (typeof source === 'object' && source !== null ? transports.get(source) : undefined)) refuse();
    if (v.#state !== 'INVOKING') return null;
    if (action === 'BEGIN') { if (v.#observation !== 'NONE') refuse(); v.#observation = 'PREPARING'; }
    else if (action === 'POSSIBLE') { if (v.#observation !== 'PREPARING') refuse(); v.#observation = 'POSSIBLE'; }
    else {
      if (v.#observation !== 'PREPARING') refuse(); v.#observation = 'NO_WRITE';
      v.#evidence = new CancelTransportNoWriteEvidence(ISSUER, v); return v.#evidence;
    }
    return null;
  }
  public static propagate(issuer: unknown, value: unknown, source: unknown, result: unknown, evidence: unknown): object {
    const v = this.read(value);
    if (issuer !== ISSUER || v === null || v.#source !== (typeof source === 'object' && source !== null ? gateways.get(source)?.source : undefined) || v.#propagated) refuse();
    if (v.#state !== 'INVOKING') return Object.freeze({}); // late, never inspect its payload
    if (evidence !== null && evidence !== v.#evidence) refuse();
    const envelope = Object.freeze({});
    v.#result = { envelope, result, evidence }; v.#propagated = true; return envelope;
  }
  public static settle(issuer: unknown, value: unknown, returned: unknown): { readonly result: unknown; readonly noWrite: boolean } | null {
    const v = this.read(value);
    if (issuer !== ISSUER || v === null || v.#state !== 'INVOKING') return null;
    v.#state = 'SETTLED'; // reserve BEFORE any result inspection or proof consumption
    const record = v.#result as { envelope: object; result: unknown; evidence: unknown } | undefined;
    const valid = record !== undefined && record.envelope === returned && v.#propagated;
    const noWrite = valid && v.#observation === 'NO_WRITE' && record.evidence === v.#evidence && v.#evidence !== null
      && CancelTransportNoWriteEvidence.consume(ISSUER, v.#evidence, v) && PracticalCancelDispatchOwner.status(v.#attempt) === 'ENTERED';
    v.#state = 'CLOSED'; v.#evidence = null; v.#result = undefined;
    return valid ? Object.freeze({ result: record.result, noWrite }) : null;
  }
  public static close(issuer: unknown, value: unknown): void {
    const v = this.read(value); if (issuer !== ISSUER || v === null) refuse();
    v.#state = 'CLOSED'; v.#evidence = null; v.#result = undefined;
  }
  public toJSON(): never { return refuse(); }
}

export class CancelTransportNoWriteEvidence {
  readonly #invocation: CancelTransportInvocation;
  #spent = false;
  public constructor(issuer: unknown, invocation: CancelTransportInvocation) { if (issuer !== ISSUER) refuse(); this.#invocation = invocation; Object.freeze(this); }
  public static consume(issuer: unknown, value: unknown, invocation: unknown): boolean {
    if (issuer !== ISSUER || typeof value !== 'object' || value === null || !(#invocation in value)
      || value.#invocation !== invocation || value.#spent) return false;
    value.#spent = true; return true;
  }
  public toJSON(): never { return refuse(); }
}

/** Constructor-only trusted transport issuer. Never configuration or per-call data. */
export function registerCancelTransportSource(transport: object): void {
  if (transportBrand === null || !transportBrand(transport) || transports.has(transport)) refuse(); transports.set(transport, new CancelTransportSource(ISSUER));
}
/** Constructor-only trusted adapter propagation registration. Source stays private. */
export function registerCancelGatewaySource(gateway: object, source: unknown, invoke: (invocation: CancelTransportInvocation) => Promise<unknown>): void {
  const genuine = typeof source === 'object' && source !== null ? transports.get(source) : undefined;
  if (gatewayBrand === null || !gatewayBrand(gateway, source) || genuine === undefined || !CancelTransportSource.genuine(genuine) || gateways.has(gateway)) refuse();
  gateways.set(gateway, Object.freeze({ source: genuine, invoke }));
}
export function hasCancelTransportSource(gateway: unknown): boolean { return typeof gateway === 'object' && gateway !== null && gateways.has(gateway); }
export function reserveCancelTransportInvocation(gateway: unknown, attempt: unknown, request: LiveCancelOrderRequest): CancelTransportInvocation | null {
  const binding = typeof gateway === 'object' && gateway !== null ? gateways.get(gateway) : undefined;
  if (binding === undefined) return null;
  const owner = PracticalCancelDispatchOwner.read(attempt);
  if (owner === null || owner.role !== 'ATTEMPT' || PracticalCancelDispatchOwner.status(attempt) !== 'UNENTERED'
    || reserved.has(attempt as object) || !Object.isFrozen(request)) refuse();
  const keys = Reflect.ownKeys(request);
  if (keys.length !== 4 || keys.some(key => typeof key !== 'string' || !['clientOrderId', 'exchangeOrderId', 'pair', 'timeoutMs'].includes(key))) refuse();
  for (const key of keys) if (!('value' in Object.getOwnPropertyDescriptor(request, key)!)) refuse();
  if (request.clientOrderId !== owner.armed.clientOrderId || request.exchangeOrderId !== owner.armed.exchangeOrderId || request.pair !== owner.armed.pair
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120_000) refuse();
  reserved.add(attempt as object);
  return new CancelTransportInvocation(ISSUER, attempt as object, request, binding.source, binding.invoke);
}
export function invokeCancelTransport(value: unknown): Promise<unknown> { return CancelTransportInvocation.invoke(ISSUER, value); }
export function readCancelTransportRequest(value: unknown): LiveCancelOrderRequest { return CancelTransportInvocation.request(ISSUER, value); }
export function beginCancelTransportPreparation(value: unknown, source: unknown): void { CancelTransportInvocation.observe(ISSUER, value, source, 'BEGIN'); }
export function markCancelTransmissionPossible(value: unknown, source: unknown): void { CancelTransportInvocation.observe(ISSUER, value, source, 'POSSIBLE'); }
export function issueCancelTransportNoWrite(value: unknown, source: unknown): CancelTransportNoWriteEvidence | null { return CancelTransportInvocation.observe(ISSUER, value, source, 'NO_WRITE'); }
export function propagateCancelTransportResult(value: unknown, source: unknown, result: unknown, evidence: unknown): object { return CancelTransportInvocation.propagate(ISSUER, value, source, result, evidence); }
export function settleCancelTransportInvocation(value: unknown, returned: unknown): { readonly result: unknown; readonly noWrite: boolean } | null { return CancelTransportInvocation.settle(ISSUER, value, returned); }
export function closeCancelTransportInvocation(value: unknown): void { CancelTransportInvocation.close(ISSUER, value); }

for (const value of [CancelTransportSource, CancelTransportInvocation, CancelTransportNoWriteEvidence]) { Object.freeze(value.prototype); Object.freeze(value); }
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ CancelTransportInvocation, CancelTransportNoWriteEvidence, installCancelTransportBrand, installCancelGatewayBrand, registerCancelTransportSource,
    registerCancelGatewaySource, hasCancelTransportSource, reserveCancelTransportInvocation, invokeCancelTransport, readCancelTransportRequest, beginCancelTransportPreparation,
    markCancelTransmissionPossible, issueCancelTransportNoWrite, propagateCancelTransportResult, settleCancelTransportInvocation, closeCancelTransportInvocation })) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.get === undefined || descriptor.set !== undefined || module.exports[name] !== value) throw new Error('CANCEL_PROVENANCE_EXPORT_BINDING_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
