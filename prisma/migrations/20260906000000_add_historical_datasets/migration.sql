CREATE TABLE `historical_datasets` (
    `dataset_id` VARCHAR(64) NOT NULL,
    `schema_version` INTEGER NOT NULL,
    `venue` VARCHAR(32) NOT NULL,
    `market` VARCHAR(32) NOT NULL,
    `resolution_minutes` INTEGER NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `from_inclusive_ms` BIGINT NOT NULL,
    `to_exclusive_ms` BIGINT NOT NULL,
    `expected_candle_count` INTEGER NOT NULL,
    `actual_candle_count` INTEGER NOT NULL,
    `first_open_time_ms` BIGINT NOT NULL,
    `last_open_time_ms` BIGINT NOT NULL,
    `content_sha256` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`dataset_id`),
    UNIQUE INDEX `historical_datasets_pair_range_unique`(`pair`, `from_inclusive_ms`, `to_exclusive_ms`),
    INDEX `historical_datasets_pair_idx`(`pair`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
