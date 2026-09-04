# Phase 4 Public WebSocket Smoke Test Evidence

**Date:** 2026-09-04  
**Command:** `npm run coindcx:ws-smoke`  
**Endpoint:** `wss://stream.coindcx.com`  
**Authentication:** NONE (Public Only, `--auth` prohibited)  
**Target Pairs:** BTC (`B-BTC_USDT`), ETH (`B-ETH_USDT`)  
**Channel Pattern:** `B-BTC_USDT_1m-futures`, `B-ETH_USDT_1m-futures`  

---

## 1. Execution Log

```text
> coindcx-quant-bot@0.1.0 coindcx:ws-smoke
> tsx scripts/coindcx-ws-smoke.ts

=== COINDCX FUTURES WEBSOCKET LAYER — PUBLIC SMOKE TEST ===

[1/5] Loaded 2 configured coin profile(s).
[2/5] Bootstrapping coin runtimes via public exchange discovery...
[2026-09-04 16:23:13.369] INFO: Starting Coin Runtime bootstrap process
    service: "coindcx-quant-bot"
    profileCount: 2
[2026-09-04 16:23:13.609] INFO: Coin runtime registered in CoinRegistry
    service: "coindcx-quant-bot"
    underlying: "BTC"
    pair: "B-BTC_USDT"
    lifecycle: "DISCOVERED"
    entryEligibility: "ELIGIBLE"
[2026-09-04 16:23:13.609] INFO: Successfully bootstrapped coin runtime
    service: "coindcx-quant-bot"
    underlying: "BTC"
    pair: "B-BTC_USDT"
    lifecycle: "DISCOVERED"
    entryEligibility: "ELIGIBLE"
[3/5] Derived 2 market data subscription intent(s):
      - BTC -> Pair: B-BTC_USDT (1m: true, Trades: false)
      - ETH -> Pair: B-ETH_USDT (1m: true, Trades: false)

[4/5] Initializing CoinDcxPublicFuturesStream (one shared public socket)...
      Connecting to CoinDcx WebSocket endpoint (wss://stream.coindcx.com)...
[2026-09-04 16:23:13.710] INFO: Coin runtime registered in CoinRegistry
    service: "coindcx-quant-bot"
    underlying: "ETH"
    pair: "B-ETH_USDT"
    lifecycle: "DISCOVERED"
    entryEligibility: "ELIGIBLE"
[2026-09-04 16:23:13.710] INFO: Successfully bootstrapped coin runtime
    service: "coindcx-quant-bot"
    underlying: "ETH"
    pair: "B-ETH_USDT"
    lifecycle: "DISCOVERED"
    entryEligibility: "ELIGIBLE"
[2026-09-04 16:23:13.710] INFO: Coin Runtime bootstrap process finished
    service: "coindcx-quant-bot"
    total: 2
    successfulCount: 2
    failureCount: 0
      Connected! Generation: 1, State: STREAMING
      Active Subscriptions: [B-BTC_USDT_1m-futures, B-ETH_USDT_1m-futures]

[5/5] Listening for real-time market data (bounded 20s)...
      [CANDLE #1] [B-ETH_USDT] O:2522.62 H:2522.86 L:2522.62 C:2522.85 V:88.981 (Gen: 1)
      [CANDLE #2] [B-BTC_USDT] O:81007.9 H:81010.4 L:81007.9 C:81010.3 V:2.141 (Gen: 1)
      [CANDLE #3] [B-ETH_USDT] O:2522.62 H:2522.86 L:2522.62 C:2522.86 V:97.552 (Gen: 1)
      [CANDLE #4] [B-BTC_USDT] O:81007.9 H:81010.4 L:81007.9 C:81010.4 V:2.201 (Gen: 1)
      Received live candles for all intended pairs before timeout!

Stopping WebSocket stream gracefully...
Stream stopped cleanly. Connected: false, State: STOPPED

=== PUBLIC SMOKE TEST STRUCTURED SUMMARY ===
publicConnectedEver=true
generationId=1
sharedSocketCount=1
intendedSubscriptionCount=2
activeSubscriptionCount=2

pairEvidence:
  BTC (B-BTC_USDT) -> observed=true, count=2
  ETH (B-ETH_USDT) -> observed=true, count=2

validEvents=4
invalidEvents=0
staleGenerationDrops=0
unexpectedEvents=0

cleanup:
connected=false
state=STOPPED

credentialsUsed=false
privateSocketStarted=false

=== PUBLIC SMOKE TEST COMPLETE: SUCCESS ===
```

---

## 2. Invariant & Contract Verification

| Check | Expected | Observed | Status |
|-------|----------|----------|--------|
| Public Connection | `publicConnectedEver=true` | `true` | PASS |
| Single Shared Socket | `sharedSocketCount=1` | `1` | PASS |
| Channel Subscriptions | Exactly matched intended runtime intents | `[B-BTC_USDT_1m-futures, B-ETH_USDT_1m-futures]` | PASS |
| BTC Candle Received | Valid 1m candle with OHLCV parsed | `O:81007.9 H:81010.4 L:81007.9 C:81010.3 V:2.141` | PASS |
| ETH Candle Received | Valid 1m candle with OHLCV parsed | `O:2522.62 H:2522.86 L:2522.62 C:2522.85 V:88.981` | PASS |
| Event Validity | `validEvents > 0`, `invalidEvents == 0` | `validEvents=4`, `invalidEvents=0` | PASS |
| Stale Drops | `staleGenerationDrops == 0` | `0` | PASS |
| Stream Cleanup | `connected=false`, `state=STOPPED` | `connected=false`, `state=STOPPED` | PASS |
| Secret Safety | `credentialsUsed=false`, `privateSocketStarted=false` | `false`, `false` | PASS |
| Process Exit Code | `0` | `0` | PASS |

