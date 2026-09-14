/**
 * [F14-02] Non-forgeable P14-B production ACQUISITION capability.
 *
 * Trusted paper execution evidence (`TrustedPaperExecutionEvidence`) was
 * already non-forgeable as an *object* (module-private `WeakMap` capability in
 * `src/execution/trusted-evidence.ts`). What it was NOT was non-forgeable in
 * its *provenance*: any caller could publicly construct a
 * `CoinDcxPaperEvidence`, hand it a fake socket factory, push fabricated
 * orderbook/conversion payloads through the public `ingest*` methods, and the
 * trusted adapter would happily mint a production-usable bundle from them —
 * because the adapter only proved "some adapter wrapped some provider object",
 * never "this data was acquired from CoinDCX through the approved path".
 *
 * This module supplies the missing half. Possession of
 * `PRODUCTION_ACQUISITION_CAPABILITY` is the ONLY way a datum inside
 * `CoinDcxPaperEvidence` can ever be tagged `PRODUCTION_ACQUISITION`, and only
 * such data may be minted into a production-usable trusted bundle.
 *
 * Deliberately isolated in its own module and ABSENT from
 * `src/integration/coindcx/index.ts` (the public barrel) — exactly mirroring
 * `SESSION_PROOF` (`src/execution/persistence/admission-bridge.ts`) and
 * `ACCOUNT_FAULT_RECOVERY_CAPABILITY` (`src/dispatch/admission.ts`), whose
 * barrel-absence is itself enforced by `tests/architecture/phase14-import-graph.test.ts`.
 * A barrel consumer cannot reach it; a structural object, a copied string
 * brand, a `{ isProduction: true }` flag, or a foreign `Symbol()` can never
 * equal it.
 *
 * Test/unit code that must exercise the genuine acquisition path without a
 * network deliberately imports this concrete module path (the "internal
 * acquisition harness" route) — that is the sanctioned test seam, and it is
 * unavailable to any production caller going through the barrel.
 */
export const PRODUCTION_ACQUISITION_CAPABILITY: unique symbol = Symbol(
  'P14-B production acquisition capability (internal, non-barrel) — proves a datum was acquired through the approved CoinDCX acquisition path',
);

/** How one stored P14-B datum was obtained. Never caller-assignable: see above. */
export type PaperEvidenceAcquisition = 'PRODUCTION_ACQUISITION' | 'CALLER_SUPPLIED';

/** `PRODUCTION_ACQUISITION` iff the caller genuinely holds the module-private capability. */
export function acquisitionFor(capability: unknown): PaperEvidenceAcquisition {
  return capability === PRODUCTION_ACQUISITION_CAPABILITY ? 'PRODUCTION_ACQUISITION' : 'CALLER_SUPPLIED';
}
