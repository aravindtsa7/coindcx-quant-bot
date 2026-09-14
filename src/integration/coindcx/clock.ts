/**
 * Compatibility re-export. The clock abstraction is exchange-neutral and lives
 * at ../../core/time/clock; this file exists only so existing CoinDCX
 * integration-side imports keep working unchanged.
 */
export type { Clock } from '../../core/time/clock';
export { SystemClock, FakeClock } from '../../core/time/clock';
