/**
 * Phase17 LIVE execution authority (§6, P17-I01/I02/I03).
 *
 * `LiveExecutionAuthority` is structurally non-interchangeable with
 * `PaperOpenExecutionAuthority`/`PaperCloseExecutionAuthority`: it is a
 * different class, holding a different ECMAScript-private field, minted only by
 * a module-private symbol this file never exports. Consequences, all of which
 * are proven by the Phase17 adversarial tests:
 *
 *   - a plain object literal, a spread reconstruction, a forged prototype, or a
 *     subclass instance is not an authority — `read()` returns `null`;
 *   - a paper authority is not a live authority, in either direction, with no
 *     cast, flag, or mode that converts one into the other;
 *   - the authority binds the exact `intentId`, account, pair, and risk lineage
 *     it was minted for, so it cannot be replayed against another intent,
 *     another pair, another account, or a mutated intent.
 *
 * The mint functions are deliberately absent from `index.ts`, exactly as
 * Phase14's paper mints are absent from the `src/execution` barrel.
 */
import type { AdmissionRecord } from '../../dispatch';
import { admitForLiveExecution, RiskAdmissionCoordinator } from '../../dispatch/admission';
import { authorizeStrategyDispatch } from '../../dispatch/strategy-dispatch';
import {
  issueResearchApprovalOrigin,
  ResearchApprovalOrigin,
  type ResearchApprovalOriginRecord,
  type ResearchValidationPlanResult,
} from '../../research/research-validation';
import type {
  AcceptedCloseRiskDecision,
  AcceptedOpenRiskDecision,
  RiskEvaluationContext,
  RiskPolicy,
} from '../../risk';
import { createStrategyRiskHandoff } from '../../risk';
import {
  StrategyDecisionOrigin,
  type StrategyDecision,
  type StrategyDecisionOriginRecord,
  type StrategyKernel,
} from '../../strategies';
import { LiveExecutionError } from './errors';
import { LiveExecutionEnablement } from './gate';
import {
  createLiveExecutionIntent,
  LiveExecutionIntent,
  type LiveExecutionIntentRecord,
  type LiveExecutionShapeRequest,
} from './intent';
import type { AuthoritativeInstrumentConstraints } from './instrument-constraints';
import type { LiveExecutionPolicySnapshot } from './execution-policy';
import type { LiveExecutionAction, LiveOrderSide } from './types';
import { liveDecimal } from './decimal';

const LIVE_AUTHORITY_ISSUER = Symbol('P17 live execution authority issuer');

export interface LiveExecutionAuthorityRecord {
  readonly action: LiveExecutionAction;
  readonly accountId: string;
  readonly pair: string;
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly intent: LiveExecutionIntentRecord;
  /** The genuine accepted Phase13 decision this mutation descends from (P17-I02). */
  readonly decision: AcceptedOpenRiskDecision | AcceptedCloseRiskDecision;
  /** OPEN-only genuine Phase12 research approval (P17-I01); `null` for research-exempt CLOSE. */
  readonly researchApproval: ResearchApprovalOriginRecord | null;
  readonly strategyOrigin: StrategyDecisionOriginRecord;
  /** OPEN-only genuine admission grant. */
  readonly admission: AdmissionRecord | null;
  /** Genuine coordinator retained only so dispatch can consume this grant. */
  readonly coordinator: RiskAdmissionCoordinator;
}

/**
 * Runtime capability. Never part of any canonical semantic identity, never
 * serialized, never persisted.
 */
export class LiveExecutionAuthority {
  readonly #record: LiveExecutionAuthorityRecord;

  public constructor(issuer: symbol, record: LiveExecutionAuthorityRecord) {
    if (issuer !== LIVE_AUTHORITY_ISSUER) {
      throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Only the genuine Phase17 mint composition may issue live execution authority');
    }
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }

  public static read(value: unknown): LiveExecutionAuthorityRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }
}
Object.freeze(LiveExecutionAuthority.prototype);
Object.freeze(LiveExecutionAuthority);

/**
 * Reads a genuine authority and proves it authorizes exactly this intent
 * instance — same intent identity, same client order id, same account, same
 * pair, same risk decision. Anything else is `LIVE_AUTHORITY_INVALID`.
 *
 * This is the only function the execution service calls to convert possession
 * of an authority into permission to mutate.
 */
export function readLiveAuthorityForIntent(authority: unknown, intent: unknown): LiveExecutionAuthorityRecord {
  const authorityRecord = LiveExecutionAuthority.read(authority);
  if (authorityRecord === null) {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Live mutation requires a genuine Phase17 live execution authority');
  }
  const intentRecord = LiveExecutionIntent.read(intent);
  if (intentRecord === null) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Live mutation requires a genuine immutable live execution intent');
  }
  if (
    authorityRecord.intentId !== intentRecord.intentId
    || authorityRecord.clientOrderId !== intentRecord.clientOrderId
    || authorityRecord.accountId !== intentRecord.content.accountId
    || authorityRecord.pair !== intentRecord.content.pair
    || authorityRecord.action !== intentRecord.content.action
    || authorityRecord.decision.riskDecisionId !== intentRecord.content.riskDecisionId
  ) {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Live execution authority is not bound to this intent', {
      details: { intentId: intentRecord.intentId },
    });
  }
  return authorityRecord;
}

function assertGenuineEnablement(enablement: unknown, accountId: string, pair: string): void {
  const record = LiveExecutionEnablement.read(enablement);
  if (record === null) {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Live mutation requires a genuine configuration enablement');
  }
  if (!record.accountAllowlist.includes(accountId)) {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Account is not on the live execution allowlist', { details: { accountId } });
  }
  if (record.credentialAccountId !== accountId) {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Execution account is not the trusted configured owner of the CoinDCX credentials', { details: { accountId } });
  }
  if (!record.pairAllowlist.includes(pair)) {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Pair is not on the live execution allowlist', { details: { pair } });
  }
}

function assertInstrumentChain(
  input: Pick<MintLiveOpenExecutionAuthorityInput, 'accountId' | 'kernel' | 'instrumentSpecSnapshotId' | 'riskPolicy' | 'evidence' | 'constraints'>,
): void {
  const { pairSnapshot, settlementRateSnapshot, accountSnapshot, exposureSnapshot } = input.evidence;
  const pair = input.kernel.pair;
  if (input.riskPolicy.pairConfig.pair !== pair || pairSnapshot.pair !== pair || input.constraints.pair !== pair) {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Pair identity differs across execution, risk policy, evidence, and instrument constraints');
  }
  if (input.instrumentSpecSnapshotId !== pairSnapshot.instrumentSpecSnapshotId
      || input.instrumentSpecSnapshotId !== input.constraints.instrumentSpecSnapshotId) {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Instrument snapshot identity differs across risk and execution');
  }
  if (accountSnapshot?.accountId !== input.accountId || exposureSnapshot?.accountId !== input.accountId
      || pairSnapshot.ownership.status !== 'RECONCILED' || pairSnapshot.ownership.accountId !== input.accountId) {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Account, exposure, and instrument ownership are not the same authenticated identity');
  }
  for (const [executionValue, riskValue] of [
    [input.constraints.priceIncrement, pairSnapshot.priceIncrement],
    [input.constraints.quantityIncrement, pairSnapshot.quantityIncrement],
    [input.constraints.contractMultiplier, pairSnapshot.contractMultiplier],
    [input.constraints.minQuantity, pairSnapshot.minQuantity],
    [input.constraints.maxQuantity, pairSnapshot.maxQuantity],
    [input.constraints.minPrice, pairSnapshot.minPrice],
    [input.constraints.maxPrice, pairSnapshot.maxPrice],
    [input.constraints.minNotional, pairSnapshot.minNotional],
    [input.constraints.maxNotional, pairSnapshot.maxNotional],
  ] as const) {
    if (executionValue === null || riskValue === null) {
      if (executionValue !== riskValue) throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Execution instrument economics differ from risk instrument economics');
    } else if (!liveDecimal(executionValue).equals(liveDecimal(riskValue))) {
      throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Execution instrument economics differ from risk instrument economics');
    }
  }
  if (settlementRateSnapshot === null || settlementRateSnapshot.sourceCurrency !== input.constraints.quoteCurrency
      || settlementRateSnapshot.targetCurrency !== 'INR') {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'No authoritative conversion binds the instrument quote currency to INR');
  }
}

/** LONG exposure opens with a BUY; SHORT opens with a SELL. */
function openSideFor(direction: AdmissionRecord['direction']): LiveOrderSide {
  return direction === 'LONG' ? 'BUY' : 'SELL';
}

/** A CLOSE always trades against the held direction. */
function closeSideFor(positionSide: 'LONG' | 'SHORT'): LiveOrderSide {
  return positionSide === 'LONG' ? 'SELL' : 'BUY';
}

export interface MintLiveOpenExecutionAuthorityInput {
  /** Genuine gate resolution. A literal cannot stand in for one. */
  readonly enablement: LiveExecutionEnablement;
  /** The one real, account-owned coordinator from the production composition. */
  readonly coordinator: RiskAdmissionCoordinator;
  readonly accountId: string;
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly planResult: ResearchValidationPlanResult;
  readonly riskPolicy: RiskPolicy;
  readonly evidence: Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>;
  readonly livePolicy: LiveExecutionPolicySnapshot;
  readonly constraints: AuthoritativeInstrumentConstraints;
  readonly shape: LiveExecutionShapeRequest;
}

export interface MintedLiveExecutionAuthority {
  readonly authority: LiveExecutionAuthority;
  readonly intent: LiveExecutionIntent;
}

/**
 * The single trusted OPEN composition. In this exact order, inside this one
 * function: genuine Phase12 PASSED research approval, matching genuine
 * `StrategyDecision` origin, `RiskEngine` acceptance and `ADMITTED` outcome
 * from the real coordinator, then — and only then — an intent built from the
 * ACCEPTED decision's own approved economics.
 *
 * Returns `null` for every genuine upstream rejection (no research approval,
 * origin mismatch, non-`ADMITTED` outcome). Throws only for a fail-closed
 * condition: disabled configuration, a forged enablement, or an unreachable
 * internal inconsistency.
 *
 * The caller never supplies quantity, leverage, risk decision id, or admission
 * id: all four are read from the authoritative decision/admission this function
 * itself obtained (P17-I02).
 */
export async function mintLiveOpenExecutionAuthority(
  input: MintLiveOpenExecutionAuthorityInput,
): Promise<MintedLiveExecutionAuthority | null> {
  assertGenuineEnablement(input.enablement, input.accountId, input.kernel.pair);
  assertInstrumentChain(input);

  const researchApproval = issueResearchApprovalOrigin(input.planResult, {
    pair: input.kernel.pair,
    strategyId: input.kernel.strategyId,
    strategyVersion: input.kernel.strategyVersion,
    parameterHash: input.kernel.parameterHash,
  });
  if (researchApproval === null) return null;

  const authorized = authorizeStrategyDispatch(input.kernel, input.decision, input.instrumentSpecSnapshotId, researchApproval);
  if (authorized === null) return null;

  const context: RiskEvaluationContext = { ...input.evidence, strategyOrigin: authorized.strategyOrigin, candidate: authorized.candidate };
  const outcome = await admitForLiveExecution(input.coordinator, { accountId: input.accountId, policy: input.riskPolicy, context });
  if (outcome.status !== 'ADMITTED') return null;

  const researchApprovalRecord = ResearchApprovalOrigin.read(researchApproval);
  const strategyOriginRecord = StrategyDecisionOrigin.read(authorized.strategyOrigin);
  if (researchApprovalRecord === null || strategyOriginRecord === null) {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Unreachable: a just-issued genuine origin failed to read back its own record');
  }

  const intent = createLiveExecutionIntent({
    policy: input.livePolicy,
    constraints: input.constraints,
    economics: {
      accountId: input.accountId,
      pair: outcome.admission.pair,
      side: openSideFor(outcome.admission.direction),
      action: 'OPEN',
      quantity: outcome.decision.approved.approvedQuantity,
      leverage: outcome.decision.approved.approvedLeverage,
      riskDecisionId: outcome.decision.riskDecisionId,
      admissionId: outcome.admission.admissionId,
      strategyInstanceId: outcome.admission.strategyInstanceId,
      strategyId: outcome.admission.strategyId,
      strategyVersion: outcome.admission.strategyVersion,
      parameterHash: outcome.admission.parameterHash,
      authorizedNotionalInr: outcome.decision.approved.approvedNotionalInr,
      settlementRateInrPerQuote: context.settlementRateSnapshot?.rateInrPerUsdt ?? null,
      positionInstanceId: null,
      positionRevision: null,
      reduceOnlyQuantity: null,
    },
    shape: input.shape,
    lineage: {
      researchApproval: {
        validationSubjectId: researchApprovalRecord.validationSubjectId,
        validationPlanId: researchApprovalRecord.validationPlanId,
        validationSubjectResultSha256: researchApprovalRecord.validationSubjectResultSha256,
      },
      sourceStrategyDecisionId: strategyOriginRecord.decision.decisionId,
    },
  });

  const intentRecord = LiveExecutionIntent.read(intent);
  if (intentRecord === null) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Unreachable: a just-built genuine intent failed to read back its own record');
  }

  return Object.freeze({
    intent,
    authority: new LiveExecutionAuthority(LIVE_AUTHORITY_ISSUER, {
      action: 'OPEN',
      accountId: input.accountId,
      pair: intentRecord.content.pair,
      intentId: intentRecord.intentId,
      clientOrderId: intentRecord.clientOrderId,
      intent: intentRecord,
      decision: outcome.decision,
      researchApproval: researchApprovalRecord,
      strategyOrigin: strategyOriginRecord,
      admission: outcome.admission,
      coordinator: input.coordinator,
    }),
  });
}

/** Durable position evidence a live CLOSE binds to. Supplied by the account-owner runtime. */
export interface LiveClosePositionBinding {
  readonly positionInstanceId: string;
  readonly positionRevision: number;
  readonly side: 'LONG' | 'SHORT';
  readonly ownedQuantity: string;
  readonly ownerStrategyInstanceId: string;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
}

export interface MintLiveCloseExecutionAuthorityInput {
  readonly enablement: LiveExecutionEnablement;
  readonly coordinator: RiskAdmissionCoordinator;
  readonly accountId: string;
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly riskPolicy: RiskPolicy;
  readonly evidence: Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>;
  readonly position: LiveClosePositionBinding;
  readonly livePolicy: LiveExecutionPolicySnapshot;
  readonly constraints: AuthoritativeInstrumentConstraints;
  readonly shape: LiveExecutionShapeRequest;
}

/**
 * The single trusted CLOSE composition. CLOSE is research-exempt by the frozen
 * Phase14 rule, so no research gate applies — but every other verification
 * still does, plus reconciled ownership of the exact position being closed,
 * keyed by the full instance/strategy/version/parameter tuple.
 *
 * The closed quantity is always the position's own owned quantity. There is no
 * path through this function to authorize an increase, a reversal, or a
 * caller-chosen target size.
 */
export async function mintLiveCloseExecutionAuthority(
  input: MintLiveCloseExecutionAuthorityInput,
): Promise<MintedLiveExecutionAuthority | null> {
  assertGenuineEnablement(input.enablement, input.accountId, input.kernel.pair);
  assertInstrumentChain(input);

  const authorized = createStrategyRiskHandoff(input.kernel, input.decision, input.instrumentSpecSnapshotId);
  if (authorized === null) return null;

  const { position } = input;
  const riskPosition = input.evidence.pairSnapshot.position;
  if (
    riskPosition.state !== 'OPEN'
    || riskPosition.positionId !== position.positionInstanceId
    || riskPosition.positionDirection !== position.side
    || riskPosition.quantityMagnitude !== position.ownedQuantity
    ||
    position.ownerStrategyInstanceId !== input.decision.strategyInstanceId
    || position.ownerStrategyId !== input.decision.strategyId
    || position.ownerStrategyVersion !== input.decision.strategyVersion
    || position.ownerParameterHash !== input.decision.parameterHash
  ) {
    return null;
  }

  const context: RiskEvaluationContext = { ...input.evidence, strategyOrigin: authorized.strategyOrigin, candidate: authorized.candidate };
  const outcome = await admitForLiveExecution(input.coordinator, { accountId: input.accountId, policy: input.riskPolicy, context });
  if (outcome.status !== 'ACCEPTED_NO_CAPACITY_OWNERSHIP') return null;

  const strategyOriginRecord = StrategyDecisionOrigin.read(authorized.strategyOrigin);
  if (strategyOriginRecord === null) {
    throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Unreachable: a just-issued genuine origin failed to read back its own record');
  }

  const intent = createLiveExecutionIntent({
    policy: input.livePolicy,
    constraints: input.constraints,
    economics: {
      accountId: input.accountId,
      pair: outcome.decision.pair,
      side: closeSideFor(position.side),
      action: 'CLOSE',
      quantity: outcome.decision.approved.approvedQuantity,
      leverage: null,
      riskDecisionId: outcome.decision.riskDecisionId,
      admissionId: null,
      strategyInstanceId: outcome.decision.strategyInstanceId,
      strategyId: outcome.decision.strategyId,
      strategyVersion: outcome.decision.strategyVersion,
      parameterHash: outcome.decision.parameterHash,
      authorizedNotionalInr: outcome.decision.approved.approvedNotionalInr,
      settlementRateInrPerQuote: null,
      positionInstanceId: position.positionInstanceId,
      positionRevision: position.positionRevision,
      reduceOnlyQuantity: outcome.decision.approved.approvedQuantity,
    },
    shape: input.shape,
    lineage: { researchApproval: null, sourceStrategyDecisionId: strategyOriginRecord.decision.decisionId },
  });

  const intentRecord = LiveExecutionIntent.read(intent);
  if (intentRecord === null) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Unreachable: a just-built genuine intent failed to read back its own record');
  }

  return Object.freeze({
    intent,
    authority: new LiveExecutionAuthority(LIVE_AUTHORITY_ISSUER, {
      action: 'CLOSE',
      accountId: input.accountId,
      pair: intentRecord.content.pair,
      intentId: intentRecord.intentId,
      clientOrderId: intentRecord.clientOrderId,
      intent: intentRecord,
      decision: outcome.decision,
      researchApproval: null,
      strategyOrigin: strategyOriginRecord,
      admission: null,
      coordinator: input.coordinator,
    }),
  });
}

// CommonJS consumers cannot replace the authority reader (or either mint)
// through the module namespace. The execution service additionally performs
// the private-field brand check on every call; freezing is defense-in-depth,
// while these non-configurable lexical accessors close export replacement.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({
    LiveExecutionAuthority,
    readLiveAuthorityForIntent,
    mintLiveOpenExecutionAuthority,
    mintLiveCloseExecutionAuthority,
  })) {
    if (Object.getOwnPropertyDescriptor(module.exports, name)?.configurable !== false) {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
  Object.freeze(module.exports);
}
