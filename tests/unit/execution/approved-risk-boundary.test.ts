import { describe, expect, it } from 'vitest';
import { paperDecimal } from '../../../src/execution/decimal';
import { executionApprovedRiskIssue } from '../../../src/execution/persistence/execution-engine';

describe('P14-E exact approved-risk execution boundary', () => {
  it('allows actual notional and margin exactly equal to their approvals', () => {
    expect(executionApprovedRiskIssue(paperDecimal('100.000000000000000001'), paperDecimal('20.000000000000000001'), '100.000000000000000001', '20.000000000000000001')).toBeNull();
  });

  it('rejects actual notional one minimal Decimal unit above approval', () => {
    expect(executionApprovedRiskIssue(paperDecimal('100.000000000000000001'), paperDecimal('20'), '100', '21')).toBe('EXECUTION_EXCEEDS_APPROVED_NOTIONAL');
  });

  it('rejects margin above approval independently when notional remains within its cap', () => {
    expect(executionApprovedRiskIssue(paperDecimal('99'), paperDecimal('20.000000000000000001'), '100', '20')).toBe('EXECUTION_EXCEEDS_APPROVED_MARGIN');
  });
});
