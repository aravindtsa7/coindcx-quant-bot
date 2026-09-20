/**
 * Phase 16: Optional Live CoinDCX SOL Metadata Verification Gate.
 *
 * This script connects to the live CoinDCX exchange API to verify that SOL
 * perpetual futures can be discovered, normalized, and validated dynamically
 * using the production read pipeline.
 *
 * SAFETY INVARIANTS:
 * - Read-only exchange calls: zero orders, zero cancellations, zero state mutations.
 * - Pure public data: requires zero API credentials or private keys.
 * - Fails with exit code 1 if network access or instrument validation fails.
 * - Never asserts frozen market parameters (e.g. exact tier counts or fee rates),
 *   allowing for natural exchange metadata updates.
 *
 * USAGE:
 * npm run test:integration:sol-live
 */

import { CoinDcxClient } from '../src/integration/coindcx/client';
import { logger } from '../src/monitoring/logger';

async function runSolLiveVerification(): Promise<void> {
  console.log('===============================================================');
  console.log('  Phase 16 — Live CoinDCX SOL Metadata Verification Gate       ');
  console.log('===============================================================');

  const client = new CoinDcxClient();

  try {
    console.log('\n[1/3] Querying active INR futures instruments...');
    const activePairs = await client.listActiveInrFuturesInstruments();
    console.log(`[INFO] Received ${activePairs.length} active instruments from CoinDCX.`);

    console.log('\n[2/3] Dynamically discovering active INR perpetual for underlying "SOL"...');
    const instrument = await client.findActiveInrPerpetualByUnderlying('SOL');

    if (!instrument) {
      console.error('\n[FAIL] No active INR perpetual futures contract found for underlying SOL.');
      process.exit(1);
    }

    console.log('\n[3/3] Validating discovered live SOL instrument specifications:');
    console.log(`  - Discovered Pair:         ${instrument.pair}`);
    console.log(`  - Underlying Currency:     ${instrument.underlyingCurrency}`);
    console.log(`  - Product Kind:            ${instrument.kind}`);
    console.log(`  - Margin Currency:         ${instrument.marginCurrency}`);
    console.log(`  - Settle Currency:         ${instrument.settleCurrency}`);
    console.log(`  - Status:                  ${instrument.status}`);
    console.log(`  - Contract Multiplier:     ${instrument.unitContractValue.toString()}`);
    console.log(`  - Price Increment (tick):  ${instrument.priceIncrement.toString()}`);
    console.log(`  - Quantity Increment (lot):${instrument.quantityIncrement.toString()}`);
    console.log(`  - Min Trade Size:          ${instrument.minTradeSize.toString()}`);
    console.log(`  - Min Notional:            ${instrument.minNotional.toString()}`);
    console.log(`  - Dynamic Leverage Tiers:  ${instrument.dynamicPositionLeverageTiers.length} brackets`);
    console.log(`  - Dynamic Margin Tiers:    ${instrument.dynamicSafetyMarginTiers.length} brackets`);

    // Invariant assertions
    if (instrument.underlyingCurrency !== 'SOL') {
      throw new Error(`Expected underlying SOL, received '${instrument.underlyingCurrency}'`);
    }
    if (instrument.marginCurrency !== 'INR') {
      throw new Error(`Expected margin currency 'INR', received '${instrument.marginCurrency}'`);
    }
    if (instrument.kind.toLowerCase() !== 'perpetual') {
      throw new Error(`Expected kind 'perpetual', received '${instrument.kind}'`);
    }
    if (instrument.status.toLowerCase() !== 'active') {
      throw new Error(`Expected status 'active', received '${instrument.status}'`);
    }
    if (!instrument.unitContractValue.isPositive()) {
      throw new Error(`Invalid non-positive contract multiplier: ${instrument.unitContractValue.toString()}`);
    }
    if (!instrument.priceIncrement.isPositive()) {
      throw new Error(`Invalid non-positive price increment: ${instrument.priceIncrement.toString()}`);
    }
    if (!instrument.quantityIncrement.isPositive()) {
      throw new Error(`Invalid non-positive quantity increment: ${instrument.quantityIncrement.toString()}`);
    }

    console.log('\n[PASS] Live CoinDCX SOL metadata verification succeeded.');
    console.log('Current live SOL instrument is structurally compatible with the generic onboarding path.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('\n[FAIL] Live CoinDCX SOL metadata verification failed:', message);
    logger.error({ err }, 'Live CoinDCX SOL metadata verification failed');
    process.exit(1);
  }
}

runSolLiveVerification();
