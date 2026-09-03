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

