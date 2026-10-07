# M2 W6: M10A admission-stop interlock (note)

**Status: offline implementation, local W6 checkpoint (including the closeout below).**
- This is not M2 acceptance.
- The design's final no-bypass exit (an empty allowlist) is **BLOCKED**: Phase 18 orphan cancellation remains a pending,
  budget-unintegrated mutation path, refused before transmission.
- The DB acceptance suites remain NOT RUN.
- Nothing here is composed into production.

## Behaviour

- **`RateLimitClient` local STOP latch.** Any STOP request (`control('STOP')`, `requestStop()`) latches local mutation
  refusal synchronously, before any acknowledgement is awaited. While latched:
  - new mutation acquisitions are `REFUSED LOCAL_STOP` with no IPC;
  - pending mutation acquisitions are refused at once (a later grant is released unused);
  - unused mutation grants are voided (NOT_STARTED);
  - the synchronous start check fails every mutation grant.

  Reads keep their eligibility; throttle and UNKNOWN still apply. The latch clears only on this client's own RESET_STOP
  that the coordinator durably applied, and only when no newer STOP was requested after that reset was sent (a stop
  generation captured at send time). An older reset acknowledgement, delayed or replayed after reconnection, never
  clears a newer latch; the coordinator status then returns to `PENDING` until the newer STOP is acknowledged.
- **`requestStop(ackTimeoutMs)`.**
  - `DURABLE` only for the coordinator's APPLIED acknowledgement. The coordinator sends it only after its durable commit
    of STOP (W2).
  - No connection, a disconnect before the acknowledgement, a rejection (failed persistence, UNKNOWN) or a timeout is
    `NOT_ACKNOWLEDGED`, never success.
  - The queued STOP is re-sent after reconnection. A later durable acknowledgement is visible in `stopStatus`.
- **`engageAdmissionStop` (`rate-limit/runtime/admission-stop.ts`).**
  - Synchronously, it calls the injected existing local admission stops (for example the practical account coordinator's
    or practical cancel service's `requestStop()`) and the limiter latch.
  - The report then carries the coordinator acknowledgement and `cancellation: CANCELLATION_HOOK_ABSENT`.
  - It imports no execution module and is not composed anywhere in `src/`.
- **`KillSwitchCancellationHook`** is an interface only. Nothing implements, registers or calls it, and no hook token is
  minted.
  - The pure scheduler now refuses a hook-token request with `CANCELLATION_HOOK_ABSENT` when no hook is registered
    (V3 R2-05; previously `HOOK_TOKEN_MISMATCH`). A token that differs from a registered one is still
    `HOOK_TOKEN_MISMATCH`.
  - The IPC request schema carries no hook field, so a raw request with one is a protocol violation, and every delivered
    grant has `viaHook: false`.
  - Caller-supplied hook fields grant nothing.

## Unchanged and preserved
- **Coordinator semantics from W1/W2:**
  - STOP revokes non-hook mutation grants;
  - a probe or cooldown changes only the throttle, never admission;
  - restart restores admission exactly, and an unreadable state gives STOPPED/UNKNOWN;
  - RESET_STOP is refused while UNKNOWN, and there is no UNKNOWN reset.
- STOP never rewrites or resends a request already started: definite outcomes stay definite, ambiguous ones stay
  ambiguous.
- STOP cannot revoke a request that already passed its synchronous start check (the documented suspension limit).
- No OPEN, CLOSE, orphan-policy, execution-authority, gate, certificate, `authorityEligible`, Invariant 28 or migration
  change.

## Tests
- New `tests/integration/coindcx/rate-limit/admission-stop.test.ts` (9 tests), covering:
  - closeout: a throwing local stop (the limiter latch still engages synchronously, every other local stop is attempted,
    failures are reported as `STOP_FAILED` apart from the coordinator acknowledgement);
  - closeout: RESET_STOP pending when a newer STOP is requested, with a delayed acknowledgement and with reconnect replay
    (scripted coordinator and the real coordinator across a restart). Before the closeout fix the older reset
    acknowledgement cleared the newer latch; both cases failed on the pre-fix logic;
  - STOP while admission waits and while grants are outstanding;
  - local refusal before the durable acknowledgement;
  - zero HTTP from refused mutations;
  - unchanged outcomes for started requests;
  - STOP + 429 + probe;
  - failed persistence;
  - unavailable, disconnect and restart;
  - absent and forged hooks.
- `throttle-and-restart.test.ts`: the V3 code for an unregistered hook, plus a mismatch-after-registration case.
- **Architecture:**
  - `m2-rate-limit-boundary.test.ts` pins the W6 module and the latch.
  - `rest-limiter-coverage.test.ts` records the W6 exit as BLOCKED by the pending orphan path, and keeps G-RX files out of
    `src/`.

## Production decisions still required
- Who engages the kill switch and composes it with which local stops.
- Coordinator supervision and startup, production initialization, and binding the budgets.
- IPC access control for operator control (U-M2-7; currently any connected client may send control).
- U-M2-4 (probe endpoints), U-M2-5 (recovery from UNKNOWN), U-M2-8 (all configuration values), U-M2-9 (termination
  evidence), U-M2-10 (suspension inside the final step), U-M2-11 (trusted time).
- M6 hook registration, the orphan-cancellation admission design, and the DB acceptance runs.
