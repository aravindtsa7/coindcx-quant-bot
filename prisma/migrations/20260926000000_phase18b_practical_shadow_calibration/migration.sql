-- Phase 18B Checkpoint C: shadow calibration + paper safety simulation storage.
--
-- Purely additive: four new `live_practical_shadow_*` tables, foreign keys
-- ONLY among those new tables, and CHECK constraints on them. No existing
-- table is altered, no column dropped, nothing backfilled. Nothing here
-- references, or is referenced by, the Stage 1B1 practical authority tables.
--
-- OBSERVATIONAL ONLY. No row here is, or can become, a practical recovery
-- certificate, a mutation lease, a dispatch claim, or Phase 18 continuity.
-- The tables hold safe calibration metadata from read-only shadow collection
-- and HYPOTHETICAL paper safety decisions.
--
-- Invariants enforced by the DATABASE (the repository re-validates on read):
--   * one ACTIVE campaign per account: `live_practical_shadow_account` holds
--     the single active-campaign pointer (UNIQUE), changed by compare-and-set
--     under `SELECT ... FOR UPDATE`;
--   * a campaign's end fields are coupled to its status (CHECK);
--   * a campaign names the exact CLEAN source commit it was started from:
--     `source_provenance` = GIT_CLEAN_COMMIT and a lowercase 40-hex commit
--     (CHECK) -- no dirty, unknown, or development-mode software version;
--   * an evaluation's result columns are coupled to its status (CHECK):
--     CLAIMED carries no result, ABORTED carries only an abort reason and
--     never a result (a crash never becomes a completed observation),
--     COMPLETED carries its full safe evidence and classification;
--   * one evaluation sequence number per campaign (UNIQUE);
--   * an evaluation can be AUTHORITY-ELIGIBLE (hypothetically) only with a
--     PROVEN_READY private stream AND a passing REST stability candidate
--     (CHECK) -- an UNPROVEN stream can never be recorded as eligible;
--   * a paper decision can be WOULD_REACH_AUTHORITY_GATE only for a Stage 5a
--     CANCEL with every authority prerequisite met, a passing REST candidate,
--     and a PROVEN_READY stream (CHECK); OPEN, CLOSE, and the future Stage 5b
--     can only ever be WOULD_BLOCK;
--   * one paper decision per (evaluation, action, rollout stage) (UNIQUE), and
--     a paper decision names its evaluation AND that evaluation's campaign
--     (composite FOREIGN KEY on (evaluation_id, campaign_id));
--   * every digest column is an exact lowercase 64-hex digest (CHECK; the
--     digest itself is recomputed and compared by the repository -- MySQL
--     does not compute SHA-256), and a paper decision id is the deterministic
--     `pd-` + 48 lowercase hex form.
--
-- Secrecy: no API key, secret, signature, authorization header, raw provider
-- account identity, or raw order/position payload is stored. The provider
-- account is stored only as the Phase 18 lowercase 64-hex fingerprint digest;
-- records appear only as canonical record-set digests, counts, and timings.

-- CreateTable
CREATE TABLE `live_practical_shadow_account` (
    `account_id` VARCHAR(128) NOT NULL,
    `active_campaign_id` VARCHAR(64) NULL,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `live_practical_shadow_account_active_campaign_key`(`active_campaign_id`),
    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_shadow_campaign` (
    `campaign_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `provider_account_fingerprint` CHAR(64) NOT NULL,
    `software_version` CHAR(40) NOT NULL,
    `source_provenance` ENUM('GIT_CLEAN_COMMIT') NOT NULL,
    `config_digest` CHAR(64) NOT NULL,
    `config_json` TEXT NOT NULL,
    `evidence_schema_version` VARCHAR(64) NOT NULL,
    `status` ENUM('ACTIVE', 'COMPLETED', 'ABORTED') NOT NULL DEFAULT 'ACTIVE',
    `worker_id` VARCHAR(64) NOT NULL,
    `next_sequence` INTEGER NOT NULL DEFAULT 1,
    `started_at_ms` BIGINT NOT NULL,
    `ended_at_ms` BIGINT NULL,
    `end_reason` VARCHAR(64) NULL,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `live_practical_shadow_campaign_account_status_idx`(`account_id`, `status`),
    PRIMARY KEY (`campaign_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_shadow_evaluation` (
    `evaluation_id` VARCHAR(64) NOT NULL,
    `campaign_id` VARCHAR(64) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `worker_id` VARCHAR(64) NOT NULL,
    `runtime_epoch` VARCHAR(64) NOT NULL,
    `status` ENUM('CLAIMED', 'COMPLETED', 'ABORTED') NOT NULL DEFAULT 'CLAIMED',
    `claimed_at_ms` BIGINT NOT NULL,
    `finished_at_ms` BIGINT NULL,
    `abort_reason` VARCHAR(64) NULL,
    `started_at_ms` BIGINT NULL,
    `ended_at_ms` BIGINT NULL,
    `reconciliation_generation` INTEGER NULL,
    `stream_incarnation` INTEGER NULL,
    `stream_readiness` ENUM('PROVEN_READY', 'UNPROVEN', 'RECONCILIATION_REQUIRED', 'DISCONNECTED') NULL,
    `rest_stability` ENUM('PASS', 'FAIL') NULL,
    `rest_failure` VARCHAR(64) NULL,
    `authority_eligible` BOOLEAN NULL,
    `primary_blocker` VARCHAR(64) NULL,
    `blockers_json` TEXT NULL,
    `evidence_schema_version` VARCHAR(64) NULL,
    `evidence_digest` CHAR(64) NULL,
    `evidence_json` MEDIUMTEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `live_practical_shadow_evaluation_campaign_status_idx`(`campaign_id`, `status`),
    UNIQUE INDEX `live_practical_shadow_evaluation_sequence_key`(`campaign_id`, `sequence`),
    UNIQUE INDEX `live_practical_shadow_evaluation_campaign_key`(`evaluation_id`, `campaign_id`),
    PRIMARY KEY (`evaluation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_shadow_paper_decision` (
    `paper_decision_id` VARCHAR(64) NOT NULL,
    `evaluation_id` VARCHAR(64) NOT NULL,
    `campaign_id` VARCHAR(64) NOT NULL,
    `requested_action` ENUM('CANCEL', 'OPEN', 'CLOSE') NOT NULL,
    `rollout_stage` ENUM('STAGE_5A_CANCEL_ONLY', 'STAGE_5B_OPEN_CLOSE_FUTURE') NOT NULL,
    `rest_stability` ENUM('PASS', 'FAIL') NOT NULL,
    `stream_readiness` ENUM('PROVEN_READY', 'UNPROVEN', 'RECONCILIATION_REQUIRED', 'DISCONNECTED') NOT NULL,
    `authority_prerequisites_met` BOOLEAN NOT NULL,
    `outcome` ENUM('WOULD_BLOCK', 'WOULD_REACH_AUTHORITY_GATE') NOT NULL,
    `blockers_json` TEXT NOT NULL,
    `policy_version` VARCHAR(64) NOT NULL,
    `created_at_ms` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `live_practical_shadow_paper_decision_campaign_idx`(`campaign_id`),
    UNIQUE INDEX `live_practical_shadow_paper_decision_intent_key`(`evaluation_id`, `requested_action`, `rollout_stage`),
    PRIMARY KEY (`paper_decision_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `live_practical_shadow_account` ADD CONSTRAINT `live_practical_shadow_account_active_campaign_fkey` FOREIGN KEY (`active_campaign_id`) REFERENCES `live_practical_shadow_campaign`(`campaign_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_shadow_campaign` ADD CONSTRAINT `live_practical_shadow_campaign_account_fkey` FOREIGN KEY (`account_id`) REFERENCES `live_practical_shadow_account`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_shadow_evaluation` ADD CONSTRAINT `live_practical_shadow_evaluation_campaign_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `live_practical_shadow_campaign`(`campaign_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_shadow_paper_decision` ADD CONSTRAINT `live_practical_shadow_paper_decision_evaluation_fkey` FOREIGN KEY (`evaluation_id`, `campaign_id`) REFERENCES `live_practical_shadow_evaluation`(`evaluation_id`, `campaign_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_shadow_paper_decision` ADD CONSTRAINT `live_practical_shadow_paper_decision_campaign_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `live_practical_shadow_campaign`(`campaign_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddCheckConstraint (Phase 18B Checkpoint C invariants)
ALTER TABLE `live_practical_shadow_account`
    ADD CONSTRAINT `practical_shadow_account_revision_chk` CHECK (`revision` >= 0);

-- AddCheckConstraint
ALTER TABLE `live_practical_shadow_campaign`
    ADD CONSTRAINT `practical_shadow_campaign_revision_chk` CHECK (`revision` >= 0),
    ADD CONSTRAINT `practical_shadow_campaign_sequence_chk` CHECK (`next_sequence` >= 1),
    ADD CONSTRAINT `practical_shadow_campaign_end_chk` CHECK (
        ((`status` = 'ACTIVE') = (`ended_at_ms` IS NULL)) AND ((`status` = 'ACTIVE') = (`end_reason` IS NULL))
    ),
    ADD CONSTRAINT `practical_shadow_campaign_window_chk` CHECK (`started_at_ms` >= 0 AND (`ended_at_ms` IS NULL OR `ended_at_ms` >= `started_at_ms`)),
    ADD CONSTRAINT `practical_shadow_campaign_provenance_chk` CHECK (
        `source_provenance` = 'GIT_CLEAN_COMMIT' AND REGEXP_LIKE(`software_version`, '^[0-9a-f]{40}$', 'c')
    ),
    ADD CONSTRAINT `practical_shadow_campaign_digest_chk` CHECK (
        REGEXP_LIKE(`config_digest`, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(`provider_account_fingerprint`, '^[0-9a-f]{64}$', 'c')
    );

-- AddCheckConstraint
ALTER TABLE `live_practical_shadow_evaluation`
    ADD CONSTRAINT `practical_shadow_evaluation_sequence_chk` CHECK (`sequence` >= 1),
    ADD CONSTRAINT `practical_shadow_evaluation_status_chk` CHECK (
        (`status` IN ('CLAIMED', 'ABORTED')
            AND `started_at_ms` IS NULL AND `ended_at_ms` IS NULL AND `reconciliation_generation` IS NULL AND `stream_incarnation` IS NULL
            AND `stream_readiness` IS NULL AND `rest_stability` IS NULL AND `rest_failure` IS NULL AND `authority_eligible` IS NULL
            AND `primary_blocker` IS NULL AND `blockers_json` IS NULL AND `evidence_schema_version` IS NULL AND `evidence_digest` IS NULL
            AND `evidence_json` IS NULL
            AND ((`status` = 'CLAIMED' AND `finished_at_ms` IS NULL AND `abort_reason` IS NULL)
                OR (`status` = 'ABORTED' AND `finished_at_ms` IS NOT NULL AND `abort_reason` IS NOT NULL)))
        OR (`status` = 'COMPLETED' AND `finished_at_ms` IS NOT NULL AND `abort_reason` IS NULL
            AND `started_at_ms` IS NOT NULL AND `ended_at_ms` IS NOT NULL AND `stream_readiness` IS NOT NULL AND `rest_stability` IS NOT NULL
            AND `authority_eligible` IS NOT NULL AND `blockers_json` IS NOT NULL AND `evidence_schema_version` IS NOT NULL
            AND `evidence_digest` IS NOT NULL AND `evidence_json` IS NOT NULL)
    ),
    ADD CONSTRAINT `practical_shadow_evaluation_window_chk` CHECK (`claimed_at_ms` >= 0 AND (`ended_at_ms` IS NULL OR `ended_at_ms` >= `started_at_ms`)),
    ADD CONSTRAINT `practical_shadow_evaluation_rest_chk` CHECK (`rest_stability` IS NULL OR ((`rest_stability` = 'PASS') = (`rest_failure` IS NULL))),
    ADD CONSTRAINT `practical_shadow_evaluation_authority_chk` CHECK (
        `authority_eligible` IS NULL OR `authority_eligible` = FALSE OR (`stream_readiness` = 'PROVEN_READY' AND `rest_stability` = 'PASS')
    ),
    ADD CONSTRAINT `practical_shadow_evaluation_blocker_chk` CHECK (`authority_eligible` IS NULL OR ((`authority_eligible` = TRUE) = (`primary_blocker` IS NULL))),
    ADD CONSTRAINT `practical_shadow_evaluation_digest_chk` CHECK (`evidence_digest` IS NULL OR REGEXP_LIKE(`evidence_digest`, '^[0-9a-f]{64}$', 'c'));

-- AddCheckConstraint
ALTER TABLE `live_practical_shadow_paper_decision`
    ADD CONSTRAINT `practical_shadow_paper_decision_prerequisites_chk` CHECK (
        `authority_prerequisites_met` = FALSE OR (`rest_stability` = 'PASS' AND `stream_readiness` = 'PROVEN_READY')
    ),
    ADD CONSTRAINT `practical_shadow_paper_decision_gate_chk` CHECK (
        `outcome` = 'WOULD_BLOCK'
        OR (`requested_action` = 'CANCEL' AND `rollout_stage` = 'STAGE_5A_CANCEL_ONLY' AND `authority_prerequisites_met` = TRUE
            AND `rest_stability` = 'PASS' AND `stream_readiness` = 'PROVEN_READY')
    ),
    ADD CONSTRAINT `practical_shadow_paper_decision_created_chk` CHECK (`created_at_ms` >= 0),
    ADD CONSTRAINT `practical_shadow_paper_decision_id_chk` CHECK (REGEXP_LIKE(`paper_decision_id`, '^pd-[0-9a-f]{48}$', 'c'));
