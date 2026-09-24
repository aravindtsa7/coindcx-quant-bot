/**
 * The ONLY implementation of `LiveOrphanCancellationPort` (§9.1, §20).
 *
 * It wraps the already-approved Phase17 `CoinDcxFuturesOrderGateway` PORT. It
 * builds no HTTP request, holds no credential, names no endpoint, and imports
 * nothing from `src/integration/**` — so an orphan cancellation travels the
 * exact transport, signer and endpoint map that every other Phase17 mutation
 * does, and Phase18 introduces no second raw-network mutation owner.
 *
 * It is deliberately a thin translation and nothing more. Every safety
 * decision — whether cleanup is enabled at all, whether the account is
 * allowlisted, whether a durable claim exists, and what an unestablished
 * outcome means — is made before this object is called, by the policy gate and
 * the durable claim in the repository. This class cannot be used to cancel
 * anything the caller has not already claimed.
 */
import type { CoinDcxFuturesOrderGateway } from '../gateway';
import type { LiveOrphanCancellationPort, LiveOrphanCancelResult } from './ports';

export class GatewayOrphanCancellation implements LiveOrphanCancellationPort {
  readonly #gateway: CoinDcxFuturesOrderGateway;

  public constructor(gateway: CoinDcxFuturesOrderGateway) {
    this.#gateway = gateway;
  }

  public async cancelVenueOrder(request: {
    readonly exchangeOrderId: string;
    readonly pair: string;
    readonly timeoutMs: number;
  }): Promise<LiveOrphanCancelResult> {
    const result = await this.#gateway.cancelOrder({
      // An orphan has no local intent, so there is no local client order id to
      // supply. The venue is addressed by its own exact order identity, which
      // is the only identity the cancel contract actually uses.
      clientOrderId: '',
      exchangeOrderId: request.exchangeOrderId,
      pair: request.pair,
      timeoutMs: request.timeoutMs,
    });

    switch (result.kind) {
      case 'CANCEL_ACCEPTED':
        return Object.freeze({ kind: 'CANCELLED' as const });
      case 'REJECTED':
        return Object.freeze({ kind: 'REJECTED' as const, reasonCode: result.reasonCode });
      case 'PRE_DISPATCH_FAILURE':
        return Object.freeze({ kind: 'PRE_DISPATCH_FAILURE' as const, reasonCode: result.reasonCode });
      case 'AMBIGUOUS':
      default:
        // Unestablished stays unestablished. It is never optimistically read as
        // a success, and the caller turns it into a blocking finding.
        return Object.freeze({ kind: 'AMBIGUOUS' as const, reasonCode: result.reasonCode });
    }
  }
}
