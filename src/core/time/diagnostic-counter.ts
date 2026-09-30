/** Saturation is a lower bound, never wraparound or a fabricated exact total. */
export function incrementDiagnosticCounter(value: number): { value: number; saturated: boolean } {
  return value >= Number.MAX_SAFE_INTEGER
    ? { value: Number.MAX_SAFE_INTEGER, saturated: true }
    : { value: value + 1, saturated: false };
}

/** Identifiers are never reused or saturated into collisions. */
export function nextDiagnosticIdentifier(value: number): number | null {
  return value >= Number.MAX_SAFE_INTEGER ? null : value + 1;
}
