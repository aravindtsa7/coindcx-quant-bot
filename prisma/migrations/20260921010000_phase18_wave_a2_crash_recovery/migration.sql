-- Phase 18 Wave A2: durable wire-arm crash recovery (F18-14).
--
-- Adds the durable distinction between "this process holds only a LOCAL
-- mutation reservation" and "this process has proven the wire request may
-- have left it" for the two Phase17-owned mutation claims (`live_order`) and
-- the one Phase18-owned orphan cancellation claim (`live_orphan_venue_order`).
--
-- Three new BOOLEAN columns, each NOT NULL DEFAULT false. A DEFAULT of false
-- is the correct reading ONLY for a row this migration's own backfill did not
-- touch: a fresh `CREATED` order, a settled terminal order, or a claim with no
-- outstanding reservation. It is NOT a correct reading for a row that was
-- ALREADY sitting in an outstanding local-reservation state the instant this
-- migration ran (§F18-16, Wave A3 remediation) — see the backfill below.

-- AlterTable
ALTER TABLE `live_order`
  ADD COLUMN `dispatch_wire_armed` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `cancel_wire_armed` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `live_orphan_venue_order`
  ADD COLUMN `cancel_wire_armed` BOOLEAN NOT NULL DEFAULT false;

-- [F18-16, Wave A3] Conservative backfill for legacy outstanding claims.
--
-- Every row already sitting in `DISPATCH_RESERVED` / `CANCEL_RESERVED` /
-- (orphan) `CANCEL_CLAIMED` the instant this migration applies was
-- necessarily created by CODE THAT PREDATES THE WIRE-ARM PROTOCOL: prior to
-- this migration and its accompanying application release, a local claim was
-- taken and the wire mutation was attempted immediately afterward, with no
-- separate, independently durable "arm" checkpoint in between. There is no
-- historical column that ever recorded whether the wire request left the
-- process for such a row.
--
-- Therefore, for exactly these pre-existing outstanding rows: ABSENCE of the
-- new column is not proof of "false" — it is UNKNOWN, and unknown must never
-- be reinterpreted as "provably unsent". The conservative (fail-closed)
-- reading of "unknown" for an outstanding claim is "possibly wire-attempted",
-- i.e. armed=true. Marking these rows armed means Phase 18 crash recovery
-- (`planClaimRecovery`) will NEVER silently reclaim them as safely-unsent
-- local-only reservations; it will instead resolve them only through
-- authoritative venue evidence (or leave them durably blocking for a human),
-- exactly as it already does for any genuinely wire-armed Wave A2 claim.
--
-- Every row NOT in one of these three outstanding states is unaffected by
-- this backfill and correctly keeps the column default of false: a `CREATED`
-- order was never claimed at all, a terminal order (`FILLED`/`CANCELLED`/
-- `REJECTED`/`SUBMISSION_AMBIGUOUS`/`RECONCILIATION_REQUIRED`) has no
-- outstanding claim to misclassify, and `cancel_state = 'NONE'` /
-- `cancel_state = 'CANCEL_CLAIMED'` absent means no cancel/orphan-cancel claim
-- is outstanding either.
UPDATE `live_order`
SET `dispatch_wire_armed` = true
WHERE `state` = 'DISPATCH_RESERVED';

UPDATE `live_order`
SET `cancel_wire_armed` = true
WHERE `cancel_state` = 'CANCEL_RESERVED';

UPDATE `live_orphan_venue_order`
SET `cancel_wire_armed` = true
WHERE `cancel_state` = 'CANCEL_CLAIMED';
