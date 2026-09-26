/**
 * Phase 18B Checkpoint C: READ-ONLY practical shadow calibration CLI.
 *
 * Usage:
 *   LIVE_PRACTICAL_SHADOW_ENABLED=true npm run shadow:practical:start   # opt-in; read-only collection
 *   npm run shadow:practical:stop      # marks the ACTIVE campaign COMPLETED (same binding required)
 *   npm run shadow:practical:abort -- --account <id> --campaign <id> --reason <CODE>
 *                                      # EXPLICIT operator abort (binding drift); database only
 *   npm run shadow:practical:status    # database only
 *   npm run shadow:practical:report    # database only: replayed calibration report
 *   npm run shadow:practical:replay    # database only: deterministic replay consistency
 *
 * `start` is disabled unless LIVE_PRACTICAL_SHADOW_ENABLED=true. It never
 * places, cancels, or closes anything, never constructs an order gateway,
 * and never prints credentials. Shadow evidence and paper decisions are NOT
 * authority. Stop with Ctrl-C: the current evaluation finishes, and the
 * campaign stays ACTIVE and resumable (a crash mid-evaluation is aborted on
 * the next resume, never counted).
 *
 * SOFTWARE PROVENANCE: `start`/`stop` run only from a CLEAN git source tree at
 * an exact commit (any uncommitted or untracked, non-ignored file refuses with
 * SHADOW_SOURCE_DIRTY; no git -> SHADOW_SOURCE_PROVENANCE_UNAVAILABLE). Run a
 * campaign from a dedicated clean checkout. Only the commit is persisted.
 *
 * All logic lives in `src/integration/coindcx/live/practical-shadow-runtime.ts`.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { runPracticalShadowCli } from '../src/integration/coindcx/live/practical-shadow-runtime';

const REPO_ROOT = path.resolve(__dirname, '..');

/** Raw git output for the repository this script runs from, or null when git fails (fail closed). */
function git(args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, '--no-optional-locks', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    console.log('[shadow] stop requested: finishing the current evaluation');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const prisma = new PrismaClient();
  try {
    return await runPracticalShadowCli(process.argv.slice(2), {
      env: process.env,
      io: { out: (line) => console.log(line), err: (line) => console.error(line) },
      prisma,
      sourceProbe: () => ({
        head: git(['rev-parse', '--verify', 'HEAD']),
        status: git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']),
      }),
      shouldContinue: () => !stopping,
    });
  } catch (error) {
    // Never print a raw error object: it could carry request context.
    console.error(`[shadow] aborted: ${error instanceof Error ? error.name : 'UnknownError'}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
