import { describe, expect, it } from 'vitest';
import { canonicalJson, type BacktestEvent, type BacktestFundingEvent } from '../../../../src/backtest';
import { InMemoryMatrixCompletedResultCache, type FinalizedStrategyCoinMatrixPlan, type MatrixCompletedResultCache, type MatrixPairExecutionResources } from '../../../../src/research/strategy-coin-matrix';
import { executeWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/executor';
import { planWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/planner';
import { BASE, ControlledGitVerifier, matrixInput, registry } from './helpers';
import { fundedResource, fundingEvent, fundingSource, reloadFunding } from './audit-b2-helpers';

const MINUTE = 60_000;
const START = BASE + 12 * MINUTE;
const END = BASE + 20 * MINUTE;
function events(rate = '0.01') {
  return [START - MINUTE, START, START + MINUTE, END, END + MINUTE].map((time) => fundingEvent(time, rate));
}
async function plan(pairResources: readonly MatrixPairExecutionResources[], start = START, end = END) {
  const dependencies = { registry: registry(), pairResources };
  const input = { ...matrixInput(pairResources, false), researchWindow: { analysisStartMs: start, analysisEndExclusiveMs: end } };
  return { finalized: await planWithGitSourceVerifier(input, dependencies, new ControlledGitVerifier()), dependencies };
}
async function execute(fixture: Awaited<ReturnType<typeof plan>>, workerCount = 1, cache?: MatrixCompletedResultCache) {
  const observed: BacktestEvent[] = [];
  const result = await executeWithGitSourceVerifier(fixture.finalized, { ...fixture.dependencies, ...(cache ? { cache } : {}) }, {
    workerCount, eventSinkFactory: () => ({ write: (event) => { observed.push(event); } }),
  }, new ControlledGitVerifier());
  expect(result.status).toBe('COMPLETED');
  const cellResults = result.cellResults.map((cell) => {
    if (cell.status !== 'COMPLETED') throw new Error(cell.failure.message);
    return cell;
  });
  return { result: { ...result, cellResults }, observed };
}

describe('Audit B2 pair-bound matrix funding slices', () => {
  it('keeps BTC/ETH sources authoritative and excludes warmup/start/future settlements independently of execution order', async () => {
    const pairResources = [fundedResource('BTC-INR', events()), fundedResource('ETH-INR', events('-0.02'))];
    const fixture = await plan(pairResources);
    const serial = await execute(fixture); const parallel = await execute(await plan([...pairResources].reverse()), 2);
    expect(canonicalJson(parallel.result)).toBe(canonicalJson(serial.result));
    for (const cell of serial.result.cellResults) {
      expect(cell.status).toBe('COMPLETED');
      expect(cell.outcome?.financialSummary.fundingPnl.value).toBe(cell.pair === 'BTC-INR' ? '-0.02' : '0.4');
      const applied = serial.observed.filter((event) => event.runId === cell.runId && event.type === 'FUNDING_APPLIED');
      expect(applied.map((event) => event.eventTimeMs)).toEqual([START + MINUTE, END]);
      expect(applied.every((event) => event.entityId.startsWith(`verified-${cell.pair}-funding-v1:`))).toBe(true);
      const binding = fixture.finalized.plan.pairs.find((pair) => pair.pair === cell.pair)?.fundingScheduleBinding;
      expect(binding?.contentSha256).toBe(pairResources.find((resource) => resource.pair === cell.pair)?.fundingSchedule.contentSha256);
    }
    expect(pairResources.map((resource) => resource.fundingSchedule.events.length)).toEqual([5, 5]);
  });

  it('applies a shared adjacent boundary exactly once in genuine backtests despite overlapping warmup', async () => {
    const resource = fundedResource('BTC-INR', [fundingEvent(END)], 32);
    const a = await execute(await plan([resource]));
    const b = await execute(await plan([resource], END, END + 8 * MINUTE));
    expect([...a.observed, ...b.observed].filter((event) => event.type === 'FUNDING_APPLIED')).toHaveLength(1);
    expect(a.result.cellResults[0]?.outcome?.financialSummary.fundingPnl.value).toBe('-0.01');
    expect(b.result.cellResults[0]?.outcome?.financialSummary.fundingPnl.value).toBe('0');
  });

  it('invalidates cell/cache provenance for changed full sources while unchanged slices keep the same Phase9 result', async () => {
    const baseEvents = events();
    const resource = fundedResource('BTC-INR', baseEvents);
    const fixture = await plan([resource]); const baseline = await execute(fixture);
    const future = baseEvents.map((event) => event.fundingTimeMs > END ? fundingEvent(event.fundingTimeMs, '0.010000000000000001') : event);
    const replacement = { ...resource, fundingSchedule: fundingSource(resource.pair, future) };
    const changed = await plan([replacement]);
    expect(changed.finalized.matrixPlanId).not.toBe(fixture.finalized.matrixPlanId);
    expect(changed.finalized.cells[0]?.matrixCellId).not.toBe(fixture.finalized.cells[0]?.matrixCellId);
    expect(changed.finalized.cells[0]?.expectedRunId).toBe(fixture.finalized.cells[0]?.expectedRunId);
    const cache = new InMemoryMatrixCompletedResultCache(baseline.result.cellResults);
    expect(cache.get(changed.finalized.cells[0]!.matrixCellId)).toBeNull();
    const fresh = await execute(changed, 1, { get: () => baseline.result.cellResults[0] });
    expect(fresh.observed.length).toBeGreaterThan(0);
    expect(fresh.result.cellResults[0]?.outcome).toEqual(baseline.result.cellResults[0]?.outcome);
    const inside = { ...resource, fundingSchedule: fundingSource(resource.pair, baseEvents.map((event) => event.fundingTimeMs === START + MINUTE ? fundingEvent(event.fundingTimeMs, '0.010000000000000001') : event)) };
    const inWindow = await execute(await plan([inside]));
    expect(inWindow.result.cellResults[0]?.outcome?.financialSummary.fundingPnl.value).toBe('-0.020000000000000001');
    expect(inWindow.result.cellResults[0]?.outcome?.resultSha256).not.toBe(baseline.result.cellResults[0]?.outcome?.resultSha256);
    await expect(executeWithGitSourceVerifier(fixture.finalized, { ...fixture.dependencies, pairResources: [replacement] }, {}, new ControlledGitVerifier())).rejects.toMatchObject({ code: 'RESOURCE_IDENTITY_MISMATCH' });
  });

  it('rejects cross-pair source substitution and malformed out-of-window evidence before execution/cache reuse', async () => {
    const btc = fundedResource('BTC-INR', events()); const eth = fundedResource('ETH-INR', events('-0.02'));
    const fixture = await plan([btc, eth]);
    await expect(executeWithGitSourceVerifier(fixture.finalized, { ...fixture.dependencies, pairResources: [{ ...btc, fundingSchedule: eth.fundingSchedule }, eth] }, {}, new ControlledGitVerifier())).rejects.toMatchObject({ code: 'RESOURCE_IDENTITY_MISMATCH' });
    const invalidEvents: BacktestFundingEvent[] = [...events(), fundingEvent(END + MINUTE)];
    await expect(plan([{ ...btc, fundingSchedule: fundingSource(btc.pair, invalidEvents) }])).rejects.toMatchObject({ code: 'FUNDING_SCHEDULE_INVALID' });
    const tampered = { ...btc, fundingSchedule: { ...btc.fundingSchedule, events: events().map((event) => event.fundingTimeMs > END ? fundingEvent(event.fundingTimeMs, '0.02') : event) } };
    await expect(executeWithGitSourceVerifier(fixture.finalized, { ...fixture.dependencies, pairResources: [tampered, eth] }, {}, new ControlledGitVerifier())).rejects.toMatchObject({ code: 'FUNDING_SCHEDULE_INVALID' });
  });

  it('reconstructs identical effective slices and completed results from serialized plans and authoritative source data', async () => {
    const resource = fundedResource('BTC-INR', events('0.000000000000000001'));
    const fixture = await plan([resource]); const original = await execute(fixture);
    const loaded = JSON.parse(JSON.stringify(fixture.finalized)) as FinalizedStrategyCoinMatrixPlan;
    const restored = { ...resource, fundingSchedule: reloadFunding(resource.fundingSchedule) };
    const replay = await execute({ finalized: loaded, dependencies: { registry: registry(), pairResources: [restored] } });
    expect(replay).toEqual(original);
    expect(restored.fundingSchedule).toEqual(resource.fundingSchedule);
    expect(replay.result.cellResults[0]?.outcome?.financialSummary.fundingPnl.value).toBe('-0.000000000000000002');
  });
});
