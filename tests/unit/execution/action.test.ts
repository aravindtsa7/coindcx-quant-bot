import { describe, expect, it } from 'vitest';
import { resolveExecutionAction } from '../../../src/execution/action';

describe('P14-A action/lifecycle contracts', () => {
  it('OPEN resolves to an executable OPEN action', () => {
    expect(resolveExecutionAction('OPEN')).toBe('OPEN');
  });

  it('CLOSE resolves to an executable CLOSE action', () => {
    expect(resolveExecutionAction('CLOSE')).toBe('CLOSE');
  });

  it('NO_CHANGE maps to no execution', () => {
    const result = resolveExecutionAction('NO_CHANGE');
    expect(result).toEqual({ outcome: 'NO_EXECUTION', reason: 'NO_CHANGE' });
  });

  it('REVERSAL_DEFERRED maps to no execution, never a synthesized close+reopen', () => {
    const result = resolveExecutionAction('REVERSAL_DEFERRED');
    expect(result).toEqual({ outcome: 'NO_EXECUTION', reason: 'REVERSAL_DEFERRED' });
  });
});
