# M2 W3: shared read budget in the three REST read primitives (note)

**Status: offline integration for review.**
- No production budget is bound anywhere in `src/`. Production initialization, the probe endpoints (U-M2-4) and all configuration values (U-M2-8) remain open.
- W4 (mutation transport) and W5 (candle reader) are pending.
- **Final no-bypass completion is not claimed.**

## Covered primitives

| Primitive | Budget source | Scope |
|---|---|---|
| `transport.ts`, non-owned `new CoinDcxTransport(options)` | `options.readBudget` (explicit; absent → refusal) | Given with the budget |
| `transport.ts`, owned `createOwnedCoinDcxReadTransport` | Set-once production binding | By host (`public.coindcx.com` → PUBLIC, otherwise API_AUTH) |
| `instrument-authority.ts`, private `privilegedAcquireProductionInstrument` | Set-once production binding | API_AUTH (api host) |
| `paper-evidence.ts`, private `privilegedGetJson` | Set-once production binding | By host |
| `paper-evidence.ts`, a public provider's own default transports | Set-once production binding, through `boundProductionTransportBudget` | PUBLIC / API_AUTH by host |

`CoinDcxClient` passes `readBudget` through to the non-owned transport it constructs.

## Behaviour (U-M2-3 decision for this offline wave)

- **Where the permit is acquired:** inside each primitive, after its existing configuration checks (missing key or signer still fails first, with no permit), and before final request preparation (signing, headers) and request creation.
- **Caller-built bodies and timestamps:** signed as given after the wait, never rewritten. **No timestamp freshness is claimed.** A stale-timestamp rejection keeps the existing read-failure handling.
- **Refusal:** a missing, unbound, unavailable or refusing budget is an explicit refusal before any HTTP request: `CoinDcxProviderError`, status 503, `details.readBudget = 'REFUSED'`, plus a reason. There is no unpaced fallback.
- **Permits:**
  - one permit per wire request, so every caller retry acquires its own;
  - the request is created inside `permit.start`, the synchronous start check, so STARTED is reported at request creation, including when creation throws;
  - an unused permit is released only when preparation fails before the start (irrevocable known non-use);
  - completion is reported only on the request's `close` event;
  - a throwing or uncertain factory produces neither NOT_STARTED nor completion evidence.
- **Shared throttle:** a 429's raw `Retry-After` and `Date` values go to the coordinator. There, full waits, all three HTTP-date forms, scoped probes and STOP apply; local-clock conversion is never trusted. The caller-facing errors (`CoinDcxRateLimitError` with `retryAfterMs`, and the instrument/paper status errors) are unchanged. Header values over 128 characters are replaced by an unparseable marker, so they fail closed.
- **Probes:** `runtime/read-probe.ts` runs an **injected** read-only executor when the coordinator announces a probe. Tests use loopback executors only.

## Set-once production binding

`bindProductionReadBudget` succeeds once per process; any later call throws. Until it is bound, every owned or privileged read refuses.
- The budget can only delay or refuse. It never supplies or alters response data.
- **Limit:** the binding is a process-global seam, and whoever binds first wins. This is the same trusted-process model as the IPC prototype.

## Architecture changes for review

- **F14-03 pin** (`tests/architecture/phase14-authority-order.test.ts`, the instrument success path): a narrow amendment allows exactly one budget-only import call, `acquireProductionPermit(url, PRODUCTION_INSTRUMENT_REQUEST_TIMEOUT_MS)`, from `./rate-limit/runtime/read-budget`. Every other repository import remains forbidden on the success path. Companion assertions pin the permit's use to `start` / `complete` / `throttled`, and keep response data out of it.
  - The other F14-02/F14-03 pins are untouched: the exact mint signature `(pair: string)`, no injectable seams in the production factory, private primitives, and the endpoint byte-identity.
- **New `tests/architecture/rest-limiter-coverage.test.ts`:**
  - provider request sites must be covered (the three primitives) or explicitly pending (W4 mutation transport, W5 candle reader);
  - the local HTTP server and local named-pipe IPC are distinguished from request sites.
- **M2 boundary:** outside `rate-limit/`, only the three primitives and `client.ts` import the limiter, and only the type-only-importing `read-budget.ts`.

## Existing tests changed (fixture injection only; no assertion weakened)

- Transport tests pass `readBudget: fixtureTransportBudget()`.
- The production acquisition harnesses bind a granting fixture production budget.
- The prototype-bypass tests bind it in their fresh module registry.
- The Phase 18B practical tests bind it in-process and in their child programs.

The fixture (`tests/helpers/read-budget-fixture.ts`) is test-only.
