import { describe, expect, it } from 'vitest';
import { runPracticalShadowCli } from '../../../../../src/integration/coindcx/live/practical-shadow-runtime';
import type { PracticalShadowSourceProbe } from '../../../../../src/execution/live/practical-shadow/provenance';
import { COMMIT_A, FINGERPRINT } from './support';

const SECRET_KEY = 'API-KEY-VALUE-MUST-NEVER-PRINT';
const SECRET = 'API-SECRET-VALUE-MUST-NEVER-PRINT';

/** A Prisma stand-in that fails the test if the command touches the database at all. */
const UNTOUCHABLE_PRISMA = new Proxy({}, { get: () => { throw new Error('the database must not be touched'); } }) as never;

const CLEAN_PROBE = (): PracticalShadowSourceProbe => ({ head: COMMIT_A, status: '' });

async function run(argv: readonly string[], env: Record<string, string>, sourceProbe: () => PracticalShadowSourceProbe = CLEAN_PROBE) {
  const lines: string[] = [];
  const code = await runPracticalShadowCli(argv, {
    env,
    io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    prisma: UNTOUCHABLE_PRISMA,
    sourceProbe,
  });
  return { code, output: lines.join('\n') };
}

const COMPLETE_ENV = {
  COINDCX_API_KEY: SECRET_KEY,
  COINDCX_API_SECRET: SECRET,
  COINDCX_LIVE_ACCOUNT_ID: 'account-live-1',
  COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: FINGERPRINT,
  LIVE_PRACTICAL_SHADOW_CADENCE_MS: '300000',
};

describe('the shadow CLI is explicitly opt-in, read-only, and credential-safe', () => {
  it.each([
    ['not opted in (disabled by default)', COMPLETE_ENV, /LIVE_PRACTICAL_SHADOW_ENABLED=true/],
    ['opted in with any other value', { ...COMPLETE_ENV, LIVE_PRACTICAL_SHADOW_ENABLED: 'yes' }, /LIVE_PRACTICAL_SHADOW_ENABLED=true/],
    ['no API secret', { ...COMPLETE_ENV, LIVE_PRACTICAL_SHADOW_ENABLED: 'true', COINDCX_API_SECRET: '' }, /COINDCX_API_KEY and COINDCX_API_SECRET/],
    ['no account', { ...COMPLETE_ENV, LIVE_PRACTICAL_SHADOW_ENABLED: 'true', COINDCX_LIVE_ACCOUNT_ID: '' }, /COINDCX_LIVE_ACCOUNT_ID/],
    ['a raw (non-fingerprint) account identity', { ...COMPLETE_ENV, LIVE_PRACTICAL_SHADOW_ENABLED: 'true', COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: 'raw-id' }, /64-hex fingerprint/],
    ['no cadence', { ...COMPLETE_ENV, LIVE_PRACTICAL_SHADOW_ENABLED: 'true', LIVE_PRACTICAL_SHADOW_CADENCE_MS: '' }, /LIVE_PRACTICAL_SHADOW_CADENCE_MS/],
    ['a malformed cadence', { ...COMPLETE_ENV, LIVE_PRACTICAL_SHADOW_ENABLED: 'true', LIVE_PRACTICAL_SHADOW_CADENCE_MS: '5m' }, /positive integer/],
  ])('start refuses when %s, before touching the database or the network, and prints no credential', async (_label, env, message) => {
    const { code, output } = await run(['start'], env);
    expect(code).toBe(2);
    expect(output).toMatch(message);
    expect(output).not.toContain(SECRET_KEY);
    expect(output).not.toContain(SECRET);
  });

  it('an unknown command prints usage; there is no live or mutation mode', async () => {
    for (const argv of [[], ['live'], ['mutate'], ['execute'], ['force-abort']]) {
      const { code, output } = await run(argv, COMPLETE_ENV);
      expect(code).toBe(2);
      expect(output).toMatch(/usage: practical-shadow <start \[--new\|--resume\] \| stop \| status \| report \| replay>/);
      expect(output).toMatch(/abort --account <accountId> --campaign <campaignId> --reason <CODE>/);
    }
  });

  const OPTED_IN = { ...COMPLETE_ENV, LIVE_PRACTICAL_SHADOW_ENABLED: 'true' };

  it.each([
    ['start', 'a dirty source tree', () => ({ head: COMMIT_A, status: ' M src/index.ts\n?? notes.txt\n' }), /SHADOW_SOURCE_DIRTY \(2 uncommitted or untracked entries\)/],
    ['start', 'no git', () => ({ head: null, status: null }), /SHADOW_SOURCE_PROVENANCE_UNAVAILABLE/],
    ['start', 'a throwing probe', () => { throw new Error('git exploded'); }, /SHADOW_SOURCE_PROVENANCE_UNAVAILABLE/],
    ['stop', 'a dirty source tree', () => ({ head: COMMIT_A, status: '?? notes.txt\n' }), /SHADOW_SOURCE_DIRTY/],
    ['stop', 'no git', () => ({ head: null, status: '' }), /SHADOW_SOURCE_PROVENANCE_UNAVAILABLE/],
  ])('P18B-C-01: %s refuses with %s before touching the database or the network; no path or content is printed', async (command, _label, probe, message) => {
    const { code, output } = await run([command], OPTED_IN, probe as () => PracticalShadowSourceProbe);
    expect(code).toBe(2);
    expect(output).toMatch(message);
    expect(output).not.toMatch(/src\/index|notes\.txt|git exploded/);
    expect(output).not.toContain(SECRET_KEY);
  });

  it.each([
    [['abort']],
    [['abort', '--account', 'account-live-1', '--campaign', 'campaign-1']],
    [['abort', '--account', 'account-live-1', '--reason', 'CONFIG_CHANGED']],
    [['abort', '--campaign', 'campaign-1', '--reason', 'CONFIG_CHANGED']],
  ])('P18B-C-02: abort requires EXACT --account, --campaign, and --reason (nothing inferred from the environment) %j', async (argv) => {
    const { code, output } = await run(argv, OPTED_IN);
    expect(code).toBe(2);
    expect(output).toMatch(/--account <accountId>, --campaign <campaignId>, and --reason <CODE> are all required/);
  });
});
