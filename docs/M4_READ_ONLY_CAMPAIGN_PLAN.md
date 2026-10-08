# M4 read-only campaign plan (next review boundary; NOT authorized, NOT run)

**Status:** a plan for a separately authorized, read-only shadow campaign.
- It approves no numeric threshold, attests no exclusive account use, places no order, and starts nothing.
- D4c (the client proposal) and AS1 (the account-scope decision) remain pending.
- A campaign result could inform those decisions. It could not make them, and could not grant any authority.

## Required explicit configuration (no defaults; every value set and reviewed before a run)
- The account under observation, and the authenticated read client's credential binding. Before any read, the
  provider account fingerprint must be verified through the existing identity read.
- The declared scope:
  - components: the client adapter supports ORDERS and POSITIONS. TRANSACTIONS is `CLIENT_ADAPTER_UNSUPPORTED`
    (not evidence that the provider lacks transaction history or fill identifiers). A scope that requires it stays
    unresolved; an orders/positions-only run is labelled as exactly that, never as full account synchronization;
  - order statuses;
  - history scope;
  - `requiredAccounting` (empty; anything else blocks by design).
- Per-component page size and page bound; the cycle limit; read and stream timeouts; evidence-age and read-duration
  bounds. Every one of these needs acceptance criteria first (roadmap §12).
- Provider contracts as explicit inputs. Each stays unconfirmed unless a recorded provider answer confirms it:
  - the terminal-page rule per endpoint;
  - the tag field and the always-tagged rule;
  - venue-generated order types and wallet stages.
- The M2 read budget and its share for the campaign (U-M2-8), plus coordinator supervision, startup and operator
  controls. None of this is bound today.
- Observation schedule, total duration and evaluation count. Coverage criteria must come before any count.
- Durable lineage inputs (owned orders, ambiguous creates, closed tags, owned positions), taken read-only from the
  existing repositories.

## Observable coverage cases (passive reads can show these)
- Two agreeing passes on a quiet account: observed convergence, with history unproven.
- Pagination:
  - multi-page scans that reach an empty page;
  - scans that stop at the bound (truncation);
  - a provider that caps page size below the requested size, which shows as records after a short page.
- Orders in each status that occurs naturally, on both sides; flat and non-flat positions.
- Fills changing between passes (disagreement), and natural page shifts or duplicates.
- Private events during a cycle, with revocation and a fresh cycle; disconnects, reconnects and epoch changes; the
  reconnect latch.
- 429 responses and the shared-budget throttle, without a request storm.
- Read failures, timeouts, malformed payloads, and missing optional fields (gaps).
- Ownership classes for whatever records appear: OWNED via durable lineage; UNRESOLVED for tags without lineage, tag
  conflicts, malformed tags and missing tags.

## Cases passive reads cannot establish
- Exclusive account use, or the absence of manual, web or mobile activity: there is no origin field (C1).
- Join or subscription acknowledgement semantics (D2), and stream delivery completeness: a quiet stream proves
  nothing.
- Atomic consistency, gap detection, or "nothing changed between or after the reads" (B12).
- Complete account history, retention, sort stability, and terminal-page semantics (B8, B9). A run can observe
  terminations, but cannot confirm the contract.
- Stable fill identity, per-fill reconstruction, fee accounting and exactly-once execution (B3, B13); funding, ADL,
  fee and transfer representation (C5b–C5d).
- The tag field contract and echo, and duplicate client-order-id rejection (C2, C3).
- Liquidation and TP/SL representation, unless such events happen to occur, and even then only as observations (C5a).
- Any case that needs an order to exist. Creating one is a live mutation: FX found no compliant path.

## Stop conditions (any of these ends the run, read-only, with the reason recorded)
- An identity-fingerprint mismatch, or unknown or mismatched account provenance.
- Any request outside the declared read endpoints; any mutation path reachable; any budget refusal storm or 429 burst
  beyond the reviewed budget.
- A coordinator UNKNOWN or STOP; loss of supervision; reaching the configured duration or evaluation limit.
- Repeated identical failures without progress (a criterion to be defined, not a number approved here).
- Any operator stop.

## How results are classified
- **PASS:** the case was observed AND its expected behaviour held (for example, a page shift was observed and
  reported as unresolved).
- **NOT_OBSERVED:** the case did not occur during the run. This is not a pass, and says nothing about whether the
  behaviour would hold.
- **UNKNOWN:** passive reads cannot decide the case (the list above). It stays a provider or design question.
- **FAIL:** the case was observed and the expected behaviour did not hold. That stops the run, and needs review.

A campaign report counts each class separately and never folds NOT_OBSERVED or UNKNOWN into PASS.
