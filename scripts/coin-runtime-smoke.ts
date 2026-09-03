import { loadCoinProfiles } from '../src/app/config/coins';
import { CoinRegistry, CoinRuntimeBootstrapService } from '../src/coin-runtime';
import { CoinDcxClient } from '../src/integration/coindcx/client';

async function main(): Promise<void> {
  console.log('=== COIN RUNTIME LAYER SMOKE (PUBLIC DISCOVERY ONLY) ===\n');

  // Load configured profiles
  const profiles = loadCoinProfiles();
  console.log(`Loaded ${profiles.length} configured coin profile(s):`);
  for (const p of profiles) {
    console.log(`  - Underlying: ${p.underlying} (enabled=${p.enabled}, dataEnabled=${p.dataEnabled}, riskProfileId=${p.riskProfileId})`);
  }
  console.log();

  // Create public-only CoinDCX client (zero credentials)
  const client = new CoinDcxClient({});
  const registry = new CoinRegistry();
  const bootstrapService = new CoinRuntimeBootstrapService(client, registry);

  console.log('Bootstrapping coin runtimes via public exchange discovery...');
  const result = await bootstrapService.bootstrap(profiles);

  if (result.failures.length > 0) {
    console.error(`\n[FAIL] Encountered ${result.failures.length} bootstrap failure(s):`);
    for (const f of result.failures) {
      console.error(`  - ${f.underlying}: [${f.category}] ${f.message}`);
    }
    process.exit(1);
  }

  console.log(`\n[PASS] Successfully bootstrapped ${result.successful.length} coin runtime(s) into CoinRegistry:\n`);

  for (const runtime of registry.list()) {
    console.log(`--- ${runtime.profile.underlying} ---`);
    console.log(`  Discovery Status:           ${runtime.status}`);
    console.log(`  Pair:                       ${runtime.instrument ? runtime.instrument.pair : '[NONE - UNDISCOVERED DISABLED]'}`);
    console.log(`  Lifecycle State:            ${runtime.lifecycle}`);
    console.log(`  Instrument Status:          ${runtime.instrument ? runtime.instrument.status : '[NONE]'}`);
    console.log(`  Entry Eligibility:          ${runtime.entryEligibility} (static metadata readiness only; NOT safe to live trade)`);
    console.log(`  Configured Timeframes:      [${runtime.profile.timeframes.join(', ')}]`);
    console.log(`  Dynamic Leverage Tiers:     ${runtime.instrument ? runtime.instrument.dynamicPositionLeverageTiers.length : 0}`);
    console.log(`  Dynamic Safety Margin Tiers:${runtime.instrument ? runtime.instrument.dynamicSafetyMarginTiers.length : 0}`);
    console.log();
  }

  console.log('Coin Runtime Layer public smoke test complete.');
}

main().catch((err: unknown) => {
  console.error('[FATAL] Smoke script failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
