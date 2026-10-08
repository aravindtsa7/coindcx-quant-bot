# M4: read-only synchronization engine (unwired review candidate)

**Status: offline candidate (local candidate checkpoint after the closeout review decisions), synthetic fixtures only.**
- It does not approve D4c, satisfy AS1, or complete the formal M3 or M4 milestone.
- The M4 exit evidence that is still missing:
  - real provider reads;
  - the separately authorized read-only shadow campaign;
  - the roadmap clean gate.
- Nothing is composed into production. There are no HTTP adapters, provider requests, runtime binding, database access
  or migrations.
- Sources: `FULL_BOT_ROADMAP_V3.md` §6 M4 and §7 O1–O6; `CAPABILITY_REGISTER_V3.md` B3/B8/B9/B12/B13, C1–C5,
  D2–D5 and the §5 ownership classes with their seven M4 scenarios.

## Shape
- `src/execution/live/practical-synchronization/engine.ts`: `runSynchronizationCandidate(config, source)`.
  - **Imports:** only the M3 evaluator and, type-only, `reconciliation/types` (`LiveVenueOrderEvidence`,
    `LiveVenuePositionEvidence`; that module imports nothing).
  - **Importers:** none; nothing in `src/` names the engine.
  - **Purity:** no I/O, clock or environment. All of these are inputs:
    - the read source, injected (`scan`, `stream`, `clock`);
    - scan limits;
    - thresholds;
    - cycle limit;
    - lineage;
    - provider contracts.
- **One cycle:**
  1. A stream snapshot at cycle start.
  2. Pass 0, then pass 1, over every declared component.
  3. A stream snapshot and the clock at evaluation.
  4. The M3 evaluator, in the explicit mode.
- **Revocation:** a private event, buffered events, a disconnect, the reconnect latch, or an unknown or changed epoch
  revokes the cycle, and a fresh cycle re-reads everything (O3). If every cycle up to `maxCycles` is revoked, the
  result is `REVOKED_CYCLE_LIMIT_REACHED`.
- **Outcomes:** `OBSERVED_CONVERGENCE`, `UNRESOLVED`, `REVOKED_CYCLE_LIMIT_REACHED` or `INVALID_CONFIGURATION`.
  Every result carries `GRANTS_NOTHING`.

## Identity, normalization and fingerprints (deterministic)
- **Keys:**
  - `order:<exchangeOrderId>`;
  - `position:<venuePositionId>`;
  - `txn:fill:<field>:<value>` only when the provider returned a fill identifier (field and value exactly as returned);
  - otherwise `txn:content:<fingerprint>` (identity `CONTENT_ONLY`).

  Fill identifiers are never invented.
- **Decimals:** exact strings, canonicalized: no leading zeros, no trailing fractional zeros, no negative zero.
  Exponents, bare points and whitespace are malformed.
- **Strings:** exact, with no trimming or case folding.
- **Fingerprint:** the component name, then `name=JSON(value)` pairs joined by `|` in a fixed field order. It is
  independent of object key order. Local read times are excluded.
  - Orders: exchangeOrderId, pair, side, venueStatus, orderedQuantity, filledQuantity, remainingQuantity,
    cancelledQuantity, averageFillPrice, price, wireOrderType, leverage, providerCreatedAtMs, providerEventTimeMs,
    `client_order_id`.
  - Positions: venuePositionId, pair, signedQuantity, averageEntryPrice, leverage, providerEventTimeMs.
  - Transactions: category, fill_id_field, fill_id_value, parentExchangeOrderId, stage, amount, currency,
    providerEventTimeMs.
- **The `client_id` / `client_order_id` conflict (C2)** is not resolved by renaming. The order evidence carries the
  venue's `client_order_id`, labelled as such. A tag contract confirmed for `client_id` is not applied to it.

## Scans and pagination (B8, B9; closeout decisions applied)
- **Limits:** `pageSize` and `maxPages` are explicit per declared component. The history scope is explicit
  (`AVAILABLE_HISTORY` or `DECLARED_WINDOW`) and is passed to the source unchanged. No production defaults exist.
- **Terminal-page contract:** `contracts.terminalShortPage` is explicit per endpoint. Only `CONFIRMED` is accepted;
  absent means unknown.
- **Termination:**
  - `OBSERVED_EMPTY_PAGE`: the scan reached an empty page. It ends scanning, but does not prove complete history.
  - `CONFIRMED_TERMINAL_SHORT_PAGE`: the last page is short and non-empty, and that endpoint's terminal-page contract
    is confirmed.
  - `SHORT_PAGE_TERMINALITY_UNCONFIRMED`: the scan stopped at a short page under an unknown contract. This blocks: the
    source must continue to an empty page or the configured bound.
  - `SCAN_BOUNDARY_REACHED`: `maxPages` full pages. This is truncation, and blocks.
  - `UNOBSERVED`: no pages; full pages stopping before the limit; an oversized page; or **records after any short
    page** (`RECORDS_AFTER_SHORT_PAGE`). This blocks even under a confirmed contract, and the later records are kept,
    never ignored.
  - `FAILED`: a failed or thrown read, or more pages than allowed. This blocks.
- **Completeness:** `historyCompleteness` is always `UNPROVEN`. Convergence is labelled
  `OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE`.
- **Declared window:** records are flagged, never filtered (`historyWindow: FLAGGED_NEVER_FILTERED`, boundary
  semantics `UNCONFIRMED`). Each blocks:
  - a provider timestamp outside the window (`RECORD_OUTSIDE_DECLARED_WINDOW`);
  - a timestamp on a boundary (`WINDOW_BOUNDARY_SEMANTICS_UNKNOWN`);
  - a missing timestamp (`WINDOW_MEMBERSHIP_UNKNOWN`).

  Orders use their created and event times, positions and transactions their event time. Under `AVAILABLE_HISTORY` no
  window check applies.
- **Duplicates within one scan:** every record view carries its `occurrences` (page and position) and `anomalies`.
  - A conflicting duplicate blocks.
  - The same record on two pages is an observed page shift, and blocks.
  - An identical same-page duplicate with a stable record id (exchange order id, venue position id, provider fill id)
    is deduplicated: non-blocking, with its occurrence provenance and the `IDENTICAL_DUPLICATE_DEDUPED` flag kept.
  - Content-only twins are never collapsed. They keep every occurrence and the `CONTENT_ONLY_TWIN_UNRESOLVED` flag,
    and block (`CONTENT_IDENTITY_AMBIGUOUS`). Their comparison fingerprint includes the occurrence count, so two
    occurrences against one is a disagreement. A content fingerprint is comparison evidence only, never a fill
    identity.
  - A malformed record blocks.

  A blocking scan finding also makes that read's pagination `UNKNOWN` for the evaluator.

## Ownership (register §5)
- **OWNED** requires durable lineage:
  - an exchange id from this bot's own create response;
  - an ambiguous create resolved to exactly one durable intent, under a confirmed `client_order_id` contract, with
    exact equality of account, tag, pair, side, quantity, price, order type and leverage;
  - a durable position ownership record;
  - or, for a fill, an OWNED parent order in the same pass.
- **A matching tag alone** never establishes ownership.
- **Seven scenarios:**
  1. a bot-looking tag without an intent is UNRESOLVED;
  2. as above;
  3. a shared tag, or a closed intent's tag, is UNRESOLVED;
  4. a malformed tag (not 1–36 visible ASCII characters) is UNRESOLVED;
  5. liquidation or TP/SL is VENUE_GENERATED only via confirmed `wireOrderType` lexemes, otherwise UNRESOLVED;
  6. a wallet change is UNRESOLVED unless its raw `stage` is a confirmed venue-generated lexeme. It is never zero and
     never interpreted, so local enums are not provider evidence for funding;
  7. a missing tag is UNRESOLVED, and FOREIGN_OBSERVED only under a confirmed contract stating bot creates are always
     tagged.

  A record outside the namespace is FOREIGN_OBSERVED only under that same confirmed contract.
- **Convergence:** any non-OWNED record blocks it. VENUE_GENERATED means quarantine and re-synchronize.

## Cumulative mode (B3, B13, O6)
`CUMULATIVE_STATE` compares the available cumulative order and position state with `CONTENT_ONLY` transactions.
Complete fill reconstruction, exactly-once execution accounting and fee accounting stay `UNKNOWN`. A scope that
requires any of them is blocked. `FULL_EVIDENCE` keeps blocking on missing fill identifiers.

## Asynchronous orchestration (separate unwired candidate, uncommitted)
- **Placement:** `src/execution/live/practical-synchronization/async-orchestrator.ts`,
  `runAsyncSynchronizationCandidate`. It imports only `./engine`. The engine's pure `evaluateCollectedCycle` (shared
  with the synchronous runner) applies every normalization, scan, ownership and assessment rule, so none is duplicated.
- **Pins:**
  - only the orchestration imports the engine;
  - nothing imports the orchestration;
  - nothing in `src/` names either.
- **Inputs:** an injected async source (`scan`, `observeStream`, `subscribeEvents`), an injected clock (`now`,
  `delay`), and an optional cancellation signal. Read and stream timeouts are explicit limits, with no defaults.
- **One cycle:** the initial stream observation, pass 0 then pass 1, the final observation, then
  `evaluateCollectedCycle`. Components of a pass run concurrently and may complete out of order.
- **Bindings:** every scan request is bound to account, scope id, cycle, pass, component, the cycle-start epoch and a
  request id, and a response must echo that exact binding. A late response from an abandoned or superseded cycle is
  never awaited by, and cannot enter, a newer cycle; a misrouted one fails its binding.
- **Failures:** a timeout on the injected clock, a rejection, cancellation, a malformed response or a binding mismatch
  is an explicit orchestration reason, and the engine also sees a failed read. An unavailable stream observation
  revokes. Outer cancellation aborts in-flight reads and ends the run as `CANCELLED`.
- **Events:** every event delivered during an active cycle increments a local observed-event counter and revokes the
  cycle at once. It stays revocation evidence even when the stream later reports an empty buffer. The counter is not
  a provider sequence (`providerSequence: 'NOT_AVAILABLE'`, `gapDetection: 'NOT_CLAIMED'`).
- **Restarts:** a revoked cycle restarts only within `maxCycles`.
- **Unchanged:** the reconnect latch and the strict reconciliation requirement pass through unchanged. Every result
  grants nothing.
- **Tests:** `async-orchestrator.test.ts` (31), covering:
  - order and bindings;
  - out-of-order and delayed completion;
  - six binding mismatches;
  - timeout, rejection, malformed responses and cancellation;
  - stream failures;
  - events between reads and during the final observation with a drained buffer;
  - malformed events;
  - late responses after a fresh cycle;
  - a misrouted stale response;
  - epoch and account changes;
  - the latch;
  - cycle-limit exhaustion;
  - parity with the synchronous engine;
  - cumulative limits;
  - no grants.

## Named scan segments and the CoinDCX read adapter (unwired candidate)
- **Segments (engine):** a scan may carry named `segments` instead of `pages`. Each segment is bounded by the same
  limits and terminated by the same reviewed rules on its own, and the scan is clean only when every segment is. A
  record appearing in two segments is a page shift. The `pages` form is unchanged.
- **Adapter:** `src/integration/coindcx/live/sync-read-adapter.ts` implements the orchestration's `scan` structurally.
  - **Imports:** only `type CoinDcxClient` and the order/position model types. It imports no candidate module.
  - **Reads:** through an injected, already-constructed, M2-budgeted `CoinDcxClient`. It adds no request site,
    signing, budget acquisition, unpaced fallback or client construction, and is imported by nothing.
  - **ORDERS (supported):** `listInrFuturesOrders`, read as segments `side=buy` and `side=sell`, for an explicit status
    list.
  - **POSITIONS (supported):** `listInrFuturesPositions`.
  - **TRANSACTIONS (`CLIENT_ADAPTER_UNSUPPORTED`):** an explicit failure. The label describes this client path only:
    no committed read method's normalized model exposes a fill identity with an established order linkage. It is not
    evidence that CoinDCX lacks transaction history or fill identifiers. Observing transaction records (not
    implemented here) and confirmed fill-level reconstruction or accounting (stable fill semantics unresolved) are
    separate questions. A scope that requires TRANSACTIONS keeps it and stays unresolved; the component is never
    dropped, and no other endpoint is substituted.
- **Pagination:** bounded, sequential, using the request's page size and page bound. A short page is never assumed
  terminal: reading continues to an empty page or the bound. Every page carries its provenance (segment, page,
  requested size, record count, local times), and every segment its stop reason. A declared window is reported as
  `UNSUPPORTED_BY_ENDPOINT_NOT_APPLIED`, and nothing is filtered. History completeness is `UNKNOWN`.
- **Provenance:** the echoed binding is `ADAPTER_LOCAL_ECHO` with no provider-returned identity. Account provenance
  is separate: the injected credential binding of the authenticated client (`BOUND`, `MISMATCH` or `UNKNOWN`).
  Unknown provenance gives the engine an unknown account scope; another account gives a mismatch.
- **Fields:** each mapped field is listed with its provider field and basis (committed schema field, derived, or not
  exposed), and `providerSemantics: 'NOT_CONFIRMED'`.
  - `client_order_id` is carried exactly as the committed normalizer keeps it.
  - `client_id` is not exposed by the committed read path, and is never renamed into `client_order_id`.
  - A missing `cancelled_quantity` is an explicit gap, never defaulted, so the record fails the engine's validation.
  - `filledQuantity` is derived and labelled as such.
- **Cancellation:** the read primitive accepts no signal. After an abort, no further page is requested, and a late page
  result is abandoned, not recorded. The in-flight request keeps its budget capacity until it completes; the adapter
  never releases it.
- **Tests:**
  - `tests/integration/coindcx/rate-limit/sync-read-adapter.test.ts` (16): loopback venue, M2-budgeted client and
    shared coordinator.
  - `tests/architecture/m4-sync-read-adapter-boundary.test.ts` (5).
  - Engine segment tests (3).

## Flat positions (decided for the candidate)
A flat position without durable ownership lineage stays UNRESOLVED (`FLAT_POSITION_WITHOUT_DURABLE_OWNERSHIP`).
Ownership is never inferred from zero quantity, and the record is never excluded to reach convergence. The production
treatment is a later scope decision.

## Open review questions
- The production treatment of flat positions (above).
- Real reads: a real-read adapter, the shadow campaign and its coverage criteria. These are separate authorizations.

## Tests
- `tests/unit/execution/live/practical-synchronization/engine.test.ts` (53 tests). The closeout counterexamples:
  - a short page alone, under unknown and confirmed contracts;
  - a short page followed by a non-empty page, which keeps the later records and is never complete;
  - an empty page ends the scan, with history unproven;
  - window flagging, without filtering;
  - stable-id deduplication with provenance;
  - unresolved content-only twins;
  - flat positions.

  The earlier coverage:
  - all seven scenarios;
  - fills changing between passes;
  - page shifts, duplicates, truncation, unobserved termination and failed reads;
  - an event conflicting with two agreeing reads;
  - quiet streams, reconnects and epoch changes;
  - cumulative mode with missing fill identifiers;
  - deterministic fingerprints, and mismatched or invalid scopes;
  - no authority grant.
- `tests/architecture/m4-practical-synchronization-boundary.test.ts` (4 tests).
- `tests/architecture/m3-practical-observation-boundary.test.ts` now allows exactly one importer of the M3 evaluator:
  this engine.
