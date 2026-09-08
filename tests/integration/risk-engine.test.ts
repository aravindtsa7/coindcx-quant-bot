import { describe, expect, it } from 'vitest';
import { RiskEngine } from '../../src/risk';
import { makeContext, makePolicy, seal } from '../unit/risk/helpers';

describe('Phase 13 integrated risk evaluation', () => {
  it('runs selected-instrument evidence through sizing into an accepted OPEN decision', () => {
    const engine = new RiskEngine(makePolicy());
    const context = makeContext();
    const sizing = engine.evaluatePositionSizing(context).decision;
    const risk = engine.evaluateRisk(context);
    expect(sizing).toMatchObject({ action: 'OPEN', outcome: 'SIZED' });
    expect(risk).toMatchObject({ status: 'ACCEPTED', action: 'OPEN', sourcePositionSizingDecisionId: sizing.positionSizingDecisionId });
    expect(Object.isFrozen(risk)).toBe(true);
  });

  it('fails closed across source, exposure, and account gates with deterministic precedence', () => {
    const context = makeContext();
    if (context.accountSnapshot === null || context.exposureSnapshot === null) throw new Error('fixture');
    const account = seal({ ...context.accountSnapshot, accountStateKnown: false });
    const exposure = seal({ ...context.exposureSnapshot, pending: { status: 'UNKNOWN' as const } });
    const first = new RiskEngine(makePolicy()).evaluateRisk({ ...context, accountSnapshot: account, exposureSnapshot: exposure });
    const second = new RiskEngine(makePolicy()).evaluateRisk({ ...context, exposureSnapshot: exposure, accountSnapshot: account });
    expect(first).toEqual(second);
    expect(first.status).toBe('REJECTED');
    if (first.status === 'REJECTED') {
      expect(first.approved).toBeNull();
      expect([first.primaryReasonCode, ...first.secondaryReasonCodes]).toEqual(expect.arrayContaining(['ACCOUNT_STATE_UNAVAILABLE', 'PENDING_EXPOSURE_UNKNOWN']));
    }
  });
});
