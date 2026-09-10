-- CreateTable
CREATE TABLE `paper_account` (
    `account_id` VARCHAR(128) NOT NULL,
    `owner_fence` BIGINT NOT NULL DEFAULT 0,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `starting_capital_inr` DECIMAL(36, 18) NOT NULL,
    `cumulative_realized_pnl_inr` DECIMAL(36, 18) NOT NULL DEFAULT 0,
    `cumulative_fees_inr` DECIMAL(36, 18) NOT NULL DEFAULT 0,
    `cumulative_funding_inr` DECIMAL(36, 18) NOT NULL DEFAULT 0,
    `peak_equity_inr` DECIMAL(36, 18) NOT NULL,
    `consecutive_loss_count` INTEGER NOT NULL DEFAULT 0,
    `cooldown_active_until_ms` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_execution_policy_snapshot` (
    `execution_policy_snapshot_id` VARCHAR(64) NOT NULL,
    `policy_version` VARCHAR(64) NOT NULL,
    `fill_selection_policy` VARCHAR(64) NOT NULL,
    `max_evidence_age_ms` INTEGER NOT NULL,
    `required_health_state` VARCHAR(32) NOT NULL,
    `taker_fee_rate` DECIMAL(36, 18) NOT NULL,
    `slippage_bps` DECIMAL(36, 18) NOT NULL,
    `spread_semantics` VARCHAR(64) NOT NULL,
    `tick_rounding_policy` VARCHAR(64) NOT NULL,
    `quantity_policy` VARCHAR(64) NOT NULL,
    `contract_multiplier` DECIMAL(36, 18) NOT NULL,
    `currency_conversion_policy` VARCHAR(64) NOT NULL,
    `accounting_policy` VARCHAR(64) NOT NULL,
    `execution_semantics_version` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`execution_policy_snapshot_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_reservation` (
    `admission_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `risk_decision_id` VARCHAR(64) NOT NULL,
    `source_strategy_decision_id` VARCHAR(64) NOT NULL,
    `strategy_instance_id` VARCHAR(64) NOT NULL,
    `strategy_id` VARCHAR(128) NOT NULL,
    `strategy_version` VARCHAR(32) NOT NULL,
    `parameter_hash` VARCHAR(64) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `decision_sequence` INTEGER NOT NULL,
    `direction` ENUM('LONG', 'SHORT') NOT NULL,
    `approved_notional_inr` DECIMAL(36, 18) NOT NULL,
    `approved_margin_inr` DECIMAL(36, 18) NOT NULL,
    `generation` INTEGER NOT NULL,
    `status` ENUM('ADMITTED', 'RELEASED', 'CONSUMED') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `paper_reservation_account_source_decision_idx`(`account_id`, `source_strategy_decision_id`),
    INDEX `paper_reservation_account_instance_sequence_idx`(`account_id`, `strategy_instance_id`, `decision_sequence`),
    UNIQUE INDEX `paper_reservation_account_risk_decision_generation_unique`(`account_id`, `risk_decision_id`, `generation`),
    PRIMARY KEY (`admission_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_execution_intent` (
    `execution_intent_id` VARCHAR(64) NOT NULL,
    `action` ENUM('OPEN', 'CLOSE') NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `strategy_instance_id` VARCHAR(64) NOT NULL,
    `strategy_id` VARCHAR(128) NOT NULL,
    `strategy_version` VARCHAR(32) NOT NULL,
    `parameter_hash` VARCHAR(64) NOT NULL,
    `risk_decision_id` VARCHAR(64) NOT NULL,
    `evaluation_time_ms` BIGINT NOT NULL,
    `execution_policy_snapshot_id` VARCHAR(64) NOT NULL,
    `admission_id` VARCHAR(64) NULL,
    `approved_quantity` DECIMAL(36, 18) NULL,
    `approved_leverage` DECIMAL(36, 18) NULL,
    `approved_notional_inr` DECIMAL(36, 18) NULL,
    `approved_margin_inr` DECIMAL(36, 18) NULL,
    `position_instance_id` VARCHAR(64) NULL,
    `position_revision` INTEGER NULL,
    `reduce_only_quantity` DECIMAL(36, 18) NULL,
    `research_approval_origin_id` VARCHAR(64) NULL,
    `validation_subject_id` VARCHAR(64) NULL,
    `validation_plan_id` VARCHAR(64) NULL,
    `validation_subject_result_sha256` VARCHAR(64) NULL,
    `strategy_origin_id` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paper_execution_intent_account_pair_idx`(`account_id`, `pair`),
    INDEX `paper_execution_intent_position_instance_idx`(`position_instance_id`),
    UNIQUE INDEX `paper_execution_intent_admission_unique`(`admission_id`),
    PRIMARY KEY (`execution_intent_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_order` (
    `execution_intent_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `action` ENUM('OPEN', 'CLOSE') NOT NULL,
    `state` ENUM('CREATED', 'ACCEPTED', 'FILLED', 'CANCELLED', 'REJECTED') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `paper_order_account_state_idx`(`account_id`, `state`),
    PRIMARY KEY (`execution_intent_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_fill` (
    `order_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `source_strategy_decision_id` VARCHAR(64) NOT NULL,
    `source_execution_key` VARCHAR(64) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `action` ENUM('OPEN', 'CLOSE') NOT NULL,
    `side` ENUM('BUY', 'SELL') NOT NULL,
    `fill_price` DECIMAL(36, 18) NOT NULL,
    `quantity` DECIMAL(36, 18) NOT NULL,
    `fee_inr` DECIMAL(36, 18) NOT NULL,
    `realized_pnl_inr` DECIMAL(36, 18) NULL,
    `quote_snapshot_content_sha256` VARCHAR(64) NOT NULL,
    `mark_snapshot_content_sha256` VARCHAR(64) NULL,
    `event_time_ms` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `paper_fill_account_source_decision_terminal_unique`(`account_id`, `source_strategy_decision_id`),
    PRIMARY KEY (`order_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_position` (
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `status` ENUM('EMPTY', 'PENDING', 'OPEN') NOT NULL DEFAULT 'EMPTY',
    `admission_id` VARCHAR(64) NULL,
    `position_instance_id` VARCHAR(64) NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `owner_strategy_instance_id` VARCHAR(64) NULL,
    `owner_strategy_id` VARCHAR(128) NULL,
    `owner_strategy_version` VARCHAR(32) NULL,
    `owner_parameter_hash` VARCHAR(64) NULL,
    `side` ENUM('LONG', 'SHORT') NULL,
    `quantity` DECIMAL(36, 18) NULL,
    `average_entry_price_inr` DECIMAL(36, 18) NULL,
    `leverage` DECIMAL(36, 18) NULL,
    `initial_margin_inr` DECIMAL(36, 18) NULL,
    `cumulative_realized_pnl_inr` DECIMAL(36, 18) NOT NULL DEFAULT 0,
    `cumulative_fees_inr` DECIMAL(36, 18) NOT NULL DEFAULT 0,
    `cumulative_funding_inr` DECIMAL(36, 18) NOT NULL DEFAULT 0,
    `opened_at_ms` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`account_id`, `pair`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_position_ownership_history` (
    `position_instance_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `strategy_instance_id` VARCHAR(64) NOT NULL,
    `strategy_id` VARCHAR(128) NOT NULL,
    `strategy_version` VARCHAR(32) NOT NULL,
    `parameter_hash` VARCHAR(64) NOT NULL,
    `side` ENUM('LONG', 'SHORT') NOT NULL,
    `opening_execution_intent_id` VARCHAR(64) NOT NULL,
    `closing_execution_intent_id` VARCHAR(64) NOT NULL,
    `quantity` DECIMAL(36, 18) NOT NULL,
    `average_entry_price_inr` DECIMAL(36, 18) NOT NULL,
    `exit_price_inr` DECIMAL(36, 18) NOT NULL,
    `realized_pnl_inr` DECIMAL(36, 18) NOT NULL,
    `total_fees_inr` DECIMAL(36, 18) NOT NULL,
    `total_funding_inr` DECIMAL(36, 18) NOT NULL,
    `opened_at_ms` BIGINT NOT NULL,
    `closed_at_ms` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paper_position_ownership_history_account_pair_idx`(`account_id`, `pair`),
    INDEX `paper_position_ownership_history_closing_intent_idx`(`closing_execution_intent_id`),
    UNIQUE INDEX `paper_position_ownership_history_opening_intent_unique`(`opening_execution_intent_id`),
    PRIMARY KEY (`position_instance_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_ledger_entry` (
    `entry_id` VARCHAR(64) NOT NULL,
    `type` ENUM('STARTING_CAPITAL', 'FEE', 'FUNDING', 'REALIZED_PNL', 'MARGIN_ESTABLISH', 'MARGIN_RELEASE') NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `position_instance_id` VARCHAR(64) NULL,
    `pair` VARCHAR(64) NULL,
    `strategy_instance_id` VARCHAR(64) NULL,
    `strategy_id` VARCHAR(128) NULL,
    `strategy_version` VARCHAR(32) NULL,
    `parameter_hash` VARCHAR(64) NULL,
    `amount_inr` DECIMAL(36, 18) NOT NULL,
    `source_fill_id` VARCHAR(64) NULL,
    `funding_event_id` VARCHAR(64) NULL,
    `conversion_snapshot_content_sha256` VARCHAR(64) NULL,
    `conversion_rate_inr_per_usdt` DECIMAL(36, 18) NULL,
    `event_time_ms` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paper_ledger_entry_account_position_idx`(`account_id`, `position_instance_id`),
    UNIQUE INDEX `paper_ledger_entry_type_source_fill_unique`(`type`, `source_fill_id`),
    UNIQUE INDEX `paper_ledger_entry_funding_dedup_unique`(`type`, `account_id`, `position_instance_id`, `funding_event_id`),
    PRIMARY KEY (`entry_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paper_reconciliation_fault` (
    `fault_id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `fault_type` VARCHAR(64) NOT NULL,
    `detected_at_ms` BIGINT NOT NULL,
    `evidence_json` TEXT NOT NULL,
    `resolved_at_ms` BIGINT NULL,
    `resolved_by` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paper_reconciliation_fault_account_type_idx`(`account_id`, `fault_type`),
    PRIMARY KEY (`fault_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `paper_reservation` ADD CONSTRAINT `paper_reservation_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_execution_intent` ADD CONSTRAINT `paper_execution_intent_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_execution_intent` ADD CONSTRAINT `paper_execution_intent_execution_policy_snapshot_id_fkey` FOREIGN KEY (`execution_policy_snapshot_id`) REFERENCES `paper_execution_policy_snapshot`(`execution_policy_snapshot_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_execution_intent` ADD CONSTRAINT `paper_execution_intent_admission_id_fkey` FOREIGN KEY (`admission_id`) REFERENCES `paper_reservation`(`admission_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_order` ADD CONSTRAINT `paper_order_execution_intent_id_fkey` FOREIGN KEY (`execution_intent_id`) REFERENCES `paper_execution_intent`(`execution_intent_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_order` ADD CONSTRAINT `paper_order_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_fill` ADD CONSTRAINT `paper_fill_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `paper_order`(`execution_intent_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_fill` ADD CONSTRAINT `paper_fill_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_position` ADD CONSTRAINT `paper_position_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_position_ownership_history` ADD CONSTRAINT `paper_position_ownership_history_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_ledger_entry` ADD CONSTRAINT `paper_ledger_entry_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_ledger_entry` ADD CONSTRAINT `paper_ledger_entry_source_fill_id_fkey` FOREIGN KEY (`source_fill_id`) REFERENCES `paper_fill`(`order_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `paper_reconciliation_fault` ADD CONSTRAINT `paper_reconciliation_fault_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `paper_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
