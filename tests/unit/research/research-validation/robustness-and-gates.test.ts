import { describe, expect, it } from 'vitest';
import { calculateDeflatedSharpeAnalysis, calculateDeflatedSharpeZ } from '../../../../src/research/research-validation/deflated-sharpe';
import { degradation, foldVerdict, subjectVerdict } from '../../../../src/research/research-validation/gates';
import { deriveMonteCarloSeed, DeterministicCounterPrng, deterministicPermutation, monteCarloCounterBlock, runMonteCarlo, unbiasedIndex } from '../../../../src/research/research-validation/monte-carlo';

describe('Phase 12 deterministic robustness engines', () => {
  it('freezes the HMAC/counter/Fisher-Yates vector and is repeatable', () => {
    const plan = 'a'.repeat(64); const subject = 'b'.repeat(64); const seed = deriveMonteCarloSeed(plan, subject); const block = monteCarloCounterBlock(seed, 0); const prng = new DeterministicCounterPrng(seed);
    const words = Array.from({ length: 4 }, () => prng.nextUint32()); const permutation = deterministicPermutation(['1', '2', '3', '4'], new DeterministicCounterPrng(seed));
    expect(seed.toString('hex')).toBe('b6fa331b088d38f2b31baf1a93993d466515ec1ac75fd9e085d2d31a970047e0');
    expect(block.toString('hex')).toBe('702dc6c50ad74c872cf4604727e2876725f76c2964e3daa5b64d8f99cd8056b4');
    expect(words).toEqual([1882048197, 181881991, 754212935, 669157223]); expect(permutation).toEqual(['1', '3', '4', '2']);
    expect(deterministicPermutation(['1', '2', '3', '4'], new DeterministicCounterPrng(seed))).toEqual(permutation);
    expect(deriveMonteCarloSeed('c'.repeat(64), subject).toString('hex')).not.toBe(seed.toString('hex'));
    const supplied = [0xffff_ffff, 5]; expect(unbiasedIndex(3, () => supplied.shift() ?? 0)).toBe(2); expect(supplied).toHaveLength(0);
  });
  it('uses the configured percentile and returns typed non-positive equity', () => {
    const config = { policyId: 'P12_MONTE_CARLO_PERMUTATION_V1' as const, simulationCount: 20, adversePercentile: 50, seedDerivationPolicy: 'HMAC_SHA256_V1' as const };
    const first = runMonteCarlo('a'.repeat(64), 'b'.repeat(64), ['0.1', '-0.2', '0.05', '-0.1'], config); const second = runMonteCarlo('a'.repeat(64), 'b'.repeat(64), ['0.1', '-0.2', '0.05', '-0.1'], config);
    expect(first).toEqual(second); expect(first.adversePercentile).toBe(50);
    expect(runMonteCarlo('a'.repeat(64), 'b'.repeat(64), ['-1'], config)).toMatchObject({ status: 'UNDEFINED', reason: 'NON_POSITIVE_SIMULATED_EQUITY' });
  });
  it('handles DSR single-trial, zero dispersion and insufficient samples', () => {
    const returns = ['0.01', '-0.005', '0.02', '-0.01'];
    expect(calculateDeflatedSharpeZ(returns, [returns], '0', 2)).toMatchObject({ status: 'VALUE' });
    expect(calculateDeflatedSharpeZ(returns, [returns, returns], '0', 2)).toMatchObject({ status: 'VALUE' });
    expect(calculateDeflatedSharpeZ(['0.1'], [['0.1']], '0', 2)).toMatchObject({ status: 'INSUFFICIENT_DATA' });
  });
  it('pins the M > 1 logarithmic SR0 branch with non-zero trial dispersion', () => {
    const family = [
      ['0.01', '-0.02', '0.015', '0.005', '-0.01', '0.02', '-0.005', '0.012'],
      ['-0.005', '0.003', '0.002', '-0.004', '0.001', '0.006', '-0.002', '0.004'],
      ['0.02', '0.01', '-0.015', '0.025', '-0.01', '0.005', '0.018', '-0.008'],
    ] as const;
    const result = calculateDeflatedSharpeAnalysis(family[0], family, '0', 2);
    // Independently derived at 80-digit precision from the frozen equations.
    expect(result.sr0).toEqual({ status: 'VALUE', value: '0.109618526852958933' });
    expect(result.deflatedSharpeZ).toEqual({ status: 'VALUE', value: '0.335775155588339433' });
  });
});

describe('Phase 12 gate semantics', () => {
  it('uses the degradation floor and exact verdict precedence', () => {
    expect(degradation({ status: 'VALUE', value: '0.05' }, { status: 'VALUE', value: '-0.05' }, '0.1')).toEqual({ status: 'VALUE', value: '1' });
    expect(degradation({ status: 'VALUE', value: '2' }, { status: 'VALUE', value: '1' }, '0.1')).toEqual({ status: 'VALUE', value: '0.5' });
    expect(foldVerdict([{ gateId: 'x', gateName: 'x', status: 'UNAVAILABLE', observedValue: null, thresholdValue: null }])).toBe('INSUFFICIENT_EVIDENCE');
    expect(subjectVerdict([{ gateId: 'x', gateName: 'x', status: 'UNAVAILABLE', observedValue: null, thresholdValue: null }, { gateId: 'y', gateName: 'y', status: 'FAIL', observedValue: '0', thresholdValue: '1' }])).toBe('FAILED');
    expect(subjectVerdict([{ gateId: 'x', gateName: 'x', status: 'DISABLED', observedValue: null, thresholdValue: null }])).toBe('PASSED');
  });
});
