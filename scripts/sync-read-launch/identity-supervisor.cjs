'use strict';
// Task-owned supervisor. Absolute executable, minimal environment, bounded lifetime, piped HEARTBEAT/STOP.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
function cleanEnvironment() {
  return { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), NODE_ENV: 'production', TSX_DISABLE_CACHE: '1',
    TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'), ESBUILD_BINARY_PATH: path.join(root, 'node_modules/@esbuild/win32-x64/esbuild.exe'),
    PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' };
}
async function supervise(inputFile, options = {}) {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'runtime-inventory.json'))), input = JSON.parse(fs.readFileSync(inputFile));
  const custodyCommand = `& { ${fs.readFileSync(path.join(__dirname, 'identity-custody.ps1'), 'utf8')} } -RuntimeRoot '${root.replaceAll("'", "''")}'`;
  const preflight = cp.spawnSync(inventory.powershell.path, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(custodyCommand, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, cwd: root, env: cleanEnvironment(), timeout: 120000 });
  if (preflight.status !== 0) throw Error('SUPERVISOR_CUSTODY_PREFLIGHT_FAILED');
  const custody = JSON.parse(preflight.stdout);
  const child = cp.spawn(inventory.node.path, ['--require', path.join(__dirname, 'identity-request-guard.cjs'), '--import', pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href,
    path.join(__dirname, 'identity-diagnostic-entry.ts'), '--input', inputFile], { cwd: root, env: cleanEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = []; let pending = '', stderrBytes = 0, killed = false;
  child.stdout.on('data', chunk => { pending += chunk.toString(); const rows = pending.split(/\r?\n/); pending = rows.pop();
    for (const row of rows) { try { const event = JSON.parse(row); if (['IDENTITY_DIAGNOSTIC_RESULT', 'IDENTITY_DIAGNOSTIC_SHUTDOWN'].includes(event.kind)) events.push(event); } catch { /* Never forward unexpected/raw output. */ } } });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; }); child.stdin.on('error', () => {});
  options.onChild?.(child);
  const heartbeat = () => { if (!child.stdin.destroyed) child.stdin.write('HEARTBEAT\n'); };
  heartbeat(); const timer = setInterval(heartbeat, input.host.supervision.heartbeatIntervalMs);
  let stopTimer = null;
  if (options.stopAfterMs !== undefined) stopTimer = setTimeout(() => { clearInterval(timer); child.stdin.end('STOP\n'); }, options.stopAfterMs);
  if (options.loseSupervisorAfterMs !== undefined) stopTimer = setTimeout(() => { clearInterval(timer); child.stdin.end(); }, options.loseSupervisorAfterMs);
  const stop = () => { clearInterval(timer); child.stdin.end('STOP\n'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadline = setTimeout(() => { stop(); setTimeout(() => { if (child.exitCode === null) { killed = true; child.kill(); } }, input.host.supervision.shutdownWaitMs).unref(); }, 120000);
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearInterval(timer); clearTimeout(deadline); if (stopTimer) clearTimeout(stopTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  return { custody, ...outcome, killed, stderrBytes, events, taskChildExited: true };
}
module.exports = { supervise, cleanEnvironment };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input' || !path.isAbsolute(args[1])) throw Error('SUPERVISOR_EXPLICIT_INPUT_REQUIRED');
  void supervise(args[1]).then(result => { console.log(JSON.stringify(result)); process.exitCode = result.code === 0 ? 0 : 1; })
    .catch(() => { console.error('PROTECTED_IDENTITY_SUPERVISOR_REFUSED'); process.exitCode = 1; });
}
