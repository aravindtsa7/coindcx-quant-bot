/**
 * Phase 14's single funding capability authority. CoinDCX does not currently
 * expose enough provider truth to reproduce perpetual-funding economics for a
 * synthetic paper position, so this value is deliberately immutable and has
 * no enabled/partial variant or public setter.
 */
export type PaperFundingCapability = 'FUNDING_UNSUPPORTED';
export type PaperFundingCapabilityReason = 'COINDCX_PROVIDER_EVIDENCE_INCOMPLETE';
export type PaperEconomicCompleteness = 'FUNDING_EXCLUDED';
export type PaperEconomicStatus = 'PAPER_NOT_ECONOMICALLY_COMPLETE';
export type PaperPnlLabel = 'FUNDING_EXCLUDED_PNL';

export interface PaperFundingDisclosure {
  readonly fundingCapability: PaperFundingCapability;
  readonly reason: PaperFundingCapabilityReason;
  readonly fundingApplied: false;
  readonly economicCompleteness: PaperEconomicCompleteness;
  readonly paperEconomicStatus: PaperEconomicStatus;
  readonly pnlLabel: PaperPnlLabel;
}

export const PAPER_FUNDING_CAPABILITY: PaperFundingDisclosure = Object.freeze({
  fundingCapability: 'FUNDING_UNSUPPORTED',
  reason: 'COINDCX_PROVIDER_EVIDENCE_INCOMPLETE',
  fundingApplied: false,
  economicCompleteness: 'FUNDING_EXCLUDED',
  paperEconomicStatus: 'PAPER_NOT_ECONOMICALLY_COMPLETE',
  pnlLabel: 'FUNDING_EXCLUDED_PNL',
});

export type PaperFundingDisclosedResult<T extends object> = T extends unknown
  ? Readonly<T & { readonly fundingDisclosure: PaperFundingDisclosure }>
  : never;

/** Adds the canonical disclosure to every terminal paper execution outcome. */
export function disclosePaperFundingExcluded<T extends object>(outcome: T): PaperFundingDisclosedResult<T> {
  return Object.freeze({ ...outcome, fundingDisclosure: PAPER_FUNDING_CAPABILITY }) as PaperFundingDisclosedResult<T>;
}

export type PaperFundingOperation = 'APPLY' | 'RECOVER';

export class PaperFundingUnsupportedError extends Error {
  public readonly code = 'FUNDING_UNSUPPORTED' as const;
  public readonly operation: PaperFundingOperation;

  public constructor(operation: PaperFundingOperation) {
    super(`[FUNDING_UNSUPPORTED] Paper funding operation ${operation} is unavailable: ${PAPER_FUNDING_CAPABILITY.reason}`);
    this.name = 'PaperFundingUnsupportedError';
    this.operation = operation;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Pure pre-persistence guard. Its signature deliberately accepts no economic
 * inputs and no repository/Prisma dependency, so APPLY/RECOVER cannot reach a
 * transaction, lock, provider call, or mutation.
 */
export function rejectUnsupportedPaperFundingOperation(operation: PaperFundingOperation): never {
  throw new PaperFundingUnsupportedError(operation);
}

/** Funding-excluded profitability is never production-promotion evidence. */
export function isPaperFundingProductionPromotionEvidence(): false {
  return false;
}
