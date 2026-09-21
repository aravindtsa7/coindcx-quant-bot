-- Phase 17: additive live-execution persistence.
--
-- Purely additive: five new tables, no ALTER of any existing table, no
-- dropped column, and no rewrite of the Phase14 paper ledger or the Phase15
-- ranking evidence. Nothing is backfilled: these tables describe authenticated
-- CoinDCX order operations, and no historic exchange state may be guessed
-- (P17 §14). An order that predates this migration is simply absent rather
-- than invented, and every nullable column below stays NULL until genuine
-- evidence supplies it.
--
-- Idempotence is enforced here, in the database, not in application memory:
--   * PRIMARY KEY(intent_id) makes a replayed intent collide.
--   * UNIQUE(client_order_id) on both tables makes a truncation collision a
--     hard conflict instead of a silent reuse of an existing exchange order.
--   * UNIQUE(intent_id, observation_sha256) makes a repeated provider event a
--     no-op.
--   * `revision` backs the conditional-update optimistic concurrency used for
--     every state transition, including the single-winner dispatch claim.
CREATE TABLE `live_execution_intent` (
    `intent_id` VARCHAR(64) NOT NULL,
    `client_order_id` VARCHAR(64) NOT NULL,
    `content_sha256` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `side` ENUM('BUY', 'SELL') NOT NULL,
    `action` ENUM('OPEN', 'CLOSE') NOT NULL,
    `quantity` DECIMAL(36,18) NOT NULL,
    `order_type` ENUM('MARKET', 'LIMIT') NOT NULL,
    `price` DECIMAL(36,18) NULL,
    `time_in_force` ENUM('UNSPECIFIED', 'GOOD_TILL_CANCEL', 'FILL_OR_KILL', 'POST_ONLY', 'IMMEDIATE_OR_CANCEL') NOT NULL,
    `leverage` DECIMAL(36,18) NULL,
    `wire_order_type` VARCHAR(64) NOT NULL,
    `risk_decision_id` VARCHAR(64) NOT NULL,
    `admission_id` VARCHAR(64) NULL,
    `strategy_instance_id` VARCHAR(64) NOT NULL,
    `strategy_id` VARCHAR(128) NOT NULL,
    `strategy_version` VARCHAR(32) NOT NULL,
    `parameter_hash` VARCHAR(64) NOT NULL,
    `live_execution_policy_id` VARCHAR(64) NOT NULL,
    `instrument_spec_snapshot_id` VARCHAR(64) NOT NULL,
    `authorized_notional_inr` DECIMAL(36,18) NOT NULL,
    `settlement_rate_inr_per_quote` DECIMAL(36,18) NULL,
    `position_instance_id` VARCHAR(64) NULL,
    `position_revision` INTEGER NULL,
    `reduce_only_quantity` DECIMAL(36,18) NULL,
    `source_strategy_decision_id` VARCHAR(64) NOT NULL,
    `validation_subject_id` VARCHAR(64) NULL,
    `validation_plan_id` VARCHAR(64) NULL,
    `validation_subject_result_sha256` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `live_execution_intent_client_order_id_unique`(`client_order_id`),
    INDEX `live_execution_intent_account_pair_idx`(`account_id`, `pair`),
    INDEX `live_execution_intent_risk_decision_idx`(`risk_decision_id`),
    INDEX `live_execution_intent_source_decision_idx`(`source_strategy_decision_id`),
    PRIMARY KEY (`intent_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `live_admission_consumption` (
    `admission_id` VARCHAR(64) NOT NULL,
    `intent_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `risk_decision_id` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `live_admission_consumption_intent_unique`(`intent_id`),
    INDEX `live_admission_consumption_account_pair_idx`(`account_id`, `pair`),
    PRIMARY KEY (`admission_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `live_position` (
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `position_instance_id` VARCHAR(64) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `side` ENUM('LONG', 'SHORT') NOT NULL,
    `quantity` DECIMAL(36,18) NOT NULL,
    `instrument_spec_snapshot_id` VARCHAR(64) NOT NULL,
    `owner_strategy_instance_id` VARCHAR(64) NOT NULL,
    `owner_strategy_id` VARCHAR(128) NOT NULL,
    `owner_strategy_version` VARCHAR(32) NOT NULL,
    `owner_parameter_hash` VARCHAR(64) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `live_position_instance_unique`(`position_instance_id`),
    PRIMARY KEY (`account_id`, `pair`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `live_order` (
    `intent_id` VARCHAR(64) NOT NULL,
    `client_order_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `state` ENUM('CREATED', 'DISPATCH_RESERVED', 'SUBMISSION_AMBIGUOUS', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'RECONCILIATION_REQUIRED') NOT NULL,
    `exchange_order_id` VARCHAR(64) NULL,
    `ordered_quantity` DECIMAL(36,18) NOT NULL,
    `cumulative_filled_quantity` DECIMAL(36,18) NOT NULL DEFAULT 0,
    `remaining_quantity` DECIMAL(36,18) NOT NULL,
    `average_fill_price` DECIMAL(36,18) NULL,
    `last_exchange_status` VARCHAR(32) NULL,
    `last_provider_event_time_ms` BIGINT NULL,
    `fault_code` VARCHAR(64) NULL,
    `cancel_state` ENUM('NONE', 'CANCEL_RESERVED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED') NOT NULL DEFAULT 'NONE',
    `cancel_generation` INTEGER NOT NULL DEFAULT 0,
    `cancel_exchange_order_id` VARCHAR(64) NULL,
    `cancel_fault_code` VARCHAR(64) NULL,
    `cancel_claimed_at` DATETIME(3) NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `live_order_client_order_id_unique`(`client_order_id`),
    INDEX `live_order_account_state_idx`(`account_id`, `state`),
    INDEX `live_order_exchange_order_idx`(`exchange_order_id`),
    PRIMARY KEY (`intent_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `live_order_event` (
    `event_id` VARCHAR(191) NOT NULL,
    `intent_id` VARCHAR(64) NOT NULL,
    `observation_sha256` VARCHAR(64) NOT NULL,
    `kind` ENUM('ACKNOWLEDGED', 'PARTIAL_FILL', 'FILL', 'CANCELLED', 'REJECTED') NOT NULL,
    `exchange_order_id` VARCHAR(64) NOT NULL,
    `exchange_status` VARCHAR(32) NOT NULL,
    `cumulative_filled_quantity` DECIMAL(36,18) NOT NULL,
    `average_fill_price` DECIMAL(36,18) NULL,
    `provider_event_time_ms` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `live_order_event_intent_observation_unique`(`intent_id`, `observation_sha256`),
    INDEX `live_order_event_intent_provider_time_idx`(`intent_id`, `provider_event_time_ms`),
    PRIMARY KEY (`event_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `live_order`
    ADD CONSTRAINT `live_order_intent_fkey`
    FOREIGN KEY (`intent_id`)
    REFERENCES `live_execution_intent`(`intent_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `live_order_event`
    ADD CONSTRAINT `live_order_event_order_fkey`
    FOREIGN KEY (`intent_id`)
    REFERENCES `live_order`(`intent_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `live_admission_consumption`
    ADD CONSTRAINT `live_admission_consumption_intent_fkey`
    FOREIGN KEY (`intent_id`)
    REFERENCES `live_execution_intent`(`intent_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
