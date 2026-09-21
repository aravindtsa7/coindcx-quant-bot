import { describe, expect, it } from 'vitest';
import { requireAuthoritativeLivePosition } from '../../../../src/execution/live/position-ownership';
import { InMemoryLiveExecutionRepository, LIVE_ACCOUNT } from './helpers';

const PAIR = 'B-BTC_USDT';

describe('Phase17 production CLOSE position dependency', () => {
  it('fails with the stable missing-position fault before any mutation-capable dependency is involved', async () => {
    const repository = new InMemoryLiveExecutionRepository();
    await expect(requireAuthoritativeLivePosition(repository, LIVE_ACCOUNT, PAIR)).rejects.toMatchObject({
      code: 'LIVE_POSITION_NOT_AVAILABLE',
      details: { accountId: LIVE_ACCOUNT, pair: PAIR },
    });
  });

  it('returns exact seeded durable ownership without inferring or rewriting it', async () => {
    const repository = new InMemoryLiveExecutionRepository();
    const position = {
      accountId: LIVE_ACCOUNT, pair: PAIR, positionInstanceId: 'position-close-1', positionRevision: 4,
      side: 'LONG' as const, ownedQuantity: '10', instrumentSpecSnapshotId: 'instrument-1',
      ownerStrategyInstanceId: 'strategy-instance-1', ownerStrategyId: 'EMA_TREND',
      ownerStrategyVersion: '1.0.0', ownerParameterHash: 'a'.repeat(64),
    };
    repository.seedPositionOwnership(position);
    await expect(requireAuthoritativeLivePosition(repository, LIVE_ACCOUNT, PAIR)).resolves.toEqual(position);
  });
});
