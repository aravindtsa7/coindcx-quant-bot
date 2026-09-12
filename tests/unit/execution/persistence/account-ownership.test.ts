import { describe, expect, it } from 'vitest';
import { PaperAccountOwnership, issueAccountOwnership } from '../../../../src/execution/persistence/account-ownership';
import { PaperPersistenceError } from '../../../../src/execution/persistence/errors';

describe('P14-D PaperAccountOwnership — non-forgeable capability (V2 §16)', () => {
  it('is mintable only via the internal issuer function, never a public constructor call', () => {
    const ownership = issueAccountOwnership({ accountId: 'acc-1', fence: 1n });
    const record = PaperAccountOwnership.read(ownership);
    expect(record).toEqual({ accountId: 'acc-1', fence: 1n });
  });

  it('rejects direct construction with a foreign issuer symbol', () => {
    expect(() => new PaperAccountOwnership(Symbol('forged'), { accountId: 'acc-1', fence: 1n })).toThrow(PaperPersistenceError);
  });

  it('.read() rejects a caller-shaped lookalike object with byte-identical fields', () => {
    const genuine = issueAccountOwnership({ accountId: 'acc-1', fence: 1n });
    const record = PaperAccountOwnership.read(genuine);
    expect(PaperAccountOwnership.read({ ...record })).toBeNull();
  });

  it('.read() rejects null/undefined/primitive values', () => {
    expect(PaperAccountOwnership.read(null)).toBeNull();
    expect(PaperAccountOwnership.read(undefined)).toBeNull();
    expect(PaperAccountOwnership.read('acc-1')).toBeNull();
    expect(PaperAccountOwnership.read(42)).toBeNull();
  });

  it('is frozen/immutable once issued', () => {
    const ownership = issueAccountOwnership({ accountId: 'acc-1', fence: 1n });
    expect(Object.isFrozen(ownership)).toBe(true);
  });
});
