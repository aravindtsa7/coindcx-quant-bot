/** Preparation CLI. Default collect is hard-blocked: no provider bootstrap, credentials, budget binding or state init. */
import fs from 'node:fs';
import path from 'node:path';
import { inspectLaunchProposal } from './sync-read-launch/proposal';

async function main(): Promise<number> {
  const [action, ...args] = process.argv.slice(2);
  const allowed = ['--spec', '--offline-loopback', '--fixture-report', '--fixture-identity-mismatch'];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!allowed.includes(arg) || values.has(arg) || flags.has(arg)) throw new Error('INVALID_LAUNCH_ARGUMENTS');
    if (arg === '--spec' || arg === '--fixture-report') {
      const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT_VALUE'); values.set(arg, value);
    } else flags.add(arg);
  }
  if (action !== 'validate' && action !== 'collect') throw new Error('VALIDATE_OR_COLLECT_REQUIRED');
  const specPath = values.get('--spec'); if (!specPath) throw new Error('SPEC_REQUIRED');
  if (!specPath.endsWith('.json')) throw new Error('JSON_SPEC_REQUIRED');
  const inspection = inspectLaunchProposal(JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8')));
  if (!inspection.parametersValid || inspection.proposal === null) { console.log(JSON.stringify(inspection, null, 2)); return 1; }
  if (action === 'validate') {
    if (flags.size || values.has('--fixture-report')) throw new Error('FIXTURE_FLAGS_REQUIRE_COLLECT');
    console.log(JSON.stringify(inspection, null, 2)); return 0;
  }
  if (!flags.has('--offline-loopback')) {
    if (flags.size || values.has('--fixture-report')) throw new Error('FIXTURE_FLAGS_REQUIRE_OFFLINE_LOOPBACK');
    console.log(JSON.stringify({ ...inspection, outcome: 'REAL_LAUNCH_BLOCKED', providerCompositionImplemented: true, legacyCollectHardBlocked: true,
      requiredEntry: 'coindcx-sync-read-bootstrap.ts run-provider --input <absolute.json> --authorization <absolute.json>' }, null, 2)); return 2;
  }
  const report = values.get('--fixture-report'); if (!report) throw new Error('EXPLICIT_FIXTURE_REPORT_REQUIRED');
  const reportPath = path.resolve(report);
  const workspace = path.resolve(__dirname, '..');
  const relative = path.relative(workspace, reportPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !reportPath.endsWith('.json')
    || reportPath === path.resolve(inspection.proposal.configuration.reportDestination.path)) throw new Error('SEPARATE_WORKSPACE_FIXTURE_REPORT_REQUIRED');
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const { runLoopbackFixture } = await import('./sync-read-launch/loopback-fixture');
    const result = await runLoopbackFixture(inspection.proposal, reportPath, controller.signal, flags.has('--fixture-identity-mismatch'));
    console.log(JSON.stringify(result, null, 2));
    return result.delivery === 'WRITTEN' ? 0 : 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (require.main === module) main().then(code => { process.exitCode = code; }, () => { console.error('LAUNCH_PREPARATION_FAILED'); process.exitCode = 1; });
