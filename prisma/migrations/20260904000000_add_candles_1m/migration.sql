-- CreateTable
CREATE TABLE `candles_1m` (
    `id` VARCHAR(191) NOT NULL,
    `pair` VARCHAR(64) NOT NULL,
    `open_time_ms` BIGINT NOT NULL,
    `close_time_ms` BIGINT NOT NULL,
    `open` DECIMAL(36, 18) NOT NULL,
    `high` DECIMAL(36, 18) NOT NULL,
    `low` DECIMAL(36, 18) NOT NULL,
    `close` DECIMAL(36, 18) NOT NULL,
    `volume` DECIMAL(36, 18) NOT NULL,
    `quote_volume` DECIMAL(36, 18) NULL,
    `source` VARCHAR(32) NOT NULL,
    `provider_event_time_ms` BIGINT NULL,
    `generation_id` INTEGER NULL,
    `finalized_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `candles_1m_pair_open_time_ms_unique`(`pair`, `open_time_ms`),
    INDEX `candles_1m_pair_open_time_ms_idx`(`pair`, `open_time_ms`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
