import { CoinDcxResponseValidationError, ValidationError } from '../../core/errors/app-error';
import type { InrFuturesInstrument } from './models';
import { normalizeInstrument } from './normalizers';
import { InstrumentDetailsResponseSchema } from './schemas';
import type { CoinDcxTransport } from './transport';

/**
 * The single CoinDCX INR-Futures instrument read pipeline shared by the
 * general read-only client and the production instrument authority.
 *
 * This function deliberately returns only structural normalized data. Passing
 * an injected transport here can never mint production trust; the authority
 * constructs its own default CoinDcxTransport before it calls this reader.
 */
export async function readInrFuturesInstrument(
  transport: CoinDcxTransport,
  pair: string,
): Promise<InrFuturesInstrument> {
  if (typeof pair !== 'string' || !/^B-[A-Z0-9]+_[A-Z0-9]+$/.test(pair.trim())) {
    throw new ValidationError('Pair must use canonical uppercase B-<BASE>_<QUOTE> format');
  }

  const requestedPair = pair.trim();
  const response = await transport.executeRead<unknown>({
    endpoint: 'INSTRUMENT',
    queryParams: { pair: requestedPair, margin_currency_short_name: 'INR' },
  });
  const parsed = InstrumentDetailsResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new CoinDcxResponseValidationError(
      `Failed to parse instrument specifications for ${pair}: ${parsed.error.message}`,
      { issues: parsed.error.issues, pair: requestedPair },
    );
  }
  if (parsed.data.instrument.pair !== requestedPair) {
    throw new CoinDcxResponseValidationError('Instrument response pair does not match requested pair', { pair: requestedPair });
  }
  return normalizeInstrument(parsed.data.instrument);
}
