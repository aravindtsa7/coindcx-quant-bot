# Additive structured observation retention (M4 candidate)

Design checkpoint: replay closeout commit `ccf9021`. This is evidence retention in the
unwired candidate, not a readiness gate or a change to assessment/ownership rules.

## Placement and provenance

Add an optional `observationVariants` array to `SyncRecordView`. Newly produced valid
records populate it; old reports/views can omit it. Each versioned variant has its own
comparison fingerprint, typed normalized comparison fields and occurrence locations.
The discriminated components are ORDERS, POSITIONS and the existing injected TRANSACTIONS
engine contract. This does not implement a provider transaction read adapter.

Capture fields at engine normalization, from the same allowlisted canonical values used
to build fingerprints, never by decoding fingerprints or retaining arbitrary input objects.
Mark the source ENGINE_NORMALIZED_INPUT, provider semantics UNCONFIRMED, and raw provider
payload/numeric lexemes NOT_RETAINED. Record field presence as PRESENT, NULL, MISSING or
INVALID; these describe the engine input, not original wire-field presence. The adapter's
existing report retains wire mapping/derivation and unsupported-field provenance separately.
Malformed records stay rejected and have no accepted structured observation.

Keep valid individual input timestamps with explicit availability. Legacy order fingerprints
null both comparison timestamps unless both are valid integers; preserve that exact rule.
If only one timestamp is valid, retain it in input-timestamp evidence while comparison fields
remain null. Missing/null/invalid timestamps have no invented numeric value; invalid values
are not echoed. Already-normalized decimals remain canonical strings, not raw wire lexemes.

## Variants, compatibility and bounds

The existing first fingerprint, aggregate occurrences, duplicate findings, ownership and
assessment inputs remain unchanged. Add every distinct normalized content/presence variant,
with its fingerprint and all its locations. Identical observations share one variant with
multiple occurrences. A conflict never overwrites an earlier variant. Variant ownership is
not independently assessed: the existing record ownership is the existing first-record
assessment, and conflict findings remain blocking. Presence differences may create distinct
evidence variants even when the legacy comparison fingerprints agree.

The campaign already serializes engine record views through the recursive redactor and
non-overwriting JSON sink. No new reporting path or bootstrap is needed. Existing candidate
consumers use the legacy keys/fingerprint/ownership/occurrence/count fields; the assessment
receives its existing projection and never consumes the new evidence. Preserve those
fields and their ordering/values. Optional typing permits old saved views and consumer
fixtures; a per-observation format tag permits future evolution without reinterpreting
legacy data. Consumers that require an exact external JSON schema must explicitly allow
this additive field; no such strict record-view consumer exists in the reviewed repository.

There is at most one variant per valid received input occurrence. Compliant campaign pages
have the existing page-size/pages/segments/components/passes/evaluations bound. Over-limit
page counts still fail before record retention. Oversized individual pages retain the
existing IRREGULAR_PAGE finding and unresolved assessment; the legacy engine can retain
their valid records, and the additive evidence follows that existing behavior without
multiplying occurrences. Canonical fields/locations are retained, not entire payloads.
This introduces no new byte/string-size cap; existing scan/transport limits are unchanged.

## Verification and unavailable evidence

Use explicitly synthetic fixtures through the actual adapter, asynchronous orchestration,
engine, redactor and JSON sink/readback. Compare the legacy output projection before/after;
test identical/conflicting duplicates, cross-pass/evaluation changes, missing/invalid times,
malformed/missing quantities, unsupported fields/components, privacy and no-overwrite.
Also exercise the existing injected transaction contract without inventing a fill identity.
Run affected engine/orchestration/reporting tests, candidate architecture, typecheck, lint
and diff checks. No real credential, HTTP, DB, coordinator or runtime startup is involved.

Verification: 113 focused/affected unit tests and 15 architecture checks pass (128 total).
The four synthetic campaign before/after reports have identical legacy projections after
excluding `observationVariants` and normalizing only the disposable destination path. All
804 baseline occurrences are retained across 804 variants; the conflicting case retains
804 occurrences/variants across 798 legacy record views. The synthetic pretty-printed
baseline grows from 826,894 to 3,511,848 bytes. This storage increase is evidence-only and
does not change request/page bounds. Source hashes, synthetic reports and verification logs
are separate under `.local/m4-structured-retention-20261014`; no actual report is backfilled.

Old actual evidence is immutable and is not backfilled. Raw payloads, original numeric
lexemes, fields absent upstream, invalid timestamp values, provider-confirmed semantics,
missing fill identities, ownership lineage, private stream/epoch evidence and complete
account history remain unavailable. Structured retention cannot establish convergence,
unique trades, current full-account positions, exclusive use, authority or formal acceptance.
AS1/D4c, all false authority grants and prior descendant ACL uncertainty remain unchanged.
