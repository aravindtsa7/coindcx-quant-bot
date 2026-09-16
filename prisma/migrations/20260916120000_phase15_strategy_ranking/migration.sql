-- Phase 15: additive, immutable, read-only strategy-ranking evidence.
--
-- Purely additive: no existing table is altered, no column is dropped, no
-- Phase12 result or Phase14 paper ledger row is touched, and there is NO
-- backfill. Historic runs are simply absent rather than invented, because a
-- ranking run is a deterministic function of Phase12 evidence and can always
-- be recomputed rather than guessed.
CREATE TABLE `ranking_run` (
    `ranking_run_id` VARCHAR(64) NOT NULL,
    `schema_version` INTEGER NOT NULL,
    `ranking_policy_id` VARCHAR(64) NOT NULL,
    `ranking_policy_version` VARCHAR(32) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `validation_plan_id` VARCHAR(64) NOT NULL,
    `candidate_count` INTEGER NOT NULL,
    `ranked_count` INTEGER NOT NULL,
    `economic_status` VARCHAR(32) NOT NULL,
    `promotion_eligible` BOOLEAN NOT NULL,
    `max_lifecycle` VARCHAR(32) NOT NULL,
    `ranking_run_sha256` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ranking_run_pair_policy_idx`(`pair`, `ranking_policy_id`),
    INDEX `ranking_run_validation_plan_idx`(`validation_plan_id`),
    PRIMARY KEY (`ranking_run_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ranking_result` (
    `ranking_result_sha256` VARCHAR(64) NOT NULL,
    `ranking_run_id` VARCHAR(64) NOT NULL,
    `schema_version` INTEGER NOT NULL,
    `status` VARCHAR(40) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `strategy_id` VARCHAR(128) NOT NULL,
    `strategy_version` VARCHAR(32) NOT NULL,
    `parameter_hash` VARCHAR(64) NOT NULL,
    `validation_subject_id` VARCHAR(64) NOT NULL,
    `validation_plan_id` VARCHAR(64) NOT NULL,
    `validation_subject_result_sha256` VARCHAR(64) NOT NULL,
    `composite_score` DECIMAL(36,18) NULL,
    `rank` INTEGER NULL,
    `candidate_count` INTEGER NULL,
    `composite_tie_group_size` INTEGER NULL,
    `tie_break_level_applied` VARCHAR(48) NULL,
    `component_scores_json` TEXT NULL,
    `reason_codes_json` TEXT NOT NULL,
    `unavailable_components_json` TEXT NULL,
    `economic_status` VARCHAR(32) NOT NULL,
    `promotion_eligible` BOOLEAN NOT NULL,
    `max_lifecycle` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ranking_result_run_subject_unique`(`ranking_run_id`, `validation_subject_id`),
    INDEX `ranking_result_run_rank_idx`(`ranking_run_id`, `rank`),
    INDEX `ranking_result_validation_subject_idx`(`validation_subject_id`),
    PRIMARY KEY (`ranking_result_sha256`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ranking_result`
    ADD CONSTRAINT `ranking_result_run_fkey`
    FOREIGN KEY (`ranking_run_id`)
    REFERENCES `ranking_run`(`ranking_run_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
