# M4 private-stream observation adapter (unwired review candidate)

**Status: offline review candidate, fake injected streams only.** It satisfies no AS1/D4c
decision, completes no formal M3/M4 milestone, proves no private-stream readiness and grants nothing. Nothing
composes it: the campaign keeps `stream: NOT_CONFIGURED`.

Requirement: roadmap V3 M4 "explicit handling of private events as revocation and reconciliation inputs" (§7 O3),
with O4 (a quiet stream proves nothing) and register D2 (join acknowledgement UNKNOWN). The M3 design reuses the
existing Phase 18B incarnation/epoch and reconnect latch by name (D5).

## Placement and dependencies

`src/integration/coindcx/live/sync-stream-adapter.ts`, beside `sync-read-adapter.ts` and pinned the same way:
- one type-only import of the websocket layer's own port types (`PrivateStreamHealthSnapshot`,
  `StreamEventListener`) from `../websocket/types`; no `src/execution` import, so the observation shape is a local
  structural type that the engine validates;
- an injected stream port (`subscribe`, `getHealthSnapshot`), which the existing `CoinDcxPrivateAccountStream`
  satisfies structurally, and an injected clock (`now`);
- no socket, credential, signer, client or runtime construction, and imported by nothing in `src`.

It returns the orchestrator's existing `observeStream` / `subscribeEvents` contract, plus `close()`.

## Mapping (each checked against the source)

| Observation field | Source | Notes |
| --- | --- | --- |
| `connected` | `health.connected` | |
| `epoch` | `health.generationId` when positive, else `null` | The local connection incarnation. It increments on every connect attempt and on `stop()`. It is not provider or account continuity |
| `epochAtWindowStart` | the `generationId` captured by the `CYCLE_START` observation | The engine already uses its cycle-start observation as the window-start epoch. `CYCLE_START` precedes the first read, so a change in between revokes rather than being missed |
| `disconnectObservedSinceWindowStart` | any lifecycle envelope in the window, or a change of `generationId` or `reconnectCount` since `CYCLE_START`, or not connected at either point | Envelopes alone are insufficient: socket and connect errors schedule a reconnect without dispatching `PRIVATE_STREAM_DISCONNECTED`, and stale-socket envelopes are dropped. Evidence is latched, so a final connected snapshot cannot erase it |
| `reconnectLatched` | `reconciliationRequired`, or state `RECONCILIATION_REQUIRED`, at either point | Sticky in the stream; never cleared here |
| `joinAcknowledgement` | always `UNKNOWN` | Any confirmation-like health field is ignored (D2) |
| `events` | one `{ observedAtMs }` per envelope received in the window, plus one at evaluation if `invalidEventCount` changed | Every envelope counts, whatever its type (the reviewed noise list is empty). An invalid-count change is an unknown private event (existing Phase 18B rule). Only the local time is kept; no payload, type or identifier |
| `bufferedUnprocessedEvents` | envelopes this adapter received but failed to deliver to a consumer (sticky) | Supported meaning and downstream effect: see below |

`observedAtMs` comes from the injected clock, the same clock as the reads, not from the envelope.

## Window lifecycle and ordering

- **Construction.** The adapter subscribes when created, before any window, so no event can fall between opening a
  window and subscribing. If `subscribe` throws or returns no unsubscribe function, the adapter is marked closed
  first and creation throws, so a listener the stream may still hold records nothing.
- **Before a window.** Envelopes are forwarded to consumers but belong to no window. This matches the evaluator,
  which only revokes on events at or after the window start; the cycle's reads follow them.
- **Cycle start.** The window is opened *before* the health capture, so an envelope arriving during the capture is
  kept in it. A failed capture closes it. A new `CYCLE_START` closes any earlier window.
- **Consumers.** The orchestrator registers its consumer once, before its first observation. A consumer registered
  later still has every in-window envelope reported through the window's `events`, which do not depend on delivery.
- **End of a window.** `EVALUATION` for the same cycle closes the window whether or not it succeeds. The window also
  closes when its cycle's `signal` aborts. The orchestrator aborts that signal on revocation and in its `finally`
  at the end of every cycle, so envelopes after an abort (callbacks do not stop at once) are forwarded but not
  retained. Without an aborting signal or an evaluation, an open window keeps one `{ observedAtMs }` per envelope;
  no numeric limit is added and no memory ceiling is claimed.
- **Bursts.** Each envelope of a synchronous burst is recorded separately; none is collapsed. Through the
  orchestrator, the first envelope aborts the cycle and so closes its window.
- **Rejections.** `EVALUATION` without its window, a closed adapter, an aborted or missing signal, a throwing or
  malformed health snapshot, or a non-integer clock all **reject**. The orchestrator then records
  `STREAM_OBSERVATION_UNAVAILABLE` and the engine revokes.
- **Consumer failure.** Each envelope is forwarded to every consumer as `{ observedAtMs }` only. If a consumer
  throws, the others still receive it, the envelope is counted as unprocessed, and the failure is rethrown to the
  stream, which logs `DOWNSTREAM_HANDLER_ERROR` (event type only). It is not swallowed.
- **Close.** `close()` marks the adapter closed before unsubscribing, so an unsubscribe failure propagates and still
  leaves it closed. Consumer unsubscribe functions are idempotent.

## `bufferedUnprocessedEvents`: supported meaning and downstream effect

Contract: "Events received but not yet applied" (`PrivateStreamObservation`). Every consumer in `src`:
- `assessment.ts` `validStream`: shape only (non-negative safe integer);
- `assessment.ts` `streamRevocations`, used by `assessPracticalObservation` and `recheckObservationCandidate`:
  `> 0` adds `BUFFERED_EVENTS_PENDING`, a revocation; the recheck path can only invalidate, never upgrade;
- `engine.ts`: `BUFFERED_EVENTS_PENDING` is in its revocation set; its unavailable observation uses `0` but revokes
  through its other fields.

The orchestrator, campaign and scripts do not read it. So `0` is never affirmative evidence of anything; it only
means that this one revocation reason is absent. A convergence result that follows is, by the assessment's own
contract, not atomic consistency, gap detection, "nothing changed between or after the reads" or strict continuity.
Changes that are never observed remain the roadmap's accepted residual risk (§7 O1), and a quiet stream is not
credited (O4).

What the adapter can honestly report, checked against the stream source:
- The stream holds no queue: it dispatches each notification synchronously to its subscribers. Every
  current-generation notification is either dispatched (even when its records are filtered out) or counted in
  `invalidEventCount` (mapped above). Only stale-generation callbacks are dropped uncounted (below).
- Every envelope received in a window is reported in `events`, independently of delivery, so it already revokes.
- What remains is an envelope that a consumer failed to apply; that is counted and kept sticky for the adapter's
  life, because it was never applied.

So the supported meaning is: **envelopes received by this adapter and not applied by every consumer**. Data not yet
received by the process (socket, operating-system or provider backlog) is outside "received" and outside this port.
It is the existing unobserved-change residual, not a buffered count, and it is neither represented nor implied.

## Other mappings and limits

- `generationId` is a local connection count. It increments on every connect attempt and on `stop()`; it is not
  provider or account continuity.
- The window-start epoch is captured at `CYCLE_START`, slightly before the first read (the field's documented point).
  The engine already uses that observation as the window start. The earlier boundary can only add revocations.
- An invalid-count change is one event, timed at detection (evaluation), not at the drop. Evaluation follows the
  first read, so it always revokes. A drop between `CYCLE_START` and the first read would not revoke if timed
  exactly, so this is conservative. Drops before `CYCLE_START` are outside the window, like other events.
- `staleGenerationDropCount` is not mapped, as in the existing Phase 18B tripwire. A socket can deliver private
  notifications only after it has connected, which sets the stream's sticky `hadConnected`. Any replacement
  connection then sets the sticky reconnect latch, and until it connects the stream reports not connected. Either
  way every later window revokes, so ignoring stale drops hides no evidence that existing policy requires.
- Not inferred: delivery equals processing (consumer processing is the orchestrator's revocation); a quiet stream
  is complete delivery; generation continuity is account continuity.

## Compatibility

No existing module, type, contract or behaviour changes. Without the adapter, the campaign and orchestrator behave
exactly as before. Real stream evidence needs separately authorized wiring and a live session; neither is part of
this candidate.
