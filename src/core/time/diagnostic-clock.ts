/** Independent observation clock. Never reads the transport's injected clock. */
export interface DiagnosticClock {
  read(): { readonly wallMs: number; readonly elapsedMs: number };
}

export class SystemDiagnosticClock implements DiagnosticClock {
  readonly #origin = process.hrtime.bigint();

  public read(): { readonly wallMs: number; readonly elapsedMs: number } {
    return { wallMs: Date.now(), elapsedMs: Number((process.hrtime.bigint() - this.#origin) / 1_000_000n) };
  }
}
