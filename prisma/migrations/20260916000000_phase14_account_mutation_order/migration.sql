-- No inferred/backfilled ordering: provider timestamps are market time, not account order.
ALTER TABLE `paper_fill`
  ADD COLUMN `account_mutation_revision` BIGINT NULL,
  ADD UNIQUE INDEX `paper_fill_account_mutation_revision_unique` (`account_id`, `account_mutation_revision`);
