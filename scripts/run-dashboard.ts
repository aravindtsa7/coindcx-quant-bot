import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadCoinProfiles } from '../src/app/config/coins';
import { createDashboardServer } from '../src/dashboard/server';
import { startPracticalReadRuntime } from './practical-read-runtime';

async function main(): Promise<void> {
  const value = process.env['DASHBOARD_PORT'] ?? '4173';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('INVALID_DASHBOARD_PORT');
  const runtime = await startPracticalReadRuntime();
  try {
    const dashboard = await createDashboardServer({ ...runtime, profiles: loadCoinProfiles(), budgetStats: runtime.stats,
      redactValues: [process.env['DATABASE_URL'] ?? ''], storageStatus: { mysqlConfigured: /^mysql:\/\//.test(process.env['DATABASE_URL'] ?? ''),
        prismaSchemaPresent: existsSync(path.resolve(__dirname, '../prisma/schema.prisma')) },
      reportDirectory: path.resolve(__dirname, '../.local'), publicDirectory: path.resolve(__dirname, '../src/dashboard/public') });
    const server = dashboard.app.listen(Number(value), '127.0.0.1');
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => closePromise ??= (async () => {
      await dashboard.stop();
      try {
        await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
      } finally {
        try { await runtime.close(); }
        finally {
          process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
          if (process.connected) process.disconnect();
        }
      }
    })();
    const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    console.log(`CoinDCX dashboard http://127.0.0.1:${value} | SHADOW / BACKTEST | LIVE LOCKED`);
    // Test/automation seam: invoke the same graceful shutdown on Windows, where POSIX signals are unavailable.
    process.on('message', message => { if (message === 'shutdown') onSignal(); });
  } catch (error) { await runtime.close(); throw error; }
}
if (require.main === module) void main().catch(() => { console.error('DASHBOARD_START_FAILED'); process.exitCode = 1; });
