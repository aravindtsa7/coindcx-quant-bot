import crypto from 'node:crypto';
import { CoinDcxConfigError } from '../../core/errors/app-error';

/**
 * Request signer abstraction for CoinDCX HMAC-SHA256 signature generation.
 */
export interface RequestSigner {
  sign(payload: string): string;
}

/**
 * HMAC-SHA256 implementation using Node.js crypto.
 *
 * CRITICAL INVARIANT:
 * Signs the exact serialized bytes that will be transmitted on the wire.
 */
export class HmacSha256Signer implements RequestSigner {
  private readonly secret: string;

  constructor(secret: string) {
    if (!secret || secret.trim() === '') {
      throw new CoinDcxConfigError('API secret must be a non-empty string for request signing');
    }
    this.secret = secret;
  }

  /**
   * Generates a hex HMAC-SHA256 signature over the exact payload string.
   */
  public sign(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload, 'utf8').digest('hex');
  }
}


// Capture in the defining module, before any consumer or option getter can patch prototypes.
const OWNED_DESCRIPTORS = Object.getOwnPropertyDescriptors(HmacSha256Signer.prototype);
for (const descriptor of Object.values(OWNED_DESCRIPTORS)) {
  for (const value of [descriptor.value, descriptor.get, descriptor.set]) if (typeof value === 'function') Object.freeze(value);
}
function protectOwnedInstance<T extends object>(instance: T): T {
  for (const [key, descriptor] of Object.entries(OWNED_DESCRIPTORS)) {
    if (key === 'constructor') continue;
    if (typeof descriptor.value === 'function') Object.defineProperty(instance, key, { value: Object.freeze(descriptor.value.bind(instance)), writable: false, configurable: false });
    else if (descriptor.get !== undefined) Object.defineProperty(instance, key, { get: Object.freeze(descriptor.get.bind(instance)), configurable: false });
  }
  return Object.freeze(instance);
}

/** Internal owned construction; callers are pinned, never an injectable authority port. */
export function createOwnedCoinDcxSigner(secret: string) : RequestSigner {
  if (typeof secret !== 'string' || secret.length === 0 || secret.trim() !== secret) throw new Error('CREDENTIAL_CONSTRUCTION_INVALID');
  return protectOwnedInstance(new HmacSha256Signer(secret));
}
Object.freeze(createOwnedCoinDcxSigner);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const descriptor = Object.getOwnPropertyDescriptor(module.exports, 'createOwnedCoinDcxSigner');
  if (descriptor?.configurable === false) {
    if (descriptor.get === undefined || descriptor.set !== undefined || module.exports.createOwnedCoinDcxSigner !== createOwnedCoinDcxSigner) throw new Error('CREDENTIAL_CONSTRUCTION_EXPORT_INVALID');
  } else Object.defineProperty(module.exports, 'createOwnedCoinDcxSigner', { get: () => createOwnedCoinDcxSigner, configurable: false });
}
