import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PracticalShadowDiagnostics } from '../../src/integration/coindcx/live/practical-shadow-runtime';
import { PrivateStreamDiagnosticExporter } from './exporter';

/** Called only by shadow start, after its existing clean-source check. */
export function createShadowDiagnosticsFactory(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
  readonly warn: (category: string) => void;
}): (commit: string) => PracticalShadowDiagnostics | null {
  return (commit) => {
    if (options.env['LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_ENABLED'] !== 'true') return null;
    const directory = options.env['LIVE_PRACTICAL_SHADOW_DIAGNOSTICS_DIR'] ?? path.join(options.repoRoot, '.local', 'private-stream-diagnostics');
    if (!path.isAbsolute(directory)) { options.warn('CONFIG_INVALID'); return null; }
    const sessionId = randomUUID();
    let exporter: PrivateStreamDiagnosticExporter | null = null;
    return {
      config: { sessionId, sourceCommit: commit },
      start: (stream) => {
        if (exporter !== null) return;
        exporter = new PrivateStreamDiagnosticExporter({
          destination: path.join(directory, `${sessionId}.json`),
          snapshot: (reason, history) => stream.getDiagnosticsSnapshot(reason, history),
          warn: options.warn,
        });
        exporter.start();
      },
      finish: async () => { if (exporter !== null) await exporter.finish(); },
    };
  };
}
