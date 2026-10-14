# M4 pagination evidence record — template

Template only. It contains no provider answer, confirms nothing and changes no contract,
configuration, gate or grant. It applies the §4 rules of `docs/M4_PAGINATION_CONTRACT_FOLLOWUP.md`.

## How to use it

- **One record per source.** A source is one provider reply (email or chat), or one capture of
  authoritative endpoint-specific documentation. An email reply is not required: documentation
  alone may support an item.
- **Reuse the existing record format.** Parts A–C below follow `PROVIDER_RECORD.md`
  (`stage2-provider-record-20261005T180427Z`): provenance table, hash table with hash scope,
  verbatim text between markers, and a statement index of exact `«…»` excerpts. The excerpts
  are checked as exact substrings of the retained text, as that package's `VERIFICATION.json`
  does. Parts D–F (pagination disposition, candidate setting, limitations) are the only
  additions; this is not a separate evidence system.
- **Where it lives.** Keep the filled record and retained text in an ignored `.local/` package
  with `SHA256SUMS`, like the stage-2 record. A reply may contain account details, so it is not
  committed. A committed document may cite it by package name and hash only.
- **Statement ids** are local to each record. Cite them as `<record id>:E<n>` so they cannot be
  confused with E1–E29 of the stage-2 record.
- **Never fill a field by inference.** Unknown values are written `Unavailable`. Unanswered items
  are written `NOT_ANSWERED`.

---

## A. Provenance

| Field | Value |
| --- | --- |
| Record id | `<record id>` |
| Source type | `PROVIDER_REPLY_EMAIL` / `PROVIDER_REPLY_CHAT` / `AUTHORITATIVE_DOCUMENTATION` |
| Reference | Case or ticket id; or documentation URL and anchor. Otherwise `Unavailable` |
| Date | Sent date (reply) or publication/last-updated date (documentation), when shown. Otherwise `Unavailable` |
| Retrieved or received | Date the account holder received or captured it |
| How it reached this record | For example: pasted by the account holder; exported `.eml`; saved page |
| Authentication | Headers/Message-ID or page integrity checked, or `Not independently verified` |
| Question it answers | The message it replies to, with its record or hash if reviewed. Otherwise: "reported sent; exact sent text not reviewed" |

| Retained file | SHA-256 | Bytes |
| --- | --- | --- |
| `<path inside the .local package>` | `<sha256>` | `<n>` |

**Hash scope.** State exactly what the hash identifies (encoding, line endings, normalization).
It identifies the retained file, not the original email bytes or the live web page.

## B. Retained text (verbatim)

Embed the retained text as `PROVIDER_RECORD.md` §2 does: the markers sit outside a `text`
fence, and the fenced content is byte-identical to the retained file.

````text
<!-- SOURCE-BEGIN -->
```text
<verbatim text>
```
<!-- SOURCE-END -->
````

For documentation, retain the endpoint section actually relied on, with its heading path.
Capturing documentation is a separate, separately permitted step; this template fetches nothing.

## C. Statement index

| Id | Exact excerpt | Location | Kind |
| --- | --- | --- | --- |
| E1 | «<exact substring>» | Paragraph/line, or documentation heading and anchor | States a rule / states an absence / example only / recommendation / disclaimer |

List pagination topics the source does not address, as `PROVIDER_RECORD.md` §3 does.

## D. Pagination disposition

One row for each item and endpoint the source touches. Items stay separate: in particular, P1
(short page is terminal at the size sent) and P1b (requests above `size` 100) are separate rows.
A P1 answer at size 25 needs no P1b answer.

| Item | Endpoint | Stated scope | Page size covered | Statement ids | Disposition | Covers our request | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 Short page terminal | `POST /exchange/v1/derivatives/futures/orders` or `.../positions` | The scope as the statement gives it: named filters (`status` values, `side`, `margin_currency_short_name`, `pairs`/`position_ids`), or a stated general scope such as "every request to this endpoint" | Sizes stated, a stated general range, or `Unstated`; effective size if different | `<record id>:E<n>` | `EXPLICIT` / `AMBIGUOUS` / `NOT_ANSWERED` | `YES` / `PARTIAL` / `NO` / `UNCLEAR` | Why |
| P1b `size` above 100 | | | | | | | |
| P2 Empty page meaning | | | | | | | |
| P3 Ordering and tie-break | | | | | | | |
| P4 Change during paging | | | | | | | |
| P5 Documented finish condition | | | | | | | |

Disposition rules:
- `EXPLICIT`: the excerpt states the rule for this item without qualification, and its stated
  scope clearly includes this endpoint. A general rule counts: for example, one stated for every
  list endpoint, or for every filter and page size of this endpoint, needs no restatement of
  our sides, statuses or size.
- `AMBIGUOUS`: the rule is hedged, example-only, or its scope (endpoint, filters or size) is
  unclear. A statement on a different subject is not an answer: stage-2 E12 ("pagination can
  continue back to the oldest available…") says nothing about what a short or empty page means.
- `NOT_ANSWERED`: nothing in the source addresses the item. It stays unknown and is never
  inferred from answered items.
- **Covers our request.** Compare the stated scope with what the adapter actually sends (follow-up
  doc §1): `YES` if it includes both `side` segments, the `status` list sent and the `size`
  requested, whether by naming them or by a clearly applicable general rule; `PARTIAL` if it
  covers only some of them (for example one side); `NO` if it excludes them; `UNCLEAR` otherwise.
  Only an `EXPLICIT` row can be `YES`.
- A partial source is recorded as partial. Each row supports only its own item and its stated scope.

## E. Candidate contract setting

Only P1 maps to an existing setting today: `contracts.terminalShortPage.ORDERS` or `.POSITIONS`.
P2–P5 and P1b are design inputs with no setting. Record the candidate, never apply it here.

| Setting | Candidate only if | Otherwise |
| --- | --- | --- |
| `terminalShortPage.POSITIONS` | A list-positions P1 row is `EXPLICIT` and covers our request `YES` | Not a candidate |
| `terminalShortPage.ORDERS` | A list-orders P1 row (or rows together) is `EXPLICIT` and covers our request `YES`: both `side` segments, the `status` list sent and the `size` requested, by name or by a clearly applicable general rule | Kept as scoped evidence; ORDERS stays unconfirmed |

**Why a narrow answer cannot confirm ORDERS.** The engine keys this setting per component. Both
list-orders `side` segments share one ORDERS value, so it cannot be confirmed for one side or one
status list only. An answer limited to `side=buy` or to some statuses is still retained, as
scoped evidence in Part D, but cannot by itself support the shared setting. A general rule for
the whole endpoint has no such limitation.

**Size limitation.** Under a confirmed setting the engine cannot tell a page shortened by a silent
provider cap from a real last page when only one short page is seen. A P1 answer is a candidate
only if its stated scope includes the `size` requested (named, or within a stated general range).
P1b is not needed for that.

## F. Remaining limitations and required review

Record, for every source:
- what it does not establish: complete history (stays `UNPROVEN`), atomic or cross-endpoint
  consistency, retention permanence, ownership, stream delivery, transactions or accounting;
- the separate review a candidate still needs: a reviewed configuration change to the explicit
  `contracts` input, rerun of the affected fixtures, and no change to gates, `authorityEligible`,
  Invariant 28, AS1, D4c or formal M3/M4 acceptance. All grants stay false;
- the observed-run rule: collection results never upgrade a disposition.

---

## SYNTHETIC illustration (not a provider statement)

The rows below are **SYNTHETIC**. They show only how a narrow, partial answer is recorded. No
provider said this, and these rows must never be copied into a real record.

SYNTHETIC case 1: a narrow answer.

| Item | Endpoint | Stated scope | Page size covered | Statement ids | Disposition | Covers our request | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | list-orders | SYNTHETIC: `side=buy` only; `status` unstated | SYNTHETIC: 25 | `SYNTHETIC-R1:E1` | `EXPLICIT` | `PARTIAL` | Scoped evidence. ORDERS is not a candidate: the sell side and status list are not covered |
| P1b | list-orders | — | — | — | `NOT_ANSWERED` | — | Not needed at size 25 |
| P2–P5 | list-orders | — | — | — | `NOT_ANSWERED` | — | Remain unknown |
| P1–P5 | list-positions | — | — | — | `NOT_ANSWERED` | — | Nothing about positions is inferred from the orders statement |

SYNTHETIC case 2: a general endpoint rule.

| Item | Endpoint | Stated scope | Page size covered | Statement ids | Disposition | Covers our request | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | list-orders | SYNTHETIC: every request to this endpoint, any filter | SYNTHETIC: every size from 1 to 100 | `SYNTHETIC-R2:E1` | `EXPLICIT` | `YES` | ORDERS becomes a review candidate without our sides, statuses or size being restated; still not applied here |
