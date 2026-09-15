/**
 * [F14-02] P14-B market-evidence acquisition PROVENANCE vocabulary.
 *
 * This module deliberately no longer defines, exports, or can produce any
 * *capability value*. The previous design exported a
 * `PRODUCTION_ACQUISITION_CAPABILITY` symbol from this concrete file (absent
 * from the public barrel, but deep-importable) and accepted it as a public
 * constructor option and as a public `ingest*` argument. Astra's F14-02
 * exploit deep-imported that symbol and used it to bless manually fabricated
 * orderbook/mark/conversion data as `PRODUCTION_ACQUISITION`.
 *
 * Production acquisition provenance is now an *object-identity* property of a
 * provider, held in a module-private `WeakSet` inside `./paper-evidence`, set
 * only by that module's own approved production factory, and consulted only by
 * that module's own internal acquisition callbacks. There is no token to
 * import, name, copy, serialize, or forge — exactly like Wave3-A's
 * module-private `INSTRUMENT_BINDING_ISSUER`.
 *
 * What remains here is the provenance *label type* alone. Naming a label has
 * never granted anything: `'PRODUCTION_ACQUISITION'` as a string is inert,
 * because the label is assigned by `paper-evidence`, never accepted from a
 * caller.
 */

/**
 * How one stored P14-B datum was obtained.
 *
 * `PRODUCTION_ACQUISITION` — the datum entered through the provider's own
 * internal CoinDCX acquisition path (its WS callbacks or its own REST reads)
 * on a provider created by the approved production factory.
 *
 * `CALLER_SUPPLIED` — everything else, unconditionally: every public `ingest*`
 * call, and every datum on any provider a caller constructed directly. Never
 * upgradeable by any argument, option, flag, or capability.
 */
export type PaperEvidenceAcquisition = 'PRODUCTION_ACQUISITION' | 'CALLER_SUPPLIED';
