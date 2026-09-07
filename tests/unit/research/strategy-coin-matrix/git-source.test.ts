import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductionGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/git-source';
import { planWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/planner';
import { matrixInput, registry, resources } from './helpers';

const run = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(directory: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd: directory, windowsHide: true });
}

async function repository(): Promise<string> {
  const directory = resolve(await mkdtemp(join(tmpdir(), 'phase11-git-')));
  temporaryRepositories.push(directory);
  await git(directory, 'init');
  await git(directory, 'config', 'user.email', 'phase11@example.invalid');
  await git(directory, 'config', 'user.name', 'Phase 11 Test');
  await writeFile(join(directory, 'tracked.txt'), 'one\n', 'utf8');
  await git(directory, 'add', 'tracked.txt');
  await git(directory, 'commit', '-m', 'initial');
  return directory;
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const directory = temporaryRepositories.pop();
    if (directory !== undefined && directory.startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

describe('P11-I04 production Git source verification', () => {
  it('captures a full OID from an isolated clean repository', async () => {
    const directory = await repository();
    const head = await new ProductionGitSourceVerifier(directory).capture();
    expect(head).toMatch(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
  }, 20_000);

  it('rejects tracked dirtiness', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'tracked.txt'), 'changed\n', 'utf8');
    await expect(new ProductionGitSourceVerifier(directory).capture()).rejects.toMatchObject({ code: 'MATRIX_SOURCE_DIRTY' });
  }, 20_000);

  it('rejects staged dirtiness', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'tracked.txt'), 'changed\n', 'utf8');
    await git(directory, 'add', 'tracked.txt');
    await expect(new ProductionGitSourceVerifier(directory).capture()).rejects.toMatchObject({ code: 'MATRIX_SOURCE_DIRTY' });
  }, 20_000);

  it('rejects untracked non-ignored files', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'untracked.txt'), 'untracked\n', 'utf8');
    await expect(new ProductionGitSourceVerifier(directory).capture()).rejects.toMatchObject({ code: 'MATRIX_SOURCE_DIRTY' });
  }, 20_000);

  it('does not treat ignored files as source dirtiness', async () => {
    const directory = await repository();
    await writeFile(join(directory, '.gitignore'), 'ignored.txt\n', 'utf8');
    await git(directory, 'add', '.gitignore');
    await git(directory, 'commit', '-m', 'ignore rule');
    await writeFile(join(directory, 'ignored.txt'), 'ignored\n', 'utf8');
    await expect(new ProductionGitSourceVerifier(directory).capture()).resolves.toMatch(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
  }, 20_000);

  it('fails closed when Git metadata is unavailable', async () => {
    const directory = resolve(await mkdtemp(join(tmpdir(), 'phase11-no-git-')));
    temporaryRepositories.push(directory);
    await expect(new ProductionGitSourceVerifier(directory).capture()).rejects.toMatchObject({ code: 'MATRIX_SOURCE_STATE_UNAVAILABLE' });
  }, 20_000);

  it('rejects a different clean HEAD and clean commits produce distinct identities', async () => {
    const directory = await repository();
    const verifier = new ProductionGitSourceVerifier(directory);
    const first = await verifier.capture();
    const pairResource = resources('BTC-INR');
    const dependencies = { registry: registry(), pairResources: [pairResource] };
    const firstPlan = await planWithGitSourceVerifier(matrixInput([pairResource], false), dependencies, verifier);
    await writeFile(join(directory, 'tracked.txt'), 'two\n', 'utf8');
    await git(directory, 'add', 'tracked.txt');
    await git(directory, 'commit', '-m', 'second');
    const second = await verifier.capture();
    const secondPlan = await planWithGitSourceVerifier(matrixInput([pairResource], false), dependencies, verifier);
    expect(second).not.toBe(first);
    expect(secondPlan.matrixPlanId).not.toBe(firstPlan.matrixPlanId);
    await expect(verifier.assertExpected(first)).rejects.toMatchObject({ code: 'MATRIX_SOURCE_COMMIT_MISMATCH' });
  }, 20_000);
});
