import {
  CoinDcxAuthError,
  CoinDcxProviderError,
  CoinDcxResponseValidationError,
  ValidationError,
} from '../../core/errors/app-error';
import { createChildLogger } from '../../monitoring/logger';
import { Clock, SystemClock } from './clock';
import {
  AuthVerificationResult,
  FuturesWalletTransaction,
  InrFuturesInstrument,
  InrFuturesOrder,
  InrFuturesPosition,
  InrFuturesPositionTransaction,
  InrFuturesTrade,
  InrFuturesWallet,
} from './models';
import {
  normalizeInstrument,
  normalizeOrder,
  normalizePosition,
  normalizePositionTransaction,
  normalizeTrade,
  normalizeUserInfo,
  normalizeWallet,
  normalizeWalletTransaction,
} from './normalizers';
import {
  ActiveInstrumentsResponseSchema,
  FuturesOrdersResponseSchema,
  FuturesPositionTransactionsResponseSchema,
  FuturesPositionsResponseSchema,
  FuturesTradesResponseSchema,
  FuturesWalletTransactionsResponseSchema,
  FuturesWalletsResponseSchema,
  InstrumentDetailsResponseSchema,
  ListInrOrdersRequest,
  ListInrOrdersRequestSchema,
  ListInrPositionTransactionsRequest,
  ListInrPositionTransactionsRequestSchema,
  ListInrPositionsRequest,
  ListInrPositionsRequestSchema,
  ListInrTradesRequest,
  ListInrTradesRequestSchema,
  ListWalletTransactionsRequest,
  ListWalletTransactionsRequestSchema,
  UserInfoResponseSchema,
} from './schemas';
import { HmacSha256Signer, RequestSigner } from './signer';
import { CoinDcxTransport, TransportOptions } from './transport';

const logger = createChildLogger('coindcx:client');

export interface CoinDcxClientOptions {
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly apiSecret?: string | undefined;
  readonly clock?: Clock | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly transport?: CoinDcxTransport | undefined;
}

/**
 * Production read-only CoinDCX REST API client.
 *
 * GUARANTEES:
 * 1. Read-Only Boundary: Zero mutation methods. Only fixed Phase 2 read endpoints are reachable.
 * 2. Scoped exclusively to INR margin mode for all trading/position reads.
 * 3. Fresh millisecond timestamp per authenticated request.
 * 4. Runtime request validation: invalid caller input fails before opening network connection.
 * 5. Runtime response validation: malformed or corrupted responses fail closed.
 * 6. Financial Decimal safety: all prices, quantities, margins, fees represented as Decimal.
 */
export class CoinDcxClient {
  readonly #transport: CoinDcxTransport;
  readonly #clock: Clock;
  readonly #hasCredentials: boolean;

  constructor(options: CoinDcxClientOptions = {}) {
    this.#clock = options.clock ?? new SystemClock();

    let signer: RequestSigner | undefined;
    if (options.apiSecret && options.apiSecret.trim() !== '') {
      signer = new HmacSha256Signer(options.apiSecret);
    }

    const apiKey = options.apiKey;
    this.#hasCredentials = Boolean(
      apiKey && apiKey.trim() !== '' && signer !== undefined
    );

    if (options.transport) {
      this.#transport = options.transport;
    } else {
      const transportOpts: TransportOptions = {
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        apiKey,
        signer,
      };
      this.#transport = new CoinDcxTransport(transportOpts);
    }
  }

  #requireCredentials(endpointName: string): void {
    if (!this.#hasCredentials) {
      throw new CoinDcxAuthError(
        `CoinDCX API credentials (API key and secret) are required for ${endpointName}`,
        401,
        { endpoint: endpointName }
      );
    }
  }

  // =========================================================================
  // PUBLIC FUTURES DISCOVERY
  // =========================================================================

  /**
   * Fetches all active INR-margined futures pair identifiers.
   */
  public async listActiveInrFuturesInstruments(): Promise<string[]> {
    logger.debug('Fetching active INR Futures instruments');
    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'ACTIVE_INSTRUMENTS',
      queryParams: {
        'margin_currency_short_name[]': 'INR',
      },
    });

    const parsed = ActiveInstrumentsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError(
        `Failed to parse active INR instruments: ${parsed.error.message}`,
        { issues: parsed.error.issues }
      );
    }

    return parsed.data;
  }

  /**
   * Fetches detailed specifications and trading constraints for a discovered pair in INR margin mode.
   */
  public async getInrFuturesInstrument(pair: string): Promise<InrFuturesInstrument> {
    if (!pair || pair.trim() === '') {
      throw new ValidationError('Pair must be a non-empty string');
    }

    logger.debug({ pair }, 'Fetching INR Futures instrument specifications');
    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'INSTRUMENT',
      queryParams: {
        pair: pair.trim(),
        margin_currency_short_name: 'INR',
      },
    });

    const parsed = InstrumentDetailsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError(
        `Failed to parse instrument specifications for ${pair}: ${parsed.error.message}`,
        { issues: parsed.error.issues, pair }
      );
    }

    return normalizeInstrument(parsed.data.instrument);
  }

  /**
   * Discovers an active INR perpetual contract generically by underlying asset name (e.g. 'BTC', 'ETH', 'SOL').
   * Guarantees zero hardcoded pair symbols in core exchange logic.
   */
  public async findActiveInrPerpetualByUnderlying(
    underlyingCurrency: string
  ): Promise<InrFuturesInstrument | null> {
    if (!underlyingCurrency || underlyingCurrency.trim() === '') {
      throw new ValidationError('underlyingCurrency must be a non-empty string');
    }

    const targetUnderlying = underlyingCurrency.trim().toUpperCase();
    logger.debug({ targetUnderlying }, 'Discovering active INR perpetual by underlying');

    const pairs = await this.listActiveInrFuturesInstruments();

    // Prioritize candidates matching naming convention (e.g. B-BTC_USDT for BTC)
    const candidatePairs = pairs.filter(
      (p) =>
        p.toUpperCase().includes(`-${targetUnderlying}_`) ||
        p.toUpperCase().includes(`_${targetUnderlying}`)
    );
    const otherPairs = pairs.filter((p) => !candidatePairs.includes(p));
    const searchOrder = [...candidatePairs, ...otherPairs];

    for (const pair of searchOrder) {
      try {
        const instrument = await this.getInrFuturesInstrument(pair);
        if (
          instrument.underlyingCurrency.toUpperCase() === targetUnderlying &&
          instrument.kind.toLowerCase() === 'perpetual' &&
          instrument.status.toLowerCase() === 'active'
        ) {
          return instrument;
        }
      } catch (err) {
        logger.warn({ pair, err }, 'Failed to inspect candidate instrument during discovery');
      }
    }

    return null;
  }

  // =========================================================================
  // AUTHENTICATED USER IDENTITY
  // =========================================================================

  /**
   * Verifies API credentials connectivity against /exchange/v1/users/info.
   * Discards user email, phone number, and personal names upon receipt.
   */
  public async getUserInfoSafe(): Promise<AuthVerificationResult> {
    this.#requireCredentials('getUserInfoSafe');

    const timestamp = this.#clock.nowMs();
    const payload = JSON.stringify({ timestamp });

    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'USER_INFO',
      body: payload,
    });

    const parsed = UserInfoResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError('Failed to parse user info response', {
        issues: parsed.error.issues,
      });
    }

    const firstUser = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
    if (!firstUser) {
      throw new CoinDcxResponseValidationError('Empty user info received');
    }

    return normalizeUserInfo(firstUser);
  }

  // =========================================================================
  // AUTHENTICATED FUTURES WALLETS
  // =========================================================================

  /**
   * Fetches all Futures wallets for the authenticated account.
   */
  public async getFuturesWallets(): Promise<InrFuturesWallet[]> {
    this.#requireCredentials('getFuturesWallets');

    const timestamp = this.#clock.nowMs();
    const payload = JSON.stringify({ timestamp });

    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'FUTURES_WALLETS',
      body: payload,
    });

    const parsed = FuturesWalletsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError('Failed to parse futures wallets response', {
        issues: parsed.error.issues,
      });
    }

    return parsed.data.map(normalizeWallet);
  }

  /**
   * Retrieves specifically the INR Futures trading wallet.
   * Rejects any mistaken attribution to USDT wallet.
   */
  public async getInrFuturesWallet(): Promise<InrFuturesWallet> {
    const wallets = await this.getFuturesWallets();
    const inrWallet = wallets.find((w) => w.currency.toUpperCase() === 'INR');

    if (!inrWallet) {
      throw new CoinDcxProviderError(
        'INR Futures wallet not found on CoinDCX account. Verify INR margin mode is enabled.',
        404
      );
    }

    return inrWallet;
  }

  /**
   * Fetches Futures wallet transaction history.
   */
  public async listFuturesWalletTransactions(
    params: ListWalletTransactionsRequest = { page: '1', size: '50' }
  ): Promise<FuturesWalletTransaction[]> {
    this.#requireCredentials('listFuturesWalletTransactions');

    const validated = ListWalletTransactionsRequestSchema.safeParse(params);
    if (!validated.success) {
      throw new ValidationError(
        `Invalid wallet transactions parameters: ${validated.error.message}`,
        { issues: validated.error.issues }
      );
    }

    const timestamp = this.#clock.nowMs();
    const payload = JSON.stringify({ timestamp });

    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'WALLET_TRANSACTIONS',
      queryParams: {
        page: validated.data.page,
        size: validated.data.size,
      },
      body: payload,
    });

    const parsed = FuturesWalletTransactionsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError(
        'Failed to parse futures wallet transactions response',
        { issues: parsed.error.issues }
      );
    }

    return parsed.data.map(normalizeWalletTransaction);
  }

  // =========================================================================
  // AUTHENTICATED FUTURES POSITIONS
  // =========================================================================

  /**
   * Reads open/active Futures positions strictly scoped to INR margin currency.
   */
  public async listInrFuturesPositions(
    params: ListInrPositionsRequest = { page: '1', size: '50' }
  ): Promise<InrFuturesPosition[]> {
    this.#requireCredentials('listInrFuturesPositions');

    const validated = ListInrPositionsRequestSchema.safeParse(params);
    if (!validated.success) {
      throw new ValidationError(
        `Invalid positions request parameters: ${validated.error.message}`,
        { issues: validated.error.issues }
      );
    }

    const timestamp = this.#clock.nowMs();
    const body: Record<string, unknown> = {
      timestamp,
      page: validated.data.page,
      size: validated.data.size,
      margin_currency_short_name: ['INR'],
    };

    if (validated.data.pairs) {
      body['pairs'] = validated.data.pairs;
    }
    if (validated.data.position_ids) {
      body['position_ids'] = validated.data.position_ids;
    }

    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'FUTURES_POSITIONS',
      body: JSON.stringify(body),
    });

    const parsed = FuturesPositionsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError('Failed to parse futures positions response', {
        issues: parsed.error.issues,
      });
    }

    return parsed.data.map(normalizePosition);
  }


  // =========================================================================
  // AUTHENTICATED FUTURES ORDERS — LIST ONLY
  // =========================================================================

  /**
   * Reads Futures orders strictly scoped to INR margin currency.
   * Mandates status, side, page, and size in compliance with official CoinDCX API requirements.
   */
  public async listInrFuturesOrders(
    params: ListInrOrdersRequest
  ): Promise<InrFuturesOrder[]> {
    this.#requireCredentials('listInrFuturesOrders');

    const validated = ListInrOrdersRequestSchema.safeParse(params);
    if (!validated.success) {
      throw new ValidationError(
        `Invalid list orders parameters: ${validated.error.message}`,
        { issues: validated.error.issues }
      );
    }

    const timestamp = this.#clock.nowMs();
    const body: Record<string, unknown> = {
      timestamp,
      status: validated.data.status,
      side: validated.data.side,
      page: validated.data.page,
      size: validated.data.size,
      margin_currency_short_name: ['INR'], // Injected internally
    };

    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'FUTURES_ORDERS',
      body: JSON.stringify(body),
    });

    const parsed = FuturesOrdersResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError('Failed to parse futures orders response', {
        issues: parsed.error.issues,
      });
    }

    return parsed.data.map(normalizeOrder);
  }

  // =========================================================================
  // AUTHENTICATED FUTURES POSITION TRANSACTIONS
  // =========================================================================

  /**
   * Reads Futures position transactions for INR margin mode.
   * Mandates explicit stage parameter (funding, default, exit, tpsl_exit, liquidation).
   */
  public async listInrFuturesPositionTransactions(
    params: ListInrPositionTransactionsRequest
  ): Promise<InrFuturesPositionTransaction[]> {
    this.#requireCredentials('listInrFuturesPositionTransactions');

    const validated = ListInrPositionTransactionsRequestSchema.safeParse(params);
    if (!validated.success) {
      throw new ValidationError(
        `Invalid position transactions parameters: ${validated.error.message}`,
        { issues: validated.error.issues }
      );
    }

    const timestamp = this.#clock.nowMs();
    const payload = JSON.stringify({
      timestamp,
      stage: validated.data.stage,
      page: validated.data.page,
      size: validated.data.size,
      margin_currency_short_name: ['INR'],
    });

    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'POSITION_TRANSACTIONS',
      body: payload,
    });

    const parsed = FuturesPositionTransactionsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError(
        'Failed to parse futures position transactions response',
        { issues: parsed.error.issues }
      );
    }

    return parsed.data.map(normalizePositionTransaction);
  }

  // =========================================================================
  // AUTHENTICATED FUTURES TRADES
  // =========================================================================

  /**
   * Reads executed Futures trades for a specific pair and date range in INR margin mode.
   */
  public async listInrFuturesTrades(
    params: ListInrTradesRequest
  ): Promise<InrFuturesTrade[]> {
    this.#requireCredentials('listInrFuturesTrades');

    const validated = ListInrTradesRequestSchema.safeParse(params);
    if (!validated.success) {
      throw new ValidationError(
        `Invalid trades request parameters: ${validated.error.message}`,
        { issues: validated.error.issues }
      );
    }

    const timestamp = this.#clock.nowMs();
    const body: Record<string, unknown> = {
      timestamp,
      pair: validated.data.pair,
      from_date: validated.data.fromDate,
      to_date: validated.data.toDate,
      page: validated.data.page,
      size: validated.data.size,
      margin_currency_short_name: ['INR'],
    };

    if (validated.data.orderId) {
      body['order_id'] = validated.data.orderId;
    }

    const response = await this.#transport.executeRead<unknown>({
      endpoint: 'FUTURES_TRADES',
      body: JSON.stringify(body),
    });

    const parsed = FuturesTradesResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new CoinDcxResponseValidationError('Failed to parse futures trades response', {
        issues: parsed.error.issues,
      });
    }

    return parsed.data.map(normalizeTrade);
  }
}
