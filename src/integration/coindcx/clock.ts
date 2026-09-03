/**
 * Clock abstraction for CoinDCX request timestamp generation and testing.
 */

export interface Clock {
  nowMs(): number;
}

/**
 * Production system clock using Date.now().
 */
export class SystemClock implements Clock {
  public nowMs(): number {
    return Date.now();
  }
}

/**
 * Injected test clock for deterministic timestamp control in unit tests.
 */
export class FakeClock implements Clock {
  private currentMs: number;

  constructor(initialMs = 1700000000000) {
    this.currentMs = initialMs;
  }

  public nowMs(): number {
    return this.currentMs;
  }

  public setTime(ms: number): void {
    this.currentMs = ms;
  }

  public advance(ms: number): void {
    this.currentMs += ms;
  }
}

