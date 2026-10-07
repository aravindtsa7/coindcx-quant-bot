# M2 closeout (shared REST rate limiter)

**Status: engineering complete offline and on a disposable database. Not production-ready, and not an execution
authorization.** No independent provider verification has been done.

## What is established
- **Coverage:** both pending lists in `tests/architecture/rest-limiter-coverage.test.ts` are empty. Every provider REST
  request site is covered, and every mutation path (practical cancel, Phase 17 create/cancel, Phase 18 orphan cancel)
  is integrated.
- **Real-database acceptance:** 539 tests passing on a task-owned, loopback-only, disposable MySQL. The operational server
  was never contacted.
  - execution persistence 48;
  - Stage 1B2 suites 382 (migration shape, cancel primitives, cancel store, interlock, no-wire, unknown-acquire,
    previous-runtime, practical cancel dispatch);
  - reconciliation persistence 103;
  - orphan budget admission 6.
- **The 13 W4-recorded "DB-marked" unit files:** 505 passing. They use scripted or fake Prisma clients and are **not**
  real-database tests.
- **DB suite fixes in this checkpoint:** the Phase 17 service constructions in the execution and reconciliation
  persistence suites, and their enabled orphan cleanup, now carry the synthetic W4 budget. Their fake gateways sit above
  the transport, so previously they reached the gateway with no budget. The new
  `tests/integration/coindcx/rate-limit/orphan-cancel-admission-db.integration.test.ts` drives the real orphan adapter,
  gateway and transport against a loopback venue over the real Prisma repository. It lives with the M2 rate-limit suites
  because Phase 18 rule P18-§25 forbids real-gateway construction in reconciliation-named tests; that rule and the
  loopback rule for every real gateway fixture are unchanged.
- **Evidence:** `.local/m2-db-acceptance-evidence-20261007/` in the original worktree.

## Pending (not done by M2)
- Production budget binding, coordinator supervision and startup, and operator controls (including IPC access control
  for STOP/RESET_STOP, U-M2-7).
- Live authorization and enablement.
- U-M2-4/5/8/9/10/11 configuration and policy decisions, and M6 cancellation-hook registration.
- Composition of the orphan-cancellation budget in production (currently unwired, so it is refused).
- **Unresolved production recovery-policy decision:** a budget refusal records the orphan's cancel as permanent
  `CANCEL_REJECTED` (`BUDGET_REFUSED`), which retires automatic cleanup for that orphan until an operator acts. This is
  the existing classification, kept unchanged and not approved for production.
- Grants consumed but never started remain uncertain (no refund).
