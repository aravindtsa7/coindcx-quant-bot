import { describe, expect, it } from 'vitest';
import * as executionBarrel from '../../../src/execution';

// P14-A-MAJ-01 correction: the public `src/execution` barrel must never expose
// the raw OPEN/CLOSE mint functions or their unsafe mint-input/evidence types
// (a `RiskAdmissionCoordinator` + `RiskEvaluationContext`-shaped evidence
// would otherwise let an arbitrary caller self-supply both and obtain a
// structurally "genuine" authority). Only the authority classes and read-only
// record/binding shapes (no mint capability) belong on the barrel.
describe('P14-A public execution barrel surface', () => {
  it('does not export mintPaperOpenExecutionAuthority', () => {
    expect('mintPaperOpenExecutionAuthority' in executionBarrel).toBe(false);
  });

  it('does not export mintPaperCloseExecutionAuthority', () => {
    expect('mintPaperCloseExecutionAuthority' in executionBarrel).toBe(false);
  });

  it('exposes the authority classes required for downstream verification', () => {
    expect('PaperOpenExecutionAuthority' in executionBarrel).toBe(true);
    expect('PaperCloseExecutionAuthority' in executionBarrel).toBe(true);
    expect(typeof executionBarrel.PaperOpenExecutionAuthority.read).toBe('function');
    expect(typeof executionBarrel.PaperCloseExecutionAuthority.read).toBe('function');
  });

  it('lists no runtime binding whose name matches the unsafe mint surface', () => {
    const runtimeExportNames = Object.keys(executionBarrel);
    const forbidden = ['mintPaperOpenExecutionAuthority', 'mintPaperCloseExecutionAuthority'];
    for (const name of forbidden) expect(runtimeExportNames).not.toContain(name);
  });
});

// Type-level proof (checked by `npm run typecheck`, not `vitest run`): each
// `@ts-expect-error` below asserts that referencing the named type THROUGH THE
// BARREL PATH fails to compile — i.e. the type is not part of the barrel's
// public contract. If any of these were ever re-exported from `index.ts`
// again, the corresponding directive would itself become a compile error
// ("Unused '@ts-expect-error' directive"), failing `npm run typecheck`.
// @ts-expect-error — MintPaperOpenExecutionAuthorityInput must not be exported from the public execution barrel
export type _AssertOpenMintInputNotPublic = import('../../../src/execution').MintPaperOpenExecutionAuthorityInput;
// @ts-expect-error — MintPaperCloseExecutionAuthorityInput must not be exported from the public execution barrel
export type _AssertCloseMintInputNotPublic = import('../../../src/execution').MintPaperCloseExecutionAuthorityInput;
// @ts-expect-error — PaperOpenRiskEvidence must not be exported from the public execution barrel
export type _AssertOpenEvidenceNotPublic = import('../../../src/execution').PaperOpenRiskEvidence;
// @ts-expect-error — PaperCloseRiskEvidence must not be exported from the public execution barrel
export type _AssertCloseEvidenceNotPublic = import('../../../src/execution').PaperCloseRiskEvidence;
