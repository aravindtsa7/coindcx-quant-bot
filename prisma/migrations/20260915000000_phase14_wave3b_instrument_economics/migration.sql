-- Phase 14 Wave3-B: additive, immutable instrument-economics lineage.
-- Existing execution intents deliberately retain NULL: legacy economics are
-- unverifiable and are diagnosed by reconciliation, never inferred/backfilled.
CREATE TABLE `paper_instrument_economics_snapshot` (
    `instrument_economics_snapshot_id` VARCHAR(64) NOT NULL,
    `identity_policy_id` VARCHAR(64) NOT NULL,
    `source_id` VARCHAR(64) NOT NULL,
    `instrument_spec_identity_policy_id` VARCHAR(64) NOT NULL,
    `instrument_spec_snapshot_id` VARCHAR(64) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `contract_multiplier` DECIMAL(36,18) NOT NULL,
    `price_increment` DECIMAL(36,18) NOT NULL,
    `quantity_increment` DECIMAL(36,18) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `paper_instrument_economics_snapshot_id_pair_unique`(`instrument_economics_snapshot_id`, `pair`),
    INDEX `paper_instrument_economics_pair_spec_idx`(`pair`, `instrument_spec_identity_policy_id`, `instrument_spec_snapshot_id`),
    PRIMARY KEY (`instrument_economics_snapshot_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `paper_execution_intent`
    ADD COLUMN `instrument_economics_snapshot_id` VARCHAR(64) NULL;

CREATE INDEX `paper_execution_intent_economics_pair_idx`
    ON `paper_execution_intent`(`instrument_economics_snapshot_id`, `pair`);

ALTER TABLE `paper_execution_intent`
    ADD CONSTRAINT `paper_execution_intent_instrument_economics_fkey`
    FOREIGN KEY (`instrument_economics_snapshot_id`, `pair`)
    REFERENCES `paper_instrument_economics_snapshot`(`instrument_economics_snapshot_id`, `pair`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
