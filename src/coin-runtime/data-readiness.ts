import { CoinLifecycleError } from '../core/errors/app-error';
import { InrFuturesInstrument } from '../integration/coindcx/models';
import { Decimal } from '../core/decimal/decimal';
import { CoinProfile, InstrumentMetadata } from './types';
import { validateCoinProfile } from './validation';
import { determineEntryEligibility } from './instrument-mapper';

/** Implemented by the Phase 2 CoinDcxClient. Completion returns exchange evidence, not a ready flag. */
export interface DataReadinessInstrumentReader {
  getInrFuturesInstrument(pair: string): Promise<InrFuturesInstrument>;
}

export function assertDataInitializationMetadata(profile: CoinProfile, instrument: InstrumentMetadata): void {
  validateCoinProfile(profile);
  const pairParts = /^B-([A-Z0-9]+)_([A-Z0-9]+)$/.exec(instrument.pair);
  if (!profile.enabled || !profile.dataEnabled || !pairParts ||
    pairParts[1] !== profile.underlying || pairParts[2] !== instrument.quoteCurrency ||
    instrument.underlying !== profile.underlying || instrument.marginCurrency !== 'INR' ||
    instrument.status.toLowerCase() !== 'active' || instrument.kind.toLowerCase() !== 'perpetual' ||
    !(instrument.unitContractValue instanceof Decimal) || !instrument.unitContractValue.isFinite() ||
    !instrument.unitContractValue.greaterThan(0)) {
    throw new CoinLifecycleError('Coin metadata is not usable for data initialization');
  }
  // Reuse the existing numeric metadata checks, independently of entry restrictions.
  // Exit-only/unknown restriction evidence must remain entry-ineligible, but permits data loading.
  if (determineEntryEligibility(profile, { ...instrument, exitOnly: false }) !== 'ELIGIBLE') {
    throw new CoinLifecycleError('Coin data initialization requires complete valid instrument metadata');
  }
}
