import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPracticalShadowCli } from '../../../../../src/integration/coindcx/live/practical-shadow-runtime';
import { PracticalShadowCampaignRunner } from '../../../../../src/execution/live/practical-shadow/campaign';
import { CoinDcxPrivateAccountStream } from '../../../../../src/integration/coindcx/websocket/private-stream';
import { COMMIT_A, FINGERPRINT } from './support';

afterEach(() => vi.restoreAllMocks());
const env = { LIVE_PRACTICAL_SHADOW_ENABLED: 'true', COINDCX_API_KEY: 'dummy-key', COINDCX_API_SECRET: 'dummy-secret', COINDCX_LIVE_ACCOUNT_ID: 'test-account', COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: FINGERPRINT, LIVE_PRACTICAL_SHADOW_CADENCE_MS: '300000' };
const prisma = new Proxy({}, { get: () => { throw new Error('NO_DATABASE_ACCESS'); } }) as never;
const config = { sessionId: '12345678-1234-4123-8123-123456789abc', sourceCommit: COMMIT_A };

describe('optional diagnostics cannot change the original shadow outcome or V1 persistence', () => {
  it.each(['normal', 'factory-error', 'start-error', 'finish-error', 'shadow-error', 'transport-error'] as const)('isolates sidecar hooks: %s', async mode => {
    const order: string[] = []; const output: string[] = [];
    vi.spyOn(PracticalShadowCampaignRunner.prototype, 'open').mockResolvedValue({ kind: 'STARTED', campaign: { campaignId: 'test-campaign' }, abortedEvaluations: 0 } as never);
    vi.spyOn(PracticalShadowCampaignRunner.prototype, 'runLoop').mockImplementation(async () => { order.push('runLoop'); if (mode === 'shadow-error') throw new Error('ORIGINAL_SHADOW_FAILURE'); return 2; });
    vi.spyOn(CoinDcxPrivateAccountStream.prototype, 'start').mockImplementation(async () => { order.push('transport.start'); if (mode === 'transport-error') throw new Error('ORIGINAL_TRANSPORT_FAILURE'); });
    vi.spyOn(CoinDcxPrivateAccountStream.prototype, 'stop').mockImplementation(() => { order.push('transport.stop'); });
    const factory = vi.fn((commit: string) => {
      expect(commit).toBe(COMMIT_A); if (mode === 'factory-error') throw new Error('PRIVATE_MARKER');
      return { config, start: () => { order.push('diagnostics.start'); if (mode === 'start-error') throw new Error('PRIVATE_MARKER'); }, finish: async () => { order.push('diagnostics.finish'); if (mode === 'finish-error') throw new Error('PRIVATE_MARKER'); } };
    });
    const pending = runPracticalShadowCli(['start'], { env, prisma, sourceProbe: () => ({ head: COMMIT_A, status: '' }), io: { out: line => output.push(line), err: line => output.push(line) }, diagnosticsFactory: factory });
    if (mode === 'shadow-error') await expect(pending).rejects.toThrow('ORIGINAL_SHADOW_FAILURE');
    else if (mode === 'transport-error') await expect(pending).rejects.toThrow('ORIGINAL_TRANSPORT_FAILURE');
    else expect(await pending).toBe(0);
    expect(output.join('\n')).not.toContain('PRIVATE_MARKER');
    if (mode !== 'factory-error') {
      expect(order[0]).toBe('diagnostics.start'); expect(order.at(-1)).toBe('diagnostics.finish');
      if (mode !== 'transport-error') expect(order.indexOf('transport.stop')).toBeLessThan(order.indexOf('diagnostics.finish'));
      else expect(order).not.toContain('transport.stop'); // Preserve the original failed-start path.
    }
  });
  it('never constructs diagnostics on disabled/dirty start or on non-start commands', async () => {
    const factory = vi.fn(() => { throw new Error('MUST_NOT_CONSTRUCT'); });
    for (const [argv, suppliedEnv, status] of [[['start'], {}, ''], [['start'], env, ' M fake.ts'], [['stop'], env, ' M fake.ts'], [['unknown'], env, '']] as const) {
      expect(await runPracticalShadowCli(argv, { env: suppliedEnv, prisma, sourceProbe: () => ({ head: COMMIT_A, status }), io: { out: () => {}, err: () => {} }, diagnosticsFactory: factory })).toBe(2);
    }
    expect(factory).not.toHaveBeenCalled();
  });
  it('bounds a hung final observer after the existing transport shutdown', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(PracticalShadowCampaignRunner.prototype, 'open').mockResolvedValue({ kind: 'STARTED', campaign: { campaignId: 'test' }, abortedEvaluations: 0 } as never);
      vi.spyOn(PracticalShadowCampaignRunner.prototype, 'runLoop').mockResolvedValue(1);
      vi.spyOn(CoinDcxPrivateAccountStream.prototype, 'start').mockResolvedValue();
      const stop = vi.spyOn(CoinDcxPrivateAccountStream.prototype, 'stop').mockImplementation(() => {}); const warnings: string[] = [];
      const pending = runPracticalShadowCli(['start'], { env, prisma, sourceProbe: () => ({ head: COMMIT_A, status: '' }), io: { out: () => {}, err: line => warnings.push(line) }, diagnosticsFactory: () => ({ config, start: () => {}, finish: () => new Promise(() => {}) }) });
      await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBe(0); expect(stop).toHaveBeenCalledOnce(); expect(warnings).toEqual(['[private-stream-diagnostics] FINAL_FLUSH_TIMEOUT']);
    } finally { vi.useRealTimers(); }
  });
});
