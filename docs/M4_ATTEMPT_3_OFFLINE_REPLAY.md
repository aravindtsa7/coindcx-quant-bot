# Attempt-3 offline reporting regression

Base checkpoint: `96838e20dfe2e434b5a509ad57b54388b722bb2b`.
This change adds tests and documentation only. It changes no runtime, reporting schema,
readiness gate, authorization, namespace or collection admission. The new work is uncommitted.

## Evidence boundary

The actual attempt-3 saved report retains `SyncRecordView` objects: `key`, `identity`,
`fingerprint`, `ownership`, `reason`, `occurrences` (segment/page/position), and `anomalies`.
The key carries a type-prefixed provider ID. The fingerprint is a comparison string, not a
separately retained normalized model or raw payload.

The producing engine encodes these named business fields inside fingerprints, without
separate structured fields in the saved record view. Provider IDs also appear in `key`:

| Component | Fingerprint content |
| --- | --- |
| Orders | exchangeOrderId, pair, side, venueStatus, ordered/filled/remaining/cancelled quantities, averageFillPrice, price, wireOrderType, leverage, providerCreatedAtMs, providerEventTimeMs, client_order_id |
| Positions | venuePositionId, pair, signedQuantity, averageEntryPrice, leverage, providerEventTimeMs |

The report also retains adapter page counts, local observation times, segment stops,
field provenance and correlation bindings; scan validity, findings, assessment reasons,
ownership classifications and occurrences; and campaign/identity/shutdown metadata.
It does not retain raw response pages, full normalized client models or original SCANNED
envelopes. Fields omitted from fingerprints, raw numeric lexemes, missing response fields,
and complete account/transaction history cannot be recovered. This task does not decode
actual fingerprint content into fields or reconstruct any provider input.

The protected source review compares 14 producing modules against their inventory hashes,
recorded Git blobs and the current checkpoint. Invocation, account-mapping and credential-
provenance **metadata** digests match the producing report. No credential file is accessed.
Private source hashes and transformation details are separately retained at:

`C:\Users\kani1\CoinDcxCollectionRuntime-v3-clockfix-bbe39e0e26ee\offline\attempt-3-replay-reporting-20261014\source-transformation.json`

## Synthetic transformation and coverage

`tests/unit/coindcx/attempt-3-reporting-replay.test.ts` reads only the committed pending
proposal template. It never reads the protected account report, runtime inventory, credential
stores or environment credentials. Every model is freshly authored with the committed wire
schemas/normalizers and `SYNTHETIC-REPLAY-*` IDs. The fake account, identity and budget IDs
have no mapping to actual IDs. Counts and the reviewed GTC quantity transition select the
fixture shape. Prices, statuses, timestamps, other model values and replacement-ID mapping
are invented stand-ins, not recovered evidence. This sanitized shape replay is **not byte-
identical to actual provider evidence**, and its saved records are not account observations.

The regression runs `runPreparedCollection` through the existing campaign, adapter,
asynchronous orchestration and engine, then the existing redactor and `localReportSink`.
The actual sink writes/fsyncs a new JSON file in a disposable synthetic directory; assertions
use JSON readback, comparing the entire saved object with the redacted delivered report.
HTTP/HTTPS requests and fetch are denied and asserted unused. No CoinDcxClient, coordinator,
credential loader, campaign namespace or provider transport is constructed.

Four cases cover:

1. Three verified synthetic identities, six passes, orders 25+25 per side, positions 25+9,
   page size 25 and maxPages=2. There are 39 settled injected method calls (not physical
   requests), 600 order observations/101 distinct fake IDs and 204 position observations/
   34 distinct fake IDs. Three fake position IDs are nonzero in every pass (18 observations).
   GTC is -447.2 in evaluation one and -557.6 in evaluations two/three. Both passes agree
   within each evaluation; the cross-evaluation transition is not mislabelled as a within-
   evaluation disagreement. Local clocks are integers; all 12 scans are ACCEPTED with no
   adapter failure, INVALID_INPUT or READ_FAILED.
2. An identical duplicate on the same buy-order page: 100 row occurrences but 99 retained
   order records per pass, 594 order observations total. Both occurrence locations and
   `IDENTICAL_DUPLICATE_DEDUPED` survive serialization. Repeats do not become distinct trades.
3. A deliberate conflicting duplicate within a position pass: the same fake GTC ID occurs
   twice with different content. `CONFLICTING_DUPLICATE`, its blocking flag, both locations
   and the first fingerprint survive readback. The existing contract retains the first
   fingerprint and a conflict finding; it does **not** retain the conflicting variant's
   complete content or apply last-write-wins. There are 33 record views/34 occurrences per
   position pass. Even with ACCEPTED scan validity, conflict and other blockers remain.
4. A separate difference between pass zero and pass one: both compared fingerprints survive,
   with `RECORDS_DISAGREE` alongside the other unresolved reasons.

All cases preserve unavailable lineage, UNRESOLVED ownership, UNKNOWN stream and null epoch,
order `SCAN_BOUNDARY_REACHED`/truncated pagination and position
`SHORT_PAGE_TERMINALITY_UNCONFIRMED`/unknown pagination. Every segment stops at SCAN_BOUND;
no short page becomes proof of complete history. The campaign completes at its evaluation
limit while every evaluation remains `REVOKED_CYCLE_LIMIT_REACHED`/NOT_CONVERGED. All grants
remain false. Field provenance stays NOT_CONFIRMED and correlation stays ADAPTER_LOCAL_ECHO.
Synthetic secret-echo canaries are redacted; identity-name/email canaries never enter the
report. An attempted second sink write is refused with EEXIST and leaves the file unchanged.

## Verification and M4 status

Run the focused regression without HTTP, provider credentials, DB or runtime startup:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/coindcx/attempt-3-reporting-replay.test.ts --maxWorkers=1 --minWorkers=1
```

The four focused tests pass; final typecheck and affected-file lint exit 0. New-file
whitespace checks have no findings. Reused sealed evidence covers the five observation-
clock/malformed-record controls and 15 engine/adapter/campaign architecture tests. Their
source/tests are unchanged from the corrected checkpoint. The older aggregate records
contain 103/24 passes; this task does not revalidate those entire aggregates or reuse the
bootstrap/operator checks whose source changed later. These checks were not rerun. The first
typecheck of the new test found a nullable stream access; that test-only access was
corrected and the final typecheck passes.

New coverage verifies persistence of the available representation and the separation of
response success, accepted scans, retained observations, distinct IDs and unresolved
assessment. Unchanged clock-validator and malformed-input checks reuse their accepted
evidence; no validator is relaxed. Verification results and source-preservation hashes
are retained separately in the protected review directory above.

Actual bounded provider information collection is established by the saved attempt-3
evidence, not by these synthetic tests. Complete history/terminal-page semantics (B8/B9),
ownership evidence and provider contracts (C1-C5), private-stream/epoch evidence and the
provider synchronization procedure remain provider/account-scope requirements. Transaction
observation is CLIENT_ADAPTER_UNSUPPORTED; fill identity/accounting remains unproven.
REST identity checks do not prove exclusive account use or per-response continuity.

The next implementation step under the existing M4/O1-O6 candidate roadmap is to close
the reviewed pagination/ownership/stream contract evidence inputs and exercise the existing
convergence/revocation scenarios with those inputs. This regression neither supplies those
inputs nor authorizes collection. Separately authorized shadow coverage and the roadmap
clean gate remain formal exit work. AS1/D4c and formal M3/M4 acceptance are unchanged.
No bot ownership, manual/API activity, unique trade count or current full-account position
count is inferred. Original evidence, ciphertext, STOPPED namespaces, consumed claims,
original fingerprints/migrations and prior descendant ACL uncertainty are preserved.
