# M4 terminal-page contract follow-up (list-orders, list-positions)

> **Status (recorded 2026-10-14):** Account holder reports pagination clarification email sent;
> provider response pending; exact sent-message evidence not reviewed.
>
> The text in §3 is the local draft, kept as a reference. It is not known to match the message
> actually sent, and no sent date, message ID or sent text is recorded here. This document
> confirms no capability, sets no `contracts.terminalShortPage` value and changes no gate,
> grant, AS1 or D4c decision.

Base checkpoint: `94672512458901cb8cba79623d8b303cd0840cf9`. This document changes no runtime
code, configuration or provider contract.

## Sources reused

| Source | Identity |
| --- | --- |
| Support email transcript (unauthenticated, user-supplied; see its provenance table) | `stage2-provider-record-20261005T180427Z/input/EMAIL_TRANSCRIPT.txt`, SHA-256 `a7e25abf817335a42e1ba9385d0befe25b2a2571696a6794562fed78e078bbae` (re-verified from `stage2-revision-20261005T183241Z.zip`) |
| Provider record, statement ids E1–E29 | `stage2-provider-record-20261005T180427Z/PROVIDER_RECORD.md` |
| Capability register V3 (B7, B8, B9, B11, B12) | `stage2-revision-20261005T183241Z/CAPABILITY_REGISTER_V3.md` |
| Full backlog (questions 13, 15–19, 44) and priority draft V2 (group 3) | `stage2-revision-…/PROVIDER_FOLLOWUP_DRAFT_V2.md`; `m2-design-revision-20261006T103215Z/PRIORITY_PROVIDER_FOLLOWUP_DRAFT_V2.md` |
| Roadmap V3 (M4 scope/exit, §7 O1–O6, §12) | `stage2-revision-…/FULL_BOT_ROADMAP_V3.md` |
| Terminations and recorded attempt-3 shape | `docs/M4_SYNCHRONIZATION_CANDIDATE.md`; `docs/M4_ATTEMPT_3_OFFLINE_REPLAY.md`; `docs/M4_OFFLINE_PIPELINE_DISCREPANCY.md` |
| Request construction | `src/integration/coindcx/transport.ts`, `client.ts`, `schemas.ts`; `src/integration/coindcx/live/sync-read-adapter.ts` |

Package SHA-256 (files under `C:\TSA`):
- `stage2-provider-record-20261005T180427Z.zip`: `9c2e7a8ca51c72e442eafda758161d09a938e6cce27340d02cd6c067cef6aea8`
- `stage2-revision-20261005T183241Z.zip`: `4a9254bfe4968fb47b2be6a8bcca1609ed13ac70b5db544e38ec0915a512e139`
- `m2-design-revision-20261006T103215Z.zip`: `de26fb6a62c30315b3d69d18a23a2fbc5e0019f56e1c774fd5e2c7ffcc3f295b`

The documentation anchors in the email were not fetched.
No reply to the earlier priority draft or full backlog is recorded in the reviewed material.
No provider response to the pagination clarification has been supplied.

## 1. Requests as the client sends them

| Endpoint | Path | Body fields sent by the M4 read adapter |
| --- | --- | --- |
| list-orders (`FUTURES_ORDERS`) | `POST /exchange/v1/derivatives/futures/orders` | `timestamp`, `status` (one comma-separated list of the declared statuses), `side` (`buy` or `sell`, one segment each), `page` (1-based string), `size`, `margin_currency_short_name: ["INR"]` |
| list-positions (`FUTURES_POSITIONS`) | `POST /exchange/v1/derivatives/futures/positions` | `timestamp`, `page`, `size`, `margin_currency_short_name: ["INR"]`; the optional `pairs`/`position_ids` filters are not sent |

Each orders side is paged and terminated independently. The proposal used `size` 25 and
`maxPages` 2 with statuses `open, filled, partially_filled, partially_cancelled, cancelled,
rejected, untriggered`.

## 2. Remaining terminal-page contract

### list-orders

| Category | Content |
| --- | --- |
| Support email states | Pagination exists, maximum page size 100 (E11); it "can continue back to the oldest available order" (E12); no fixed retention period should be assumed (E13). list-orders "provides the order history" (E5). No atomic cross-endpoint snapshot (E1, E3, E23). |
| Actual collection observed | Attempt 3, per side and pass: two full pages of 25 (25+25), stop at the page bound. Termination `SCAN_BOUNDARY_REACHED` (truncated). No short or empty page was reached, so terminality was not exercised. 600 observations / 101 distinct IDs are repeated per-scan observations, not unique orders. |
| Client assumes | Nothing terminal from a short page: the adapter continues to an empty page or the bound. The engine accepts a short last page as terminal only if `contracts.terminalShortPage` for this endpoint is `CONFIRMED`; records after any short page still block. `historyCompleteness` is always `UNPROVEN`. |
| Unknown | Short-page terminality per (`status` list, `side`, margin currency) filter; meaning of an empty page; sort key, direction and tie-break; page movement under concurrent create/update; whether `size` > 100 is rejected or silently reduced; whether a multi-status `status` list paginates as one ordered union; the documented finish condition. (Register B9; backlog 13, 15–17, 19.) |

### list-positions

| Category | Content |
| --- | --- |
| Support email states | Same pagination statements (E11–E13); list-positions "provides the current position state" (E9). |
| Actual collection observed | Attempt 3, per pass: 25 then 9 rows, then stop at the page bound. Termination `SHORT_PAGE_TERMINALITY_UNCONFIRMED` (unknown pagination); no empty page was requested. 204 observations / 34 distinct IDs are repeated observations, not a current full-account position count. |
| Client assumes | As for orders. The 9-row page is not treated as terminal. |
| Unknown | Whether a page shorter than `size` is terminal; meaning of an empty page; which positions are enumerated (open only, or also flat/closed records); sort key and tie-break; page movement when positions open, change or close during paging; the documented finish condition. (Register B9; backlog 13, 15–17.) |

Neither the short 9-row page, the full pages stopping at the bound, nor the completed
bounded campaign is evidence of complete history.

## 3. Draft provider message (reference draft; not the reviewed sent text)

The account holder reports that a pagination clarification email was sent. Its exact text was
not reviewed, so the draft below must not be cited as what the provider received. When reading
a reply, compare it with the sent message if that becomes available, not with this draft.

This draft narrows priority draft V2 group 3 to the two endpoints the M4 adapter reads. If the
priority draft is sent later, drop its group 3 pagination bullets so that nothing is asked
twice; the timestamp questions (11, 12, 18, 44) stay there.

> Subject: Follow-up — INR Futures list-orders / list-positions: when is a page scan finished?
>
> Dear CoinDCX Service Team,
>
> Thank you for your earlier email. You said these APIs paginate with a maximum page size
> of 100 back to the oldest available record. For these two calls, as we send them, could you
> give a dated written answer or documentation link, and a case reference?
>
> - list-orders: `POST /exchange/v1/derivatives/futures/orders`, body `timestamp`, `status`
>   (comma-separated, e.g. `open,filled,cancelled`), `side` (`buy` or `sell`), `page`, `size`,
>   `margin_currency_short_name: ["INR"]`.
> - list-positions: `POST /exchange/v1/derivatives/futures/positions`, body `timestamp`,
>   `page`, `size`, `margin_currency_short_name: ["INR"]`.
>
> For each endpoint separately:
>
> 1. If a page returns fewer records than `size`, is it always the last page for that exact
>    filter? Is `page` 1-based, and is a `size` above 100 rejected or reduced?
> 2. What does an empty page guarantee for that filter: no further records at that moment,
>    or only that the page number is past the current end?
> 3. What is the sort key and direction, and how are ties broken? For list-orders, does a
>    multi-value `status` paginate as one ordered list? For list-positions, are only open
>    positions returned, or also closed or zero-quantity ones?
> 4. If records are created or updated while pages are read, can a record move between
>    pages and be skipped or returned twice? Is there a recommended safe paging method?
> 5. What exact documented condition should a client use to stop requesting pages?
>
> We understand there is no atomic snapshot across endpoints and are not asking for one.
> A sanitized example (no real account data) would be very helpful.
>
> Kind regards,
> [account holder name]

## 4. Evidence needed to close each pagination item

**Accepted sources.** Either a provider reply recorded verbatim with provenance and a hash, as
`PROVIDER_RECORD.md` does, or authoritative endpoint-specific documentation captured with its
URL, retrieval date and a content hash (fetching it is a separate step; nothing was fetched
here). A general statement (such as E12) closes nothing. Observed runs cannot close any item.

**Disposition rules.**
- Items are independent. An explicit answer to one item supports only that item, for only the
  endpoint (and filter) it names. A partial reply is recorded as partial; unanswered items stay
  unknown and are not inferred from answered ones.
- A single contract setting can be reviewed once the items it depends on are answered. All
  pagination questions do not have to be answered first. For example, P1 alone is the input
  for reviewing `contracts.terminalShortPage` for one endpoint.
- Receiving an answer changes nothing by itself. Runtime contracts change only through a
  separately reviewed configuration change. No answer establishes complete history (which
  stays `UNPROVEN`), atomic consistency, ownership or any authority; all grants stay false.

| Item | Supported by | Effect if supported |
| --- | --- | --- |
| P1 Short-page terminality | An explicit statement, for the endpoint and filter, that a page with fewer than `size` records is the last page at the size the client sends (25 in the reviewed proposal) | Input for reviewing `contracts.terminalShortPage = CONFIRMED` for that endpoint only. `RECORDS_AFTER_SHORT_PAGE` still blocks; history stays `UNPROVEN` |
| P1b Requested `size` above 100 | A statement of whether such a request is rejected or reduced | Separate from P1: not needed for a terminality answer at size 25. Needed only before any configuration requests more than 100 |
| P2 Empty-page meaning | A statement of what an empty page guarantees for the requested filter | `OBSERVED_EMPTY_PAGE` keeps its "ends scanning, does not prove history" meaning unless the statement says more |
| P3 Ordering and tie-break | Sort key, direction and tie-break per endpoint; for orders, how a multi-status list is ordered; for positions, the enumerated set | Lets the design state which page shifts are possible; no completeness claim |
| P4 Change during paging | Whether records can be skipped or duplicated under concurrent change, and any recommended safe method | Keeps the two-pass comparison and duplicate/page-shift findings; a safe method would be a new design input, not a guarantee |
| P5 Finish condition | The documented stop condition per endpoint | Defines the adapter stop rule in a reviewed change; a bound reached first stays `SCAN_BOUNDARY_REACHED` |

Record with any reply: its case reference and date where available. An authenticated original
is preferable to a pasted copy (the existing transcript is unauthenticated).

## 5. Other evidence inputs (recorded separately; not part of this message)

- **Ownership.** Needs genuine durable lineage: this bot's own create responses bound to
  durable pre-dispatch intents, or a durable position ownership record (register §5,
  candidate "Ownership"). Manual orders, matching tags or `client_order_id` values alone do not
  establish bot ownership; C2/C3 remain unconfirmed and C1 says no provider field separates
  manual from API activity. The account is manually and shared used; no exclusivity is inferred.
  Any lineage export requires separate authorization and is not obtained here.
- **Stream.** Needs current private-stream connection and epoch observations over each
  observation window (connected state, epoch at window start and evaluation, disconnects,
  reconnect latch, buffered events). The join acknowledgement is UNKNOWN (D2), there is no
  sequence ID or replay cursor (E17), and a quiet stream proves nothing (O4). Attempt 3 had
  `stream: NOT_CONFIGURED`, UNKNOWN stream and a null epoch.
- **Transactions and accounting.** TRANSACTIONS is `CLIENT_ADAPTER_UNSUPPORTED`. Fill identity
  (B3) is claimed but unspecified; per-fill history, fees and exactly-once reconstruction (B13,
  O6) remain unresolved; priority draft V2 group 2 already asks the fill-identity questions.

## 6. Offline work while replies are pending

**Accepted milestones:** none changes. M2 implementation and its recorded offline checks are
complete; general production deployment is not approved. M3 and M4 remain candidates. M4 exit
still requires the roadmap's fixture tests, all seven register §5 scenarios, a separately
authorized read-only shadow campaign and a clean gate.

**Design candidates (offline, unaccepted, each separately reviewed before any code):**

1. *Done 2026-10-14 (test-only regression checkpoint):* the pagination contract cases and the seven §5
   scenarios were mapped to existing tests, and only missing regressions were added to
   `tests/unit/execution/live/practical-synchronization/engine.test.ts`. Those cover a SYNTHETIC
   confirmation for one component not applying to the other, ownership and stream blockers under
   clean confirmed termination, scenario 2 exact-field mismatches, and scenario 7 foreign
   classification. Page-size capping, records after a short page, unknown short pages and
   empty-page semantics were already covered (engine and loopback adapter tests).
2. *Contract gaps reported by that review (no engine change made):*
   - `contracts.terminalShortPage` is keyed per component. Both list-orders `side` segments
     share one setting, so a confirmation that covers only one side or one status list cannot be
     expressed. Such an answer is kept as scoped evidence, but cannot by itself confirm the shared
     ORDERS setting.
   - Under a confirmed contract, the engine cannot tell a page shortened by a silent provider
     cap from a genuine last page when only one short page is seen. A P1 answer is usable only if
     it holds at the exact `size` requested.
3. A recorded-reply template and per-endpoint mapping from a verbatim answer to
   `contracts.terminalShortPage`, so a list-orders answer can never be applied to list-positions
   by accident, and partial answers stay partial.
4. M4 acceptance criteria for history-completeness limits and read-duration bounds (roadmap
   §12), defined without numeric values and without filling unknown contracts.
5. A lineage-input format design for a future read-only export from the existing repositories;
   obtaining the export needs separate authorization.

Unchanged: strict gates, certificates, `authorityEligible`, Invariant 28, all authority grants
(false), AS1, D4c, formal M3/M4 acceptance, and prior descendant ACL uncertainty.
