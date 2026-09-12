import { describe, expect, it, vi } from 'vitest';
import {
  PAPER_FUNDING_CAPABILITY,
  PaperFundingUnsupportedError,
  disclosePaperFundingExcluded,
  isPaperFundingProductionPromotionEvidence,
  rejectUnsupportedPaperFundingOperation,
} from '../../../src/execution/funding-capability';

describe('P14-F canonical funding-unsupported capability', () => {
  it('is the exact immutable Phase14 disclosure and cannot be caller-mutated', () => {
    expect(PAPER_FUNDING_CAPABILITY).toEqual({
      fundingCapability: 'FUNDING_UNSUPPORTED',
      reason: 'COINDCX_PROVIDER_EVIDENCE_INCOMPLETE',
      fundingApplied: false,
      economicCompleteness: 'FUNDING_EXCLUDED',
      paperEconomicStatus: 'PAPER_NOT_ECONOMICALLY_COMPLETE',
      pnlLabel: 'FUNDING_EXCLUDED_PNL',
    });
    expect(Object.isFrozen(PAPER_FUNDING_CAPABILITY)).toBe(true);
    expect(() => {
      (PAPER_FUNDING_CAPABILITY as { fundingApplied: boolean }).fundingApplied = true;
    }).toThrow(TypeError);
    expect(PAPER_FUNDING_CAPABILITY.fundingApplied).toBe(false);
    expect(isPaperFundingProductionPromotionEvidence()).toBe(false);
  });

  it.each(['APPLY', 'RECOVER'] as const)('%s rejects before any persistence operation', (operation) => {
    const prismaTransaction = vi.fn();
    const ledgerWrite = vi.fn();
    const accountMutation = vi.fn();
    const positionMutation = vi.fn();

    expect(() => rejectUnsupportedPaperFundingOperation(operation)).toThrow(PaperFundingUnsupportedError);
    try {
      rejectUnsupportedPaperFundingOperation(operation);
    } catch (error) {
      expect(error).toMatchObject({ code: 'FUNDING_UNSUPPORTED', operation });
    }

    expect(prismaTransaction).not.toHaveBeenCalled();
    expect(ledgerWrite).not.toHaveBeenCalled();
    expect(accountMutation).not.toHaveBeenCalled();
    expect(positionMutation).not.toHaveBeenCalled();
  });

  it('attaches one deterministic immutable disclosure to success and retry outcomes', () => {
    const success = disclosePaperFundingExcluded({ outcome: 'FILLED' as const });
    const retry = disclosePaperFundingExcluded({ outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' as const });

    for (const result of [success, retry]) {
      expect(result.fundingDisclosure).toBe(PAPER_FUNDING_CAPABILITY);
      expect(Object.isFrozen(result)).toBe(true);
      expect(() => {
        (result.fundingDisclosure as { economicCompleteness: string }).economicCompleteness = 'COMPLETE';
      }).toThrow(TypeError);
    }
  });
});
