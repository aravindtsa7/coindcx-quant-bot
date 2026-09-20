# Phase 16 — New-Coin Architecture Proof (SOL Verification)

**Status:** Architecture proof complete; SOL remains disabled for paper, shadow, and live execution.

## 1. Purpose and boundary

Phase 16 verifies that SOL can use the existing generic configuration, metadata, runtime, market-data, indicator, backtest, research, ranking, and risk interfaces without a SOL-specific production-core implementation.

The protected boundary is:

- `src/core/**`
- `src/coin-runtime/**`
- `src/integration/coindcx/**`
- `src/market-data/**`
- `src/indicators/**`
- `src/backtest/**`
- `src/strategies/**`
- `src/research/**`
- `src/risk/**`
- `src/execution/**`
- `src/dispatch/**`
- `src/ranking/**`
- `prisma/schema.prisma`

No protected-core file or Prisma schema change is required by the Phase 16 proof.

## 2. Configuration boundary and dynamic pair discovery

The application-layer change in `src/app/config/coins.ts` is the following actual `CoinProfile` entry:

```typescript
Object.freeze({
  underlying: 'SOL',
  enabled: true,
  dataEnabled: true,
  researchEnabled: true,
  paperEnabled: false,
  shadowEnabled: false,
  liveEnabled: false,
  timeframes: STANDARD_TIMEFRAMES,
  strategyAssignments: Object.freeze([]),
  riskProfileId: 'DEFAULT_SAFE',
  defaultLeverage: new Decimal(1),
  configuredAbsoluteMaxLeverage: new Decimal(20),
}),
```

The profile contains an underlying, not a fixed exchange pair. `CoinRuntimeBootstrapService` asks the discovery client for the active INR perpetual for that underlying, so pair discovery remains dynamic. All execution modes are disabled.

## 3. Deterministic fixture proof

`tests/fixtures/coindcx/sol-instrument.json` supplies deterministic CoinDCX instrument metadata. `tests/fixtures/coindcx/sol-instrument.ts` verifies the raw fixture SHA-256:

`2f97f5b58c988b387e9b4e498586813333e7c8f5cc82333acc197fafeb2fe031`

The fixture-based tests parse and normalize the payload and check its recorded metadata, including `B-SOL_USDT`, multiplier `1`, price and quantity increments `0.01`, minimum notional `6`, and the fixture's 11 dynamic position-leverage tiers. These are deterministic fixture assertions, not promises about future live metadata.

## 4. AST architecture scanner

`tests/architecture/phase16-new-coin-proof.test.ts` uses the TypeScript compiler API directly. It scans 209 TypeScript files in the protected directories.

The canonical forbidden-token set is exactly:

`SOL`, `BTC`, `ETH`, `B-SOL_USDT`, `B-BTC_USDT`, `B-ETH_USDT`, `B-SOL`, `B-BTC`, `B-ETH`, `SOL_USDT`, `BTC_USDT`, `ETH_USDT`, `SOL-INR`, `BTC-INR`, `ETH-INR`, `SOLUSDT`, `BTCUSDT`, `ETHUSDT`.

Detection is case-insensitive and is not limited to whole-string equality. Symbol boundaries also catch canonical fragments such as `-SOL` and `SOL_US`. The scanner covers:

- `StringLiteral` and `NoSubstitutionTemplateLiteral` nodes;
- `TemplateHead`, `TemplateMiddle`, and `TemplateTail` nodes;
- `RegularExpressionLiteral` nodes, including escaped underscores;
- statically evaluable string `+` expressions and constant template substitutions;
- literals used by string methods, calls, comparisons, switch cases, element access, and object, array, and property values;
- coin tokens that form structural identifier words in camelCase, PascalCase, or separator-delimited names.

Diagnostic-only strings passed directly to `Error` constructors are excluded structurally because they explain formats rather than choose a coin. Conditions and other executable values that lead to those errors remain scanned.

Identifier matching does not use an English-word allowlist. It tokenizes identifier structure, so `solPair`, `sol_pair`, `SolStrategy`, `btcConfig`, `ethMarket`, and `handleSolPair` are rejected, while words such as `solution`, `solver`, `solvent`, `ethics`, `ethnic`, `ether`, and `ethereal` are not coin tokens.

Synthetic tests cover all acceptance-review bypasses, every template token kind, regex literals, string-method arguments, compile-time concatenation, positive coin-style identifiers, and negative ordinary-English identifiers. The suite also verifies that protected code cannot reach `src/app/config/coins` through the import graph and that Prisma has no SOL-specific model, enum, or field.

## 5. Exact integration proof level

`tests/integration/phase16-sol-onboarding.test.ts` contains 28 tests. The suite proves the following production-path or component boundaries:

1. **Fixture, schema, and normalization:** The captured response is parsed through `InstrumentDetailsResponseSchema` and `normalizeInstrument`, then mapped to `CoinMetadata`.
2. **Runtime:** `determineEntryEligibility`, `validateCoinProfile`, `CoinRegistry`, and `CoinRuntimeBootstrapService` accept the SOL profile and discovered instrument.
3. **WebSocket channel construction:** The generic candle, trade, order-book, and real-time mark channel builders derive channels from the supplied pair.
4. **Canonical market data:** The test calls `createCanonicalCandle1m` with supplied OHLCV fields and validates the result. It does not exercise `CanonicalMarketDataEngine` trade-tick ingestion.
5. **Historical and indicator components:** Chunk planning, exact 5-minute aggregation, EMA, RSI, and ATR operate on SOL-labelled test data.
6. **Backtest:** A deterministic `BacktestEngine` run completes and produces one fill; a separate test creates and validates a SOL-compatible backtest instrument specification.
7. **Strategies:** The four production strategy definitions and `StrategyRegistry` instantiate kernels bound to `B-SOL_USDT`. The tests do not feed candles to those kernels or assert generated signals. The exposure vocabulary is `LONG` / `SHORT` / `FLAT`.
8. **Strategy × coin planning:** The real `planWithGitSourceVerifier` planner accepts SOL resources without a SOL-specific strategy subclass.
9. **Phase 13 valuation:** `verifyCurrentValuation` proves unit valuation and aggregate current-notional compatibility for the supplied SOL snapshot. Maintenance margin and liquidation price remain deferred.
10. **Paper boundary:** The test builds and validates only a `PaperInstrumentEconomicsSnapshot`. It does not exercise `PaperAccountKernel`, a paper session, ledger postings, or the paper fill path.
11. **Phase 12 to Phase 15 authority:** Genuine Phase 12 `PASSED` results enter `rankStrategyCandidates`, and `isAuthoritativeRankingRunSet` confirms the in-memory result. The Phase 16 test does not persist a ranking run.
12. **Regression:** BTC and ETH application profiles remain present and unchanged, and production strategy definitions remain pair-generic.

## 6. Optional live metadata gate

`npm run test:integration:sol-live` performs read-only public CoinDCX discovery and normalization. It checks structural invariants:

- the discovered underlying is SOL;
- margin currency is INR;
- kind is perpetual;
- status is active;
- contract multiplier, price increment, and quantity increment are positive.

The gate reports the current pair, multiplier, tick, lot, minimums, and tier counts. It does not assert an exact multiplier, tick, lot, or tier count. No credentials, orders, cancellations, or private exchange calls are involved.

## 7. Explicit limitations

- SOL paper, shadow, and live execution remain disabled.
- No SOL strategy algorithm or subclass was added.
- No full paper-account/session/ledger/fill path was proved.
- No strategy-kernel candle execution or signal result was proved.
- No maintenance-margin or liquidation-price calculation was proved.
- No ranking database persistence was proved.
- Live metadata is mutable; only the committed fixture has frozen exact values.

## 8. Reproduction

```bash
npm run typecheck
npm run lint
npm run build
npx vitest run tests/architecture/
npx vitest run tests/integration/phase16-sol-onboarding.test.ts --reporter=verbose
npm test
npx prisma validate
git diff --check

# Optional public-network gate
npm run test:integration:sol-live
```

The final acceptance run passed exactly 182 test files and 2,362 tests.

See [COIN_ONBOARDING.md](./COIN_ONBOARDING.md) for the generic lifecycle context.
