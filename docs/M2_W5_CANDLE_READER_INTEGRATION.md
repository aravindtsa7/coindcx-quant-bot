# M2 W5: shared read budget in the candle-reader primitive (note)

**Status: offline integration for review, uncommitted.**
- No production budget is bound; production configuration is not approved (U-M2-8).
- Phase 18 orphan cancellation remains a pending, budget-unintegrated mutation path, refused before transmission.
  **Complete M2 coverage is not claimed.**

## Targeted G-R/G-RX disposition (W0 freeze, only what W5 needs)

| Freeze entry | Disposition | Reason |
|---|---|---|
| `src/market-data/rest-candle-reader.ts` (G-R, modified; byte-identical to research commit `da8f4be`) | **Use committed source.** Defer the dirty change | The committed request primitive is sufficient. The dirty change adds a historical-window API (`fetchClosedCandleWindow`, `NO_DATA`, a retryable classification, `RestHttpStatusError`) used only by the uncommitted G-RX acquisition work. It is a separate reviewed milestone, not budget integration |
| `src/market-data/historical/acquisition.ts`, `scripts/coindcx-historical-candles.ts` (G-RX, untracked) | **Defer.** Not imported | Provider-data acquisition and a standalone downloader, absent from committed source. Adopting them later requires explicit budget injection through `FuturesCandleRestReaderConfig.readBudget` |
| `candle-repository.ts` and the other G-R/G-RX tests, evidence and research files | **Defer.** Not needed by W5 | Unrelated to the request primitive |

The original worktree and its 50 fingerprints are unchanged. No frozen file was copied.

## Integration

- **Default transport:** `CoinDcxFuturesCandleRestReader`'s default HTTP transport is the only candle request site in
  `src/`.
  - It acquires one read permit from `readBudget` before request preparation. The wait counts against the request
    timeout.
  - It creates the request inside `permit.start`, so STARTED is reported at creation, including when creation throws.
  - Completion is reported only on the request's `close`.
- **No budget given:** the reader uses the set-once production binding (scope PUBLIC), which refuses while unbound.
  There is no unpaced fallback.
- **Refusals:** a missing, unavailable, throwing or refusing budget, or a grant voided at start (expired, revoked, session
  closed), refuses before any request. The error is the existing `CanonicalRecoveryError('Futures candlestick recovery
  request failed: …')`.
- **Released permits:** a grant arriving after the request timeout (abandonment), or a preparation failure, releases the
  unused permit (known non-use).
- **429:** the raw `Retry-After` and `Date` headers go to the coordinator. The caller-facing error
  (`HTTP status 429`) is unchanged.
- **Unchanged:** parsing, filtering, dedupe, the window query and error mapping. The reader has no retries. Each caller
  retry and each caller window is a new request with a new permit.
- **Callers:**
  - `CanonicalMarketDataEngine` constructs the default reader and now passes an optional `readBudget` through.
  - `HistoricalBackfillService` takes an injected reader and has no `src/` construction.
  - Nothing in `src/` supplies the `httpTransport` test seam. Tests use it only for fake transports.

## Architecture
- `rest-limiter-coverage.test.ts`: the candle reader is COVERED, with callers accounted for. No unpaced request site
  remains. The orphan-cancellation path stays PENDING.
- `m2-rate-limit-boundary.test.ts`: the candle reader is a read-budget importer.

## Tests
- New `tests/integration/coindcx/rate-limit/candle-reader.test.ts`, covering:
  - the budget shared with reads and mutations;
  - measured starts and request-duration concurrency;
  - refusal with zero HTTP;
  - expiry, abandonment and single use;
  - a 429 block, Retry-After and probe recovery;
  - fresh permits per caller retry;
  - unchanged data, query and errors.
- `audit-final-transport.test.ts`: its loopback readers get a fixture read budget. Fixture injection only.
