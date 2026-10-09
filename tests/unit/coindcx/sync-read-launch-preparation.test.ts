import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { inspectLaunchProposal } from '../../../scripts/sync-read-launch/proposal';
import { writeNewJson } from '../../../scripts/sync-read-launch/report-sink';

const ROOT = path.resolve(__dirname, '../../..');
const SPEC = path.join(ROOT, 'docs/launch/m4-orders-positions-proposal.json');
const proposal = () => JSON.parse(fs.readFileSync(SPEC, 'utf8')) as unknown;
const directory = fs.mkdtempSync(path.join(ROOT, '.local/m4-launch-preparation-test-'));
const command = (args: string[]) => {
  const result = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs',
    './scripts/coindcx-sync-read-launch.ts', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 });
  expect(result.stdout, result.stderr || result.error?.message).not.toBe('');
  return { exit: result.status, stderr: result.stderr, result: JSON.parse(result.stdout) as Record<string, unknown> };
};

describe('one explicit M4 launch proposal: offline preparation only', () => {
  it('validates proposed values, statuses, both sides and the maximum count without filling missing real inputs', () => {
    const result = inspectLaunchProposal(proposal());
    expect(result.parametersValid).toBe(true);
    expect(result.configurationValid).toBe(false);
    expect(result.readyToContactProvider).toBe(false);
    expect(result.limiterValidation).toBe('VALID');
    expect(result.orderFilterValidation).toBe('VALID');
    expect(result.unresolvedInputs).toEqual(['account.accountId', 'account.expectedProviderAccountFingerprint', 'budget.connectionId', 'lineage']);
    expect(result.requestBounds).toEqual({ identityReads: 3, pagesPerPass: 6, passesPerCycle: 2, cyclesPerEvaluation: 1, requestsPerEvaluation: 13, maximumRequests: 39 });
    expect(result.preflight?.scopeLabel).toBe('ORDERS_AND_POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION');
    expect(result.preflight?.limitations.some(item => item.code.includes('PRIVATE_STREAM_OBSERVATION_NOT_CONFIGURED'))).toBe(true);
  });

  it('rejects a required transaction component instead of silently deleting it, and rejects unsupported status filters', () => {
    const original = inspectLaunchProposal(proposal()).proposal!;
    const transactions = { ...original, configuration: { ...original.configuration,
      scope: { ...original.configuration.scope, components: ['ORDERS', 'POSITIONS', 'TRANSACTIONS'] } } };
    expect(inspectLaunchProposal(transactions).parametersValid).toBe(false);
    expect(transactions.configuration.scope.components).toContain('TRANSACTIONS');
    const statuses = { ...original, configuration: { ...original.configuration, scope: { ...original.configuration.scope, orderStatuses: ['unsupported'] } } };
    expect(inspectLaunchProposal(statuses).errors).toEqual(['ORDER_FILTER_INVALID:buy', 'ORDER_FILTER_INVALID:sell']);
  });

  it('rejects inconsistent limiter, timeout and share values without changing them', () => {
    const original = inspectLaunchProposal(proposal()).proposal!;
    const invalid = { ...original, configuration: { ...original.configuration,
      budget: { ...original.configuration.budget, campaignShare: { maxStartsPerFairnessWindow: 1 } },
      timeouts: { ...original.configuration.timeouts, readTimeoutMs: 1000 } } };
    expect(inspectLaunchProposal(invalid).errors).toEqual(['SCAN_TIMEOUT_TOO_SHORT', 'EVALUATION_EXCEEDS_PROPOSED_SHARE']);
    const limiter = { ...original, configuration: { ...original.configuration, budget: { ...original.configuration.budget, limiter: {} } } };
    expect(inspectLaunchProposal(limiter).errors).toContain('LIMITER_INVALID:CONFIG_SHAPE');
  });

  it('executes the exact validation and default collect commands; provider composition stays absent and blocked', () => {
    const validation = command(['validate', '--spec', SPEC]);
    expect(validation.exit, validation.stderr).toBe(0);
    expect(validation.result).toMatchObject({ parametersValid: true, configurationValid: false, readyToContactProvider: false });
    const launch = command(['collect', '--spec', SPEC]);
    expect(launch.exit, launch.stderr).toBe(2);
    expect(launch.result).toMatchObject({ outcome: 'REAL_LAUNCH_BLOCKED', providerCompositionImplemented: false, readyToContactProvider: false });
    expect(launch.result['blockers']).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'REQUIRED_INPUT', code: 'CAMPAIGN_STATE_LIFECYCLE_REVIEW_REQUIRED' }),
      expect.objectContaining({ kind: 'REQUIRED_INPUT', code: 'HOST_SECURITY_AND_SUPERVISION_REVIEW_REQUIRED' }),
      expect.objectContaining({ kind: 'AUTHORIZATION', code: 'VALUES_AND_REAL_COLLECTION_NOT_AUTHORIZED' }),
    ]));
  }, 30_000);

  it('exercises that collect path with explicit loopback fixtures and the unchanged numeric proposal', () => {
    const file = path.join(directory, 'loopback-report.json');
    const run = command(['collect', '--spec', SPEC, '--offline-loopback', '--fixture-report', file]);
    expect(run.exit, run.stderr).toBe(0);
    expect(run.result).toMatchObject({ mode: 'OFFLINE_LOOPBACK_FIXTURE_ONLY', readyToContactProvider: false, realProvenanceSatisfied: false,
      productionBudgetBound: false, productionStateInitialized: false, limiterPacingExercised: false, parametersChanged: false,
      requestCount: 39, delivery: 'WRITTEN', permits: { acquired: 39, started: 39, completed: 39, released: 0 } });
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(report.scopeLabel).toBe('ORDERS_AND_POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION');
    expect(report.evaluations).toHaveLength(3);
    expect(report.evaluations.every((entry: { identity: { outcome: string }; stream: { observation: string }; result: { status: string } }) =>
      entry.identity.outcome === 'VERIFIED' && entry.stream.observation === 'UNKNOWN' && entry.result.status === 'REVOKED_CYCLE_LIMIT_REACHED')).toBe(true);
    expect(Object.values(report.grants).every(value => value === false)).toBe(true);
    const requests = run.result['requests'] as Array<{ path: string; body: Record<string, unknown> }>;
    expect(requests[0]!.path).toBe('/exchange/v1/users/info');
    expect(requests.filter(request => request.path.endsWith('/users/info'))).toHaveLength(3);
    expect(new Set(requests.map(request => request.path))).toEqual(new Set(['/exchange/v1/users/info', '/exchange/v1/derivatives/futures/orders', '/exchange/v1/derivatives/futures/positions']));
    expect(new Set(requests.filter(request => request.path.endsWith('/orders')).map(request => request.body['side']))).toEqual(new Set(['buy', 'sell']));
    expect(requests.filter(request => request.path.endsWith('/orders')).every(request => request.body['status'] === inspectLaunchProposal(proposal()).proposal!.configuration.scope.orderStatuses.join(','))).toBe(true);
    expect(requests.filter(request => !request.path.endsWith('/users/info')).every(request => ['1', '2'].includes(String(request.body['page'])) && request.body['size'] === '25')).toBe(true);
    expect(fs.existsSync(inspectLaunchProposal(proposal()).proposal!.configuration.reportDestination.path)).toBe(false);
  }, 30_000);

  it('an identity mismatch on the same invocation stops before every account scan', () => {
    const run = command(['collect', '--spec', SPEC, '--offline-loopback', '--fixture-identity-mismatch', '--fixture-report', path.join(directory, 'mismatch-report.json')]);
    expect(run.exit, run.stderr).toBe(0);
    expect(run.result).toMatchObject({ requestCount: 1, report: { stopReason: 'ACCOUNT_IDENTITY_MISMATCH', observations: { evaluations: 1, convergedEvaluations: 0 } } });
    expect((run.result['requests'] as Array<{ path: string }>).map(request => request.path)).toEqual(['/exchange/v1/users/info']);
  }, 30_000);

  it('the report sink refuses overwriting and the default CLI cannot read credentials or start a coordinator', () => {
    const file = path.join(directory, 'sink.json');
    writeNewJson(file, { preserved: true });
    expect(() => writeNewJson(file, { replaced: true })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ preserved: true });
    const cli = fs.readFileSync(path.join(ROOT, 'scripts/coindcx-sync-read-launch.ts'), 'utf8');
    expect(cli).not.toMatch(/dotenv|process\.env|apiKey|apiSecret|new CoinDcxClient|RateLimitCoordinator|bindProduction/);
    const fixture = fs.readFileSync(path.join(ROOT, 'scripts/sync-read-launch/loopback-fixture.ts'), 'utf8');
    expect(fixture).toContain("server.listen(0, '127.0.0.1', resolve)");
    expect(fixture).not.toMatch(/ensureFixtureProductionReadBudget|bindProduction|initializeDisposable|createOrder|cancelOrder|register\w*Hook/);
  });
});
