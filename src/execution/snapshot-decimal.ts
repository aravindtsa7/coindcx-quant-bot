import { canonicalPaperDecimalString, MAX_PAPER_INTEGER_DIGITS, MAX_PAPER_SCALE } from './decimal';
import { paperSourceInvalid } from './errors';

/** Canonicalizes without rounding and proves exact DECIMAL(36,18) storage. */
export function canonicalPersistedDecimal(value: unknown, label: string): string {
  const canonical = canonicalPaperDecimalString(value, label);
  const unsigned = canonical.startsWith('-') ? canonical.slice(1) : canonical;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const integerDigits = integer === '0' ? 0 : integer.length;
  if (integerDigits > MAX_PAPER_INTEGER_DIGITS || fraction.length > MAX_PAPER_SCALE) {
    paperSourceInvalid(`${label} must fit DECIMAL(36,18) exactly`);
  }
  return canonical;
}

export function canonicalPositivePersistedDecimal(value: unknown, label: string): string {
  const canonical = canonicalPersistedDecimal(value, label);
  if (canonical === '0' || canonical.startsWith('-')) paperSourceInvalid(`${label} must be strictly positive`);
  return canonical;
}
