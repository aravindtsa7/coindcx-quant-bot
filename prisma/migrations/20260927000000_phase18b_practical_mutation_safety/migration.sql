-- Phase 18B Stage 1B2: practical mutation-safety durable lease shape.
--
-- Forward-only and additive, except for exactly ONE lifted constraint: the
-- Stage 1B1 "never armed" CHECK (`live_practical_mutation_lease_not_armed_chk`)
-- is dropped in the SAME statement that adds its strict Stage 1B2
-- replacements, so there is no statement boundary at which arming is
-- permitted without the coupling rules below. No column, table, index,
-- foreign key, or other constraint is dropped, renamed, or modified, and
-- nothing is backfilled: every existing lease stays an UNBOUND Stage 1B1
-- lease (all binding columns NULL, never armed).
--
-- Durable storage only. Nothing in this migration authorizes, arms, or
-- dispatches a mutation, and nothing here represents Phase 18 account
-- continuity.
--
-- A lease has exactly one of two closed shapes (CHECK-enforced; the
-- repository re-validates every read and never repairs a row):
--   * UNBOUND (Stage 1B1 bookkeeping): intent_id, client_order_id, and
--     cancel_generation all NULL. It can NEVER be armed.
--   * ORDER-BOUND (Stage 1B2): all three set; action CANCEL only (OPEN and
--     CLOSE are never order-bound); cancel_generation >= 1 names the ONE
--     Phase 17 cancel claim the lease owns; armed at most once, never before
--     it was created; completed never before it was armed or, if it was
--     never armed, never before it was created. A completed
--     UNARMED order-bound lease can only record PRE_DISPATCH_FAILURE (nothing
--     can have reached the wire); an ARMED one records ACCEPTED, REJECTED,
--     AMBIGUOUS, or PRE_DISPATCH_FAILURE (DUPLICATE_CLIENT_ORDER_ID is a
--     create-only outcome and never valid for a cancel).
--
-- ONE STRUCTURAL ORDER BINDING. An order-bound lease references exactly one
-- live_order row through ONE composite foreign key on
-- (intent_id, client_order_id, account_id). Independent single-column keys
-- are deliberately NOT used: each could match a different order. The
-- referenced composite UNIQUE index on live_order is new and purely
-- additive; intent_id remains its primary key and client_order_id keeps its
-- own UNIQUE index, both unchanged. Under this case-insensitive, pad-space
-- collation the key compares case-insensitively, so it is defense in depth
-- only: the application compares account, intent, and client order id with
-- exact string equality on every authoritative read. An unbound lease has
-- NULL key columns and is not checked by the foreign key.
--
-- UNIQUE (intent_id, cancel_generation): at most one lease per Phase 17
-- cancel claim. The existing UNIQUE (certificate_id) still allows at most one
-- lease per certificate.
--
-- Secrecy: no credential, signature, raw provider identity, or provider
-- payload is stored.

-- AlterTable
ALTER TABLE `live_practical_mutation_lease` ADD COLUMN `cancel_generation` INTEGER NULL;

-- CreateIndex
CREATE UNIQUE INDEX `live_order_practical_binding_key` ON `live_order`(`intent_id`, `client_order_id`, `account_id`);

-- CreateIndex
CREATE INDEX `live_practical_mutation_lease_order_binding_idx` ON `live_practical_mutation_lease`(`intent_id`, `client_order_id`, `account_id`);

-- CreateIndex
CREATE UNIQUE INDEX `live_practical_mutation_lease_intent_cancel_key` ON `live_practical_mutation_lease`(`intent_id`, `cancel_generation`);

-- AddForeignKey
ALTER TABLE `live_practical_mutation_lease` ADD CONSTRAINT `live_practical_mutation_lease_order_fkey` FOREIGN KEY (`intent_id`, `client_order_id`, `account_id`) REFERENCES `live_order`(`intent_id`, `client_order_id`, `account_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ReplaceCheckConstraint (Phase 18B Stage 1B2: lift ONLY "never armed", in the same statement as its strict replacements)
ALTER TABLE `live_practical_mutation_lease`
    DROP CHECK `live_practical_mutation_lease_not_armed_chk`,
    ADD CONSTRAINT `live_practical_mutation_lease_binding_chk` CHECK ((`intent_id` IS NULL) = (`client_order_id` IS NULL) AND (`intent_id` IS NULL) = (`cancel_generation` IS NULL)),
    ADD CONSTRAINT `live_practical_mutation_lease_bound_action_chk` CHECK (`intent_id` IS NULL OR `action` = 'CANCEL'),
    ADD CONSTRAINT `live_practical_mutation_lease_cancel_generation_chk` CHECK (`cancel_generation` IS NULL OR `cancel_generation` >= 1),
    ADD CONSTRAINT `live_practical_mutation_lease_armed_bound_chk` CHECK (`armed_at_ms` IS NULL OR `intent_id` IS NOT NULL),
    ADD CONSTRAINT `live_practical_mutation_lease_armed_time_chk` CHECK (`armed_at_ms` IS NULL OR `armed_at_ms` >= `created_at_ms`),
    ADD CONSTRAINT `live_practical_mutation_lease_bound_completed_time_chk` CHECK (`intent_id` IS NULL OR `completed_at_ms` IS NULL OR `completed_at_ms` >= COALESCE(`armed_at_ms`, `created_at_ms`)),
    ADD CONSTRAINT `live_practical_mutation_lease_bound_outcome_chk` CHECK (
        `intent_id` IS NULL
        OR `outcome` IS NULL
        OR (`armed_at_ms` IS NULL AND `outcome` = 'PRE_DISPATCH_FAILURE')
        OR (`armed_at_ms` IS NOT NULL AND `outcome` IN ('ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE'))
    );
