import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StrategyCoinMatrixError } from './errors';

const execFileAsync = promisify(execFile);
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface GitSourceVerifier {
  capture(): Promise<string>;
  assertExpected(expectedGitCommitHash: string): Promise<void>;
}

async function git(repositoryPath: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', [...args], { cwd: repositoryPath, encoding: 'utf8', windowsHide: true });
    return result.stdout;
  } catch (error) {
    throw new StrategyCoinMatrixError('MATRIX_SOURCE_STATE_UNAVAILABLE', 'Unable to inspect authoritative Git source state', { cause: error });
  }
}

export class ProductionGitSourceVerifier implements GitSourceVerifier {
  public constructor(private readonly repositoryPath: string) {}

  public async capture(): Promise<string> {
    const head = (await git(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    if (!FULL_OID.test(head)) throw new StrategyCoinMatrixError('MATRIX_SOURCE_STATE_UNAVAILABLE', 'Git HEAD is not a full 40-hex or 64-hex object ID');
    const status = await git(this.repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status.length !== 0) throw new StrategyCoinMatrixError('MATRIX_SOURCE_DIRTY', 'Git working tree is not clean');
    return head;
  }

  public async assertExpected(expectedGitCommitHash: string): Promise<void> {
    if (!FULL_OID.test(expectedGitCommitHash)) throw new StrategyCoinMatrixError('MATRIX_SOURCE_COMMIT_MISMATCH', 'Planned Git identity is not a full object ID');
    const actual = await this.capture();
    if (actual !== expectedGitCommitHash) {
      throw new StrategyCoinMatrixError('MATRIX_SOURCE_COMMIT_MISMATCH', 'Current Git HEAD differs from the finalized matrix plan');
    }
  }
}
