# CoinDCX Read-Only Integration Layer

## 1. Overview & Architectural Boundaries

The **CoinDCX Read-Only Integration Layer** provides an immutable, production-grade, secure read-only interface for querying CoinDCX INR-Margined Crypto Perpetual Futures.

In strict compliance with **Invariant 1** (CoinDCX Only), **Invariant 2** (INR Futures Isolated Margin Only), **Invariant 4** (No Coin-Specific Hardcoding), **Invariant 16** (Zero Credential Leakage), and **Invariant 20** (Explicit Live Trading Activation), this integration layer enforces:
- An unbypassable read-only boundary using fixed semantic endpoint IDs;
- Exact-payload HMAC-SHA256 request signing;
- Native socket transport supporting authenticated GET-with-signed-body requests;
- Lossless JSON numeric parsing into exact `Decimal` arithmetic;
- Fail-closed runtime validation on both caller inputs and exchange responses;
- Explicit currency tagging on all financial models.

---

## 2. Unbypassable Read-Only Boundary Architecture

To prevent any possibility of runtime tampering or accidental transmission of state-mutating requests:
1. **Semantic Endpoint Union**:
   The transport accepts strictly a closed union of fixed endpoint identifiers (`CoinDcxReadEndpoint`):
   `'ACTIVE_INSTRUMENTS' | 'INSTRUMENT' | 'USER_INFO' | 'FUTURES_WALLETS' | 'FUTURES_POSITIONS' | 'FUTURES_ORDERS' | 'POSITION_TRANSACTIONS' | 'FUTURES_TRADES' | 'WALLET_TRANSACTIONS'`.
2. **Private Immutable Endpoint Map**:
   The internal endpoint map (`READ_ENDPOINT_DEFINITIONS`) is frozen (`Object.freeze`) and strictly non-exported.
   No higher-level module can provide arbitrary URL path strings.
3. **ECMAScript-Private Wire Dispatcher**:
   The actual network execution function is an ECMAScript-private method (`#executeWireRequest`). It is structurally unreachable from outside the `CoinDcxTransport` instance, preventing any monkey-patching or path overrides.
4. **Zero Public Mutation Surface**:
   No order placement, modification, cancellation, leverage alteration, margin adjustment, or wallet transfer methods exist on `CoinDcxClient`.

---

## 3. Supported Read-Only Endpoints

| Endpoint ID | HTTP Method | Endpoint Path | Auth Required | Parameters / Body Scope |
| :--- | :--- | :--- | :--- | :--- |
| `ACTIVE_INSTRUMENTS` | `GET` | `/exchange/v1/derivatives/futures/data/active_instruments` | No | `margin_currency_short_name[]=INR` |
| `INSTRUMENT` | `GET` | `/exchange/v1/derivatives/futures/data/instrument` | No | `pair=<pair>&margin_currency_short_name=INR` |
| `USER_INFO` | `POST` | `/exchange/v1/users/info` | Yes | `{ timestamp }` |
| `FUTURES_WALLETS` | `GET` | `/exchange/v1/derivatives/futures/wallets` | Yes | `{ timestamp }` (*GET with signed body*) |
| `FUTURES_POSITIONS` | `POST` | `/exchange/v1/derivatives/futures/positions` | Yes | `{ timestamp, page, size, margin_currency_short_name: ["INR"] }` |
| `FUTURES_ORDERS` | `POST` | `/exchange/v1/derivatives/futures/orders` | Yes | `{ timestamp, status, side, page, size, margin_currency_short_name: ["INR"] }` |
| `POSITION_TRANSACTIONS`| `POST` | `/exchange/v1/derivatives/futures/positions/transactions`| Yes | `{ timestamp, stage, page, size, margin_currency_short_name: ["INR"] }` |
| `FUTURES_TRADES` | `POST` | `/exchange/v1/derivatives/futures/trades` | Yes | `{ timestamp, pair, from_date, to_date, page, size, order_id?, margin_currency_short_name: ["INR"] }` |
| `WALLET_TRANSACTIONS` | `GET` | `/exchange/v1/derivatives/futures/wallets/transactions` | Yes | `?page=&size=` + `{ timestamp }` (*GET with signed body*) |

---

## 4. Authentication, Signing & Exact Wire Payload Invariant

### 4.1 HMAC-SHA256 Signing
Authenticated requests require an HMAC-SHA256 signature calculated over the exact UTF-8 request body bytes:
$$\text{Signature} = \text{HMAC-SHA256}(\text{serialized JSON body bytes}, \text{API Secret})$$

Transmitted headers:
- `X-AUTH-APIKEY`: CoinDCX API key
- `X-AUTH-SIGNATURE`: 64-character lowercase hex digest
- `Content-Type`: `application/json`
- `Content-Length`: Exact byte length calculated via `Buffer.byteLength(body, 'utf8')`

### 4.2 Exact-Payload Invariant
The exact string serialized for HMAC generation is the exact byte stream written to the socket. Zero re-serialization occurs between signature generation and socket dispatch.

### 4.3 Millisecond Timestamping & Documentation Contradiction
- **Documentation Contradiction**: Official CoinDCX prose in the authentication section states `"timestamp: EPOCH timestamp in seconds"`. However, the official executable code samples (JavaScript `Math.floor(Date.now())` and Python `int(round(time.time() * 1000))`) generate epoch timestamps in milliseconds.
- **Resolution**: The implementation intentionally follows the executable official code samples and transmits millisecond epoch timestamps generated via the `Clock` abstraction immediately prior to request dispatch.

---

## 5. Lossless JSON Parsing & Finite Decimal Safety

Standard `JSON.parse` converts JSON numeric tokens into 64-bit binary floating point (`number`), permanently losing precision on high-precision decimals (e.g. `0.011572734637194769`).

To prevent precision loss and numerical corruption:
1. `CoinDcxTransport` parses raw UTF-8 response bytes using `lossless-json`.
2. Financial values are preserved as `LosslessNumber` and converted directly into `Decimal` instances via exact string lexemes.
3. No financial value passes through `Number(...)`, `parseFloat(...)`, unary `+`, or `Math.*`.
4. **Finite Decimal Invariant**:
   - Every converted `Decimal` is explicitly verified via `dec.isFinite() && !dec.isNaN()`.
   - Non-finite tokens (`NaN`, `+NaN`, `-NaN`, `Infinity`, `+Infinity`, `-Infinity`, `inf`, `-inf`) are strictly rejected with `CoinDcxResponseValidationError`.
   - Empty strings (`""`) or whitespace strings (`"   "`) are strictly rejected.
   - For optional/nullable financial fields:
     - Field missing (`undefined`) $\rightarrow$ `null`
     - Field explicit `null` $\rightarrow$ `null`
     - Field present as empty string `""` $\rightarrow$ validation error (fails closed)
     - Field present as `"0"` $\rightarrow$ `Decimal(0)`
5. Integer fields (e.g. millisecond timestamps) are verified with `Number.isSafeInteger()`. If a fractional or unsafe timestamp is received, it fails validation rather than silently truncating.

---

## 6. Explicit Financial Currency Semantics

For CoinDCX INR-margined futures contracts, contracts are quoted in USDT while settled and margined in INR. To prevent currency confusion:
- **Positions**:
  - `activePositionQuantity`: Underlying contract quantity
  - `avgPriceUsdt`, `liquidationPriceUsdt`, `markPriceUsdt`: USDT price
  - `lockedMarginUsdt`, `lockedUserMarginUsdt`, `lockedOrderMarginUsdt`, `maintenanceMarginUsdt`: USDT margin amounts
  - `settlementCurrencyAvgPriceInrPerUsdt`: INR per USDT conversion context
  - `marginCurrency`: `'INR'`
  - `marginType`: `'isolated'`
- **Orders**:
  - `priceUsdt`, `stopPriceUsdt`, `avgPriceUsdt`: USDT price
  - `feeAmountUsdt`: Fee in USDT
  - `settlementCurrencyConversionPriceInrPerUsdt`: INR per USDT conversion price
- **Trades**:
  - `priceUsdt`: Execution price in USDT
  - `feeAmountUsdt`: Fee in USDT
  - `settlementCurrencyConversionPriceInrPerUsdt`: Conversion price
- **Position Transactions**:
  - `pnlAmountInr`: Realized PnL in INR
  - `feeAmountInr`: Fee in INR
  - `priceInInr`, `priceInUsdt`: Context prices
  - `settlementAmountInr`: Non-authoritative settlement amount (marked ignored by CoinDCX docs)

Phase 2 performs **no currency conversion** and calculates **no PnL**.

---

## 7. Dynamic Leverage & Safety Margin Semantics

CoinDCX documentation explicitly marks `max_leverage_long` and `max_leverage_short` as `"Ignore this"`. These fields are not authoritative leverage limits.

- Legacy fields are segregated as `legacyMaxLeverageLongIgnored` and `legacyMaxLeverageShortIgnored`.
- Authoritative leverage constraints are parsed into structured, sorted tier models:
  - `dynamicPositionLeverageTiers`: `DynamicLeverageTier[]` with `{ leverage, maxPositionSizeUsdt }` sorted by leverage ascending.
  - `dynamicSafetyMarginTiers`: `DynamicSafetyMarginTier[]` with `{ positionSizeThresholdUsdt, maintenanceMarginPercent }` sorted by threshold ascending.

---

## 8. Fail-Closed Response & Runtime Request Validation

### 8.1 Fail-Closed Position Validation
- `margin_currency_short_name` must be present and equal `'INR'`. Non-INR positions are rejected with `CoinDcxResponseValidationError`.
- `margin_type`:
  - `"isolated"`: Valid.
  - `null`: Documented by CoinDCX as isolated; normalized explicitly to `'isolated'`.
  - `"crossed"`: CoinDCX documentation states cross margin is unsupported for INR Futures. An INR position marked crossed is treated as an exchange contract anomaly and rejected.
  - Missing key (`undefined`): Rejected with validation error.
- Missing required fields (`pair`, `active_pos`, `avg_price`, `locked_margin`, etc.) are rejected rather than defaulted to zero.

### 8.2 Runtime Request Validation
All query arguments are validated via Zod schemas before opening any network connection:
- `listInrFuturesOrders`:
  - `status`: Required. Must be a documented status (`open`, `filled`, `partially_filled`, `partially_cancelled`, `cancelled`, `rejected`, `untriggered`) or comma-separated combination.
  - `side`: Required (`'buy'` | `'sell'`).
  - `page`, `size`: Required positive integer strings (`/^[1-9]\d*$/`).
  - `margin_currency_short_name: ["INR"]`: Injected internally; caller cannot alter to USDT.
- `listInrFuturesPositionTransactions`:
  - `stage`: Required. Must be one of: `'funding'`, `'default'`, `'exit'`, `'tpsl_exit'`, `'liquidation'`.
  - `page`, `size`: Required positive integer strings.
- `listInrFuturesTrades`:
  - `pair`: Required non-empty string.
  - `fromDate`, `toDate`: Required strict Gregorian calendar date validation in `YYYY-MM-DD` format (leap year aware; e.g. accepts `2024-02-29` and rejects `2026-02-29`, `2026-02-31`, `2026-04-31`), with `fromDate <= toDate`.
  - `page`, `size`: Required positive integer strings.

### 8.3 Safe Error Policy (Zero Provider Reflection)
- Provider response text (such as `{ "message": "..." }`) is external and untrusted.
- Transport never reflects raw provider error messages in `AppError.message` or `AppError.details`.
- Deterministic, static local error messages are emitted (e.g. `CoinDCX authentication request failed`, `CoinDCX rate limit exceeded`, `CoinDCX provider request failed`).
- Error details retain only bounded, safe diagnostic metadata (`path`, `statusCode`, `retryAfterMs`).

---

## 9. Official Documentation Ambiguities

### 9.1 Transaction Stage "all" Ambiguity
- CoinDCX documentation prose mentions `"all OR default"`, while the request parameters table explicitly lists only: `funding`, `default`, `exit`, `tpsl_exit`, `liquidation`.
- **Resolution**: Stage is mandatory. Supported stages strictly follow the request parameter table. The implementation does not default to `"all"` and smoke tests do not use `"all"`.

### 9.2 Currency Conversion Endpoint Ambiguity
- `/api/v1/derivatives/futures/data/conversions`: Documentation contains contradictory specifications (JS sample uses POST, Python sample uses GET with body, parameter table lists POST, path is `/api/v1/` rather than `/exchange/v1/`).
- **Resolution**: Left unimplemented in Phase 2.

### 9.3 Wallet Locked Initial Margin Semantics & Ignored Balance
- CoinDCX Futures Wallet documentation explicitly marks `balance` as `"Ignore this"`.
- `lockedInitialMargin` is only the amount currently locked as initial margin for isolated Futures orders/positions. It must NOT be interpreted as account equity, available balance, or total capital.
- The read layer does NOT compute derived account equity (`totalBalance`, `availableBalance`, or `equity`).
- Cross-margin wallet fields (`crossOrderMargin`, `crossUserMargin`) are preserved as documented raw figures, but cross margin is unsupported for INR Futures and they do not represent usable INR trading capacity.

### 9.4 User Info Shape
- Official documentation shows an array response `[{ coindcx_id: ... }]`, whereas single-user endpoints in production may return `{ coindcx_id: ... }`.
- **Resolution**: `UserInfoResponseSchema` accepts both array and single-object shapes while requiring `coindcx_id`.

### 9.5 Live Positions Nullability for Flat Records
- **Official Documentation Limitation**: CoinDCX official documentation does not explicitly document nullability for `maintenance_margin`, `mark_price`, and `settlement_currency_avg_price`.
- **Live Authentication Evidence (2026-09-03)**: Authenticated live verification observed that flat/inactive INR Futures position records (`active_pos == 0`) return explicit `null` for:
  - `maintenance_margin`
  - `mark_price`
  - `settlement_currency_avg_price`
- **Application Validation Rule**:
  - Missing fields (`undefined`) remain strictly invalid (`CoinDcxResponseValidationError`).
  - Explicit `null` is accepted only for flat position records (`active_pos == 0`).
  - Active positions (`active_pos != 0`) strictly require non-null values for all three fields.
  - Null values remain `null` and do not manufacture `Decimal(0)`.



---

## 10. Local Smoke Script

To verify exchange discovery:
```bash
npm run coindcx:read-smoke
```
By default, the script executes public discovery only.

To run authenticated reads with local credentials:
```bash
npm run coindcx:read-smoke -- --auth
```
Authenticated reads execute **only** when `--auth` is provided as an explicit command-line argument. No mutation capability exists in either mode.
