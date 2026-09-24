-- Phase 18: additive startup reconciliation and crash recovery.
--
-- Purely additive: five new tables, no ALTER of any existing table, no dropped
-- column, and no rewrite of Phase 17 live-execution data. Nothing is
-- backfilled. Every account is absent from `live_reconciliation_state` until a
-- real reconciliation attempt inserts it, and an absent row reads as
-- RECONCILIATION_REQUIRED — so applying this migration alone makes every
-- account fail closed rather than inheriting an invented healthy state.
--
-- This migration deliberately does NOT restate the pre-existing Phase 14
-- (`paper_execution_intent`) and Phase 15 (`ranking_result`) foreign-key name
-- drift that a whole-schema diff also reports. That drift predates Phase 18,
-- is unrelated to it, and rewriting those historical constraints here would
-- make an additive reconciliation migration silently mutate Phase 14/15
-- objects.
--
-- Fencing and idempotence are enforced here, in the database, not in
-- application memory:
--   * UNIQUE(account_id, generation) on `live_reconciliation_run` means two
--     racing reconcilers cannot own one generation: the loser's INSERT
--     collides. The winner is decided by MySQL, not by a process-local lock.
--   * UNIQUE(account_id, finding_sha256) makes a rerun against unchanged
--     evidence update `last_seen_generation` instead of inserting a duplicate
--     fault.
--   * PRIMARY KEY(account_id, exchange_order_id) on `live_orphan_venue_order`
--     binds an orphan cancellation claim to one exact venue order identity, so
--     at most one claim can exist per venue order however many workers run.
--   * PRIMARY KEY(account_id, pair, owner_strategy_instance_id) lets several
--     strategy instances hold provable shares of one venue position without
--     any of them being able to claim the aggregate.
--   * `revision` backs the conditional-update optimistic concurrency used by
--     every durable Phase 18 state transition.

-- CreateTable
CREATE TABLE `live_reconciliation_state` (
    `account_id` VARCHAR(128) NOT NULL,
    `status` ENUM('RECONCILIATION_REQUIRED', 'RUNNING', 'HEALTHY', 'UNHEALTHY', 'MANUAL_REVIEW_REQUIRED') NOT NULL DEFAULT 'RECONCILIATION_REQUIRED',
    `current_generation` INTEGER NOT NULL DEFAULT 0,
    `current_run_id` VARCHAR(64) NULL,
    `current_runtime_epoch` VARCHAR(64) NULL,
    `healthy_generation` INTEGER NULL,
    `last_evaluated_at_ms` BIGINT NULL,
    `blocking_finding_count` INTEGER NOT NULL DEFAULT 0,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `live_reconciliation_state_status_idx`(`status`),
    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_reconciliation_run` (
    `run_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `generation` INTEGER NOT NULL,
    `status` ENUM('RUNNING', 'COMPLETED_HEALTHY', 'COMPLETED_UNHEALTHY', 'COMPLETED_MANUAL_REVIEW', 'ABANDONED') NOT NULL DEFAULT 'RUNNING',
    `runtime_epoch` VARCHAR(64) NOT NULL,
    `snapshot_sha256` VARCHAR(64) NULL,
    `snapshot_validated` BOOLEAN NOT NULL DEFAULT false,
    `orders_complete` BOOLEAN NOT NULL DEFAULT false,
    `positions_complete` BOOLEAN NOT NULL DEFAULT false,
    `snapshot_started_at_ms` BIGINT NOT NULL,
    `snapshot_ended_at_ms` BIGINT NULL,
    `evaluated_at_ms` BIGINT NULL,
    `finding_count` INTEGER NOT NULL DEFAULT 0,
    `blocking_finding_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,

    INDEX `live_reconciliation_run_account_status_idx`(`account_id`, `status`),
    UNIQUE INDEX `live_reconciliation_run_account_generation_unique`(`account_id`, `generation`),
    PRIMARY KEY (`run_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_reconciliation_finding` (
    `finding_id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `finding_sha256` VARCHAR(64) NOT NULL,
    `category` ENUM('VERIFIED_MATCH', 'SAFE_AUTHORITATIVE_ADVANCE', 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE', 'CONFLICT', 'ORPHAN', 'AMBIGUOUS', 'MANUAL_REVIEW_REQUIRED') NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `blocking` BOOLEAN NOT NULL DEFAULT true,
    `pair` VARCHAR(64) NULL,
    `intent_id` VARCHAR(64) NULL,
    `exchange_order_id` VARCHAR(64) NULL,
    `venue_position_id` VARCHAR(64) NULL,
    `strategy_instance_id` VARCHAR(64) NULL,
    `evidence_json` TEXT NOT NULL,
    `first_seen_run_id` VARCHAR(64) NOT NULL,
    `first_seen_generation` INTEGER NOT NULL,
    `last_seen_generation` INTEGER NOT NULL,
    `first_seen_at_ms` BIGINT NOT NULL,
    `last_seen_at_ms` BIGINT NOT NULL,
    `resolved_at_ms` BIGINT NULL,
    `resolved_by` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `live_reconciliation_finding_account_generation_idx`(`account_id`, `last_seen_generation`, `blocking`),
    INDEX `live_reconciliation_finding_account_category_idx`(`account_id`, `category`),
    UNIQUE INDEX `live_reconciliation_finding_account_content_unique`(`account_id`, `finding_sha256`),
    PRIMARY KEY (`finding_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_orphan_venue_order` (
    `account_id` VARCHAR(128) NOT NULL,
    `exchange_order_id` VARCHAR(64) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `side` ENUM('BUY', 'SELL') NOT NULL,
    `venue_status` VARCHAR(32) NOT NULL,
    `ordered_quantity` DECIMAL(36, 18) NOT NULL,
    `filled_quantity` DECIMAL(36, 18) NOT NULL,
    `price` DECIMAL(36, 18) NULL,
    `first_seen_generation` INTEGER NOT NULL,
    `last_seen_generation` INTEGER NOT NULL,
    `provider_event_time_ms` BIGINT NOT NULL,
    `cancel_state` ENUM('NONE', 'CANCEL_CLAIMED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED') NOT NULL DEFAULT 'NONE',
    `cancel_generation` INTEGER NOT NULL DEFAULT 0,
    `cancel_fault_code` VARCHAR(64) NULL,
    `cancel_claimed_at` DATETIME(3) NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `live_orphan_venue_order_account_cancel_idx`(`account_id`, `cancel_state`),
    INDEX `live_orphan_venue_order_account_pair_idx`(`account_id`, `pair`),
    PRIMARY KEY (`account_id`, `exchange_order_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_position_ownership_share` (
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `owner_strategy_instance_id` VARCHAR(64) NOT NULL,
    `side` ENUM('LONG', 'SHORT') NOT NULL,
    `quantity` DECIMAL(36, 18) NOT NULL,
    `owner_strategy_id` VARCHAR(128) NOT NULL,
    `owner_strategy_version` VARCHAR(32) NOT NULL,
    `owner_parameter_hash` VARCHAR(64) NOT NULL,
    `venue_position_id` VARCHAR(64) NULL,
    `lineage_sha256` VARCHAR(64) NOT NULL,
    `lineage_json` TEXT NOT NULL,
    `established_generation` INTEGER NOT NULL,
    `last_proven_generation` INTEGER NOT NULL,
    `materialized` BOOLEAN NOT NULL DEFAULT false,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `live_position_ownership_share_account_pair_idx`(`account_id`, `pair`),
    PRIMARY KEY (`account_id`, `pair`, `owner_strategy_instance_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `live_reconciliation_run` ADD CONSTRAINT `live_reconciliation_run_state_fkey` FOREIGN KEY (`account_id`) REFERENCES `live_reconciliation_state`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_reconciliation_finding` ADD CONSTRAINT `live_reconciliation_finding_run_fkey` FOREIGN KEY (`first_seen_run_id`) REFERENCES `live_reconciliation_run`(`run_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
