import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256CanonicalJson } from '../risk/canonical';
import type { PracticalBacktestReport } from '../integration/coindcx/live/practical-backtest-runner';
import type { PracticalBotRunReport } from '../integration/coindcx/live/practical-bot-orchestrator';
import { evidenceDigest } from './evidence';

export interface ReportEvidence { id: string; kind: string; title: string; timestamp: string; source: string;
  sha256: string | null; integrity: 'VERIFIED' | 'DIGEST_ONLY' | 'FAILED' }

export class DashboardReportStore {
  public constructor(readonly root: string) {}
  async #write(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, file);
    }
    finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  async #read(file: string): Promise<unknown> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) throw new Error('REPORT_UNAVAILABLE');
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  }
  public async loadShadow(): Promise<PracticalBotRunReport | null> {
    try {
      const raw = await this.#read(path.join(this.root, 'bot-shadow-risk-report.json')) as PracticalBotRunReport;
      return raw && ['SHADOW', 'DRY_RUN', 'TINY_LIVE'].includes(raw.mode) && Array.isArray(raw.cycles) && raw.account ? raw : null;
    } catch { return null; }
  }
  public async saveBacktest(report: PracticalBacktestReport): Promise<void> {
    if (!/^bt-[a-f0-9]{24}$/.test(report.runId)) throw new Error('INVALID_REPORT_ID');
    await this.#write(path.join(this.root, 'backtest-reports', `${report.runId}.json`), report);
    await this.#seal('backtest-reports', report.runId, report);
  }
  public async saveShadow(report: PracticalBotRunReport): Promise<string> {
    const savedAtIso = new Date().toISOString();
    const runId = `sh-${sha256CanonicalJson(JSON.stringify({ savedAtIso, report })).slice(0, 24)}`;
    const archive = { runId, savedAtIso, report };
    await this.#write(path.join(this.root, 'shadow-reports', `${runId}.json`), archive);
    await this.#seal('shadow-reports', runId, archive);
    await this.#write(path.join(this.root, 'bot-shadow-risk-report.json'), report);
    await this.#write(path.join(this.root, 'bot-shadow-risk-report.integrity.json'), { algorithm: 'SHA-256', sha256: evidenceDigest(report) });
    return runId;
  }
  public async read(id: string): Promise<unknown> {
    if (id === 'latest-shadow') return this.#read(path.join(this.root, 'bot-shadow-risk-report.json'));
    if (!/^(bt|sh)-[a-f0-9]{24}$/.test(id)) throw new Error('INVALID_REPORT_ID');
    return this.#read(path.join(this.root, id.startsWith('bt-') ? 'backtest-reports' : 'shadow-reports', `${id}.json`));
  }
  async #seal(dir: string, id: string, report: unknown): Promise<void> {
    await this.#write(path.join(this.root, dir, `${id}.integrity.json`), { algorithm: 'SHA-256', sha256: evidenceDigest(report) });
  }
  public async inspect(id: string): Promise<ReportEvidence> {
    const dir = id.startsWith('bt-') ? 'backtest-reports' : 'shadow-reports';
    const source = id === 'latest-shadow' ? '.local/bot-shadow-risk-report.json' : `.local/${dir}/${id}.json`;
    const base: ReportEvidence = { id, kind: id.startsWith('bt-') ? 'BACKTEST' : 'SHADOW', title: id, timestamp: '', source, sha256: null, integrity: 'FAILED' };
    try {
      const raw = await this.read(id) as Record<string, unknown>, report = (raw['report'] ?? raw) as Record<string, unknown>;
      const sha256 = evidenceDigest(raw), timestamp = String(raw['savedAtIso'] ?? raw['completedAtIso'] ?? '');
      const manifestFile = id === 'latest-shadow' ? path.join(this.root, 'bot-shadow-risk-report.integrity.json') : path.join(this.root, dir, `${id}.integrity.json`);
      let integrity: ReportEvidence['integrity'];
      try { const seal = await this.#read(manifestFile) as Record<string, unknown>;
        integrity = seal['algorithm'] === 'SHA-256' && seal['sha256'] === sha256 ? 'VERIFIED' : 'FAILED';
      } catch (error) { integrity = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'DIGEST_ONLY' : 'FAILED'; }
      if (id !== 'latest-shadow' && raw['runId'] !== id) integrity = 'FAILED';
      return { ...base, title: `${String(report['pair'] ?? report['strategy'] ?? 'Shadow observation')} · ${id}`, sha256, timestamp, integrity };
    } catch { return base; }
  }
  public async inventory(): Promise<ReportEvidence[]> {
    const evidence: ReportEvidence[] = [];
    for (const dir of ['backtest-reports', 'shadow-reports']) {
      const files = await fs.readdir(path.join(this.root, dir)).catch(() => [] as string[]);
      for (const file of files.filter(f => /^(bt|sh)-[a-f0-9]{24}\.json$/.test(f))) evidence.push(await this.inspect(file.slice(0, -5)));
    }
    if (!evidence.some(e => e.kind === 'SHADOW')) {
      try { await fs.lstat(path.join(this.root, 'bot-shadow-risk-report.json')); evidence.push(await this.inspect('latest-shadow')); } catch { /* No shadow evidence retained. */ }
    }
    return evidence.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  public async list(): Promise<readonly { runId: string; mode: string; savedAtIso: string; summary: unknown; pair?: string; config?: PracticalBacktestReport['config'] }[]> {
    const reports: { runId: string; mode: string; savedAtIso: string; summary: unknown; pair?: string; config?: PracticalBacktestReport['config'] }[] = [];
    for (const dir of ['backtest-reports', 'shadow-reports']) {
      const entries = await fs.readdir(path.join(this.root, dir)).catch(() => [] as string[]);
      for (const file of entries.filter(f => /^(bt|sh)-[a-f0-9]{24}\.json$/.test(f))) {
        try {
          const raw = await this.read(file.slice(0, -5)) as Record<string, unknown>;
          const report = (raw['report'] ?? raw) as Record<string, unknown>;
          reports.push({ runId: file.slice(0, -5), mode: String(report['mode']), savedAtIso: String(raw['savedAtIso'] ?? raw['completedAtIso']),
            ...(report['mode'] === 'BACKTEST' ? { pair: String(report['pair']), config: report['config'] as PracticalBacktestReport['config'] } : {}),
            summary: report['summary'] ?? { status: report['status'], strategy: report['strategy'], ordersSubmitted: report['ordersSubmitted'] } });
        } catch { /* Ignore partial/corrupt reports without hiding the rest of the history. */ }
      }
    }
    const latest = await this.loadShadow();
    if (latest) reports.push({ runId: 'latest-shadow', mode: latest.mode, savedAtIso: (await fs.stat(path.join(this.root, 'bot-shadow-risk-report.json'))).mtime.toISOString(),
      summary: { status: latest.status, strategy: latest.strategy, ordersSubmitted: latest.ordersSubmitted } });
    return reports.sort((a, b) => b.savedAtIso.localeCompare(a.savedAtIso));
  }
}
