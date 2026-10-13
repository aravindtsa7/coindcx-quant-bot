# Offline diagnosis of the attempt-2 observation discrepancy

Base HEAD: `9c0fa81f6438ce6968eb9531d7383acb2a663eaf`. Changes are uncommitted.
No provider collection, HTTP (including loopback), credential loading, database access,
namespace initialization/reset, admission reset or protected runtime source update was performed.

## Cause and validation predicates

The host's injected collection clock returned raw `performance.now()`: fractional,
monotonic milliseconds. The adapter copies `clock.now()` into the SCANNED envelope's
`startedAtMs`/`endedAtMs` and page provenance; orchestration passes the envelope unchanged
and supplies `clock.now()` as `evaluatedAtMs` to the engine.

The engine's `isTime` predicate in `practical-synchronization/engine.ts` requires:

```typescript
typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
```

`evaluateScan` rejects an envelope if either scan timestamp fails that predicate,
producing `READ_FAILED`, termination FAILED and no record views **before record normalization**.
The assessment in `practical-observation/assessment.ts` independently applies the same
predicate to `evaluatedAtMs` (and successful-read timestamps), producing `INVALID_INPUT`.
Orchestration's RESPONSE means the response envelope echoed its binding, not that the
engine accepted the scan. Adapter failure=null therefore did not imply engine scan validity.

Saved attempt-2 page and evaluation times are fractional. The saved report does not retain
the original SCANNED envelopes or exact assessment evaluation tick. The committed producer
and consumers explain the mismatch, and the complete synthetic pipeline reproduces both
failure signals. No missing provider record fields are inferred as the cause: the envelope
is rejected before those fields are inspected.

## Small fix and reporting

The host now injects `Math.floor(performance.now())` as its observation clock. It retains
the monotonic domain and the existing integer-millisecond contract. Engine and assessment
validators, provider timestamp handling, supervision clocks, timers/timeouts, bindings,
pagination, ownership and authority rules are unchanged. Invalid externally supplied
fractional scan/evaluation clocks remain rejected.

Campaign reports add `readAssessments`, joining existing adapter, orchestration and engine
evidence per evaluation/cycle/pass/component. They expose response outcome, adapter failure,
response page/row counts, scan validity, termination/findings, retained record/occurrence
counts and assessment reasons. An accepted scan may have bounded/unproven history and an
unresolved assessment. Partial malformed records remain excluded and explicitly flagged;
valid records in the same scan retain their existing occurrence provenance.

`recordCountSemantics` labels aggregate counts as per-scan record observations, not unique
trades, fills or current positions. The original `observations` shape is preserved.
Repeated provider IDs retain occurrences and existing duplicate/page-shift findings.

## Offline regression

The new test uses the actual host observation clock with fractional monotonic ticks and
the complete `runPreparedCollection` -> campaign -> adapter -> async orchestration -> engine
-> in-memory report sink path. Its injected client returns models built with the committed
wire schemas and normalizers. No CoinDcxClient, HTTP server, provider credential, coordinator
or campaign namespace is started. All records/identity are explicitly SYNTHETIC.

Fixtures retain the reviewed configuration: three identity-verified evaluations, two passes
each, buy orders 25+25, sell orders 25+25, positions 25+8, maxPages=2, unknown terminal-page
contracts, unavailable lineage and UNKNOWN stream. Before the fix the regression produces
39 settled synthetic reads but no records and INVALID_INPUT/READ_FAILED. After the fix it
retains 600 synthetic order and 198 synthetic position observations across six scans per
component. These are NOT observations of the operator's account.

Orders remain SCAN_BOUNDARY_REACHED/TRUNCATED. Positions remain
SHORT_PAGE_TERMINALITY_UNCONFIRMED/UNKNOWN, with the adapter's SCAN_BOUND stop still recorded.
Neither the bound nor a non-empty short page becomes a transport failure or proof of complete
history. Lineage, stream and pagination continue to block convergence; grants remain false.

Focused controls cover an injected adapter rejection, missing cancelled quantity (malformed
records excluded), duplicate occurrences, and a deliberately invalid fractional injected clock.
The regression failed before the fix and passes after it. Affected offline tests: 103 passing;
architecture checks: 24 passing; typecheck, affected lint and diff checks pass. Existing
HTTP/loopback integration suites were not executed under the task's no-HTTP constraint.

## Limits of existing actual evidence

The original actual reports record 39 physical attempts (3 identity, 24 orders, 12 positions),
three verified identities/evaluations, adapter page counts and stops, no adapter failures,
and empty engine records. They do not retain raw provider pages, normalized SCANNED record
payloads or record-level IDs/pairs/quantities/timestamps. Aggregate metadata can be re-derived
offline; corrected actual record-level assessments cannot. Rounding saved page timestamps or
substituting synthetic rows cannot recover the discarded records and was not done.

Separate evidence is under:
`C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07\offline\pipeline-discrepancy-20261013`.
It contains before/after synthetic reports and test results, a derived actual **metadata-only**
summary, and preservation checks. Original campaign reports, STOPPED state, admission claims,
credentials/ciphertext, authorization and previous evidence remain unchanged. The protected
runtime still contains its original source snapshot; this task changes only the review worktree.

Stream UNKNOWN; transactions CLIENT_ADAPTER_UNSUPPORTED; history UNPROVEN; lineage UNAVAILABLE.
AS1/D4c and formal M3/M4 acceptance are unchanged; all authority grants remain false.
Prior deeper-descendant ACL-restoration uncertainty remains. No additional collection is authorized.
