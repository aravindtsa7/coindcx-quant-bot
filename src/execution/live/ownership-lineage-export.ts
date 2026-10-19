/**
 * M4 offline ownership-lineage EXPORT (unwired): snapshot port -> offline diagnostic -> write-once package -> readback.
 *
 * - The snapshot comes from an INJECTED structural port (the repository's `readLineageDiagnosticSnapshot` satisfies
 *   it). This module constructs no repository, Prisma client or connection and reads no environment or credential.
 * - Only the allowlisted diagnostic is persisted, never the snapshot rows. Filesystem work starts only after the port
 *   has returned, i.e. after its transaction has committed.
 * - A package is a NEW directory holding exactly `lineage-diagnostic.json` and `SHA256SUMS`, which is written last and
 *   marks completion. Nothing is ever overwritten. A failed write leaves an incomplete directory that readback rejects.
 * - Readback checks the file set, the manifest digest, the diagnostic shape and its `recordSha256`. These detect
 *   accidental corruption and incomplete writes; they do not authenticate the package against a writer able to
 *   recompute both digests.
 *
 * The result is never a `SyncLineage` and this module offers no conversion; M4 lineage stays `UNAVAILABLE`.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256CanonicalJson } from '../../risk';
import {
  buildOfflineLineageDiagnostic,
  type LineageDiagnosticOrderRow,
  type OfflineLineageDiagnostic,
  type OfflineLineageDiagnosticInput,
  type OfflineLineageDiagnosticRefusalReason,
} from './ownership-lineage-diagnostic';

/** The structural snapshot port. `PrismaLiveExecutionRepository` satisfies it; nothing here imports it. */
export interface LineageSnapshotPort {
  readLineageDiagnosticSnapshot(accountId: string): Promise<Readonly<{
    accountId: string;
    orders: readonly LineageDiagnosticOrderRow[];
    findings: readonly Readonly<{ accountId: unknown; intentId: unknown; exchangeOrderId: unknown; code: unknown }>[];
    certificates: readonly Readonly<{ accountId: unknown; providerAccountFingerprint: unknown }>[];
    reconciliationState: Readonly<{ accountId: unknown; currentGeneration: unknown; healthyGeneration: unknown }> | null;
    ownershipShareCount: number;
  }>>;
}

/** The filesystem operations a package needs; `nodeLineagePackageFileSystem` is the real one. */
export interface LineagePackageFileSystem {
  /** Creates exactly this directory; fails if it exists (no recursion, no reuse). */
  makeDirectory(directory: string): Promise<void>;
  /** Creates a new file exclusively, writes it, flushes it and closes it; fails if it exists. */
  writeNewFile(file: string, text: string): Promise<void>;
  listDirectory(directory: string): Promise<readonly string[]>;
  /** Describes the entry itself (a symbolic link is not a regular file). */
  describe(file: string): Promise<Readonly<{ regularFile: boolean; size: number }>>;
  readText(file: string): Promise<string>;
}

export const nodeLineagePackageFileSystem: LineagePackageFileSystem = Object.freeze({
  async makeDirectory(directory: string): Promise<void> { await mkdir(directory, { mode: 0o700 }); },
  async writeNewFile(file: string, text: string): Promise<void> {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async listDirectory(directory: string): Promise<readonly string[]> { return readdir(directory); },
  async describe(file: string): Promise<Readonly<{ regularFile: boolean; size: number }>> {
    const stat = await lstat(file);
    return { regularFile: stat.isFile(), size: stat.size };
  },
  async readText(file: string): Promise<string> { return readFile(file, 'utf8'); },
});

export const LINEAGE_DIAGNOSTIC_FILE = 'lineage-diagnostic.json';
export const LINEAGE_MANIFEST_FILE = 'SHA256SUMS';
const REQUIRED_FILES = Object.freeze([LINEAGE_MANIFEST_FILE, LINEAGE_DIAGNOSTIC_FILE].sort());
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MANIFEST = /^([0-9a-f]{64}) {2}lineage-diagnostic\.json\n$/;
const LINEAGE_KEYS = new Set(['ownedOrders', 'ambiguousCreates', 'closedIntentTags', 'ownedPositions', 'botTagNamespace']);
const POLICY_EMPTY = JSON.stringify({
  ownedOrderLineage: { status: 'EMPTY_BY_POLICY', decision: 'D4' },
  closedIntentTagLineage: { status: 'EMPTY_BY_POLICY', decision: 'D2' },
  ownedPositionLineage: { status: 'EMPTY_BY_POLICY', decision: 'D3' },
});

export type LineagePackageRejection =
  | 'PATH_INVALID' | 'UNREADABLE' | 'INCOMPLETE' | 'FILE_SET_INVALID' | 'NOT_REGULAR_FILE' | 'TOO_LARGE'
  | 'MANIFEST_MALFORMED' | 'DIGEST_MISMATCH' | 'DIAGNOSTIC_MALFORMED' | 'RECORD_DIGEST_MISMATCH';
export type LineagePackageReadback =
  | Readonly<{ kind: 'VERIFIED'; diagnostic: OfflineLineageDiagnostic; diagnosticSha256: string }>
  | Readonly<{ kind: 'REJECTED'; reason: LineagePackageRejection }>;

export type LineagePackageWriteFailure = 'DESTINATION_INVALID' | 'DESTINATION_EXISTS' | 'DIRECTORY_CREATE_FAILED' | 'WRITE_FAILED' | 'READBACK_FAILED';
export type LineagePackageWrite =
  | Readonly<{ kind: 'WRITTEN'; directory: string; diagnosticSha256: string }>
  | Readonly<{ kind: 'WRITE_FAILED'; category: LineagePackageWriteFailure; packageState: 'NOT_CREATED' | 'INCOMPLETE_OR_UNVERIFIED' }>;

export type OfflineLineageExportResult =
  | Readonly<{ kind: 'EXPORTED'; directory: string; diagnosticSha256: string; recordSha256: string }>
  | Readonly<{ kind: 'EXPORT_REFUSED'; reason: OfflineLineageDiagnosticRefusalReason }>
  | Readonly<{ kind: 'EXPORT_FAILED'; stage: 'DESTINATION_INVALID' | 'SNAPSHOT_READ_FAILED' | 'SNAPSHOT_MALFORMED' }>
  | Readonly<{ kind: 'EXPORT_FAILED'; stage: 'PACKAGE_WRITE_FAILED'; category: LineagePackageWriteFailure; packageState: 'NOT_CREATED' | 'INCOMPLETE_OR_UNVERIFIED' }>;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validDirectory = (directory: unknown): directory is string => typeof directory === 'string' && path.isAbsolute(directory)
  && path.basename(directory).length > 0 && !directory.includes('\0');
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function hasLineageKey(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => LINEAGE_KEYS.has(key) || hasLineageKey(child));
}

/** The minimal structural re-check of a stored diagnostic; anything else is malformed. */
function wellFormedDiagnostic(value: unknown): value is OfflineLineageDiagnostic {
  if (!isRecord(value) || hasLineageKey(value)) return false;
  const candidates = value['ambiguousCreateCandidates'];
  const provenance = value['provenance'];
  const diagnostics = value['diagnostics'];
  return value['kind'] === 'OFFLINE_LINEAGE_DIAGNOSTIC' && value['use'] === 'OFFLINE_DIAGNOSTIC_ONLY'
    && value['engineInput'] === 'NOT_PERMITTED' && value['ownershipProof'] === 'NONE' && typeof value['accountId'] === 'string'
    && JSON.stringify(value['policyEmpty']) === POLICY_EMPTY
    && isRecord(candidates) && Array.isArray(candidates['entries']) && candidates['scope'] === 'SUPPLIED_SNAPSHOT_ONLY'
    && candidates['accountWideAbsence'] === 'NOT_ESTABLISHED' && candidates['evidenceUse'] === 'DIAGNOSTIC_ONLY'
    && candidates['status'] === (candidates['entries'].length > 0 ? 'ENTRIES_FOUND' : 'NONE_FOUND_IN_SNAPSHOT')
    && isRecord(diagnostics) && ['excluded', 'omitted', 'conflicts', 'unlinkedFindingCodes'].every((key) => Array.isArray(diagnostics[key]))
    && isRecord(provenance) && isRecord(provenance['callerStatements']) && isRecord(provenance['checkedOnSuppliedRows'])
    && provenance['callerStatements']['fingerprintStatements'] === 'STATEMENTS_AGREE_BINDS_NOTHING'
    && Array.isArray(provenance['notEstablished']) && provenance['notEstablished'].includes('ACCOUNT_WIDE_ABSENCE')
    && typeof value['recordSha256'] === 'string';
}

/** Reads and verifies a package. Rejection reasons are fixed codes; no content is echoed. */
export async function readLineageDiagnosticPackage(directory: string, fileSystem: LineagePackageFileSystem = nodeLineagePackageFileSystem): Promise<LineagePackageReadback> {
  const reject = (reason: LineagePackageRejection): LineagePackageReadback => Object.freeze({ kind: 'REJECTED' as const, reason });
  if (!validDirectory(directory)) return reject('PATH_INVALID');
  try {
    const names = [...await fileSystem.listDirectory(directory)].sort();
    if (!names.includes(LINEAGE_MANIFEST_FILE)) return reject('INCOMPLETE');
    if (JSON.stringify(names) !== JSON.stringify(REQUIRED_FILES)) return reject('FILE_SET_INVALID');
    for (const name of names) {
      const entry = await fileSystem.describe(path.join(directory, name));
      if (!entry.regularFile) return reject('NOT_REGULAR_FILE');
      if (entry.size > MAX_FILE_BYTES) return reject('TOO_LARGE');
    }
    const manifest = MANIFEST.exec(await fileSystem.readText(path.join(directory, LINEAGE_MANIFEST_FILE)));
    if (manifest === null) return reject('MANIFEST_MALFORMED');
    const text = await fileSystem.readText(path.join(directory, LINEAGE_DIAGNOSTIC_FILE));
    const diagnosticSha256 = sha256(text);
    if (diagnosticSha256 !== manifest[1]) return reject('DIGEST_MISMATCH');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return reject('DIAGNOSTIC_MALFORMED'); }
    if (!wellFormedDiagnostic(parsed)) return reject('DIAGNOSTIC_MALFORMED');
    const { recordSha256, ...body } = parsed;
    if (sha256CanonicalJson(body) !== recordSha256) return reject('RECORD_DIGEST_MISMATCH');
    return Object.freeze({ kind: 'VERIFIED' as const, diagnostic: deepFreeze(parsed), diagnosticSha256 });
  } catch {
    return reject('UNREADABLE');
  }
}

/** Writes a new package for one diagnostic, then verifies it by readback. Never overwrites anything. */
export async function writeLineageDiagnosticPackage(directory: string, diagnostic: OfflineLineageDiagnostic,
  fileSystem: LineagePackageFileSystem = nodeLineagePackageFileSystem): Promise<LineagePackageWrite> {
  const fail = (category: LineagePackageWriteFailure, created: boolean): LineagePackageWrite =>
    Object.freeze({ kind: 'WRITE_FAILED' as const, category, packageState: created ? 'INCOMPLETE_OR_UNVERIFIED' as const : 'NOT_CREATED' as const });
  if (!validDirectory(directory) || !wellFormedDiagnostic(diagnostic)) return fail('DESTINATION_INVALID', false);
  const text = `${JSON.stringify(diagnostic, null, 2)}\n`;
  const diagnosticSha256 = sha256(text);
  try {
    await fileSystem.makeDirectory(directory);
  } catch (error) {
    return fail(isRecord(error) && error['code'] === 'EEXIST' ? 'DESTINATION_EXISTS' : 'DIRECTORY_CREATE_FAILED', false);
  }
  try {
    await fileSystem.writeNewFile(path.join(directory, LINEAGE_DIAGNOSTIC_FILE), text);
    await fileSystem.writeNewFile(path.join(directory, LINEAGE_MANIFEST_FILE), `${diagnosticSha256}  ${LINEAGE_DIAGNOSTIC_FILE}\n`); // completion marker
  } catch {
    return fail('WRITE_FAILED', true);
  }
  const readback = await readLineageDiagnosticPackage(directory, fileSystem);
  if (readback.kind !== 'VERIFIED' || readback.diagnosticSha256 !== diagnosticSha256) return fail('READBACK_FAILED', true);
  return Object.freeze({ kind: 'WRITTEN' as const, directory, diagnosticSha256 });
}

export interface OfflineLineageExportRequest {
  readonly snapshots: LineageSnapshotPort;
  readonly accountId: string;
  readonly statements: OfflineLineageDiagnosticInput['statements'];
  /** Absolute path of the NEW package directory; its parent must already exist. */
  readonly directory: string;
  readonly fileSystem?: LineagePackageFileSystem;
}

/** Projects the snapshot onto exactly the fields the diagnostic reads; nothing else is carried forward. */
function diagnosticRows(snapshot: unknown): OfflineLineageDiagnosticInput['rows'] | null {
  if (!isRecord(snapshot)) return null;
  const { orders, findings, certificates, reconciliationState: state, ownershipShareCount } = snapshot;
  if (!Array.isArray(orders) || !Array.isArray(findings) || !Array.isArray(certificates) || !(state === null || isRecord(state))) return null;
  const pick = (row: unknown, keys: readonly string[]): unknown =>
    (isRecord(row) ? Object.freeze(Object.fromEntries(keys.map((key) => [key, row[key]]))) : row);
  return Object.freeze({
    orders: orders.map((row) => pick(row, ['intentId', 'clientOrderId', 'accountId', 'pair', 'state', 'exchangeOrderId', 'dispatchWireArmed',
      'side', 'wireOrderType', 'orderedQuantity', 'price', 'leverage'])),
    findings: findings.map((row) => pick(row, ['accountId', 'intentId', 'exchangeOrderId', 'code'])),
    certificates: certificates.map((row) => pick(row, ['accountId', 'providerAccountFingerprint'])),
    reconciliationState: state === null ? null : pick(state, ['accountId', 'currentGeneration', 'healthyGeneration']),
    ownershipShareCount,
  }) as unknown as OfflineLineageDiagnosticInput['rows'];
}

/**
 * Reads one snapshot through the port, builds the offline diagnostic and writes it as a new package. A read failure,
 * a malformed snapshot or a diagnostic refusal writes nothing; no failure echoes an error message or a row value.
 */
export async function exportOfflineLineageDiagnostic(request: OfflineLineageExportRequest): Promise<OfflineLineageExportResult> {
  const failed = (stage: 'DESTINATION_INVALID' | 'SNAPSHOT_READ_FAILED' | 'SNAPSHOT_MALFORMED'): OfflineLineageExportResult =>
    Object.freeze({ kind: 'EXPORT_FAILED' as const, stage });
  if (!isRecord(request)) return failed('DESTINATION_INVALID');
  // Read once, then validate the values actually used (a getter cannot swap the path after validation).
  const { snapshots, accountId, statements, directory, fileSystem = nodeLineagePackageFileSystem } = request;
  if (!validDirectory(directory) || typeof snapshots?.readLineageDiagnosticSnapshot !== 'function') return failed('DESTINATION_INVALID');
  let snapshot: unknown;
  try {
    snapshot = await snapshots.readLineageDiagnosticSnapshot(accountId);
  } catch {
    return failed('SNAPSHOT_READ_FAILED');
  }
  const rows = diagnosticRows(snapshot);
  if (rows === null || (snapshot as Record<string, unknown>)['accountId'] !== accountId) return failed('SNAPSHOT_MALFORMED');
  const diagnostic = buildOfflineLineageDiagnostic({ accountId, rows, statements });
  if (diagnostic.kind !== 'OFFLINE_LINEAGE_DIAGNOSTIC') return Object.freeze({ kind: 'EXPORT_REFUSED' as const, reason: diagnostic.reason });
  const written = await writeLineageDiagnosticPackage(directory, diagnostic, fileSystem);
  if (written.kind !== 'WRITTEN') {
    return Object.freeze({ kind: 'EXPORT_FAILED' as const, stage: 'PACKAGE_WRITE_FAILED' as const, category: written.category, packageState: written.packageState });
  }
  return Object.freeze({ kind: 'EXPORTED' as const, directory, diagnosticSha256: written.diagnosticSha256, recordSha256: diagnostic.recordSha256 });
}
