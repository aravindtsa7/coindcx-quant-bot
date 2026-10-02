/** Unwired integration-owned construction. Local provenance is never authority. */
import { inspect, types } from 'node:util';
import type { PracticalVenueReadPort } from '../../../execution/live/practical-recovery/ports';
import type { CoinDcxFuturesOrderGateway } from '../../../execution/live/gateway';
import { createOwnedCoinDcxReadClient } from '../client';
import { createOwnedCoinDcxPrivateStream, type CoinDcxPrivateAccountStream } from '../websocket/private-stream';
import { createOwnedCoinDcxReader } from './reconciliation-evidence-adapter';
import { createOwnedCoinDcxMutationGateway } from './order-gateway';

export interface CoinDcxCredentialConstructionOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly configuredAccountId: string;
  readonly expectedProviderAccountFingerprint: string;
  readonly restOrigin?: string | undefined;
  readonly streamEndpoint?: string | undefined;
}
export interface CoinDcxPracticalSourceSet {
  readonly reader: PracticalVenueReadPort;
  readonly privateStream: CoinDcxPrivateAccountStream;
  readonly gateway: Pick<CoinDcxFuturesOrderGateway, 'cancelOrder'>;
}
export interface CoinDcxCredentialScope {
  readonly configuredAccountId: string;
  readonly expectedProviderAccountFingerprint: string;
}
export type CredentialConstructionRefusal = 'INVALID_OPTIONS' | 'OPTION_READ_FAILED' | 'INVALID_CREDENTIALS'
  | 'INVALID_ACCOUNT_EXPECTATIONS' | 'INVALID_ENDPOINT' | 'INCOMPATIBLE_ENVIRONMENT'
  | 'UNSUPPORTED_ENVIRONMENT' | 'CONSTRUCTION_FAILED';
export type CredentialConstructionResult =
  | Readonly<{ kind: 'CONSTRUCTED'; association: CoinDcxCredentialOriginAssociation }>
  | Readonly<{ kind: 'REFUSED'; code: CredentialConstructionRefusal }>;
export type CredentialAssociationCheck =
  | Readonly<{ kind: 'LOCAL_CONSTRUCTION_ASSOCIATED' }>
  | Readonly<{ kind: 'REFUSED'; code: 'INVALID_ASSOCIATION' | 'INSTANCE_ASSOCIATION_MISMATCH' }>;
export type CredentialScopeCheck =
  | Readonly<{ kind: 'CONFIGURED_SCOPE_MATCH' }>
  | Readonly<{ kind: 'REFUSED'; code: 'INVALID_ASSOCIATION' | 'INVALID_SCOPE' | 'CONFIGURED_SCOPE_MISMATCH' }>;

const ISSUER = Object.freeze({});
const REST_ORIGIN = 'https://api.coindcx.com';
const STREAM_ENDPOINT = 'wss://stream.coindcx.com';
const OPTION_KEYS = Object.freeze(['apiKey', 'apiSecret', 'configuredAccountId', 'expectedProviderAccountFingerprint', 'restOrigin', 'streamEndpoint']);
const SCOPE_KEYS = Object.freeze(['configuredAccountId', 'expectedProviderAccountFingerprint']);
interface RecordData { readonly sources: Readonly<CoinDcxPracticalSourceSet>; readonly scope: Readonly<CoinDcxCredentialScope> }
let readAssociation: (value: unknown) => RecordData | null;

/** Native private brand; neither construction nor serialization can mint an origin. */
export class CoinDcxCredentialOriginAssociation {
  readonly #record: RecordData;
  public constructor(issuer: unknown, record: RecordData) {
    if (issuer !== ISSUER || new.target !== CoinDcxCredentialOriginAssociation) throw new Error('CREDENTIAL_ASSOCIATION_INVALID');
    this.#record = record;
    Object.freeze(this);
  }
  static {
    readAssociation = Object.freeze((value: unknown): RecordData | null => {
      if (typeof value !== 'object' || value === null || !(#record in value)) return null;
      return value.#record;
    });
  }
  public toJSON(): never { throw new Error('CREDENTIAL_ASSOCIATION_NOT_SERIALIZABLE'); }
  public [inspect.custom](): string { return 'CoinDcxCredentialOriginAssociation [local construction only]'; }
}

function shape(input: unknown, keys: readonly string[], dataOnly: boolean): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || types.isProxy(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return null;
  // A polluted ordinary prototype must not supply configuration.
  if (prototype !== null && Object.keys(prototype).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = descriptors[key]!;
    if (dataOnly && !Object.hasOwn(descriptor, 'value')) return null;
  }
  const retained: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) retained[key] = undefined;
    else retained[key] = Object.hasOwn(descriptor, 'value') ? descriptor.value : Reflect.get(input, key);
  }
  return retained;
}
function validScope(account: unknown, fingerprint: unknown): account is string {
  return typeof account === 'string' && account.length !== 0 && account.trim() === account
    && typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint);
}
function endpoint(value: unknown, protocol: 'https:' | 'wss:', fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
  // Reject non-origin syntax before URL canonicalization can erase dot paths,
  // empty userinfo or control characters. This operates only on a primitive.
  if (!/^[a-z]+:\/\/[^/?#\\\s@]+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== protocol || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
      || url.pathname !== '/' || value.includes('?') || value.includes('#')) return null;
    return url.origin;
  } catch { return null; }
}

export function createCoinDcxPracticalCredentialSources(options: CoinDcxCredentialConstructionOptions): CredentialConstructionResult {
  const refuse = (code: CredentialConstructionRefusal): CredentialConstructionResult => Object.freeze({ kind: 'REFUSED', code });
  let values: Record<string, unknown> | null;
  try { values = shape(options, OPTION_KEYS, false); } catch { return refuse('OPTION_READ_FAILED'); }
  if (values === null) return refuse('INVALID_OPTIONS');
  const key = values['apiKey'], secret = values['apiSecret'], account = values['configuredAccountId'], fingerprint = values['expectedProviderAccountFingerprint'];
  if (typeof key !== 'string' || key.length === 0 || key.trim() !== key
    || typeof secret !== 'string' || secret.length === 0 || secret.trim() !== secret) return refuse('INVALID_CREDENTIALS');
  if (!validScope(account, fingerprint)) return refuse('INVALID_ACCOUNT_EXPECTATIONS');
  const rest = endpoint(values['restOrigin'], 'https:', REST_ORIGIN), stream = endpoint(values['streamEndpoint'], 'wss:', STREAM_ENDPOINT);
  if (rest === null || stream === null) return refuse('INVALID_ENDPOINT');
  if ((rest === REST_ORIGIN) !== (stream === STREAM_ENDPOINT)) return refuse('INCOMPATIBLE_ENVIRONMENT');
  if (rest !== REST_ORIGIN || stream !== STREAM_ENDPOINT) return refuse('UNSUPPORTED_ENVIRONMENT');
  const credentials = Object.freeze({ apiKey: key, apiSecret: secret, baseUrl: rest });
  try {
    const client = createOwnedCoinDcxReadClient(credentials);
    const reader = createOwnedCoinDcxReader(client, account);
    const privateStream = createOwnedCoinDcxPrivateStream(Object.freeze({ apiKey: key, apiSecret: secret, endpoint: stream }));
    const gateway = createOwnedCoinDcxMutationGateway(credentials);
    const sources = Object.freeze({ reader, privateStream, gateway });
    const scope = Object.freeze({ configuredAccountId: account, expectedProviderAccountFingerprint: fingerprint as string });
    const association = new CoinDcxCredentialOriginAssociation(ISSUER, Object.freeze({ sources, scope }));
    return Object.freeze({ kind: 'CONSTRUCTED', association });
  } catch { return refuse('CONSTRUCTION_FAILED'); }
}
export function readCoinDcxPracticalCredentialSources(association: unknown): Readonly<CoinDcxPracticalSourceSet> | null {
  return readAssociation(association)?.sources ?? null;
}
export function checkCoinDcxPracticalCredentialSources(association: unknown, sources: unknown): CredentialAssociationCheck {
  const original = readCoinDcxPracticalCredentialSources(association);
  if (original === null) return Object.freeze({ kind: 'REFUSED', code: 'INVALID_ASSOCIATION' });
  return original === sources ? Object.freeze({ kind: 'LOCAL_CONSTRUCTION_ASSOCIATED' })
    : Object.freeze({ kind: 'REFUSED', code: 'INSTANCE_ASSOCIATION_MISMATCH' });
}
export function checkCoinDcxCredentialScope(association: unknown, expected: CoinDcxCredentialScope): CredentialScopeCheck {
  const record = readAssociation(association);
  if (record === null) return Object.freeze({ kind: 'REFUSED', code: 'INVALID_ASSOCIATION' });
  let scope: Record<string, unknown> | null;
  try { scope = shape(expected, SCOPE_KEYS, true); } catch { scope = null; }
  if (scope === null || !validScope(scope['configuredAccountId'], scope['expectedProviderAccountFingerprint'])) return Object.freeze({ kind: 'REFUSED', code: 'INVALID_SCOPE' });
  return scope['configuredAccountId'] === record.scope.configuredAccountId && scope['expectedProviderAccountFingerprint'] === record.scope.expectedProviderAccountFingerprint
    ? Object.freeze({ kind: 'CONFIGURED_SCOPE_MATCH' }) : Object.freeze({ kind: 'REFUSED', code: 'CONFIGURED_SCOPE_MISMATCH' });
}

Object.freeze(CoinDcxCredentialOriginAssociation.prototype);
Object.freeze(CoinDcxCredentialOriginAssociation);
for (const value of [readCoinDcxPracticalCredentialSources, checkCoinDcxPracticalCredentialSources,
  checkCoinDcxCredentialScope, createCoinDcxPracticalCredentialSources]) Object.freeze(value);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ CoinDcxCredentialOriginAssociation, createCoinDcxPracticalCredentialSources,
    readCoinDcxPracticalCredentialSources, checkCoinDcxPracticalCredentialSources, checkCoinDcxCredentialScope })) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.get === undefined || descriptor.set !== undefined || module.exports[name] !== value) throw new Error('CREDENTIAL_CONSTRUCTION_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
  Object.freeze(module.exports);
}
