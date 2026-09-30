import { Worker } from 'node:worker_threads';
import { lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { incrementDiagnosticCounter } from '../../src/core/time/diagnostic-counter';
import { DIAGNOSTICS_LIMITS, EMPTY_EXPORT_HISTORY, EXPORT_FAILURES, parsePrivateStreamDiagnostics, type ExportFailure, type ExportHistory, type PrivateStreamDiagnosticsV1 } from '../../src/integration/coindcx/websocket/private-stream-diagnostics-schema';

interface Ownership { readonly dev: string; readonly ino: string }
type SnapshotSource = (reason: PrivateStreamDiagnosticsV1['snapshot']['reason'], history: ExportHistory) => PrivateStreamDiagnosticsV1 | null;
export interface DiagnosticExporterOptions {
  readonly destination: string;
  readonly snapshot: SnapshotSource;
  readonly warn: (category: ExportFailure) => void;
  /** Test-only dependency injection. No CLI option enables these. */
  readonly workerPath?: string;
  readonly testFault?: 'AFTER_OPEN' | 'AFTER_WRITE' | 'BEFORE_LINK' | 'BEFORE_REPLACE' | 'HANG_AFTER_CLOSE';
  readonly ackTimeoutMs?: number;
  readonly finalWaitMs?: number;
}

/** One in-flight export, no queue; worker failures cannot affect the shadow result. */
export class PrivateStreamDiagnosticExporter {
  readonly #options: DiagnosticExporterOptions;
  #worker: Worker | null = null;
  #timer: NodeJS.Timeout | null = null;
  #pending: { sequence: number; timer: NodeJS.Timeout; resolve: (ok: boolean) => void; temporary: Ownership | null } | null = null;
  #disabled = false;
  #finished: Promise<boolean> | null = null;
  #history: ExportHistory = { ...EMPTY_EXPORT_HISTORY };
  public constructor(options: DiagnosticExporterOptions) { this.#options = options; }
  public get history(): ExportHistory { return Object.freeze({ ...this.#history }); }
  public get busy(): boolean { return this.#pending !== null; }
  #increment(value: number): number { return incrementDiagnosticCounter(value).value; }
  #warn(category: ExportFailure): void { try { this.#options.warn(category); } catch { /* Diagnostics never throw into the CLI. */ } }
  #failure(category: ExportFailure): void {
    this.#history = { ...this.#history, failedWrites: this.#increment(this.#history.failedWrites), lastFailure: category };
    this.#warn(category);
  }
  #startWorker(): boolean {
    if (this.#disabled) return false;
    if (this.#worker !== null) return true;
    try {
      const worker = new Worker(this.#options.workerPath ?? path.join(__dirname, 'writer.mjs'), {
        env: {}, execArgv: [],
        workerData: { destination: this.#options.destination, ...(this.#options.testFault === undefined ? {} : { testFault: this.#options.testFault }) },
      });
      this.#worker = worker;
      worker.on('message', (message: unknown) => this.#message(worker, message));
      worker.on('error', () => this.#workerFailed(worker));
      worker.on('exit', () => { if (this.#worker === worker) this.#workerFailed(worker); });
      worker.unref();
      return true;
    } catch {
      this.#disabled = true;
      this.#history = { ...this.#history, workerFailures: this.#increment(this.#history.workerFailures) };
      this.#failure('WORKER_START_FAILED'); return false;
    }
  }
  #message(worker: Worker, input: unknown): void {
    if (worker !== this.#worker || typeof input !== 'object' || input === null) return;
    const message = input as Record<string, unknown>;
    const pending = this.#pending;
    if (pending === null || message['sequence'] !== pending.sequence) return;
    if (message['kind'] === 'TEMP_OWNED') {
      const ownership = message['ownership'] as Ownership | undefined;
      if (ownership !== undefined && /^\d+$/.test(ownership.dev) && /^\d+$/.test(ownership.ino)) pending.temporary = { dev: ownership.dev, ino: ownership.ino };
      return;
    }
    if (message['kind'] !== 'RESULT') return;
    clearTimeout(pending.timer); this.#pending = null;
    if (message['ok'] === true) {
      this.#history = { ...this.#history, lastAcknowledgedSnapshotSequence: pending.sequence };
      pending.resolve(true);
    } else {
      const category = EXPORT_FAILURES.includes(message['category'] as ExportFailure) ? message['category'] as ExportFailure : 'WRITE_FAILED';
      this.#failure(category);
      if (category === 'DESTINATION_EXISTS' || category === 'OWNERSHIP_LOST' || category === 'TEMP_CLEANUP_FAILED') this.#terminate();
      pending.resolve(false);
    }
  }
  #workerFailed(worker: Worker): void {
    if (worker !== this.#worker) return;
    this.#history = { ...this.#history, workerFailures: this.#increment(this.#history.workerFailures) };
    this.#failure('WORKER_EXITED'); this.#terminate();
  }
  #terminate(): void {
    const worker = this.#worker; this.#worker = null; this.#disabled = true;
    const pending = this.#pending; this.#pending = null;
    if (pending !== null) { clearTimeout(pending.timer); pending.resolve(false); }
    if (worker !== null) {
      // Termination is never awaited by transport or beyond the final deadline.
      void worker.terminate().then(async () => {
        if (pending?.temporary === null || pending?.temporary === undefined) return;
        const temporary = `${this.#options.destination}.tmp-${pending.sequence}`;
        try {
          const stat = await lstat(temporary, { bigint: true });
          if (stat.isFile() && String(stat.dev) === pending.temporary.dev && String(stat.ino) === pending.temporary.ino) await unlink(temporary);
        } catch { /* An unproven temporary artifact is preserved. */ }
      }).catch(() => {});
    }
  }
  public request(reason: PrivateStreamDiagnosticsV1['snapshot']['reason']): Promise<boolean> {
    if (this.#pending !== null) {
      this.#history = { ...this.#history, skippedRequests: this.#increment(this.#history.skippedRequests) };
      return Promise.resolve(false);
    }
    try {
      // Validate/rebuild before serialization or any file publication.
      const snapshot = parsePrivateStreamDiagnostics(this.#options.snapshot(reason, this.history));
      const text = JSON.stringify(snapshot) + '\n';
      if (Buffer.byteLength(text, 'utf8') > DIAGNOSTICS_LIMITS.snapshotBytes) { this.#failure('SIZE_LIMIT'); return Promise.resolve(false); }
      if (!this.#startWorker()) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const timeout = Math.min(DIAGNOSTICS_LIMITS.exportAckTimeoutMs, Math.max(1, this.#options.ackTimeoutMs ?? DIAGNOSTICS_LIMITS.exportAckTimeoutMs));
        const timer = setTimeout(() => {
          this.#history = { ...this.#history, ackTimeouts: this.#increment(this.#history.ackTimeouts) };
          this.#failure('ACK_TIMEOUT'); this.#terminate();
        }, timeout);
        this.#pending = { sequence: snapshot.snapshot.sequence, timer, resolve, temporary: null };
        try { this.#worker!.postMessage({ sequence: snapshot.snapshot.sequence, text }); }
        catch { this.#failure('WORKER_EXITED'); this.#terminate(); }
      });
    } catch { this.#failure('SNAPSHOT_INVALID'); return Promise.resolve(false); }
  }
  public start(): void {
    if (this.#timer !== null || this.#finished !== null) return;
    void this.request('START');
    this.#timer = setInterval(() => { void this.request('PERIODIC'); }, DIAGNOSTICS_LIMITS.exportIntervalMs);
    this.#timer.unref();
  }
  public finish(): Promise<boolean> {
    this.#finished ??= this.#finish();
    return this.#finished;
  }
  async #finish(): Promise<boolean> {
    if (this.#timer !== null) { clearInterval(this.#timer); this.#timer = null; }
    if (this.#pending !== null) {
      this.#history = { ...this.#history, finalUnconfirmed: true };
      this.#failure('FINAL_BUSY'); this.#terminate(); return false;
    }
    let deadline: NodeJS.Timeout | undefined;
    const published = await Promise.race([
      this.request('FINAL'),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => {
          this.#history = { ...this.#history, finalUnconfirmed: true };
          this.#failure('FINAL_FLUSH_TIMEOUT'); this.#terminate(); resolve(false);
        }, Math.min(DIAGNOSTICS_LIMITS.finalFlushTimeoutMs, Math.max(1, this.#options.finalWaitMs ?? DIAGNOSTICS_LIMITS.finalFlushTimeoutMs)));
      }),
    ]);
    if (deadline !== undefined) clearTimeout(deadline);
    if (!published) { this.#history = { ...this.#history, finalUnconfirmed: true }; this.#warn(this.#history.lastFailure ?? 'WRITE_FAILED'); }
    this.#terminate(); return published;
  }
}
