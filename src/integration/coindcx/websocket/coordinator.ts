import { MarketDataSubscriptionIntent } from '../../../coin-runtime/types';
import { CoinDcxPrivateAccountStream, PrivateStreamConfig } from './private-stream';
import { CoinDcxPublicFuturesStream, PublicStreamConfig } from './public-stream';

export interface StreamCoordinatorConfig {
  publicConfig?: PublicStreamConfig;
  privateConfig?: PrivateStreamConfig;
}

/**
 * Lightweight coordinator composing Public Futures and Private Account streams.
 *
 * Invariants:
 * - Does NOT auto-start the private socket in development or testing.
 * - Enforces clean separation between public market data and private account data.
 * - Idempotent stopAll() tears down both streams cleanly.
 */
export class CoinDcxStreamCoordinator {
  readonly #publicStream: CoinDcxPublicFuturesStream;
  #privateStream: CoinDcxPrivateAccountStream | null = null;
  readonly #privateConfig: PrivateStreamConfig | undefined;

  constructor(config: StreamCoordinatorConfig = {}) {
    this.#publicStream = new CoinDcxPublicFuturesStream(config.publicConfig);
    this.#privateConfig = config.privateConfig;
  }

  public get publicStream(): CoinDcxPublicFuturesStream {
    return this.#publicStream;
  }

  public get privateStream(): CoinDcxPrivateAccountStream | null {
    return this.#privateStream;
  }

  public async startPublic(intents: readonly MarketDataSubscriptionIntent[]): Promise<void> {
    return this.#publicStream.start(intents);
  }

  public async startPrivate(overrideConfig?: PrivateStreamConfig): Promise<void> {
    const finalConfig = overrideConfig ?? this.#privateConfig;
    if (!finalConfig) {
      throw new Error('Private stream configuration (apiKey/apiSecret) must be provided');
    }

    if (!this.#privateStream) {
      this.#privateStream = new CoinDcxPrivateAccountStream(finalConfig);
    }

    return this.#privateStream.start();
  }

  public stopAll(): void {
    this.#publicStream.stop();
    if (this.#privateStream) {
      this.#privateStream.stop();
    }
  }
}

