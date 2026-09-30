import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable } from './support/import-graph';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const recorder = 'src/integration/coindcx/websocket/private-stream-diagnostics.ts';
const schema = 'src/integration/coindcx/websocket/private-stream-diagnostics-schema.ts';
describe('observational diagnostics cannot reach authority or historical shadow storage', () => {
  it('recorder/schema runtime dependencies are only local diagnostics and independent core clock/counter helpers', () => {
    const { graph } = buildImportGraph(path.join(root, 'src'), root);
    expect([...new Set([recorder, ...computeReachable(graph, recorder)])].sort()).toEqual([
      'src/core/time/diagnostic-clock.ts', 'src/core/time/diagnostic-counter.ts', recorder, schema,
    ].sort());
  });
  it('preserves the exact existing seven listeners and never resets the reconciliation latch', () => {
    const stream = read('src/integration/coindcx/websocket/private-stream.ts');
    expect([...stream.matchAll(/socket\.on\('([^']+)'/g)].map(match => match[1])).toEqual(['connect', 'disconnect', 'connect_error', 'error', 'df-position-update', 'df-order-update', 'balance-update']);
    expect(stream.match(/#reconciliationRequired = false/g)).toHaveLength(1);
    expect(stream).not.toMatch(/socket\.on\('(?:ack|authenticated|subscribed|subscription-confirmed)'/);
  });
  it('worker has no transport, database, shadow collector or authority imports; coordinator workers inherit no environment', () => {
    const worker = read('scripts/private-stream-diagnostics/writer.mjs');
    expect([...worker.matchAll(/from '([^']+)'/g)].map(match => match[1])).toEqual(['node:fs/promises', 'node:path', 'node:worker_threads']);
    expect(read('scripts/private-stream-diagnostics/exporter.ts')).toContain('env: {}, execArgv: []');
    for (const file of [recorder, schema, 'scripts/private-stream-diagnostics/exporter.ts', 'scripts/private-stream-diagnostics/writer.mjs']) {
      expect(read(file)).not.toMatch(/PrismaClient|process\.env|createOrder|cancelOrder|releaseLease|startCertification|provesAccountContinuity: true/);
    }
  });
});
