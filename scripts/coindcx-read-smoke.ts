/**
 * Safe, read-only CoinDCX smoke test script.
 *
 * SAFETY INVARIANTS:
 * - Read-only queries only: no orders, no cancellations, no mutations.
 * - Zero secret leakage: never logs API key, secret, or HMAC signature.
 * - Zero PII leakage: never prints email, phone number, or full name.
 * - Authenticated checks require the explicit command-line flag: --auth.
 *
 * USAGE:
 * Public Discovery:    npm run coindcx:read-smoke
 * Authenticated Reads: npm run coindcx:read-smoke -- --auth
 */

import { getConfig } from '../src/app/config/env';
import { CoinDcxClient } from '../src/integration/coindcx/client';
import { logger } from '../src/monitoring/logger';

async function runSmoke(): Promise<void> {
  logger.info('Starting CoinDCX Read-Only Smoke Test');

  const config = getConfig();

  const client = new CoinDcxClient({
    apiKey: config.COINDCX_API_KEY || undefined,
    apiSecret: config.COINDCX_API_SECRET || undefined,
  });

  // -------------------------------------------------------------------------
  // 1. PUBLIC FUTURES DISCOVERY
  // -------------------------------------------------------------------------
  console.log('\n=== STEP 1: PUBLIC INR FUTURES DISCOVERY ===');
  try {
    const activePairs = await client.listActiveInrFuturesInstruments();
    console.log(`[PASS] Discovered ${activePairs.length} active INR Futures instruments.`);

    // Generic underlying discovery for BTC
    const btcInstrument = await client.findActiveInrPerpetualByUnderlying('BTC');
    if (btcInstrument) {
      console.log(
        `[PASS] BTC perpetual discovered: pair=${btcInstrument.pair}, status=${btcInstrument.status}, dynamicLeverageTierCount=${btcInstrument.dynamicPositionLeverageTiers.length}`
      );
    } else {
      console.log('[WARN] BTC perpetual not found in active INR instruments.');
    }

    // Generic underlying discovery for ETH
    const ethInstrument = await client.findActiveInrPerpetualByUnderlying('ETH');
    if (ethInstrument) {
      console.log(
        `[PASS] ETH perpetual discovered: pair=${ethInstrument.pair}, status=${ethInstrument.status}, dynamicLeverageTierCount=${ethInstrument.dynamicPositionLeverageTiers.length}`
      );
    } else {
      console.log('[WARN] ETH perpetual not found in active INR instruments.');
    }
  } catch (err) {
    console.error('[FAIL] Public discovery encountered error:', (err as Error).message);
  }

  // -------------------------------------------------------------------------
  // 2. AUTHENTICATED READ CHECKS (Strictly requires --auth flag)
  // -------------------------------------------------------------------------
  console.log('\n=== STEP 2: AUTHENTICATED READ CHECKS ===');

  const enableAuth = process.argv.includes('--auth');

  if (!enableAuth) {
    console.log('[INFO] Authenticated smoke checks require explicit opt-in.');
    console.log('[INFO] To run authenticated checks with local credentials, execute:');
    console.log('       npm run coindcx:read-smoke -- --auth');
    console.log('\nSmoke verification complete (Public Discovery only).');
    return;
  }

  if (!config.COINDCX_API_KEY || !config.COINDCX_API_SECRET) {
    console.log('[INFO] COINDCX_API_KEY or COINDCX_API_SECRET not set in environment.');
    console.log('[INFO] Provide credentials in your local environment to test authenticated reads.');
    console.log('\nSmoke verification complete (Public Discovery only).');
    return;
  }

  console.log('[INFO] Explicit --auth flag confirmed. Running safe authenticated reads...');

  // User Info / Connectivity Check
  try {
    const authResult = await client.getUserInfoSafe();
    console.log(
      `[PASS] Authentication verified: authenticated=${authResult.authenticated}, accountIdPresent=${Boolean(
        authResult.coindcxId
      )}`
    );
  } catch (err) {
    console.error('[FAIL] User info authentication check failed:', (err as Error).message);
  }

  // Futures Wallets
  try {
    const inrWallet = await client.getInrFuturesWallet();
    console.log(`[PASS] INR Futures wallet verified: present=true, currency=${inrWallet.currency}`);
  } catch (err) {
    console.error('[FAIL] INR Futures wallet check failed:', (err as Error).message);
  }

  // Futures Positions
  try {
    const positions = await client.listInrFuturesPositions({ page: '1', size: '20' });
    const activePositions = positions.filter((p) => !p.activePositionQuantity.isZero());
    console.log(
      `[PASS] Futures positions read: totalRecords=${positions.length}, activePositionsCount=${activePositions.length}`
    );
  } catch (err) {
    console.error('[FAIL] Futures positions check failed:', (err as Error).message);
  }



  // Futures Orders (explicitly querying buy and sell open orders)
  try {
    const openBuyOrders = await client.listInrFuturesOrders({
      status: 'open',
      side: 'buy',
      page: '1',
      size: '50',
    });
    const openSellOrders = await client.listInrFuturesOrders({
      status: 'open',
      side: 'sell',
      page: '1',
      size: '50',
    });
    const totalOpenOrders = openBuyOrders.length + openSellOrders.length;
    console.log(
      `[PASS] Futures orders read: openBuyOrders=${openBuyOrders.length}, openSellOrders=${openSellOrders.length}, totalOpenOrders=${totalOpenOrders}`
    );
  } catch (err) {
    console.error('[FAIL] Futures orders check failed:', (err as Error).message);
  }

  // Futures Transactions (using documented stage: funding)
  try {
    const transactions = await client.listInrFuturesPositionTransactions({
      stage: 'funding',
      page: '1',
      size: '10',
    });
    console.log(`[PASS] Futures position transactions read: count=${transactions.length}`);
  } catch (err) {
    console.error('[FAIL] Futures transactions check failed:', (err as Error).message);
  }

  console.log('\nSmoke verification complete.');
}

void runSmoke();
