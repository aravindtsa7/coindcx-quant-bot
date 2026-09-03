# Coin Runtime Layer (Phase 3)

## 1. Overview and Role of Phase 3

The **Coin Runtime Layer** is the generic operational supervisor positioned directly between the **CoinDCX Read-Only Integration Layer** (Phase 2) and downstream engines:
- Real-Time WebSockets (Phase 4)
- Canonical 1m Market Data Ingestion (Phase 5)
- Quantitative Strategy Matrix (Phases 10–11)
- Risk & Leverage Engine (Phase 13)
- Execution and Reconciliation (Phases 17–18)

### What Phase 3 Answers
- Which coins are configured and enabled?
- Which live CoinDCX INR Futures instrument contract represents each asset?
- Is that instrument active, tradeable, and compliant with our isolated-margin scope?
- What are the immutable instrument constraints (tick size, lot size, fees, dynamic leverage tiers)?
- Which timeframes are configured for each coin?
- What strategy assignments and risk profile IDs are assigned?
- What lifecycle promotion state is the coin in?
- Can runtime state or failures for one coin impact any other coin? (Answer: Strictly isolated).

---

## 2. Textual Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│             Static Coin Profiles Configuration           │
│        (BTC, ETH, etc. — ZERO hardcoded pairs/secrets)   │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│              Coin Profile Validation Engine              │
│  (Canonical symbols, dependent flags, 1m rule, leverage) │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│             CoinRuntimeBootstrapService                  │
│       (Generic CoinDCX discovery, failure isolation)     │
└──────────────┬────────────────────────────┬──────────────┘
               │                            │
      (Generic Discovery)           (Per-Coin Mapping)
               ▼                            ▼
┌─────────────────────────────┐ ┌──────────────────────────┐
│      CoinDcxClient          │ │   InstrumentMetadata     │
│ findActiveInrPerpetualBy... │ │  (Dynamic leverage tiers,│
└─────────────────────────────┘ │   precision, tick size)  │
                                └────────────┬─────────────┘
                                             │
                                             ▼
                                ┌──────────────────────────┐
                                │   CoinEntryEligibility   │
                                │(ELIGIBLE, INACTIVE, etc.)│
                                └────────────┬─────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────┐
│                      CoinRegistry                        │
│   - Isolated in-memory containers (Map<Underlying, ...>) │
│   - Deep immutability boundary (caller-owned isolation)  │
│   - Pair index exists ONLY for discovered instruments    │
│   - Sequential Lifecycle State Transitions               │
│   - Deterministic alphabetical ordering                  │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│             MarketDataSubscriptionIntent                 │
│      (Pure metadata intent for future Phase 4 sockets;   │
│       returns null for undiscovered/disabled coins)      │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Core Models & Exchange Truth

### 3.1 CoinProfile
The configuration-facing model defining operational parameters per underlying:
- `underlying`: Canonical uppercase symbol (`/^[A-Z0-9]{1,20}$/`).
- `enabled`: Global toggle.
- `dataEnabled`, `researchEnabled`, `paperEnabled`, `shadowEnabled`, `liveEnabled`: Dependent operational flags.
- `timeframes`: Configured aggregation granularities (mandates `'1m'` whenever `dataEnabled: true`).
- `strategyAssignments`: Array of `{ strategyId, enabled, parameterProfileId }`.
- `riskProfileId`: Non-empty risk identity string (e.g. `'DEFAULT_SAFE'`).
- `defaultLeverage`, `configuredAbsoluteMaxLeverage`: Configured positive `Decimal` bounds.

### 3.2 InstrumentMetadata
Normalized snapshot derived from Phase 2 `InrFuturesInstrument`:
- `pair`: Live exchange contract identifier (e.g. `B-BTC_USDT`).
- `marginCurrency`: Strictly `'INR'`.
- Authoritative exchange constraints: `unitContractValue`, `priceIncrement`, `quantityIncrement`, `minTradeSize`, `minPrice`, `maxPrice`, `minQuantity`, `maxQuantity`, `minNotional`, `maxMarketOrderQuantity`, `makerFeePercent`, `takerFeePercent`, `exitOnly`.
- Dynamic leverage: Authoritative `dynamicPositionLeverageTiers` and `dynamicSafetyMarginTiers`. Legacy static ignored leverage fields are discarded.
- **Provider-Ignored max_notional**: Retained as `legacyMaxNotionalIgnored: Decimal | null`. Official CoinDCX documentation explicitly marks `max_notional` as "Ignore this". Phase 3 preserves the raw normalized Decimal value for audit and compatibility, but it is non-authoritative, does not affect entry eligibility, and is not a risk limit. Zero is not interpreted as an unlimited sentinel. The future Risk Engine must not use it unless CoinDCX officially documents a change in contract.
- **Zero Fabrication Guarantee**: Never synthesized with fake pairs (`UNRESOLVED-*`) or fake zero constraints.

### 3.3 Discriminated Union: CoinRuntime
The runtime container explicitly models the distinction between undiscovered disabled coins and verified discovered coins:

```typescript
export interface UndiscoveredDisabledCoinRuntime {
  readonly status: 'UNDISCOVERED_DISABLED';
  readonly profile: CoinProfile;
  readonly instrument: null;
  readonly lifecycle: 'DISABLED';
  readonly entryEligibility: 'CONFIG_DISABLED';
}

export interface DiscoveredCoinRuntime {
  readonly status: 'DISCOVERED';
  readonly profile: CoinProfile;
  readonly instrument: InstrumentMetadata;
  readonly lifecycle: CoinLifecycleState;
  readonly entryEligibility: CoinEntryEligibility;
}

export type CoinRuntime = DiscoveredCoinRuntime | UndiscoveredDisabledCoinRuntime;
```

- **Undiscovered Disabled Coin**: When a coin is configured with `enabled: false`, it bypasses network discovery. Its `instrument` is strictly `null`. It possesses no pair index, no fabricated constraints, and generates no subscription intent.
- **Discovered Coin**: Once resolved via CoinDCX discovery, it holds authoritative `InstrumentMetadata` and is indexed by both underlying and pair. If later suspended, it retains its verified instrument metadata while transitioning to `lifecycle: 'DISABLED'`.

### 3.4 CoinLifecycleState & State Machine
The 11 frozen onboarding lifecycle states (docs/COIN_ONBOARDING.md):
`DISCOVERED` $\rightarrow$ `DATA_LOADING` $\rightarrow$ `DATA_READY` $\rightarrow$ `BACKTESTING` $\rightarrow$ `RESEARCH_APPROVED` $\rightarrow$ `PAPER` $\rightarrow$ `PAPER_APPROVED` $\rightarrow$ `SHADOW` $\rightarrow$ `LIVE_CANDIDATE` $\rightarrow$ `LIVE` $\rightarrow$ `DISABLED`.

- **Terminal Suspension**: `DISABLED` is a terminal suspension state for ordinary lifecycle transitions (`ALLOWED_LIFECYCLE_TRANSITIONS.DISABLED = []`). Calling `transitionLifecycle(underlying, 'DISCOVERED')` is strictly rejected.
- **Reactivation Requires Rediscovery**: Re-activating a disabled coin must proceed through `bootstrapService.reactivate(profile)`, ensuring exchange truth is re-verified before entering `DISCOVERED`.
- **LIVE Configuration Gate**: Transitioning from `LIVE_CANDIDATE` to `LIVE` strictly requires `profile.liveEnabled === true`. Default BTC and ETH profiles have `liveEnabled: false` and cannot reach `LIVE` in Phase 3.
- **`liveEnabled=true` Semantics**: Setting `liveEnabled=true` does **NOT** authorize live trading or automatically promote the runtime; it is merely a configuration gate allowing the lifecycle state machine to consider `LIVE` in a future approved workflow.

### 3.5 CoinEntryEligibility (Fail-Closed Static Verification)
Deterministic status representing static, provider, and configuration readiness:
- `ELIGIBLE`: Instrument is active, tradable, non-exit-only, and passes all authoritative static numeric bounds.
- `CONFIG_DISABLED`: Config profile has `enabled: false`.
- `UNDISCOVERED`: Coin has not undergone network discovery (`instrument === null`).
- `INSTRUMENT_INACTIVE`: Exchange contract status is not active.
- `EXIT_ONLY`: Contract is marked exit-only on exchange.
- `INVALID_INSTRUMENT_METADATA`: Precision increments, trade sizes, price limits, minimum notional limits, fees, or leverage tiers fail positive/finite validation.

> [!IMPORTANT]
> **ELIGIBLE != SAFE_TO_TRADE_NOW**. It indicates only that configuration and static exchange metadata permit downstream phases to consider this coin. It does not evaluate account balance, market data freshness, or risk limits.

---

## 4. CoinRegistry & Deep Immutability Boundary

- **Private Storage**: Internal state is held in private Maps (`#byUnderlying`, `#byPair`).
- **Deep Cloning at Boundaries**:
  - At `register()`: Deep-clones caller-provided `CoinProfile`, `InstrumentMetadata`, and all nested arrays/objects (timeframes, strategy assignments, order types, leverage tiers, safety margin tiers). Reconstructs all `Decimal` instances via `new Decimal(d.toString())`.
  - At query (`getByUnderlying`, `getByPair`, `list`, `listEnabled`): Deep-clones and deeply freezes snapshots via `Object.freeze`.
- **Pair Index Consistency**:
  - Only discovered runtimes with a non-null instrument appear in `#byPair`.
  - `#byUnderlying` and `#byPair` point to the exact same canonical runtime state.
  - Mutating returned snapshots or original caller objects after registration cannot alter registry state.

---

## 5. Bootstrap Service, Reactivation & Safe Errors

- **Failure Isolation**: Discovery or mapping failure for one coin does not affect other coins.
- **Safe Error Model**: Untrusted caught error messages (e.g. secret canaries or provider response dumps) are never copied into `failure.message`, logged, or returned to callers. Deterministic local failure categories and messages are used:
  - `CONFIG_ERROR`: "Coin runtime configuration validation failed"
  - `DISCOVERY_FAILED`: "Coin instrument discovery failed"
  - `MAPPING_FAILED`: "Coin instrument mapping failed"
  - `REGISTRATION_FAILED`: "Coin runtime registration failed"
  - `ELIGIBILITY_FAILED`: "Coin instrument eligibility validation failed"
- **Safe Reactivation Boundary**: `reactivate(profile)` guards every phase (validation, discovery, mapping, eligibility, registration) and throws deterministic categorized `AppError` instances (`CoinConfigError`, `CoinDiscoveryError`, `CoinRegistrationError`) with safe `{ underlying, category }` details. Original errors are discarded, ensuring zero canary or provider leakages escape into caller scope or logs.
- **Atomic Reactivation**: `reactivate(profile)` queries CoinDCX discovery, validates constraints, and atomically updates the registry and pair index upon success. If rediscovery fails, the existing disabled state remains untouched.

---

## 6. Market Data Subscription Intent

- Function `createSubscriptionIntent(runtime): MarketDataSubscriptionIntent | null`.
- Returns `null` for undiscovered coins (`instrument === null`) or disabled coins (`profile.enabled === false`).
- Returns real intent with verified pair for active coins (`requiresOneMinuteCandles: true` if `dataEnabled: true`).
- Zero WebSockets or socket connections.

---

## 7. Modular Onboarding: Adding a New Coin (e.g. SOL, XRP)

Upholding **Invariant 4** and **Invariant 5**, onboarding a new coin requires **zero modifications** to core engine code:
1. Add a `CoinProfile` entry in `src/app/config/coins.ts`.
2. Generic `CoinRuntimeBootstrapService` queries CoinDCX discovery by symbol, resolves instrument, maps metadata, and registers container.
3. Proven by automated architectural tests in `tests/unit/coin-runtime/bootstrap.test.ts` and `scope-invariants.test.ts`.

---

## 8. What Phase 3 Intentionally Does NOT Do

- Does **NOT** establish WebSocket connections.
- Does **NOT** ingest market ticks or synthesize candles.
- Does **NOT** execute backtests or calculate indicators.
- Does **NOT** run paper trading or shadow trading.
- Does **NOT** calculate account-level margin or position sizing (Risk Engine).
- Does **NOT** place, modify, or cancel orders.
- Does **NOT** enable live trading.
