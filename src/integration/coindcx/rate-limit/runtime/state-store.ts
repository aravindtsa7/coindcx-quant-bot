/**
 * M2 W2: durable limiter state for the installed Windows runtime (Node `fs`, synchronous I/O).
 *
 * Layout of the state directory:
 *   INSTALLATION.json   marker; written LAST by explicit initialization. Without it the directory is never treated
 *                       as fresh: open fails closed.
 *   state.slot-a        record (pre-created at initialization; never renamed or recreated)
 *   state.slot-b        record (same content as slot A after every completed commit)
 *
 * Record: magic "CDXRLJ01" | u32 BE format version | u64 BE sequence | u32 BE payload length | SHA-256 (32 bytes)
 * over all preceding header fields and the payload | UTF-8 JSON payload.
 *
 * Commit order (sequence N): write slot A in place, truncate, fsync; then write slot B in place, truncate, fsync.
 * The commit is acknowledged (returned) only after both fsyncs succeed. Consequences:
 *   - a crash or failure while writing A leaves B at N-1, the last acknowledged commit;
 *   - a crash or failure while writing B leaves A at N (complete but unacknowledged; restoring it is conservative,
 *     because grants are delivered only after acknowledgement and every release in N rests on positive evidence);
 *   - damage to one slot after a commit leaves the other slot at N.
 * Recovery therefore accepts the higher valid sequence of the two slots, or the single valid slot.
 * Fails closed: missing/invalid marker, wrong installation or pipe, incompatible version, sequence gap > 1,
 * oversized or undecodable record, or no valid slot.
 *
 * Limits (not claims): `fsync` maps to FlushFileBuffers on Windows. Durability across power loss depends on the
 * storage stack honouring that flush and is NOT verified here; tests cover process crashes and torn/corrupt files.
 * No directory fsync is possible on Windows from Node; the slot files exist from initialization onwards, so
 * commits never depend on directory-entry durability. A rename-based scheme is not used and not relied on.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const STATE_FORMAT = 'coindcx-rest-limiter-state/1';
export const MARKER_FORMAT = 'coindcx-rest-limiter-installation/1';
const MAGIC = Buffer.from('CDXRLJ01', 'ascii');
const RECORD_VERSION = 1;
const HEADER_BYTES = 8 + 4 + 8 + 4 + 32;
export const MARKER_FILE = 'INSTALLATION.json';
export const SLOT_FILES = { A: 'state.slot-a', B: 'state.slot-b' } as const;
type Slot = keyof typeof SLOT_FILES;

const hex32 = z.string().regex(/^[a-z][0-9a-f]{32}$/);
const recordSchema = z.object({
  format: z.literal(STATE_FORMAT),
  installationId: hex32,
  journalSeq: z.number().int().nonnegative().refine(Number.isSafeInteger),
  /** The W1 scheduler snapshot (validated by `restoreLimiterState`), or null only for the initial record. */
  scheduler: z.unknown(),
  clients: z.array(z.object({ clientInstanceId: hex32, resumeSecretSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
}).strict();
export type DurableRecord = z.infer<typeof recordSchema>;
const markerSchema = z.object({ format: z.literal(MARKER_FORMAT), installationId: hex32, pipePath: z.string().max(256), initialization: z.enum(['DISPOSABLE_TEST_DIRECTORY', 'NEW_READ_ONLY_CAMPAIGN']) }).strict();

export type OpenResult =
  | Readonly<{ kind: 'OPEN'; store: StateStore; record: DurableRecord; recoveredFrom: 'BOTH' | 'A_ONLY' | 'B_ONLY' }>
  | Readonly<{ kind: 'FAIL_CLOSED'; reason: string }>;
/** Test-only fault points. Production construction passes none. */
export interface StateStoreFaults { readonly beforeSlotWrite?: (slot: Slot, seq: number) => void; readonly afterSlotWrite?: (slot: Slot, seq: number) => void }

export function encodeRecord(seq: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES - 32);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(RECORD_VERSION, 8);
  header.writeBigUInt64BE(BigInt(seq), 12);
  header.writeUInt32BE(payload.length, 20);
  const digest = createHash('sha256').update(header).update(payload).digest();
  return Buffer.concat([header, digest, payload]);
}
type SlotRead = Readonly<{ kind: 'VALID'; record: DurableRecord }> | Readonly<{ kind: 'INVALID'; reason: string }> | Readonly<{ kind: 'INCOMPATIBLE'; reason: string }>;
function readSlot(file: string, maxStateBytes: number): SlotRead {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); } catch { return { kind: 'INVALID', reason: 'MISSING' }; }
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, 8).equals(MAGIC)) return { kind: 'INVALID', reason: 'HEADER' };
  if (bytes.readUInt32BE(8) !== RECORD_VERSION) return { kind: 'INCOMPATIBLE', reason: `RECORD_VERSION_${bytes.readUInt32BE(8)}` };
  const seq = bytes.readBigUInt64BE(12), length = bytes.readUInt32BE(20);
  if (length > maxStateBytes || HEADER_BYTES + length > bytes.length) return { kind: 'INVALID', reason: 'LENGTH' };
  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + length);
  const digest = createHash('sha256').update(bytes.subarray(0, HEADER_BYTES - 32)).update(payload).digest();
  if (!digest.equals(bytes.subarray(HEADER_BYTES - 32, HEADER_BYTES))) return { kind: 'INVALID', reason: 'CHECKSUM' };
  let json: unknown;
  try { json = JSON.parse(payload.toString('utf8')); } catch { return { kind: 'INVALID', reason: 'JSON' }; }
  if (typeof json === 'object' && json !== null && (json as { format?: unknown }).format !== STATE_FORMAT) return { kind: 'INCOMPATIBLE', reason: 'STATE_FORMAT' };
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success || BigInt(parsed.data.journalSeq) !== seq) return { kind: 'INVALID', reason: 'SCHEMA' };
  if ((parsed.data.scheduler === null) !== (parsed.data.journalSeq === 0)) return { kind: 'INVALID', reason: 'INITIAL_RECORD' };
  return { kind: 'VALID', record: parsed.data };
}
function writeSlot(file: string, bytes: Buffer, flags: 'r+' | 'wx'): void {
  const fd = fs.openSync(file, flags);
  try {
    for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fs.ftruncateSync(fd, bytes.length);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/**
 * Explicit initialization, permitted in this wave only for a NEW disposable test directory: the directory must not
 * exist or must be empty. Slots are written and flushed first; the marker last.
 */
export function initializeDisposableStateDirectory(directory: string, pipePath: string, installationId: string, confirmation: 'DISPOSABLE_TEST_DIRECTORY'): void {
  if (confirmation !== 'DISPOSABLE_TEST_DIRECTORY' || !hex32.safeParse(installationId).success) throw new Error('initialization refused');
  initializeStateDirectory(directory, pipePath, installationId, confirmation);
}

/** Deliberate isolated campaign initialization: a nonexistent directory only, never replacement or repair. */
export function initializeCampaignStateDirectory(directory: string, pipePath: string, installationId: string, confirmation: 'NEW_READ_ONLY_CAMPAIGN'): void {
  if (confirmation !== 'NEW_READ_ONLY_CAMPAIGN' || !hex32.safeParse(installationId).success || !path.isAbsolute(directory)
    || pipePath !== `\\\\.\\pipe\\coindcx-readonly-campaign-${installationId}` || fs.existsSync(directory)) throw new Error('campaign initialization refused');
  fs.mkdirSync(directory); // Exclusive namespace claim; parent must already exist. No repair after failure.
  initializeStateDirectory(directory, pipePath, installationId, confirmation);
}

function initializeStateDirectory(directory: string, pipePath: string, installationId: string, initialization: 'DISPOSABLE_TEST_DIRECTORY' | 'NEW_READ_ONLY_CAMPAIGN'): void {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) throw new Error('initialization refused: directory is not new or empty');
  fs.mkdirSync(directory, { recursive: true });
  const initial: DurableRecord = { format: STATE_FORMAT, installationId, journalSeq: 0, scheduler: null, clients: [] };
  const bytes = encodeRecord(0, Buffer.from(JSON.stringify(initial), 'utf8'));
  writeSlot(path.join(directory, SLOT_FILES.A), bytes, 'wx');
  writeSlot(path.join(directory, SLOT_FILES.B), bytes, 'wx');
  const marker = Buffer.from(JSON.stringify({ format: MARKER_FORMAT, installationId, pipePath, initialization }), 'utf8');
  writeSlot(path.join(directory, MARKER_FILE), marker, 'wx');
}

export function openStateStore(directory: string, pipePath: string, maxStateBytes: number, faults: StateStoreFaults = {}): OpenResult {
  const fail = (reason: string): OpenResult => Object.freeze({ kind: 'FAIL_CLOSED', reason });
  let markerJson: unknown;
  try { markerJson = JSON.parse(fs.readFileSync(path.join(directory, MARKER_FILE), 'utf8')); } catch { return fail('INSTALLATION_MARKER_MISSING_OR_UNREADABLE'); }
  const marker = markerSchema.safeParse(markerJson);
  if (!marker.success) return fail('INSTALLATION_MARKER_INVALID');
  if (marker.data.pipePath !== pipePath) return fail('PIPE_PATH_MISMATCH');
  const a = readSlot(path.join(directory, SLOT_FILES.A), maxStateBytes), b = readSlot(path.join(directory, SLOT_FILES.B), maxStateBytes);
  if (a.kind === 'INCOMPATIBLE' || b.kind === 'INCOMPATIBLE') return fail(`INCOMPATIBLE_${a.kind === 'INCOMPATIBLE' ? a.reason : (b as { reason: string }).reason}`);
  const valid = [a, b].flatMap((slot) => (slot.kind === 'VALID' ? [slot.record] : []));
  if (valid.some((record) => record.installationId !== marker.data.installationId)) return fail('INSTALLATION_MISMATCH');
  if (valid.length === 0) return fail(`NO_VALID_SLOT_${a.kind === 'INVALID' ? a.reason : ''}_${b.kind === 'INVALID' ? b.reason : ''}`);
  if (valid.length === 2 && Math.abs(valid[0]!.journalSeq - valid[1]!.journalSeq) > 1) return fail('SLOT_SEQUENCE_GAP');
  const record = valid.reduce((best, next) => (next.journalSeq > best.journalSeq ? next : best));
  const recoveredFrom = valid.length === 2 ? 'BOTH' : a.kind === 'VALID' ? 'A_ONLY' : 'B_ONLY';
  return Object.freeze({ kind: 'OPEN', store: new StateStore(directory, marker.data.installationId, record.journalSeq, maxStateBytes, faults), record, recoveredFrom });
}

export class StateStore {
  readonly #directory: string; readonly #faults: StateStoreFaults; readonly #maxStateBytes: number;
  readonly installationId: string;
  #seq: number; #failed = false;
  constructor(directory: string, installationId: string, seq: number, maxStateBytes: number, faults: StateStoreFaults) {
    this.#directory = directory; this.installationId = installationId; this.#seq = seq; this.#maxStateBytes = maxStateBytes; this.#faults = faults;
  }
  get lastSeq(): number { return this.#seq; }
  get failed(): boolean { return this.#failed; }

  /** Durable commit of the full state. Returns the committed sequence only after both slots are written and flushed. */
  commit(content: Pick<DurableRecord, 'scheduler' | 'clients'>): number {
    if (this.#failed) throw new Error('state store failed earlier; restart required');
    const seq = this.#seq + 1;
    const record: DurableRecord = { format: STATE_FORMAT, installationId: this.installationId, journalSeq: seq, scheduler: content.scheduler, clients: content.clients };
    const payload = Buffer.from(JSON.stringify(record), 'utf8');
    if (payload.length > this.#maxStateBytes) { this.#failed = true; throw new Error('state exceeds maxStateBytes'); }
    const bytes = encodeRecord(seq, payload);
    try {
      for (const slot of ['A', 'B'] as const) {
        this.#faults.beforeSlotWrite?.(slot, seq);
        writeSlot(path.join(this.#directory, SLOT_FILES[slot]), bytes, 'r+');
        this.#faults.afterSlotWrite?.(slot, seq);
      }
    } catch (error) {
      this.#failed = true; // slot contents are now uncertain: no further commits from this process
      throw error;
    }
    this.#seq = seq;
    return seq;
  }
}
