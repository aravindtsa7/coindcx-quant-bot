/**
 * M2 W1: Retry-After interpretation (design V3 §5.1). Pure; no clock reads.
 * Accepts delay-seconds and all three RFC 9110 HTTP-date forms (IMF-fixdate, obsolete RFC 850, obsolete asctime).
 * A present value that cannot be parsed, an overflowing value, and a date that cannot be converted with a trusted
 * reference all fail closed (UNBOUNDED). The configured no-header default applies only when the header is ABSENT.
 */
import type { RetryAfterPolicy } from './config';

export type HttpDateForm = 'IMF' | 'RFC850' | 'ASCTIME';
export type HttpDateParse =
  | Readonly<{ kind: 'DATE'; form: HttpDateForm; wallMs: number }>
  | Readonly<{ kind: 'TWO_DIGIT_YEAR_UNRESOLVED' }>
  | Readonly<{ kind: 'INVALID'; reason: 'SYNTAX' | 'FIELD_RANGE' | 'CALENDAR' | 'WEEKDAY_MISMATCH' }>;
export type RetryAfterParse =
  | Readonly<{ kind: 'ABSENT' }>
  | Readonly<{ kind: 'SECONDS'; waitMs: number }>
  | Readonly<{ kind: 'OVERFLOW' }>
  | HttpDateParse;
export type ServerWaitBound =
  | Readonly<{ kind: 'DEFAULT'; waitMs: number }>
  | Readonly<{ kind: 'RELATIVE'; waitMs: number; form: 'SECONDS' | HttpDateForm }>
  | Readonly<{ kind: 'UNBOUNDED'; alert: 'RETRY_AFTER_OVERFLOW' | 'RETRY_AFTER_PRESENT_BUT_UNPARSEABLE' | 'DATE_CONVERSION_UNCERTAIN' }>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAYL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MON = MONTHS.join('|');
// HTTP-date is case-sensitive (RFC 9110 §5.6.7).
const IMF = new RegExp(`^(${DAY3.join('|')}), (\\d{2}) (${MON}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`);
const RFC850 = new RegExp(`^(${DAYL.join('|')}), (\\d{2})-(${MON})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`);
const ASCTIME = new RegExp(`^(${DAY3.join('|')}) (${MON}) ( \\d|\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`);

function build(form: HttpDateForm, dayName: string, dayNames: readonly string[], day: string, month: string, year: number, hh: string, mm: string, ss: string): HttpDateParse {
  const d = Number(day), m = MONTHS.indexOf(month as (typeof MONTHS)[number]), h = Number(hh), mi = Number(mm), s = Number(ss);
  if (h > 23 || mi > 59 || s > 60 || d < 1) return Object.freeze({ kind: 'INVALID', reason: 'FIELD_RANGE' });
  const dayStart = Date.UTC(year, m, d);
  const check = new Date(dayStart);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== m || check.getUTCDate() !== d) return Object.freeze({ kind: 'INVALID', reason: 'CALENDAR' });
  if (dayNames[check.getUTCDay()] !== dayName) return Object.freeze({ kind: 'INVALID', reason: 'WEEKDAY_MISMATCH' });
  // Second 60 (leap second) rolls forward: later, therefore conservative for a wait bound.
  return Object.freeze({ kind: 'DATE', form, wallMs: dayStart + ((h * 60 + mi) * 60 + s) * 1000 });
}

/**
 * Parses one HTTP-date. `referenceYear` resolves an RFC 850 two-digit year: a year more than 50 years after the
 * reference means the most recent past year with those digits. Without a trusted reference the RFC 850 form is
 * reported as TWO_DIGIT_YEAR_UNRESOLVED (never guessed).
 */
export function parseHttpDate(value: string, referenceYear: number | null): HttpDateParse {
  let match = IMF.exec(value);
  if (match) return build('IMF', match[1]!, DAY3, match[2]!, match[3]!, Number(match[4]), match[5]!, match[6]!, match[7]!);
  match = RFC850.exec(value);
  if (match) {
    if (referenceYear === null) return Object.freeze({ kind: 'TWO_DIGIT_YEAR_UNRESOLVED' });
    let year = Math.floor(referenceYear / 100) * 100 + Number(match[4]);
    if (year > referenceYear + 50) year -= 100;
    return build('RFC850', match[1]!, DAYL, match[2]!, match[3]!, year, match[5]!, match[6]!, match[7]!);
  }
  match = ASCTIME.exec(value);
  if (match) return build('ASCTIME', match[1]!, DAY3, match[3]!.trim(), match[2]!, Number(match[7]), match[4]!, match[5]!, match[6]!);
  return Object.freeze({ kind: 'INVALID', reason: 'SYNTAX' });
}

export function parseRetryAfter(value: string | undefined, referenceYear: number | null): RetryAfterParse {
  if (value === undefined) return Object.freeze({ kind: 'ABSENT' });
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(seconds * 1000) ? Object.freeze({ kind: 'SECONDS', waitMs: seconds * 1000 }) : Object.freeze({ kind: 'OVERFLOW' });
  }
  return parseHttpDate(trimmed, referenceYear);
}

export interface RetryAfterContext {
  /** Raw Retry-After value, or undefined when the header was absent. */
  readonly retryAfter: string | undefined;
  /** Raw server Date header, when present. */
  readonly serverDate: string | undefined;
  /** Local wall clock at receipt. Used only when `localClockTrusted` (U-M2-11; default: not trusted). */
  readonly receiptWallMs: number | null;
  readonly localClockTrusted: boolean;
}

/**
 * Converts a 429's Retry-After into a relative wait measured from local receipt (design V3 §5.1).
 * Date candidates: (a) Retry-After minus the server Date header (server-clock arithmetic);
 * (b) Retry-After minus the local receipt wall time, only for a declared-trusted local clock.
 * No candidate -> UNBOUNDED (DATE_CONVERSION_UNCERTAIN). Never falls back to the no-header default.
 */
export function serverWaitBound(context: RetryAfterContext, policy: RetryAfterPolicy): ServerWaitBound {
  const trustedWall = context.localClockTrusted && context.receiptWallMs !== null && Number.isSafeInteger(context.receiptWallMs) ? context.receiptWallMs : null;
  const trustedYear = trustedWall === null ? null : new Date(trustedWall).getUTCFullYear();
  // The Date header's own year may serve as the RFC 850 reference when it is in a four-digit-year form.
  const serverDateParsed = context.serverDate === undefined ? null : parseHttpDate(context.serverDate.trim(), trustedYear);
  const serverDate = serverDateParsed?.kind === 'DATE' ? serverDateParsed : null;
  const referenceYear = trustedYear ?? (serverDate === null ? null : new Date(serverDate.wallMs).getUTCFullYear());
  const parsed = parseRetryAfter(context.retryAfter, referenceYear);
  switch (parsed.kind) {
    case 'ABSENT': return Object.freeze({ kind: 'DEFAULT', waitMs: policy.noHeaderDefaultMs });
    case 'SECONDS': return Object.freeze({ kind: 'RELATIVE', waitMs: parsed.waitMs, form: 'SECONDS' });
    case 'OVERFLOW': return Object.freeze({ kind: 'UNBOUNDED', alert: 'RETRY_AFTER_OVERFLOW' });
    case 'INVALID': return Object.freeze({ kind: 'UNBOUNDED', alert: 'RETRY_AFTER_PRESENT_BUT_UNPARSEABLE' });
    case 'TWO_DIGIT_YEAR_UNRESOLVED': return Object.freeze({ kind: 'UNBOUNDED', alert: 'DATE_CONVERSION_UNCERTAIN' });
    case 'DATE': {
      const candidates: number[] = [];
      if (serverDate !== null) candidates.push(parsed.wallMs - serverDate.wallMs);
      if (trustedWall !== null) candidates.push(parsed.wallMs - trustedWall);
      if (candidates.length === 0) return Object.freeze({ kind: 'UNBOUNDED', alert: 'DATE_CONVERSION_UNCERTAIN' });
      const waitMs = Math.max(0, ...candidates) + policy.clockUncertaintyMs;
      return Number.isSafeInteger(waitMs) ? Object.freeze({ kind: 'RELATIVE', waitMs, form: parsed.form }) : Object.freeze({ kind: 'UNBOUNDED', alert: 'RETRY_AFTER_OVERFLOW' });
    }
  }
}

/**
 * Full retained wait: max(server bound, provider-stated block, local backoff). Local values only lengthen.
 * Infinity means fail closed (no automatic resumption).
 */
export function fullRetainedWaitMs(bound: ServerWaitBound, failuresInRow: number, policy: RetryAfterPolicy): number {
  if (bound.kind === 'UNBOUNDED') return Infinity;
  const exponent = Math.min(failuresInRow, 52);
  const backoff = Math.min(policy.localBackoffBaseMs * 2 ** exponent, policy.localBackoffMaxMs);
  return Math.max(bound.waitMs, policy.providerStatedBlockMs, backoff);
}
