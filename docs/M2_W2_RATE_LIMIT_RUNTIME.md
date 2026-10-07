# M2 W2: shared REST limiter runtime (note)

**Status: unwired prototype for review. NOT APPROVED for operational use.**
- No provider request or mutation path imports the limiter.
- A budget permit is never execution authority.
- W3–W6 have not been authorized.
- The frozen V3 design (`.local/m2-design-v3-20261006T150732Z/`) is unchanged; this note records where W2 differs from or tightens it.

## Tightened inventory rule (supersedes design V3 §2.4)

An empty, missing or partial reconnect inventory is **not** proof that a grant was not used. The coordinator releases an uncertain charge or slot only on positive, trustworthy, irrevocable evidence:
- `STARTED`, `COMPLETED` or `NOT_STARTED` for that grant;
- an explicit `voided` inventory entry for that grant.

That evidence must come from a session authenticated as the grant's client instance, and it must name the grant's own epoch and session. A grant the client never received cannot appear in its inventory, so it stays uncertain. V3 §2.4 had treated grants missing from an inventory as released; that rule is withdrawn.

## Persistence contract (`runtime/state-store.ts`)

- **Installation marker:** `INSTALLATION.json` is written last, only by explicit initialization. In this wave initialization is permitted only for a new or empty disposable test directory. Without the marker the coordinator refuses to start; existing slot files never turn a directory into a fresh installation.
- **Slots:** two files, `state.slot-a` and `state.slot-b`, pre-created at initialization and never renamed.
- **Record format:** a magic number, a version, a sequence number, a length and a SHA-256 over the header and payload. The payload holds the full W1 scheduler snapshot plus the client registry, with resume secrets stored only as SHA-256.
- **Commit:** write A in place, truncate, `fsync`; then write B in place, truncate, `fsync`. A commit is acknowledged only after both. The coordinator delivers grants, acknowledges STOP and RESET_STOP, acknowledges throttle and probe reports, and announces probes only after the commit containing the change.
- **Recovery:** the higher valid slot, or the single valid slot. That is always at least the last acknowledged commit.
- **Fail closed (refuse to start, overwrite nothing):**
  - a missing or invalid marker, or one for another installation or pipe;
  - an incompatible version;
  - a sequence gap greater than 1;
  - no valid slot;
  - an unreadable scheduler snapshot.
- **Failed write:** the coordinator goes to UNKNOWN for the rest of that process. It never retries, every request is refused, and recovery means a restart from the durable slots.
- **Restart:**
  - outstanding charges and slots are restored;
  - each block re-waits its full duration from the restart;
  - STOP is restored exactly;
  - no cancellation hook is restored;
  - a new random epoch is created.

**Limits.** `fsync` maps to `FlushFileBuffers`. Tests cover process crashes at three commit points, plus torn, corrupt and incompatible files.
- **Not verified:** durability across power loss, which depends on the storage stack honouring the flush.
- **Not available:** a directory `fsync` on Windows from Node. Commits do not depend on one, because the slot files exist from initialization onwards.

## Conservative W2 decisions (they defer, not approve, U-M2-5/7/8/9/11)

- **UNKNOWN is terminal for the process:** no operator recovery or reset from UNKNOWN.
- **No process-termination evidence:** a disconnected or crashed client keeps its uncertain charges and slots.
- **No time-based release:** nothing is released by elapsed TTL, orphan timeout, request timeout or an empty inventory.
- **No trusted clock:** no trusted-local-clock date conversion, and no shortened restart wait. The coordinator never passes those optional W1 inputs. An HTTP-date is converted only with the server `Date` header; otherwise it fails closed.
- **No defaults:** every configuration value is explicit. All test values are fixtures.
- **IPC is an offline trusted-host prototype:**
  - Windows named pipe `\\.\pipe\…`;
  - a second coordinator on the same pipe fails to bind (EADDRINUSE, verified by process test);
  - the marker binds the state directory to one pipe;
  - **no ACL, impersonation control or remote-client exclusion is implemented or claimed**;
  - any connected client may send operator `CONTROL`.
- **Identity:**
  - the coordinator generates the epoch, session, grant and client-instance identifiers;
  - a client resumes only by presenting the instance's resume secret;
  - reports are bound to the grant's client instance, epoch and session;
  - caller-supplied identifiers alone are never evidence;
  - a client whose identity was pruned (no charges, no live session) registers anew.

## Pinned limits (not claims)

- **Suspension:** a process suspended inside the synchronous start region starts its request late. Its charge stays uncertain until `STARTED`, which the OS-suspension process test verifies. Suspension can also delay refusals and acknowledgements; no real-time bound is claimed.
- **Lost grants:** a grant written to a connection that is closing may be lost in transit. It remains uncertain at the coordinator: capacity is lost, the budget is never exceeded.

## Capability allowlist additions (for later reconciliation with G-PX)

W2 adds exactly these entries to `tests/architecture/phase17-mutation-capability.test.ts`. There are no wildcards, and no mutation permission is added. The separate pin that `src/integration/coindcx/live/` has exactly one network owner, the order-mutation transport, is unchanged.

| List | Added path | Why |
|---|---|---|
| `APPROVED_NETWORK_OWNERS` | `src/integration/coindcx/rate-limit/runtime/client.ts` | Local named-pipe IPC client only |
| `APPROVED_NETWORK_OWNERS` | `src/integration/coindcx/rate-limit/runtime/coordinator.ts` | Local named-pipe IPC server only |
| `APPROVED_COINDCX_CRYPTO_OWNERS` | `src/integration/coindcx/rate-limit/runtime/coordinator.ts` | SHA-256 of resume secrets, random identifiers |
| `APPROVED_COINDCX_CRYPTO_OWNERS` | `src/integration/coindcx/rate-limit/runtime/state-store.ts` | SHA-256 record integrity |

The original worktree's uncommitted G-PX version of the same file, which is left untouched, adds one different entry to `APPROVED_COINDCX_CRYPTO_OWNERS`: `src/integration/coindcx/websocket/private-stream-provider-observations.ts`.

To reconcile, take the **union** of both sets of additions and change no other entry. Both sets of restrictions stay in force: the exact-list equality assertions, the single `live/` network owner, and the M2 boundary pins that limit the runtime to local `\.\pipe\` endpoints with no HTTP, TLS or signing.
