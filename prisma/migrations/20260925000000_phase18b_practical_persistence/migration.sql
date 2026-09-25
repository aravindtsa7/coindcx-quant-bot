-- Phase 18B Stage 1B1: practical live-safety durable persistence foundation.
--
-- Purely additive: seven new `live_practical_*` tables, foreign keys ONLY among
-- those new tables, and CHECK constraints on them. No existing table is
-- altered, no column dropped, nothing backfilled. Every account is absent
-- from `live_practical_account_state` until explicitly initialized, and an
-- absent row is the only thing that reads as "no prior practical state".
--
-- Durable storage only. Nothing in this migration authorizes, arms, or
-- dispatches a mutation, and nothing here represents Phase 18 account
-- continuity: a practical certificate is PRACTICAL_RECOVERY evidence.
--
-- Invariants enforced by the DATABASE (the repository re-validates every row
-- on read and never repairs one):
--   * one current state row and one fence row per account (PRIMARY KEY);
--   * the fence mode is a closed discriminated union: IDLE carries nothing,
--     CERTIFYING carries exactly run_id, MUTATION_LEASED carries exactly
--     lease_id + certificate_id + lease_action (CHECK), and a leased fence
--     names a real lease with the SAME lease id, certificate, account,
--     action, runtime epoch, and reconciliation generation (six-column
--     composite FOREIGN KEY). The FK cannot bind the lease's LEASED status,
--     and under this case-insensitive, pad-space collation it compares
--     case-insensitively; the repository re-validates exact equality of all
--     of these plus status = LEASED on every read of a leased account;
--   * the state's current pointers are coupled to the state (CHECK):
--     recovery episode <=> QUARANTINED/CERTIFYING/PROVIDER_UNAVAILABLE,
--     review episode <=> MANUAL_REVIEW_REQUIRED, certificate <=> CERTIFIED_IDLE;
--   * a certificate's terminal fields are coupled to its status (CHECK), and
--     at most ONE mutation lease can ever exist per certificate
--     (UNIQUE live_practical_mutation_lease.certificate_id);
--   * a lease names a real certificate with the SAME certificate id, account,
--     runtime epoch, and reconciliation generation (four-column composite
--     FOREIGN KEY). The FK cannot bind the certificate's CONSUMED status and
--     compares case-insensitively; the repository re-validates the complete
--     fence -> LEASED lease -> CONSUMED certificate chain exactly;
--   * a review episode can be resolved by a given resolution at most once
--     (UNIQUE resolution_id), and its resolution fields are coupled to its
--     status (CHECK);
--   * Stage 1B1 arms nothing: live_practical_mutation_lease.armed_at_ms must
--     stay NULL (CHECK). Stage 1B2 may lift this only in its own reviewed
--     forward migration.
--
-- Secrecy: no API key, secret, signature, authorization header, raw provider
-- account identity, or provider payload is stored. The provider account is
-- stored only as the Phase 18 lowercase 64-hex fingerprint digest.
--
-- MALFORMED-STATE LATCH (`live_practical_malformed_latch`). When an account's
-- practical rows fail strict validation, escalation writes an append-only
-- MALFORMED_STATE review episode (fixed reason DURABLE_STATE_MALFORMED, a safe
-- problem code only, never row contents) and points this latch at it. The
-- malformed rows themselves are never rewritten, so no epoch, generation, or
-- revision is invented. The latch has no foreign key to the account rows
-- (they may be the malformed ones); it references only its review episode.
-- One latch row per account (PRIMARY KEY) makes concurrent escalations
-- converge on one current episode.

-- CreateTable
CREATE TABLE `live_practical_account_state` (
    `account_id` VARCHAR(128) NOT NULL,
    `state` ENUM('QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE', 'CERTIFIED_IDLE', 'MUTATING', 'MANUAL_REVIEW_REQUIRED') NOT NULL,
    `current_recovery_episode_id` VARCHAR(64) NULL,
    `current_review_episode_id` VARCHAR(64) NULL,
    `current_certificate_id` CHAR(64) NULL,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `live_practical_account_state_recovery_episode_key`(`current_recovery_episode_id`),
    UNIQUE INDEX `live_practical_account_state_review_episode_key`(`current_review_episode_id`),
    UNIQUE INDEX `live_practical_account_state_certificate_key`(`current_certificate_id`),
    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_account_fence` (
    `account_id` VARCHAR(128) NOT NULL,
    `runtime_epoch` VARCHAR(64) NOT NULL,
    `reconciliation_generation` INTEGER NOT NULL,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `mode` ENUM('IDLE', 'CERTIFYING', 'MUTATION_LEASED') NOT NULL DEFAULT 'IDLE',
    `run_id` VARCHAR(64) NULL,
    `lease_id` VARCHAR(64) NULL,
    `certificate_id` CHAR(64) NULL,
    `lease_action` ENUM('OPEN', 'CANCEL', 'CLOSE') NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `live_practical_account_fence_lease_key`(`lease_id`, `certificate_id`),
    UNIQUE INDEX `live_practical_account_fence_lease_binding_key`(`lease_id`, `certificate_id`, `account_id`, `lease_action`, `runtime_epoch`, `reconciliation_generation`),
    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_certificate` (
    `certificate_id` CHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `provider_account_fingerprint` CHAR(64) NOT NULL,
    `runtime_epoch` VARCHAR(64) NOT NULL,
    `reconciliation_generation` INTEGER NOT NULL,
    `stream_incarnation` INTEGER NOT NULL,
    `evidence_digest` CHAR(64) NOT NULL,
    `issued_at_ms` BIGINT NOT NULL,
    `expires_at_ms` BIGINT NOT NULL,
    `status` ENUM('ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'ISSUED',
    `terminal_at_ms` BIGINT NULL,
    `terminal_reason` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `live_practical_certificate_account_status_idx`(`account_id`, `status`),
    UNIQUE INDEX `live_practical_certificate_lease_binding_key`(`certificate_id`, `account_id`, `runtime_epoch`, `reconciliation_generation`),
    PRIMARY KEY (`certificate_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_mutation_lease` (
    `lease_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `certificate_id` CHAR(64) NOT NULL,
    `action` ENUM('OPEN', 'CANCEL', 'CLOSE') NOT NULL,
    `intent_id` VARCHAR(64) NULL,
    `client_order_id` VARCHAR(64) NULL,
    `runtime_epoch` VARCHAR(64) NOT NULL,
    `reconciliation_generation` INTEGER NOT NULL,
    `created_at_ms` BIGINT NOT NULL,
    `armed_at_ms` BIGINT NULL,
    `completed_at_ms` BIGINT NULL,
    `status` ENUM('LEASED', 'COMPLETED') NOT NULL DEFAULT 'LEASED',
    `outcome` ENUM('ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'DUPLICATE_CLIENT_ORDER_ID', 'PRE_DISPATCH_FAILURE') NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `live_practical_mutation_lease_certificate_key`(`certificate_id`),
    INDEX `live_practical_mutation_lease_account_idx`(`account_id`),
    UNIQUE INDEX `live_practical_mutation_lease_lease_certificate_key`(`lease_id`, `certificate_id`),
    UNIQUE INDEX `live_practical_mutation_lease_fence_binding_key`(`lease_id`, `certificate_id`, `account_id`, `action`, `runtime_epoch`, `reconciliation_generation`),
    UNIQUE INDEX `live_practical_mutation_lease_certificate_binding_key`(`certificate_id`, `account_id`, `runtime_epoch`, `reconciliation_generation`),
    PRIMARY KEY (`lease_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_recovery_episode` (
    `episode_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `started_at_ms` BIGINT NOT NULL,
    `ended_at_ms` BIGINT NULL,
    `start_cause` VARCHAR(64) NOT NULL,
    `status` ENUM('OPEN', 'CERTIFIED', 'ESCALATED_TO_MANUAL_REVIEW') NOT NULL DEFAULT 'OPEN',
    `runtime_epoch` VARCHAR(64) NOT NULL,
    `reconciliation_generation` INTEGER NULL,
    `certified_certificate_id` CHAR(64) NULL,
    `review_episode_id` VARCHAR(64) NULL,
    `opened_by_resolution_id` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `live_practical_recovery_episode_certificate_key`(`certified_certificate_id`),
    UNIQUE INDEX `live_practical_recovery_episode_review_key`(`review_episode_id`),
    INDEX `live_practical_recovery_episode_account_idx`(`account_id`, `started_at_ms`),
    PRIMARY KEY (`episode_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_review_episode` (
    `review_episode_id` VARCHAR(64) NOT NULL,
    `account_id` VARCHAR(128) NOT NULL,
    `kind` ENUM('INVALIDATION', 'MALFORMED_STATE') NOT NULL DEFAULT 'INVALIDATION',
    `entered_at_ms` BIGINT NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `malformed_problem` VARCHAR(64) NULL,
    `runtime_epoch` VARCHAR(64) NOT NULL,
    `status` ENUM('OPEN', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `resolved_at_ms` BIGINT NULL,
    `resolution_id` VARCHAR(128) NULL,
    `resolution_asserted_by` VARCHAR(128) NULL,
    `resolution_note` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `live_practical_review_episode_resolution_key`(`resolution_id`),
    INDEX `live_practical_review_episode_account_idx`(`account_id`, `entered_at_ms`),
    PRIMARY KEY (`review_episode_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `live_practical_malformed_latch` (
    `account_id` VARCHAR(128) NOT NULL,
    `current_review_episode_id` VARCHAR(64) NULL,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `live_practical_malformed_latch_review_episode_key`(`current_review_episode_id`),
    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `live_practical_account_state` ADD CONSTRAINT `live_practical_account_state_recovery_episode_fkey` FOREIGN KEY (`current_recovery_episode_id`) REFERENCES `live_practical_recovery_episode`(`episode_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_account_state` ADD CONSTRAINT `live_practical_account_state_review_episode_fkey` FOREIGN KEY (`current_review_episode_id`) REFERENCES `live_practical_review_episode`(`review_episode_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_account_state` ADD CONSTRAINT `live_practical_account_state_certificate_fkey` FOREIGN KEY (`current_certificate_id`) REFERENCES `live_practical_certificate`(`certificate_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_account_fence` ADD CONSTRAINT `live_practical_account_fence_account_fkey` FOREIGN KEY (`account_id`) REFERENCES `live_practical_account_state`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_account_fence` ADD CONSTRAINT `live_practical_account_fence_lease_fkey` FOREIGN KEY (`lease_id`, `certificate_id`, `account_id`, `lease_action`, `runtime_epoch`, `reconciliation_generation`) REFERENCES `live_practical_mutation_lease`(`lease_id`, `certificate_id`, `account_id`, `action`, `runtime_epoch`, `reconciliation_generation`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_certificate` ADD CONSTRAINT `live_practical_certificate_account_fkey` FOREIGN KEY (`account_id`) REFERENCES `live_practical_account_state`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_mutation_lease` ADD CONSTRAINT `live_practical_mutation_lease_account_fkey` FOREIGN KEY (`account_id`) REFERENCES `live_practical_account_state`(`account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_mutation_lease` ADD CONSTRAINT `live_practical_mutation_lease_certificate_fkey` FOREIGN KEY (`certificate_id`, `account_id`, `runtime_epoch`, `reconciliation_generation`) REFERENCES `live_practical_certificate`(`certificate_id`, `account_id`, `runtime_epoch`, `reconciliation_generation`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_recovery_episode` ADD CONSTRAINT `live_practical_recovery_episode_certificate_fkey` FOREIGN KEY (`certified_certificate_id`) REFERENCES `live_practical_certificate`(`certificate_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_recovery_episode` ADD CONSTRAINT `live_practical_recovery_episode_review_fkey` FOREIGN KEY (`review_episode_id`) REFERENCES `live_practical_review_episode`(`review_episode_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `live_practical_malformed_latch` ADD CONSTRAINT `live_practical_malformed_latch_review_episode_fkey` FOREIGN KEY (`current_review_episode_id`) REFERENCES `live_practical_review_episode`(`review_episode_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddCheckConstraint (Phase 18B Stage 1B1 invariants)
ALTER TABLE `live_practical_account_state`
    ADD CONSTRAINT `live_practical_account_state_revision_chk` CHECK (`revision` >= 0),
    ADD CONSTRAINT `live_practical_account_state_recovery_chk` CHECK ((`state` IN ('QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE')) = (`current_recovery_episode_id` IS NOT NULL)),
    ADD CONSTRAINT `live_practical_account_state_review_chk` CHECK ((`state` = 'MANUAL_REVIEW_REQUIRED') = (`current_review_episode_id` IS NOT NULL)),
    ADD CONSTRAINT `live_practical_account_state_certificate_chk` CHECK ((`state` = 'CERTIFIED_IDLE') = (`current_certificate_id` IS NOT NULL));

-- AddCheckConstraint
ALTER TABLE `live_practical_account_fence`
    ADD CONSTRAINT `live_practical_account_fence_revision_chk` CHECK (`revision` >= 0),
    ADD CONSTRAINT `live_practical_account_fence_generation_chk` CHECK (`reconciliation_generation` >= 0),
    ADD CONSTRAINT `live_practical_account_fence_mode_chk` CHECK (
        (`mode` = 'IDLE' AND `run_id` IS NULL AND `lease_id` IS NULL AND `certificate_id` IS NULL AND `lease_action` IS NULL)
        OR (`mode` = 'CERTIFYING' AND `run_id` IS NOT NULL AND `lease_id` IS NULL AND `certificate_id` IS NULL AND `lease_action` IS NULL)
        OR (`mode` = 'MUTATION_LEASED' AND `run_id` IS NULL AND `lease_id` IS NOT NULL AND `certificate_id` IS NOT NULL AND `lease_action` IS NOT NULL)
    );

-- AddCheckConstraint
ALTER TABLE `live_practical_certificate`
    ADD CONSTRAINT `live_practical_certificate_generation_chk` CHECK (`reconciliation_generation` >= 1),
    ADD CONSTRAINT `live_practical_certificate_stream_chk` CHECK (`stream_incarnation` >= 1),
    ADD CONSTRAINT `live_practical_certificate_window_chk` CHECK (`issued_at_ms` >= 0 AND `expires_at_ms` > `issued_at_ms`),
    ADD CONSTRAINT `live_practical_certificate_terminal_at_chk` CHECK ((`status` = 'ISSUED') = (`terminal_at_ms` IS NULL)),
    ADD CONSTRAINT `live_practical_certificate_terminal_reason_chk` CHECK ((`status` IN ('EXPIRED', 'REVOKED')) = (`terminal_reason` IS NOT NULL)),
    ADD CONSTRAINT `live_practical_certificate_expired_reason_chk` CHECK (`status` <> 'EXPIRED' OR `terminal_reason` = 'CERTIFICATE_EXPIRED');

-- AddCheckConstraint
ALTER TABLE `live_practical_mutation_lease`
    ADD CONSTRAINT `live_practical_mutation_lease_generation_chk` CHECK (`reconciliation_generation` >= 1),
    ADD CONSTRAINT `live_practical_mutation_lease_not_armed_chk` CHECK (`armed_at_ms` IS NULL),
    ADD CONSTRAINT `live_practical_mutation_lease_completed_chk` CHECK ((`status` = 'LEASED') = (`completed_at_ms` IS NULL)),
    ADD CONSTRAINT `live_practical_mutation_lease_outcome_chk` CHECK ((`status` = 'LEASED') = (`outcome` IS NULL));

-- AddCheckConstraint
ALTER TABLE `live_practical_recovery_episode`
    ADD CONSTRAINT `live_practical_recovery_episode_ended_chk` CHECK ((`status` = 'OPEN') = (`ended_at_ms` IS NULL)),
    ADD CONSTRAINT `live_practical_recovery_episode_certified_chk` CHECK ((`status` = 'CERTIFIED') = (`certified_certificate_id` IS NOT NULL)),
    ADD CONSTRAINT `live_practical_recovery_episode_escalated_chk` CHECK ((`status` = 'ESCALATED_TO_MANUAL_REVIEW') = (`review_episode_id` IS NOT NULL));

-- AddCheckConstraint
ALTER TABLE `live_practical_review_episode`
    ADD CONSTRAINT `live_practical_review_episode_resolved_at_chk` CHECK ((`status` = 'OPEN') = (`resolved_at_ms` IS NULL)),
    ADD CONSTRAINT `live_practical_review_episode_resolution_chk` CHECK ((`status` = 'OPEN') = (`resolution_id` IS NULL)),
    ADD CONSTRAINT `live_practical_review_episode_asserted_by_chk` CHECK ((`status` = 'OPEN') = (`resolution_asserted_by` IS NULL)),
    ADD CONSTRAINT `live_practical_review_episode_note_chk` CHECK ((`status` = 'OPEN') = (`resolution_note` IS NULL));

-- AddCheckConstraint (malformed-state latch)
ALTER TABLE `live_practical_review_episode`
    ADD CONSTRAINT `live_practical_review_episode_kind_reason_chk` CHECK ((`kind` = 'MALFORMED_STATE') = (`reason` = 'DURABLE_STATE_MALFORMED')),
    ADD CONSTRAINT `live_practical_review_episode_kind_problem_chk` CHECK ((`kind` = 'MALFORMED_STATE') = (`malformed_problem` IS NOT NULL));

-- AddCheckConstraint (an INVALIDATION review episode is entered only for a
-- MANUAL_REVIEW-severity Stage 1A reason; this list is pinned to the Stage 1A
-- severity table by an architecture test)
ALTER TABLE `live_practical_review_episode`
    ADD CONSTRAINT `live_practical_review_episode_invalidation_reason_chk` CHECK (`kind` <> 'INVALIDATION' OR `reason` IN (
        'ACCOUNT_IDENTITY_MISMATCH', 'POST_MUTATION_MISMATCH', 'CLIENT_ORDER_ID_MULTIPLE_MATCHES', 'ORPHAN_ORDER', 'UNEXPLAINED_POSITION',
        'VENUE_INITIATED_CHANGE', 'ECONOMICS_MISMATCH', 'ORDER_IDENTITY_CONFLICT', 'UNKNOWN_VENUE_STATUS', 'RECOVERY_ESCALATION_THRESHOLD'
    ));

-- AddCheckConstraint
ALTER TABLE `live_practical_malformed_latch`
    ADD CONSTRAINT `live_practical_malformed_latch_revision_chk` CHECK (`revision` >= 0);
