import fs from 'node:fs';
import path from 'node:path';
import type { SyncReadCampaignDependencies } from '../../src/integration/coindcx/live/sync-read-campaign';

/** Local, non-overwriting sink. OS ownership/ACL and storage durability still need operator review. */
export function writeNewJson(file: string, value: unknown): void {
  if (!path.isAbsolute(file)) throw new Error('ABSOLUTE_REPORT_PATH_REQUIRED');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export const localReportSink: NonNullable<SyncReadCampaignDependencies['reportSink']> = Object.freeze({
  async write(destination, report) { writeNewJson(destination.path, report); },
});
