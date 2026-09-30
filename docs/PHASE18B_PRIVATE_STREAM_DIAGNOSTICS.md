# Phase 18B observational private-stream diagnostics

Implementation review wave; no commit, deployment or live enablement is implied.
Baseline: `7c6f6fa1d8bc89fe6c7b291681c593fa158c91e5` on
`feature/phase18b-stage1b2-mutation-safety`.

## Contract and scope

The optional sidecar records **local lifecycle observations only**. Its schema
is separate from historical practical-shadow V1 evidence, classification,
replay, configuration digest, collector and persistence. It has no database
dependency and grants no authority. A clean source commit is checked by the
existing shadow start gate; there is no dirty-source override.

`private-stream-diagnostics-schema.ts` is the normative closed TypeScript
schema and runtime parser. All object fields are required; absence is expressed
only by the declared `null` alternatives. Numbers are nonnegative safe integers;
event/snapshot/attempt/gap identifiers and socket generations are positive.
Session IDs are UUID v4; source commits are lowercase 40-hex git commits.
Source provenance means the existing clean-source check passed at session
start, not continuous filesystem attestation. The diagnostic attempt ID is
local to that session, paired with the transport generation; neither is a
provider incarnation identifier or a capability.

The parser rebuilds and freezes exact own data fields. It rejects unknown keys,
accessors, inherited required fields, exotic prototypes, symbols, sparse arrays
and extra array properties, without reading field getters or `toJSON`. A proxy
can execute its own reflection traps; thrown failures are reduced to the fixed
`DIAGNOSTICS_INVALID` error. JSON-text input has a separate bounded preflight
which rejects duplicate **decoded** keys at every object nesting level (including
objects in arrays), before standard parsing. Object validation cannot recover
duplicate keys already lost by an earlier JSON parser. Text input is limited to
4,194,304 UTF-8 bytes and nesting depth 32.

`grantsAuthority` and `provesAccountContinuity` are always `false`.
`providerConfirmationObservation` is always
`NOT_OBSERVABLE_WITH_EXISTING_LISTENERS`. There is no free-text reason, provider
timestamp, endpoint, path, account/order identifier, raw private payload, raw
disconnect argument, raw error or credential field. CLI warning categories are
fixed codes and never interpolate filesystem/error values.

## Timing, retention and coverage

The independent diagnostic clock reads wall time with `Date.now()` and elapsed
whole milliseconds with `process.hrtime.bigint()` relative to recorder
construction. It never calls the transport clock, scheduler or RNG. Durations
use elapsed time only. Wall regression/invalid samples record their fixed
categories but do not invalidate otherwise valid elapsed durations. Monotonic
regression/invalid samples increment a diagnostic clock epoch; durations
crossing epochs, or involving a null elapsed sample, become `null` with
`CLOCK_INVALID`, even if a later clock sample recovers. A throwing/reentrant
clock disables further capture, preserves retained observations and sets
`RECORDER_FAULT`; subsequent snapshots use the last available stamp. Timestamps
are observations, not provider freshness or continuity proof.

For both object and JSON-text inputs, any non-empty clock-issues array in a
retained stamp requires coverage `CLOCK_ANOMALY`: session start, snapshot,
first observed reconciliation requirement, every event, and every open/closed
gap's opening, ending (when present) and observation-through stamp. Either
positive cumulative wall/monotonic anomaly counter also requires that flag,
even after the original observations are evicted. The flag consequently
requires `INCOMPLETE`. Inconsistent evidence is rejected, never repaired.
This implication is one-way: a historical `CLOCK_ANOMALY` flag remains valid
without retained corroboration. Recorder-fault null sentinel stamps with empty
issues remain valid; wall-only issues do not invalidate monotonic durations.

The event ring retains 4,096 events, the closed-gap ring 256 records, and one
open gap is protected separately. Oldest closed records/events are evicted;
IDs keep increasing and eviction totals and retained first/last sequence are
exported. Aggregate counters remain exact after history eviction; coverage is
`INCOMPLETE`. Counters saturate at `Number.MAX_SAFE_INTEGER` without wrapping;
overflow is flagged and counts become lower bounds. Identifier exhaustion
disables capture instead of reusing IDs. Export counter saturation is also
represented conservatively as incomplete/non-exact coverage. Ring insertion
at transport capture points is constant work; snapshot rebuilding is bounded
by the fixed retention limits and runs outside provider callbacks.

Coverage `COMPLETE` means only complete local observation from `session.startedAt`
through `snapshot.at`, with no known recorder/clock/retention/export loss. It
does not mean a complete campaign, successful connection, reconciliation,
provider confirmation or account continuity. An open gap can have complete
local coverage. Terminal failures cannot rewrite an older snapshot to describe
the failure; fixed CLI warnings and in-memory export history report it. An
older nonterminal sidecar cannot establish session coverage after its timestamp.

## Capture points and lifecycle rules

Exactly the existing seven provider listeners remain: `connect`, `disconnect`,
`connect_error`, `error`, `df-position-update`, `df-order-update`, `balance-update`.
There is no acknowledgement listener.

| Capture point | Observation and association |
| --- | --- |
| Existing generation allocation | Local attempt plus generation; INITIAL, RETRY or AFTER_STOP phase |
| Owned socket factory return | SOCKET_CREATED for that attempt |
| Admitted connect callback | CONNECTED; callback and unique local socket counts; existing reconnect-path boolean |
| Existing reconnect latch assertion | RECONCILIATION_REQUIRED with first-assertion flag and first observed stamp |
| Existing categorized disconnect | DISCONNECTED using the existing six-category reason mapping once |
| Admitted connect timeout / connect_error / error / attempt catch | FAILURE with CONNECT_TIMEOUT / CONNECT_ERROR / SOCKET_ERROR / ATTEMPT_EXCEPTION only |
| Existing join emit boundaries | JOIN_EMIT_ATTEMPTED, JOIN_EMIT_RETURNED, JOIN_MARKED_SENT only where the original transport sets its local flag |
| Existing reconnect token checks/install/fire | RECONNECT_SUPPRESSED, RECONNECT_SCHEDULED with the already computed delay, RECONNECT_TIMER_FIRED |
| Stale listener/timeout/reconnect/heartbeat/guard callbacks | STALE_CALLBACK with closed callback category; captured old association where available, null for internal guards without one |
| Existing validated/invalid notification increments | Aggregate counts only; no per-notification event or content retained |
| Existing stop generation increment | STOP with resulting generation, close any open gap as STOPPED_UNRESOLVED |

Existing disconnect mapping is SERVER_DISCONNECT, CLIENT_DISCONNECT,
PING_TIMEOUT, TRANSPORT_CLOSE, TRANSPORT_ERROR or UNKNOWN_DISCONNECT_REASON.
No diagnostic code examines the raw argument a second time.

The first admitted failure/disconnect opens a gap; repeats retain the first
cause and origin and increment counters without opening duplicate gaps. Until
the first admitted connection, it is INITIAL_CONNECTION_FAILURE. A failure
after stop and before a new connection is AFTER_STOP_CONNECTION_FAILURE.
Following a prior connection it is TRANSPORT_GAP. The interval begins at the
observed failure, not at attempt start; it is not claimed as the full real
network outage. Only an admitted connection closes it as TRANSPORT_RESTORED;
initial-failure recovery does not increment successfulTransportReconnects.
Stop freezes a pending gap as STOPPED_UNRESOLVED; later snapshots do not extend
that duration. Open-gap duration extends through each snapshot's clock sample.
Stop/restart retains the same recorder session, sequence, totals and latch
history; a new CLI invocation creates a fresh diagnostic session.

Repeated connect callbacks remain visible, while unique socketConnections and
gap restoration are deduplicated. Stale callbacks cannot open/restore gaps or
assert the latch. Reentrant subscriber/signer/socket continuations keep all
original ownership checks; JOIN_EMIT_RETURNED can be recorded for an old
attempt after reentrant stop without claiming JOIN_MARKED_SENT. The recorder
has no external observer callback. Capture failures are caught internally,
disable observation and never throw into transport. Diagnostic factory/start/
finish and warning failures are isolated at the CLI boundary. Original health,
metrics, clock/RNG calls, reconnect tokens/delays, envelopes, readiness,
classification and shutdown ordering remain unchanged.

## Optional shadow-only export

Only practical-shadow `start` can construct this sidecar, after the existing
clean source/configuration checks. It starts after the campaign opens, before
transport start; refusal/non-start commands create no worker or sidecar. Enable
with exact `LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_ENABLED=true`; any other value is
disabled. Optional `LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_DIR` must be absolute;
invalid configuration reports `CONFIG_INVALID` and disables diagnostics without
changing the shadow command result. Default directory is this checkout's
`.local/private-stream-diagnostics`. Filename is a fresh diagnostic UUID plus
`.json`. These settings are not persisted in shadow V1 campaign configuration.

START is requested once; PERIODIC every **30,000 ms**; FINAL after the existing
transport shutdown. The unchanged original failed-start path is preserved;
its diagnostic finalizer does not introduce transport shutdown. A snapshot is
closed-validated and serialized before any write. One worker receives only that
bounded text and its internal destination, with an empty environment and no
inherited loader arguments. There is one in-flight request and **no pending
queue**; overlapping requests increment skippedRequests. The interval and worker
are unreferenced, and the request acknowledgement timer is finite.

Per-export acknowledgement timeout is **5,000 ms**. Timeout clears busy,
disables future exports and requests worker termination. Worker startup/exit
failure does the same. A hung worker cannot hold the CLI open permanently.
Finite shortened deadlines/fault injection in tests have no CLI configuration.

The worker exclusively creates `<destination>.tmp-<snapshot-sequence>` with
`wx`, writes complete serialized text, and closes it before publication. First
publication uses an atomic filesystem hard link; an existing destination
(including a symlink) is refused, never overwritten/adopted. A failed first
write leaves no partial destination. Subsequent replacement verifies the
previous owned destination's device/inode and atomically renames the complete
temporary over it. Pre-publication/write/replace failure preserves the last
valid destination. Unsupported hard links/atomic rename fail closed; there is
no non-atomic fallback. Atomic visibility is promised, not power-loss durability
or a provider/filesystem guarantee on arbitrary network filesystems.

Only owned handles/temporary device+inode identities are cleaned. Temporary
collisions/unproven artifacts are preserved. Cleanup failure reports
TEMP_CLEANUP_FAILED and disables exports, bounding further accumulation. On
termination the parent cleans only a temporary whose identity was acknowledged
by the worker, after termination completes. If death occurs before that
ownership message, a temporary can remain; it is preserved, never guessed at.
No destination, historical file or unrelated file is deleted. Use an
operator-controlled output directory and a local filesystem supporting hard
links/atomic rename; inode checks are not protection against adversarial
concurrent directory replacement or in-place tampering. POSIX mode 0600 is
requested; Windows access is governed by the directory's ACL.

After existing shutdown, FINAL has a separate maximum **1,000 ms** wait,
including a composition-root fallback bound. Busy FINAL is not queued: it
reports FINAL_BUSY, marks finalUnconfirmed and terminates the worker. A FINAL
deadline reports FINAL_FLUSH_TIMEOUT; ack timeout/write/worker failure reports
its fixed failure category and finalUnconfirmed. No return value claims FINAL
success without the matching RESULT acknowledgement. Snapshot reason FINAL
means requested terminal observation; it is not itself acknowledgement proof.
Snapshot exportHistory describes previous acknowledgements; a snapshot cannot
self-report its future acknowledgement. Publication may have completed before
an acknowledgement was lost; no rollback/overwrite is attempted in that race.
The destination still contains a complete valid snapshot, but FINAL remains
unconfirmed. Periodic/final export failure never changes the original shadow
exit code, thrown error, evaluation count or classification. Shutdown does not
wait for worker cleanup beyond the final deadline; owned cleanup is best effort.

## Acceptance matrix and gates

| Invariant | Meaningful test coverage |
| --- | --- |
| Exact schema, immutable rebuilding, no raw values | JSON/object round trip; authority flags, unknown fields, duration/ID/size violations |
| Duplicate keys and hostile objects | Root/nested source/stamp/array-element decoded duplicates; getter/inheritance/symbol/proxy/sparse/accessor-array rejection |
| Initial failures and repeated callbacks | One initial gap, repeated failure counts, unique socket/recovery counts |
| Transport restoration distinct from reconciliation | Transport gap origin/new attempt, unchanged sticky latch after reconnect/stop |
| Local incarnation association, stale/reentrant callbacks | Old callback association, stale timeout/ping/reconnect guards, subscriber stop/restart, join-emission stop, clock reentry |
| Behaviour preservation | Enabled/disabled/failed-observer trace equality for six scenarios: envelopes, health, metrics, timers, clock/RNG calls, emissions and cleanup |
| Clocks, open/stopped gaps | Wall regression; invalid/regressed monotonic clock epochs; open duration; stop freezes unresolved duration |
| Clock evidence/coverage consistency | Every retained stamp location and all four issue categories in object/text inputs; positive counters alone; actual event/gap eviction; missing flag or COMPLETE rejection; historical flag and recorder-fault sentinel acceptance; valid wall-regressed monotonic duration |
| Bounded retention/counters/IDs | Event and gap ring eviction, protected open gap, exact aggregate counts, saturation arithmetic, ID exhaustion arithmetic, invalid generation |
| Atomic first publication | Real worker/files: complete publication, existing destination refusal, first-write fault points, exclusive temporary collision, competing first publishers |
| Ownership and replacement | Real device/inode loss rejection; replacement fault keeps previous contents and inode |
| Worker lifetime and export isolation | Real hang ack timeout, finite FINAL busy/deadline, startup/exit failure, idle real worker allows child process exit, throwing snapshot/warning |
| Shadow compatibility and authority | Sidecar hook failures preserve CLI outcomes/order; disabled/dirty/non-start guards; real adapter with diagnostics disabled/enabled remains UNPROVEN and authority-ineligible; existing historical V1 replay/classification/integrity suites |
| Architecture | Diagnostics depend only on local schema/clock/counter helpers; exact seven listeners; no latch reset, DB/authority imports or inherited worker environment |

Focused checks: websocket suites, practical-shadow suites, practical recovery,
practical mutation and live authority suites, followed by all architecture
tests, project typecheck, lint, build and `git diff --check`. Use explicit Vitest
`run --maxWorkers=6`; run the full six-worker suite once after focused checks
pass. No watch/default-overloaded worker run, provider campaign, credential
inspection or operational DB access is part of this wave. Database integration
results without an available test database do not establish durable DB behaviour.

Historical original review checks: focused 958/958 tests and architecture 696/696 tests passed;
typecheck, lint (10 warnings in an unchanged test file), build and diff checks
passed. The full six-worker suite ran once with DATABASE_URL removed, database
integration opt-ins removed, and dotenv pointed to an empty test file. It had
6,140 passed, 15 failed and 1 skipped tests. The 15 failures are mandatory
database-availability assertions in three unchanged Phase 14 paper integration
files (4 account-persistence, 1 instrument-economics migration, 10 production
runtime). No database-backed acceptance is claimed, and the full gate is FAIL.
At that review no full rerun or database access was used. All four
new diagnostic unit test files passed in the full run (46 tests).

Historical authorized follow-up: an isolated loopback-only disposable MySQL
instance resolved all 15 failed assertions and the explicit skip. With all 13
existing database strict flags enabled, its six-worker full gate passed
6,156/6,156 tests, with zero failed, skipped or database soft-skipped bodies.
The original failed-gate history is retained separately; these historical
results do not establish acceptance of the subsequent clock-coverage correction.

## Evidence gaps and non-goals

The operator campaign previously reported 193 evaluations and
PRIVATE_STREAM_RECONCILIATION_REQUIRED; those figures remain reported evidence
unless separately confirmed by available sanitized artifacts. This wave does
not require another long campaign, establish provider guarantees, or reinterpret
unavailable campaign artifacts as never having run.

The existing reconnect latch is not cleared here. Only a separately reviewed
resolution satisfying the current reconciliation contract can address that
gap. Transport restoration does not establish reconciliation completion.
After reconciliation the existing production stream still lacks provider
confirmation and remains UNPROVEN. Provider-origin confirmation must verifiably
establish this private account/channel subscription for the current socket
incarnation; join returns, received notifications, REST PASS, zero failures,
restarts and elapsed days do not establish it. The existing seven listeners
cannot collect such confirmation, and its event/ack format, account/channel
binding, incarnation binding, invalidation and delivery guarantees are evidence
gaps rather than invented fields. The implemented readiness contract also
requires well-formed live health, connected transport, no unresolved reconnect,
authJoinSent, AUTH_JOIN_SENT state, and confirmation source PROVIDER with an
exact matching positive-safe incarnation and nonnegative-safe confirmedAtMs.
These are existing contract fields, not additions to this sidecar. Strict Tier-A additionally requires the
authoritative complete, gap-free account continuity evidence documented in
`PHASE18_RECONCILIATION.md`, including detectable provider gaps/sequence or replay
coverage across reconnect; this sidecar proves none of it.

Explicit non-goals: acknowledgement listener, fabricated confirmation, latch
reset, certification/authority changes, armed-orphan release, dispatch/outcome
handling, mutation-store changes, execution/startup/gateway wiring, Prisma or
migration changes, Tier-A relaxation, live enablement, database cleanup or
modification of the operator shadow checkout. Provider semantics require
provider-origin evidence and separate review. The absence of a standalone
authoritative Phase 18B roadmap remains a documentation gap; this diagnostics
design does not invent remaining Phase 18 requirements.

## Complete synthetic example

The example below is generated entirely from deterministic local test events;
it is not operator campaign or provider evidence. It includes a restored
transport gap, the still-required reconciliation state, and a second open gap.

```json
{
  "schemaVersion": "P18B_PRIVATE_STREAM_DIAGNOSTICS_V1",
  "grantsAuthority": false,
  "provesAccountContinuity": false,
  "session": {
    "id": "12345678-1234-4123-8123-123456789abc",
    "source": {
      "kind": "GIT_CLEAN_COMMIT",
      "commit": "7c6f6fa1d8bc89fe6c7b291681c593fa158c91e5",
      "checkedAt": "SESSION_START"
    },
    "startedAt": {
      "wallMs": 1700000000000,
      "elapsedMs": 0,
      "clockEpoch": 0,
      "issues": []
    }
  },
  "snapshot": {
    "sequence": 1,
    "reason": "PERIODIC",
    "at": {
      "wallMs": 1700000000030,
      "elapsedMs": 30,
      "clockEpoch": 0,
      "issues": []
    }
  },
  "limits": {
    "lifecycleEvents": 4096,
    "closedGaps": 256,
    "openGaps": 1,
    "snapshotBytes": 4194304,
    "exportIntervalMs": 30000,
    "exportAckTimeoutMs": 5000,
    "finalFlushTimeoutMs": 1000
  },
  "current": {
    "generation": 2,
    "activeAttempt": {
      "attempt": 2,
      "generation": 2
    },
    "state": "RECONNECT_WAIT",
    "authJoinSent": false,
    "reconciliationRequired": true,
    "firstObservedRequiredAt": {
      "wallMs": 1700000000020,
      "elapsedMs": 20,
      "clockEpoch": 0,
      "issues": []
    }
  },
  "providerConfirmationObservation": "NOT_OBSERVABLE_WITH_EXISTING_LISTENERS",
  "counters": {
    "attemptsStarted": 2,
    "socketsCreated": 0,
    "connectCallbacks": 2,
    "socketConnections": 2,
    "successfulTransportReconnects": 1,
    "disconnectCallbacks": 2,
    "failureCallbacks": 0,
    "reconnectsScheduled": 0,
    "reconnectTimersFired": 0,
    "reconnectSchedulesSuppressed": 0,
    "joinEmitAttempts": 0,
    "joinEmitReturns": 0,
    "joinMarkedSent": 0,
    "stopCalls": 0,
    "staleCallbacks": 0,
    "validNotifications": 0,
    "invalidNotifications": 0,
    "gapsOpened": 2,
    "gapsRestored": 1,
    "gapsStopped": 0,
    "latchAssertions": 1,
    "wallClockAnomalies": 0,
    "monotonicClockAnomalies": 0
  },
  "disconnectsByCategory": {
    "SERVER_DISCONNECT": 0,
    "CLIENT_DISCONNECT": 0,
    "PING_TIMEOUT": 1,
    "TRANSPORT_CLOSE": 1,
    "TRANSPORT_ERROR": 0,
    "UNKNOWN_DISCONNECT_REASON": 0
  },
  "failuresByCategory": {
    "CONNECT_TIMEOUT": 0,
    "CONNECT_ERROR": 0,
    "SOCKET_ERROR": 0,
    "ATTEMPT_EXCEPTION": 0
  },
  "events": [
    {
      "sequence": 1,
      "at": {
        "wallMs": 1700000000000,
        "elapsedMs": 0,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 1,
        "generation": 1
      },
      "kind": "ATTEMPT_STARTED",
      "phase": "INITIAL"
    },
    {
      "sequence": 2,
      "at": {
        "wallMs": 1700000000000,
        "elapsedMs": 0,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 1,
        "generation": 1
      },
      "kind": "CONNECTED",
      "reconnectPath": false
    },
    {
      "sequence": 3,
      "at": {
        "wallMs": 1700000000010,
        "elapsedMs": 10,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 1,
        "generation": 1
      },
      "kind": "DISCONNECTED",
      "category": "TRANSPORT_CLOSE"
    },
    {
      "sequence": 4,
      "at": {
        "wallMs": 1700000000010,
        "elapsedMs": 10,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 1,
        "generation": 1
      },
      "kind": "GAP_OPENED",
      "gapId": 1
    },
    {
      "sequence": 5,
      "at": {
        "wallMs": 1700000000020,
        "elapsedMs": 20,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 2,
        "generation": 2
      },
      "kind": "ATTEMPT_STARTED",
      "phase": "RETRY"
    },
    {
      "sequence": 6,
      "at": {
        "wallMs": 1700000000020,
        "elapsedMs": 20,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 2,
        "generation": 2
      },
      "kind": "CONNECTED",
      "reconnectPath": true
    },
    {
      "sequence": 7,
      "at": {
        "wallMs": 1700000000020,
        "elapsedMs": 20,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 2,
        "generation": 2
      },
      "kind": "GAP_RESTORED",
      "gapId": 1
    },
    {
      "sequence": 8,
      "at": {
        "wallMs": 1700000000020,
        "elapsedMs": 20,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 2,
        "generation": 2
      },
      "kind": "RECONCILIATION_REQUIRED",
      "firstAssertion": true
    },
    {
      "sequence": 9,
      "at": {
        "wallMs": 1700000000025,
        "elapsedMs": 25,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 2,
        "generation": 2
      },
      "kind": "DISCONNECTED",
      "category": "PING_TIMEOUT"
    },
    {
      "sequence": 10,
      "at": {
        "wallMs": 1700000000025,
        "elapsedMs": 25,
        "clockEpoch": 0,
        "issues": []
      },
      "socket": {
        "attempt": 2,
        "generation": 2
      },
      "kind": "GAP_OPENED",
      "gapId": 2
    }
  ],
  "gaps": {
    "closed": [
      {
        "gapId": 1,
        "kind": "TRANSPORT_GAP",
        "cause": "TRANSPORT_CLOSE",
        "openedBy": {
          "attempt": 1,
          "generation": 1
        },
        "openedAt": {
          "wallMs": 1700000000010,
          "elapsedMs": 10,
          "clockEpoch": 0,
          "issues": []
        },
        "status": "TRANSPORT_RESTORED",
        "endedBy": {
          "attempt": 2,
          "generation": 2
        },
        "endedAt": {
          "wallMs": 1700000000020,
          "elapsedMs": 20,
          "clockEpoch": 0,
          "issues": []
        },
        "observedThrough": {
          "wallMs": 1700000000020,
          "elapsedMs": 20,
          "clockEpoch": 0,
          "issues": []
        },
        "durationMs": 10,
        "durationStatus": "VALID"
      }
    ],
    "open": {
      "gapId": 2,
      "kind": "TRANSPORT_GAP",
      "cause": "PING_TIMEOUT",
      "openedBy": {
        "attempt": 2,
        "generation": 2
      },
      "openedAt": {
        "wallMs": 1700000000025,
        "elapsedMs": 25,
        "clockEpoch": 0,
        "issues": []
      },
      "status": "OPEN",
      "endedBy": null,
      "endedAt": null,
      "observedThrough": {
        "wallMs": 1700000000030,
        "elapsedMs": 30,
        "clockEpoch": 0,
        "issues": []
      },
      "durationMs": 5,
      "durationStatus": "VALID"
    }
  },
  "coverage": {
    "scope": "LOCAL_OBSERVATIONS_ONLY",
    "status": "COMPLETE",
    "captureState": "ACTIVE",
    "issues": [],
    "firstRetainedEventSequence": 1,
    "lastRecordedEventSequence": 10,
    "eventsEvicted": 0,
    "closedGapsEvicted": 0,
    "recorderFaults": 0,
    "counterSaturated": false,
    "countersExact": true
  },
  "exportHistory": {
    "lastAcknowledgedSnapshotSequence": null,
    "skippedRequests": 0,
    "failedWrites": 0,
    "workerFailures": 0,
    "ackTimeouts": 0,
    "finalUnconfirmed": false,
    "lastFailure": null
  }
}
```
