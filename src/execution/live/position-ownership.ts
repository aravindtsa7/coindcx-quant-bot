import { LiveExecutionError } from './errors';
import type { LiveExecutionRepository, LivePositionOwnershipRecord } from './repository';

/**
 * Phase17 consumes durable live-position truth but does not establish it.
 * Phase18 owns the venue reconciliation/writer that can make this succeed in
 * production. Absence is an explicit refusal, never a fabricated flat/position.
 */
export async function requireAuthoritativeLivePosition(
  repository: LiveExecutionRepository,
  accountId: string,
  pair: string,
): Promise<LivePositionOwnershipRecord> {
  const position = await repository.loadPositionOwnership(accountId, pair);
  if (position === null) {
    throw new LiveExecutionError(
      'LIVE_POSITION_NOT_AVAILABLE',
      'Authoritative durable live position state is unavailable; Phase18 reconciliation must establish it before CLOSE',
      { details: { accountId, pair } },
    );
  }
  return position;
}
