-- Phase 18 Wave C1: durable orphan cancellation ambiguity resolution (F18-06).
--
-- Wave B made a durable orphan `CANCEL_AMBIGUOUS` cancellation sticky and
-- fail-closed (F18-25): it reasserts a blocking finding every generation,
-- regardless of whether the venue currently returns the order, and nothing
-- automatic ever clears it. That is correct, but it left no authoritative
-- in-band way for a human to ever resolve one. This migration adds exactly
-- that recovery path, without weakening stickiness for anything unresolved.
--
-- Two additive changes:
--
--   1. A new `cancel_state` value, `CANCEL_AMBIGUOUS_RESOLVED`. Deliberately
--      NOT `NONE` (which would silently re-arm automatic cancellation) and
--      NOT `CANCEL_ACKNOWLEDGED`/`CANCEL_REJECTED` (which both mean THIS
--      SYSTEM proved a specific venue outcome, which an operator resolution
--      never does). Existing code paths already treat "any state other than
--      NONE" as not-reclaimable and "any state other than CANCEL_AMBIGUOUS"
--      as not-sticky-reasserted, so this new value automatically inherits
--      both of those safety properties with no other code path needing to
--      special-case it.
--
--   2. A new append-only audit table, `live_orphan_cancel_resolution`, one
--      row per operator resolution. Never updated or deleted: the original
--      ambiguity stays provable forever. Unique on
--      (account_id, exchange_order_id, resolved_cancel_generation) so the
--      exact cancellation attempt a resolution targets can be resolved
--      exactly once, giving idempotent-replay and concurrent-resolution
--      protection at the database layer in addition to the application's own
--      row-level locking and revision fencing.

-- AlterTable
ALTER TABLE `live_orphan_venue_order`
  MODIFY COLUMN `cancel_state` ENUM('NONE', 'CANCEL_CLAIMED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED', 'CANCEL_AMBIGUOUS_RESOLVED') NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE `live_orphan_cancel_resolution` (
    `resolution_id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `exchange_order_id` VARCHAR(64) NOT NULL,
    `resolved_orphan_revision` INTEGER NOT NULL,
    `resolved_cancel_generation` INTEGER NOT NULL,
    `outcome` ENUM('ACKNOWLEDGED_NO_RETRY', 'CONFIRMED_CANCELLED') NOT NULL,
    `resolved_by` VARCHAR(128) NOT NULL,
    `note` VARCHAR(512) NULL,
    `resolved_at_ms` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `live_orphan_cancel_resolution_account_order_idx`(`account_id`, `exchange_order_id`),
    UNIQUE INDEX `live_orphan_cancel_resolution_account_order_gen_key`(`account_id`, `exchange_order_id`, `resolved_cancel_generation`),
    PRIMARY KEY (`resolution_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `live_orphan_cancel_resolution` ADD CONSTRAINT `live_orphan_cancel_resolution_orphan_fkey` FOREIGN KEY (`account_id`, `exchange_order_id`) REFERENCES `live_orphan_venue_order`(`account_id`, `exchange_order_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
