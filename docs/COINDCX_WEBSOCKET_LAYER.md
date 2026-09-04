# CoinDCX Futures WebSocket Transport Layer (Phase 4)

## 1. Architectural Overview

The CoinDCX Futures WebSocket layer (`src/integration/coindcx/websocket/`) provides a production-grade, resilient, non-mutating transport mechanism for real-time market data and private account execution updates from CoinDCX.

```
+-----------------------------------------------------------------------------+
|                        CoinDcxStreamCoordinator                             |
+-----------------------------------------------------------------------------+
               |                                             |
               v (Shared across all coins)                   v (Dedicated per account)
+-------------------------------+             +-------------------------------+
|  CoinDcxPublicFuturesStream   |             |  CoinDcxPrivateAccountStream  |
+-------------------------------+             +-------------------------------+
| - Socket.IO v2 client         |             | - Socket.IO v2 client         |
| - Channel: [pair]_1m-futures  |             | - Channel: "coindcx" (Auth)   |
| - Candle updates              |             | - Position / Order / Balance  |
| - Generation isolation        |             | - HMAC-SHA256 join payload    |
| - Single-flight reconnect     |             | - Disconnect reconciliation   |
| - Jittered bounded backoff    |             | - Zero credential logging     |
| - Safe Zod OHLC validation    |             | - Zero balance mutation       |
| - Recovery required barrier   |             | - Non-authoritative events    |
+-------------------------------+             +-------------------------------+
               |                                             |
               +----------------------+----------------------+
                                      |
                                      v
                      +-------------------------------+
                      |    Typed Stream Envelopes     |
                      |   (CoinDcxStreamEnvelope<T>)  |
                      +-------------------------------+
```

---

## 2. Core Invariants & Design Principles

1. **Protocol & Dependency Pinning**:
   - Strictly pinned to `socket.io-client@2.4.0` (exact pin, no caret `^` or tilde `~`).
   - CoinDCX v2 WebSocket transport (`wss://stream.coindcx.com`) requires native websocket transport (`transports: ['websocket']`), `autoConnect: false`, and `reconnection: false` (we manage reconnection single-flight and generation transitions deterministically).

2. **Stream Topology**:
   - **One Shared Public Stream**: All coins (BTC, ETH, SOL, etc.) share a single public WebSocket connection. Multiple channels (`B-BTC_USDT_1m-futures`, `B-ETH_USDT_1m-futures`) are multiplexed over this single socket via `join` and `leave` emits.
   - **One Isolated Private Stream**: A completely separate socket dedicated to authenticated account updates. Private authentication is isolated and never combined with public market data.

3. **Generation Isolation**:
   - Every connection attempt increments a monotonic `generationId`.
   - When a connection drops or reconnects, the previous socket instance is immediately dismantled, listeners stripped, and any lingering events or timeouts from older generations are rejected (`staleGenerationDropCount`).

4. **Single-Flight Concurrency Control**:
   - **Connection Single-Flight**: `#connectionAttempt` latch guarantees that concurrent calls to `start()` or internal reconnects join the existing attempt rather than creating duplicate connections.
   - **Reconnect Timer Single-Flight**: `#reconnectTimer` latch ensures that multiple failure triggers (`disconnect`, `connect_error`, `error`) on the same generation register exactly one backoff timer.

5. **Bounded Exponential Backoff with Jitter**:
   - Delay formula: `min(maxDelayMs, baseDelayMs * factor^(attempt - 1))`.
   - Full jitter formula: `random() * calculatedDelay`.
   - Defaults: base delay 1,000 ms, factor 2, max delay 30,000 ms, jitter factor 0.5.

6. **Channel Naming Contract & Ambiguity Resolution**:
   - CoinDCX documentation contains conflicting examples (`[pair]_[interval]-futures` vs `[pair]_[interval]-future`).
   - Phase 4 implements the documented example standard: `${pair}_${interval}-futures` (e.g. `B-BTC_USDT_1m-futures`).
   - Live smoke verification against `wss://stream.coindcx.com` confirmed exact match with incoming `B-BTC_USDT_1m-futures` and `B-ETH_USDT_1m-futures`.

7. **Envelope Structure**:
   Every dispatched event is wrapped in an immutable `CoinDcxStreamEnvelope<T>`:
   ```typescript
   export interface CoinDcxStreamEnvelope<T> {
     readonly source: 'COINDCX';
     readonly stream: 'PUBLIC_FUTURES' | 'PRIVATE_ACCOUNT';
     readonly generationId: number;
     readonly sequence: number;
     readonly receivedAtMs: number;
     readonly eventType: StreamEventType;
     readonly providerTimestampMs: number | null;
     readonly pair: string | null;
     readonly payload: T;
   }
   ```

8. **Strict Zod Validation & Financial Decimals**:
   - All incoming financial quantities (`open`, `high`, `low`, `close`, `volume`, `quote_volume`, `price`, `quantity`, `balance`) are parsed into immutable `Decimal` instances.
   - Structural OHLC consistency checks: `high >= low`, `high >= open`, `high >= close`, `low <= open`, `low <= close`.
   - Candle `isClosed: false` invariant enforced on real-time streaming updates.

9. **Recovery & Reconciliation Barriers**:
   - **Public Recovery Required** (`PUBLIC_STREAM_RECOVERY_REQUIRED`): Dispatched upon reconnection after an active stream was previously receiving valid market data, notifying downstream engines that gaps may exist and REST backfill is required.
   - **Private Reconciliation Required** (`PRIVATE_RECONCILIATION_REQUIRED`): Dispatched upon private socket disconnect/reconnect, instructing downstream account supervisors to trigger REST sync because private streaming events are change notifications, not source of truth.

10. **Security & Redaction**:
    - Zero private credentials, signatures, or raw payloads logged.
    - Sensitive keys (`apiKey`, `apiSecret`, `authSignature`, `auth_signature`, `authsignature`) recursively redacted to `'[REDACTED]'`.

---

## 2.1 Candle Phase Ownership & Finality Boundary (Phase 4 vs Phase 5)

> [!IMPORTANT]
> **Phase 4 candlestick events are TRANSPORT UPDATES. They are NOT canonical closed candles.**

1. **Phase 4 Transport Updates Only**:
   - Events dispatched by `CoinDcxPublicFuturesStream` (`PUBLIC_CANDLE_UPDATE`) represent in-progress real-time streaming updates from the WebSocket transport.
   - They are **NOT** canonical closed candles, **NOT** finalized strategy candles, and **NOT** persisted market truth.
   - Phase 4 **MUST NOT** decide candle finality. Even if a CoinDCX payload contains `close_time`, `duration`, and current OHLC, a received WebSocket message may still represent an in-progress candle.
   - The normalized Phase 4 event deliberately exposes `isClosed: false` to enforce explicit non-final semantics.

2. **Phase 5 Ownership**:
   - Phase 5 owns:
     - Canonical 1-minute candle construction and finality determination.
     - Closed-candle detection (ensuring all ticks for the minute have elapsed and the window is finalized).
     - Candle continuity semantics and historical REST gap-fill/repair when recovery is required.
     - Downstream canonical market-data emission to strategy and execution pipelines.
   - **NO strategy or downstream component may consume a Phase 4 candle UPDATE directly as a finalized candle.**

3. **Wire Precision Boundary**:
   - **String financial fields**: Parsed directly into arbitrary-precision `Decimal` instances via `Decimal.js`, preserving full exact precision without IEEE 754 binary floating-point errors.
   - **Already-decoded JS numeric fields**: If the provider or transport emits pre-parsed JavaScript numeric floats, original lexical precision cannot be reconstructed. Universal wire-lossless precision is not claimed across all transport boundaries; financial string payloads are required for lossless decimal fidelity.

---

## 3. Scope Boundaries

The WebSocket layer strictly adheres to Phase 4 architectural boundaries:
- **NO Order Placement or Cancellation**: No routes or methods to create or cancel orders.
- **NO Leverage Mutation**: No methods to update leverage or margin.
- **NO Position Exit**: No methods to close or exit positions.
- **NO Wallet Transfer**: No deposit or withdrawal operations.
- **NO Risk Engine Reference**: Zero dependencies on risk checks or margin calculators.
- **NO Database Persistence**: Candlestick updates are dispatched downstream in envelopes; no direct DB writes.
- **NO Strategy Invocation**: Zero signal generation or trade evaluation.
- **NO Foreign Exchange References**: Zero references or dependencies on Binance, Bybit, or other exchanges.

---

## 4. Verification & Testing

The WebSocket layer is verified through automated unit tests and public live exchange smoke validation:

| Test Suite | Tests | Status |
| :--- | :--- | :--- |
| `tests/unit/coindcx/ws/connection.test.ts` | 14 tests | PASS |
| `tests/unit/coindcx/ws/generation.test.ts` | 9 tests | PASS |
| `tests/unit/coindcx/ws/subscription.test.ts` | 10 tests | PASS |
| `tests/unit/coindcx/ws/candle-validation.test.ts` | 13 tests | PASS |
| `tests/unit/coindcx/ws/private-auth.test.ts` | 9 tests | PASS |
| `tests/unit/coindcx/ws/private-events.test.ts` | 9 tests | PASS |
| `tests/unit/coindcx/ws/recovery-barriers.test.ts` | 6 tests | PASS |
| `tests/unit/coindcx/ws/security.test.ts` | 7 tests | PASS |
| `tests/unit/coindcx/ws/resource-leaks.test.ts` | 6 tests | PASS |
| `tests/unit/coindcx/ws/scope-invariants.test.ts` | 10 tests | PASS |
| **Total Phase 4 Unit Tests** | **93 tests** | **100% PASS** |

### Live Exchange Public Smoke Test
- Command: `npm run coindcx:ws-smoke`
- Validated: Discovers BTC/ETH perpetuals, subscribes to `B-BTC_USDT_1m-futures` and `B-ETH_USDT_1m-futures`, connects to `wss://stream.coindcx.com`, receives real live candles, normalizes them with Decimal precision, checks health snapshot, and stops cleanly with zero leaks.
