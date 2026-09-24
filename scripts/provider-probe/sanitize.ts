/**
 * READ-ONLY CoinDCX provider probe: sanitization.
 *
 * Nothing the provider returns is written out raw. Headers are reduced to
 * names plus values only for a fixed set of clearly non-secret headers;
 * payloads are reduced to key paths, types, counts, and shapes; identifiers
 * are reduced to SHA-256 digests. Every artifact and log line is finally swept
 * against a registry of known-sensitive strings, and the probe refuses to
 * write anything that still contains one: the API key, API secret, and every
 * generated signature are force-registered at any length; provider
 * identifiers and PII are registered on a bounded, length-filtered,
 * defense-in-depth basis.
 */
import { createHash } from 'node:crypto';
import { isLosslessNumber } from 'lossless-json';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Never recorded, not even as a shape: authentication and cookie material. */
const SUPPRESSED_HEADER = /^(set-cookie|cookie|authorization|proxy-authorization|www-authenticate|x-auth-.*|x-api-key|x-amz-security-token)$/i;

/** Clearly non-secret headers whose value is recorded (truncated). */
const VALUE_SAFE_HEADERS = new Set([
  'date', 'content-type', 'content-length', 'content-encoding', 'cache-control', 'last-modified',
  'age', 'vary', 'server', 'via', 'expires', 'pragma', 'connection', 'transfer-encoding', 'keep-alive',
  'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'x-xss-protection',
  'cf-cache-status', 'x-cache', 'retry-after', 'access-control-allow-origin', 'referrer-policy',
]);

const CANDIDATE_HEADER = /etag|revision|version|sequence|seq|cursor|snapshot|watermark|event|update|generation|session|connection|last-modified|date|request-id|trace-id/i;

export type HeaderTreatment = 'SUPPRESSED' | 'VALUE_RECORDED' | 'SHAPE_ONLY' | 'NAME_ONLY';

export interface SanitizedHeader {
  readonly name: string;
  readonly treatment: HeaderTreatment;
  readonly candidate: boolean;
  readonly value?: string;
  readonly shape?: ValueShape;
}

export interface ValueShape {
  readonly length: number;
  readonly charset: 'DIGITS' | 'HEX' | 'ALNUM' | 'OTHER';
  readonly digest12: string;
}

export function valueShape(value: string): ValueShape {
  const charset = /^\d+$/.test(value) ? 'DIGITS' : /^[0-9a-f]+$/i.test(value) ? 'HEX' : /^[0-9a-z_-]+$/i.test(value) ? 'ALNUM' : 'OTHER';
  return { length: value.length, charset, digest12: sha256Hex(value).slice(0, 12) };
}

export function sanitizeHeaders(headers: Readonly<Record<string, string | readonly string[] | number | undefined>>): readonly SanitizedHeader[] {
  const out: SanitizedHeader[] = [];
  for (const rawName of Object.keys(headers).sort()) {
    const name = rawName.toLowerCase();
    const raw = headers[rawName];
    const value = Array.isArray(raw) ? raw.join(', ') : raw === undefined ? '' : String(raw);
    const candidate = CANDIDATE_HEADER.test(name) || name.startsWith('x-');
    if (SUPPRESSED_HEADER.test(name)) {
      out.push({ name, treatment: 'SUPPRESSED', candidate });
    } else if (VALUE_SAFE_HEADERS.has(name)) {
      out.push({ name, treatment: 'VALUE_RECORDED', candidate, value: value.slice(0, 200) });
    } else if (candidate) {
      out.push({ name, treatment: 'SHAPE_ONLY', candidate, shape: valueShape(value) });
    } else {
      out.push({ name, treatment: 'NAME_ONLY', candidate });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload structure
// ---------------------------------------------------------------------------

export type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export function kindOf(value: unknown): JsonKind {
  if (value === null || value === undefined) return 'null';
  if (isLosslessNumber(value) || typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

/** String form of a scalar, with lossless numbers kept exact. */
export function scalarText(value: unknown): string | null {
  if (isLosslessNumber(value)) return (value as { value: string }).value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  return null;
}

const MAX_DEPTH = 12;
const MAX_ARRAY_ITEMS = 50;

export interface LeafVisit {
  readonly path: string;
  readonly key: string;
  readonly value: unknown;
}

/** Walks every node, arrays as `[]`, bounded in depth and array width. */
export function walk(value: unknown, visit: (node: LeafVisit) => void, path = '$', key = '$', depth = 0): void {
  visit({ path, key, value });
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object' || isLosslessNumber(value)) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) walk(item, visit, `${path}[]`, key, depth + 1);
    return;
  }
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    walk(child, visit, `${path}.${childKey}`, childKey, depth + 1);
  }
}

export interface KeyPath {
  readonly path: string;
  readonly types: readonly JsonKind[];
}

export function enumerateKeyPaths(value: unknown): readonly KeyPath[] {
  const paths = new Map<string, Set<JsonKind>>();
  walk(value, ({ path, value: node }) => {
    const types = paths.get(path) ?? new Set<JsonKind>();
    types.add(kindOf(node));
    paths.set(path, types);
  });
  return [...paths.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, types]) => ({ path, types: [...types].sort() }));
}

export function structureSha256(value: unknown): string {
  return sha256Hex(enumerateKeyPaths(value).map((entry) => `${entry.path}:${entry.types.join('|')}`).join('\n'));
}

// ---------------------------------------------------------------------------
// Continuity-candidate fields
// ---------------------------------------------------------------------------

/** Normalized (lowercase, no `_`/`-`) key names that could carry ordering or session semantics. */
export const CANDIDATE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'sequence', 'seq', 'seqnum', 'sequencenumber', 'revision', 'rev', 'version', 'vs', 'cursor', 'nextcursor',
  'snapshot', 'snapshotid', 'watermark', 'eventid', 'updateid', 'previousupdateid', 'lastupdateid', 'offset',
  'nonce', 'generation', 'sessionid', 'connectionid', 'socketid', 'lasteventid', 'asof', 'servertime',
  'resumetoken', 'replay', 'epoch', 'etag',
]);

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isCandidateField(key: string): boolean {
  return CANDIDATE_FIELD_NAMES.has(normalizeKey(key));
}

export interface CandidateFieldSummary {
  readonly scope: string;
  readonly path: string;
  readonly occurrences: number;
  readonly types: readonly JsonKind[];
  readonly distinctValues: number;
  readonly numericDigitCounts: readonly number[];
  /** Across occurrences in observation order; null when not every value was numeric. */
  readonly numericNonDecreasing: boolean | null;
  readonly classification: 'OBSERVED';
  readonly note: 'NAME_MATCH_ONLY_SEMANTICS_UNVERIFIED';
}

/** Tracks candidate values in memory only; only derived summaries are ever serialized. */
export class CandidateTracker {
  readonly #series = new Map<string, { scope: string; path: string; types: Set<JsonKind>; values: string[] }>();

  public observe(scope: string, value: unknown): void {
    walk(value, ({ path, key, value: node }) => {
      if (!isCandidateField(key)) return;
      const id = `${scope}\u0000${path}`;
      const entry = this.#series.get(id) ?? { scope, path, types: new Set<JsonKind>(), values: [] };
      entry.types.add(kindOf(node));
      entry.values.push(scalarText(node) ?? `<${kindOf(node)}>`);
      this.#series.set(id, entry);
    });
  }

  public summarize(): readonly CandidateFieldSummary[] {
    return [...this.#series.values()].map((entry) => {
      const numeric = entry.values.every((value) => /^-?\d+$/.test(value));
      let nonDecreasing: boolean | null = null;
      if (numeric) {
        nonDecreasing = entry.values.every((value, index) => index === 0 || BigInt(value) >= BigInt(entry.values[index - 1]!));
      }
      return {
        scope: entry.scope,
        path: entry.path,
        occurrences: entry.values.length,
        types: [...entry.types].sort(),
        distinctValues: new Set(entry.values).size,
        numericDigitCounts: numeric ? [...new Set(entry.values.map((value) => value.replace('-', '').length))].sort((a, b) => a - b) : [],
        numericNonDecreasing: nonDecreasing,
        classification: 'OBSERVED' as const,
        note: 'NAME_MATCH_ONLY_SEMANTICS_UNVERIFIED' as const,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

export type TimestampUnit =
  | 'SECONDS' | 'SECONDS_FRACTIONAL' | 'MILLISECONDS' | 'MICROSECONDS' | 'NANOSECONDS'
  | 'ISO_8601_STRING' | 'UNCLASSIFIED';

const TIMESTAMP_KEY = /(^|_)(at|time|timestamp|ts|date)$|(At|Time|Timestamp)$/;

export function isTimestampKey(key: string): boolean {
  return TIMESTAMP_KEY.test(key);
}

/** Magnitude-based unit guess. OBSERVED behavior only, never a provider guarantee. */
export function classifyTimestamp(value: unknown): TimestampUnit {
  const text = scalarText(value);
  if (text === null) return 'UNCLASSIFIED';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return 'ISO_8601_STRING';
  if (/^\d{9,10}\.\d+$/.test(text)) return 'SECONDS_FRACTIONAL';
  if (!/^\d+$/.test(text)) return 'UNCLASSIFIED';
  const digits = text.length;
  if (digits === 9 || digits === 10) return 'SECONDS';
  if (digits === 12 || digits === 13) return 'MILLISECONDS';
  if (digits === 15 || digits === 16) return 'MICROSECONDS';
  if (digits === 18 || digits === 19) return 'NANOSECONDS';
  return 'UNCLASSIFIED';
}

export interface TimestampFieldSummary {
  readonly scope: string;
  readonly path: string;
  readonly units: Readonly<Record<string, number>>;
}

export class TimestampTracker {
  readonly #fields = new Map<string, { scope: string; path: string; units: Map<TimestampUnit, number> }>();

  public observe(scope: string, value: unknown): void {
    walk(value, ({ path, key, value: node }) => {
      if (!isTimestampKey(key) || kindOf(node) === 'object' || kindOf(node) === 'array' || kindOf(node) === 'null') return;
      const id = `${scope}\u0000${path}`;
      const entry = this.#fields.get(id) ?? { scope, path, units: new Map<TimestampUnit, number>() };
      const unit = classifyTimestamp(node);
      entry.units.set(unit, (entry.units.get(unit) ?? 0) + 1);
      this.#fields.set(id, entry);
    });
  }

  public summarize(): readonly TimestampFieldSummary[] {
    return [...this.#fields.values()].map((entry) => ({
      scope: entry.scope,
      path: entry.path,
      units: Object.fromEntries([...entry.units.entries()].sort()),
    }));
  }
}

// ---------------------------------------------------------------------------
// /users/info
// ---------------------------------------------------------------------------

export interface UserInfoObservation {
  readonly shape: 'OBJECT' | 'ARRAY' | 'OTHER';
  readonly arrayLength: number | null;
  readonly cardinalityExpected: boolean;
  readonly coindcxIdPresent: boolean;
  readonly coindcxIdSha256: string | null;
  /** Field NAMES only; values are never recorded. */
  readonly fieldNames: readonly string[];
}

/** Keys whose values are personal or identifying and must never leave memory. */
const SENSITIVE_KEY = /coindcx_id|email|mobile|phone|^(name|first_name|last_name|full_name|username|user_name|display_name)$|address|^pan|aadhar|aadhaar|dob|birth|referral|^id$|_id$/i;

export function analyzeUserInfo(data: unknown, registry: SecretRegistry): UserInfoObservation {
  registerSensitiveLeaves(data, registry);
  const shape = Array.isArray(data) ? 'ARRAY' as const : data !== null && typeof data === 'object' ? 'OBJECT' as const : 'OTHER' as const;
  const arrayLength = Array.isArray(data) ? data.length : null;
  const record = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const rawId = record !== undefined && record !== null && typeof record === 'object' ? scalarText(record['coindcx_id']) : null;
  return {
    shape,
    arrayLength,
    cardinalityExpected: shape === 'OBJECT' || (shape === 'ARRAY' && arrayLength === 1),
    coindcxIdPresent: rawId !== null && rawId !== '',
    coindcxIdSha256: rawId === null || rawId === '' ? null : sha256Hex(rawId),
    fieldNames: record !== undefined && record !== null && typeof record === 'object' ? Object.keys(record).sort() : [],
  };
}

/**
 * Registers identifying/PII leaf values for the final sweep. Bounded defense in
 * depth: the scan stops at MAX_DEPTH / MAX_ARRAY_ITEMS and skips short values,
 * so it is not a guarantee; the primary control is that raw provider payload
 * values are never serialized into artifacts.
 */
export function registerSensitiveLeaves(data: unknown, registry: SecretRegistry): void {
  walk(data, ({ key, value }) => {
    if (!SENSITIVE_KEY.test(key)) return;
    const text = scalarText(value);
    if (text !== null) registry.addProviderValue(`value-of:${key}`, text);
  });
}

// ---------------------------------------------------------------------------
// Secret registry and final sweep
// ---------------------------------------------------------------------------

/**
 * Minimum lengths for PROVIDER-DERIVED values only (`addProviderValue`): a
 * short provider value (an id, a status-like string) would also occur by
 * chance in legitimate artifact text, and an all-hex or all-digit one inside
 * the many SHA-256 digests, making the sweep refuse clean artifacts. The probe
 * never serializes raw provider payload values at all, so for these the sweep
 * is bounded defense in depth. Explicit credentials and signatures never go
 * through this heuristic: `addSecret` registers them at any length.
 */
export const MIN_SWEEP_TOKEN_LENGTH = 6;
export const MIN_HEX_SWEEP_TOKEN_LENGTH = 12;

/** Redaction markers, tried in order; the first containing no registered secret is used ('' always qualifies). */
const REDACTION_FALLBACK_MARKERS = ['<redacted>', '###', '***', '~~~', ''];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SecretRegistry {
  readonly #tokens = new Map<string, string>();

  /**
   * Explicit credential material (API key, API secret, every generated HMAC
   * signature): registered whenever non-empty, regardless of length, so the
   * sweep and redaction can never skip it.
   */
  public addSecret(label: string, value: string | undefined): void {
    if (typeof value !== 'string' || value === '') return;
    this.#tokens.set(value, label);
  }

  /** Provider-derived identifying values: registered only above the false-positive length floor. */
  public addProviderValue(label: string, value: string | undefined): void {
    if (typeof value !== 'string') return;
    const minimum = /^[0-9a-f]+$/i.test(value) ? MIN_HEX_SWEEP_TOKEN_LENGTH : MIN_SWEEP_TOKEN_LENGTH;
    if (value.length < minimum) return;
    if (!this.#tokens.has(value)) this.#tokens.set(value, label);
  }

  /** Labels (never values) of every registered secret found in `text`. */
  public findIn(text: string): readonly string[] {
    const found: string[] = [];
    for (const [value, label] of this.#tokens) if (text.includes(value)) found.push(label);
    return found;
  }

  /**
   * Replaces every registered value in one pass, longest first. A marker is
   * never allowed to reintroduce a registered value (a one-character secret
   * could occur inside `<redacted:api-key>`), and if a value still survives,
   * for example spanning a marker boundary, the whole text is replaced.
   */
  public redact(text: string): string {
    if (this.#tokens.size === 0) return text;
    const pattern = new RegExp([...this.#tokens.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g');
    const out = text.replace(pattern, (match) => this.#marker(this.#tokens.get(match) ?? 'secret'));
    return this.findIn(out).length === 0 ? out : this.#marker('unsafe-text');
  }

  #marker(label: string): string {
    for (const marker of [`<redacted:${label.replace(/:.*/, '')}>`, ...REDACTION_FALLBACK_MARKERS]) {
      if (this.findIn(marker).length === 0) return marker;
    }
    return '';
  }

  public get size(): number {
    return this.#tokens.size;
  }
}
