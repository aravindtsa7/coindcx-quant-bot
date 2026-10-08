# M4 read-only collection launch checklist

Unwired review candidate. No real campaign has been authorized or run, and no values below are approved. M3/M4 remain
review candidates; D4c and AS1 remain pending. A report cannot grant authority or complete formal acceptance.

Before a separately authorized real read-only collection:

1. Review the runner, preflight and offline evidence. Obtain separate authorization for the exact account, declared
   observation scope, schedule and read-only composition. Supply an expected lowercase SHA-256 provider account
   fingerprint. Use the existing identity fingerprint/verifier functions; identity must verify before every evaluation's
   account scans. Supply independent authenticated-client credential provenance; unknown or mismatched account/budget
   bindings block collection.
2. Explicitly configure every `SyncReadCampaignConfig` field: account and fingerprint; mode, required components,
   accounting requirements, history and order statuses; account-scope assumption with attestation `NONE`; D4c/AS1
   `PENDING`; shared budget connection ID, authenticated scope, priority, admission deadline, transport timeout, limiter
   configuration and campaign share; page size/bound for every required component; identity/read/stream timeouts;
   cycle limit; evidence-age/read-duration bounds; duration, evaluation interval/count and failed-read stop limit;
   durable lineage; `ALL_UNCONFIRMED` contracts; absolute local JSON report destination. Review all values independently
   of the synthetic fixtures. Match the declarations to the actual injected client's construction and coordinator.
3. Provide a supervised, connected M2 coordinator and an already constructed authenticated M2-budgeted read client,
   narrowed to identity, orders and positions. Review its actual shared-budget binding and share allocation. Provide an
   injected clock, operator cancellation signal, and durable local report sink. This candidate supplies no production
   binding, startup path, file writer or credential loader. Confirm destination access and report delivery handling.
4. Supply read-only durable lineage and, if available, an independently observed private-stream source. Missing or
   unavailable stream observations remain `UNKNOWN` and revoke cycles. No quiet observation may be fabricated.
   Keep required `TRANSACTIONS` in scope: `CLIENT_ADAPTER_UNSUPPORTED` prevents convergence and does not establish
   provider absence. A scope excluding it is explicitly partial. Required accounting remains unresolved. Declared
   history windows flag records without filtering; complete history and terminal-page semantics stay unproven.
5. Inspect preflight's two lists separately. Resolve all **collection-start blockers** (configuration, independent client
   provenance, connected/not-stopped budget, destination/sink). Record **limitations** that prevent convergence or
   formal acceptance; collection permission does not resolve them. Do not narrow required scope to obtain convergence.
6. Verify stop/report handling before launch: identity mismatch/unverified identity; operator cancellation; coordinator
   loss/STOP/UNKNOWN; budget refusal or 429; configured failed-read, duration and evaluation bounds. Duration interrupts
   active observation; if the next scheduled evaluation falls outside it, the report says
   `NEXT_EVALUATION_OUTSIDE_DURATION`. Active client calls cannot receive an abort signal and may finish after stop;
   an already-invoked call awaiting budget admission may even start its HTTP request after stop. No new client call or
   page scan is launched; late results are discarded and capacity is not refunded by the runner. M2 completion alone frees slots;
   rate-window charges remain. Report in-flight uncertainty and distinguish `WRITTEN`, `FAILED` and `NOT_ATTEMPTED`.
7. Preserve PASS / FAIL / NOT_OBSERVED / UNKNOWN separately. `COMPLETED` means collection ended within schedule bounds,
   never acceptance. Snapshot reports retain unsettled calls; late diagnostic reports arriving before finalization are
   separate from observations. All grants stay false; no execution, mutation, hook registration or recovery path is
   available. Preserve gates, certificates, `authorityEligible` and Invariant 28.

The actual read-only composition and real launch need their own authorization. Do not invoke production startup or
reuse a mutation-capable composition to run this candidate.
