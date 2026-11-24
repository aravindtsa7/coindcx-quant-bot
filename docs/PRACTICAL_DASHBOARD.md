# Historical backtests and connected dashboard

Start the local dashboard with `npm run dashboard`, then open http://127.0.0.1:4173. Set `DASHBOARD_PORT` to change the port. In PowerShell environments that block npm's `.ps1` shim, use `npm.cmd` and `npx.cmd`.

The dashboard follows the complete 42-screen design catalog with five sidebar groups, contextual family tabs, a screen jumper and a searchable screen index. Screens 01–30 and 34–39 have connected research, execution and control workflows. Screens 31–33 and 40–42 retain workspace-backed views for Batch 4. The local `index.html`, `styles.css`, `ui-core.js`, `execution.js`, `system.js` and `app.js` assets require no CDN or build step. Market data and account observations still require connectivity to CoinDCX.

## Run a historical experiment

```sh
npx tsx scripts/run-backtest.ts --coin SOL --timeframe 15m --strategy ema-trend --bars 200 --capital-inr 5000 --max-inr 700
```

Coins: BTC, ETH, SOL. Timeframes: 1m, 5m, 15m, 1h. Strategies: ema-trend, rsi-momentum, atr-breakout, multi-timeframe-trend. Request 30–1000 closed bars. The runner fetches pages of at most 200 bars through the existing M2-budgeted candle transport and rejects missing, contradictory or invalid history. It uses the actual strategy and indicator kernels. Multi-timeframe indicators use only complete UTC-aligned aggregates of the base candles.

Optional flags: `--fee-bps` (taker fee, default 5), `--maker-fee-bps` (default 2), `--liquidity TAKER|MAKER`, `--slippage-bps` (default 2), `--inr-per-usdt`, and `--end-time-ms`. All costs are per fill. Without an explicit conversion rate, the runner fetches the current CoinDCX conversion snapshot and fixes that rate across the experiment. This is not historical FX. Funding is excluded.

Research sizing uses one position at 1× and caps entry notional by the requested maximum and available virtual cash, including entry fees. It deliberately does not claim M7 approval or exchange minimum/lot compliance. Signals from a closed candle execute at the next candle open. SL and TP default to NONE. Configure PERCENT or INR thresholds with the flags below. Thresholds measure gross trading PnL before fees and execution costs; INR distance uses actual quantity, contract multiplier and conversion rate. Intrabar double hits resolve to SL first. Stops fill at the worse of the trigger and a gapped open; TP gaps receive no favorable price improvement. Intrabar exit timestamps are recorded at bar close. Remaining exposure closes at the final close. Maker mode assumes full fills; queue position, partial fills, liquidation and funding are not modeled.

Reports include summary metrics, marked equity and drawdown, chart candles, and the complete chronological round-trip ledger. Profit factor is `null` when there are no losing trades. IDs include exact candle inputs and effective configuration. Replay with the saved `endTimeMs` and `inrPerUsdt` to reproduce the metrics, provided CoinDCX returns unchanged candles.

## API and persistence

| Endpoint | Behavior |
| --- | --- |
| GET /api/status | Server readiness, saved shadow report, current limiter statistics |
| POST /api/shadow/run | One real SHADOW or DRY_RUN orchestrator cycle with M7 evaluation |
| GET /api/candles?pair=B-SOL_USDT&resolution=15&bars=120 | Closed candles with EMA 9/21, RSI 14 and ATR 14 overlays |
| POST /api/backtest/run | Historical experiment and full report |
| GET /api/reports | Saved shadow and backtest history |
| GET /api/reports/:id | Inspect an allowlisted saved report |

Backtest request fields: `coin`, `timeframe`, `strategy`, `bars`, `capitalInr`, `maxOrderNotionalInr`, `makerFeeBps`, `takerFeeBps`, `slippageBps`, `fillLiquidity`, optional `inrPerUsdt` and `endTimeMs`. Shadow requests accept `coins`, `strategy`, `equityInr`, `maxOrderNotionalInr`, and `mode` (`SHADOW` or `DRY_RUN`). Extra fields and live modes are rejected. Concurrent run submissions receive HTTP 409.

The dashboard loads `.local/bot-shadow-risk-report.json` on startup. New cycles update it and create an archive in `.local/shadow-reports/`. Backtests go to `.local/backtest-reports/<runId>.json`. Reports are written through temporary files and rename; malformed history entries are skipped. The dashboard uses one shared coordinator for public, conversion and private reads. Local pacing is 1 start/second, 20 starts/minute, concurrency 1; these are local settings, not provider quota claims. SIGINT/SIGTERM stop admission, abort subsequent work, drain active HTTP operations and close the limiter. The launcher also supports an IPC `shutdown` message for Windows lifecycle verification.

## Safety and interpretation

No live executor is composed by the dashboard. It binds only to loopback, refuses foreign hosts/origins, and provides no live-enable endpoint. The existing orchestrator continues to require `confirmLive: true` and fresh `OBSERVED_CONVERGENCE` for any live dispatch path. Frozen execution and architecture files are untouched.

Shadow equity is a separate, operator-funded evaluation book for each cycle; it does not assert a venue balance or paper fills. Interactive PAPER accounts use their own virtual book and real M7 decisions. Unknown/private position state remains unavailable to venue M7 evaluations. The private stream is scoped to each orchestrator run and stops afterward. Saved convergence hashes are historical observations, not live readiness or continuity authority. Minimum INR notionals are derived from discovered instrument minimums and the observed conversion, rather than the older ₹612 SOL reference displayed before an observation is available.

## Verification

```sh
npm run typecheck
npx vitest run tests/unit/coindcx/practical-bot-orchestrator.test.ts tests/unit/coindcx/practical-backtest-runner.test.ts tests/unit/coindcx/dashboard-server.test.ts tests/architecture/phase18b-practical-boundary.test.ts
npx vitest run tests/architecture --maxWorkers=2
```

The worker bound avoids resource contention in architecture tests that scan the entire source tree and have fixed timeouts. No architecture tests or their thresholds are modified.

## Batch 1 workspace engine API

Batch 1 supplies the persistent workspace and research engine consumed by the Batch 2 UI.

```sh
npx tsx scripts/run-backtest.ts --coin SOL --timeframe 15m --strategy ema-trend --bars 200 --capital-inr 5000 --max-inr 700 --sl-mode percent --sl-value 1.0 --tp-mode percent --tp-value 2.0
```

Additional flags are `--spread-bps` (default 1) and `--stop-slippage-bps` (default 5). Each fill pays half the spread. Ordinary fills use `slippageBps`; stops use `stopSlippageBps` instead. Every completed trade contains DECISION_RECORDED, ENTRY_FILL, SL_TP_ARMED and EXIT_FILL events. The JSON API accepts `stopLossMode`, `stopLossValue`, `takeProfitMode`, `takeProfitValue`, `spreadBps`, `stopSlippageBps`, and a `parameters` object alongside the existing backtest fields.

| Endpoint | Request / result |
| --- | --- |
| GET /api/workspace | Persistent state, shadow report, saved backtests, presets, paper sessions/orders/positions, settings, alerts, jobs, audit, budget stats |
| GET /api/strategies | Named saved configurations |
| POST /api/strategies | `name`, `strategy`, `timeframe`, `parameters`, `slMode`, `slValue`, `tpMode`, `tpValue`; same-name saves replace the existing preset |
| POST /api/matrix/run | Backtest fields except coin, plus `coins`, `fastPeriods`, `slowPeriods`; maximum 64 cells; returns all cells and ranked valid cells |
| POST /api/validation/run | Matrix fields plus `trainPercent` (60), `oosPercent` (20), `costStressMultiplier` (2); bars 150–1000 |
| GET /api/matrix, /api/validation, /api/rankings | Saved research evidence; always PAPER · no promotion |
| POST /api/data/sync | `coin`, `timeframe`, `bars`, optional `endTimeMs`; bounded dataset write and honest gap report |
| GET /api/data/datasets | Dataset inventory and sync jobs |
| GET /api/data/datasets/:id | Checksum-verified cached candles and quality inspection |
| POST /api/paper/sessions | `name` plus backtest fields; defaults ₹125,000 virtual capital, ₹10,000 max order, PERCENT SL 1% |
| POST /api/paper/sessions/:id/step | Empty JSON object; one idempotent progression through newly closed candles |
| POST /api/paper/sessions/:id/toggle | Optional `running: boolean`; omitted means toggle |
| GET /api/paper/sessions, /api/paper/orders, /api/paper/positions, /api/paper/fills | Isolated virtual execution state |
| POST /api/operations/stop, /api/operations/resume | Optional `reason`; persistent workspace admission latch, never a live enablement |
| GET /api/operations | Admission state and budget health |
| POST /api/settings | Partial `language` (en/hi), valid IANA `timezone`, `defaultCoin` |
| GET /api/alerts, /api/audit | Actionable alerts, operator audit and bounded job history |
| POST /api/alerts/:id/ack | Empty JSON object |
| GET /api/reports/export?id=...&format=csv\|json | Download CSV round-trip ledger or JSON evidence package; supports backtest and paper IDs, plus research/shadow JSON |

Matrix reads are shared across grid cells. EMA and multi-timeframe strategies sweep fast/slow periods; RSI and ATR run their supplied parameter object as one cell per coin. Invalid EMA grid combinations are reported explicitly. Rankings use profit factor then net PnL; profit factor remains null when undefined. Validation uses chronological, non-overlapping TRAIN/OOS/HOLDOUT slices, with independent warmup, flat starting exposure and capital in each slice. Parameter selection uses TRAIN net PnL only. Comparative rankings use OOS only, never HOLDOUT. The OOS stress rerun multiplies all modeled costs by the requested factor; unsupported cost ranges are rejected rather than capped. This is bounded chronological split validation, not automatic promotion or a claim of statistical significance.

The workspace is persisted in `.local/workspace-state.json` with checksum verification, serialized transactions, fsync, atomic replacement and a prior-state backup. Corruption preserves the damaged file, restores a verified backup or an empty book, pauses sessions and stops admissions with a critical alert. Review and explicitly resume after recovery. Interrupted jobs become FAILED on restart. Limits are 20 paper accounts, 100 presets, 64 matrix cells, 5,000 candle bars per paper session, and bounded audit/job/alert histories.

Data sync stores actual returned bars under `.local/datasets/`. Missing bars remain missing. Only 1m datasets can substantiate minute coverage; coarser datasets explicitly report minute coverage as unobservable.

Paper sessions never read a private wallet or submit a venue order. Bootstrap warms the real kernel without historical fills and queues only an M7-approved virtual order. Orders fill at the first subsequent eligible bar open occurring after the order was created, with M7 recheck and cash/notional caps. Repeat ticks and restarts do not duplicate fills. A manual step catches up protection and existing orders but queues new admission only from the latest closed-bar decision. There is no automatic tick scheduler in this batch. Working orders are cancelled when paused. Paused accounts retain positions; resume and step to advance them.

Paper risk uses virtual capital, fills, daily PnL, ownership, pending-state knowledge, current discovered instrument constraints, leverage tiers, and current provider conversion. M7 OPEN/CLOSE decisions are honored; NO_CHANGE and REVERSAL_DEFERRED do not dispatch orders. SL/TP reductions execute previously armed protection from the approved virtual entry and record that reason. NONE does not fabricate an M7 stop proposal, so unprotected entries may correctly be refused. Fixed INR stops above the policy's risk budget are blocked separately. The stop latch cancels working OPEN orders and blocks new research/shadow admission and paper entries, while permitting paper protection and approved risk-reducing steps. Resume cannot enable live trading.

Run workspace tests with `npx vitest run tests/unit/coindcx/workspace-engine.test.ts` in addition to the verification commands above.

## Batch 2 connected research UI

Start at `#unlock` or `#overview`. All 42 design-book hashes are routable, including `#screen-index` for the index modal. Screens 01–15 connect workspace summaries, the three-pair watchlist, candle charts, dataset quality and backfill, saved presets, parameter matrices, historical results and trade events, chronological validation, and pair-local rankings. The welcome screen opens local navigation; it is not an authentication mechanism and does not unlock trading.

Overview equity is the sum of isolated virtual account marks. Its curve shows actual cash events (capital and realized fills), rather than inventing historical unrealized marks. Today's modeled P&L is realized fill P&L less entry/exit fees in the configured timezone. Funding is excluded. Markets shows actual closed hourly observations, with a 24-hour change only when both matching timestamps exist. Instrument charts include volume and shared-kernel EMA/RSI/ATR values, with hover, keyboard inspection, visible-bar zoom and historical panning. Leverage metadata comes from the latest retained shadow observation and is labeled accordingly.

Coverage uses 28 chronological groups of expected bars, computed from the inspected dataset's actual timestamps. Green requires every bar in that group to be present and valid without duplicates; amber means missing or invalid data; unobserved groups stay neutral. Coarse data never implies minute completeness. Sync is bounded to 30–1000 bars; the backtest UI allows 100–1000. Saved presets carry kernel-specific parameters and PERCENT/INR protections into research forms. Cost inputs match backend limits of 0–100 bps per modeled cost.

Backtests navigate to results and retain a searchable chronological ledger with expandable event evidence and native CSV/JSON downloads. Undefined profit factor is displayed as N/D. Validation uses actual Train/OOS/Holdout fold metrics and cost stress. Gap/purge remains explicitly **0 bars / not modeled**. Rankings prefer the latest pair-local OOS validation, then matrix evidence, then retained historical backtests; in-sample evidence is labeled and never grants promotion. Comparability across windows, timeframes and cost assumptions requires review.

The UI requests data on demand and exposes provider errors without fabricating candles or results. Use Refresh to reload workspace state; charts and watchlists have dedicated refresh controls. Retained convergence and stream evidence are historical snapshots. `LIVE LOCKED` is persistent, and there is no live enablement or venue order entry control.

Additional UI checks:

```sh
npx vitest run tests/unit/coindcx/dashboard-ui.test.ts tests/unit/coindcx/dashboard-ui-render.test.ts tests/unit/coindcx/dashboard-server.test.ts
```

These verify the navigation catalog, honest coverage, virtual accounting, exact parameter bindings, escaping, route rendering with empty/populated state, and static asset MIME types. The document-boundary rendering checks do not replace visual browser review.

## Batch 3 execution and control UI

Screens 16–21, 36 and 39 support virtual account cards, session selection, deployment from saved presets or all four kernels, manual stepping, pause/resume, candlestick/EMA charts, order and position drill-downs, actual fill/event histories, and separated accounting. New paper sessions default to SAFE M7 risk with a 1% stop and 2% target. A step catches up available closed bars; the first step warms the kernel without historical fills. It is not a continuous scheduler or a guarantee of exactly one newly available bar. Pausing cancels virtual working orders and retains positions at their last mark. Risk-reducing stepping remains available under an operator admission stop for running sessions.

Account curves use recorded capital/fill events plus the latest retained equity mark. They do not reconstruct historical mark-to-market equity. Position exposure requires actual quantity, contract multiplier, mark and conversion; missing inputs remain unknown. Chart prices are a separately fetched current closed-candle window and never silently overwrite the paper book's retained mark. Position details overlay actual virtual entry, SL and TP levels. Spread and slippage remain embedded in modeled fills, so accounting does not subtract them twice. Funding is unknown/excluded and transfers/ADL unresolved.

Orders separates PAPER records from `OBS-*` venue observations. New shadow cycles retain up to 500 normalized order and position records from the last REST pass. Counts and SHA-256 digests still cover the complete original read, with explicit display-truncation status. Older archives may retain only hashes/counts and cannot display reconstructed individual records. Order timelines show retained strategy/risk references, linked protection events and fills; working orders have no fabricated SL/TP arming. Observed records never imply local ownership or provide cancel/amend controls.

Screens 22–30 and 34–38 include actual per-account SAFE policies, M7 audit steps, two-pass SHA-256 comparisons, manual recovery review, offline ownership boundaries, shadow campaign history, measured REST-pass latency, process/latch controls, actionable alert acknowledgement, discovered profiles/tiers and native report exports. Stop and resume call the existing persistent operator latch; stop is available during an in-flight UI job. These actions never flatten venue exposure or unlock trading. News/event risk remains an explicit roadmap with working manual operator pause controls. Allocations aggregate independently funded paper books; no shared reserve or automatic regime allocator is invented.

`GET /api/instruments` performs bounded read-budgeted profile discovery with current conversion and safe per-pair failure states. Missing conversion leaves fresh INR minimums unknown. `GET /api/workspace` also includes the latest 30 archived shadow campaigns, current paper policies and an observation timestamp. Per-scope limiter telemetry measures actual acquisitions, starts, pending requests, completions and start-to-completion durations. Traffic and latency series retain at most 120 samples and reset with the process. REST-pass latency includes managed budget waits. Unknown external IP consumers remain unknown.

The 1000 req / 10s requested reference is labeled **not configured**. The effective coordinator remains the stricter existing local policy: 1 start/second, 20 starts/minute, concurrency 1. No provider quota guarantee or admission bypass is introduced. Use Refresh to update retained workspace/telemetry views. Alert feedback preferences are browser-local; email/webhook/push delivery is not configured. Acknowledgement is retained and audited without clearing the underlying risk condition.

Verification adds `tests/unit/coindcx/dashboard-read-telemetry.test.ts` and interaction checks for paper SL/TP deployment, step/pause/resume, admission stop during an in-flight job, alert acknowledgement, source-separated order details, and re-enabling controls after a job settles. All 42 routes are still exercised with empty and populated state.


## Batch 4 system screens and evidence

Screens 28, 31?33, 38 and 40?42 expose the evidence catalog, safe runtime connection metadata, persistent preferences, locked readiness review, native downloads and recovery/onboarding states. The grouped screen index and jumper cover all 42 routes. Every live permission remains false; neither settings nor retained convergence authorizes execution.

`GET /api/evidence` lists saved backtests, shadow archives, strategy configurations and paper sessions. New report writes retain detached SHA-256 manifests. `VERIFIED` means the local report manifest or workspace envelope matches; `DIGEST_ONLY` means an older report has no prior manifest; corrupt or mismatching evidence is `FAILED`. Local digests are not external signatures. `GET /api/evidence/:id` inspects a redacted JSON package. Workspace integrity is checked against the atomic local store, including compatibility with original V1 field ordering.

`GET /api/reports/export?format=json` downloads the workspace audit bundle without requiring a report ID. Named backtest/paper IDs support CSV trade ledgers; research, shadow and saved-strategy IDs support JSON. Downloads use the native browser GET form and `Content-Disposition: attachment`. Credential fields, known configured secrets and database connection strings are redacted. CSV cells are quoted and formula-prefixed strings are escaped. A mismatching report seal blocks export. Legacy unsealed reports remain explicitly unsealed.

Settings support English or Tamil navigation/system labels, Kolkata or UTC display, default coin, virtual equity, maximum order, default SL/TP percentages, and in-app routine/research toast preferences. Technical evidence retains its original field names. Critical errors and operator confirmations remain visible. Defaults affect fresh forms; saved presets, drafts and existing sessions retain their configurations. Optional schema fields preserve legacy checksums. Email/webhook/push delivery is not composed.

REST connection status distinguishes configured credentials from actual authentication and labels the exact observed HTTP source. Account fingerprint display is truncated. The stream is scoped to each read-only cycle and stopped afterward. Optional MySQL/Prisma configuration indicators never claim a database connection. Instrument minimums use observed metadata and conversion, without substituting design reference amounts.

All admission-stop actions open the shared native confirmation dialog, including `#stop-confirm` and `window.openStop()`. Escape, backdrop click or Keep viewing dismiss it without a mutation. Confirm stops the persistent admission latch, refreshes all views, and retains the operator reason. This control stays available during an in-flight UI job; it never promises a venue flatten/cancel action. Resume still requires the existing explicit operator action.

## Historical minute inventory and tracked coin catalog

Screen 05, Quality and Backfill now show `.local/datasets/<PAIR>-1m.json` inventory: tracked coins, actual minute candle counts, observed coverage, UTC date ranges, gap intervals, missing minutes and actual disk bytes (MB = bytes / 1024²). Coverage measures the observed first-to-last span including gaps. Empty archives and stale tails remain distinct from synchronized data.

`GET /api/catalog/coins?q=XRP&offset=0&limit=6` searches the full active INR perpetual list and reads lot/tick/dynamic leverage metadata for the requested page. Paging avoids hundreds of reads when opening the modal. `POST /api/catalog/coins` accepts `{ "underlying": "XRP" }` or `{ "pair": "B-XRP_USDT" }`, revalidates instrument metadata, initializes the archive and persists the tracked universe. Legacy workspace checksums are verified before migration. Markets, strategy research, validation, paper and shadow selectors use this universe; added profiles stay live-disabled.

`GET /api/data/inventory` returns measured inventory. `POST /api/data/history` accepts `action` (`sync`, `backfill`, `repair`, `extend`), either `coin` or `all: true`, and optional `days` (1–365) or `fromDate`/`toDate` (also `fromMs`/`toMs`). Sync catches up to the latest closed minute, initially one day for an empty archive. Backfill merges the requested window. Extend prepends the selected number of days to the earliest observed minute. Repair fetches detected internal missing intervals. Missing provider candles remain absent and are reported as `requestedMissingMinutes`; synthetic candles are never created.

Downloads use sequential pages of at most 200 minutes through the existing reader and shared M2 ReadBudget. Every page requires a fresh permit. Identical timestamps deduplicate; contradictory pages fail without contaminating the archive. Verified partial progress survives later failures; retrying requests only remaining missing ranges. The existing 1 start/second, 20 starts/minute, concurrency 1 policy is unchanged, so long histories can take hours.

Screen 11 provides 1d, 3d, 7d, 15d, 30d, 90d, 365d and Custom windows with synchronized date inputs. **UTC ranges are [From, To): To is excluded**, including date-only inputs at midnight. Date ranges override the legacy bar-count lookback, read the minute archive first and download missing edges or internal gaps. Replay rejects incomplete minute history and aggregates only complete UTC-aligned 1m/5m/15m/1h groups. Reports retain resolved `fromMs`/`toMs`. Percent/INR SL/TP, next-open fills, costs and funding exclusions retain their existing semantics.

CLI examples: `npm run backtest:run -- --coin XRP --days 3 --sl-mode percent --sl-value 1 --tp-mode inr --tp-value 20`, or `--from-date 2026-11-19 --to-date 2026-11-22`. Add XRP through the catalog first. `--from-ms`/`--to-ms` support minute-aligned boundaries. Requests are bounded to 365 days; future or contradictory date/day inputs fail validation. UI presets use complete UTC dates, while API `days` alone ends at the latest closed minute. Live trading remains **LIVE LOCKED**; no external CDN dependency or frozen execution change is introduced.
