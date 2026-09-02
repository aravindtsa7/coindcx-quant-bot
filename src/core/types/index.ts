/**
 * Core type definitions for the CoinDCX Quant Futures Bot.
 */

export type Nullable<T> = T | null;

export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T[P] extends object
      ? DeepReadonly<T[P]>
      : T[P];
};

export type Result<T, E = Error> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };

export const Result = {
  ok: <T>(data: T): Result<T, never> => ({ success: true, data }),
  err: <E>(error: E): Result<never, E> => ({ success: false, error }),
};

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  version: string;
  timestamp: string;
  uptimeSeconds: number;
  database?: {
    connected: boolean;
    latencyMs?: number;
    error?: string;
  };
}

