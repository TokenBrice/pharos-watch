/**
 * The minimal structural D1 surface the rate-limit and API-key modules actually
 * consume.
 *
 * It stays structural (rather than importing Cloudflare's `D1Database`) so
 * tests can pass narrow stubs and so these modules do not depend on the full
 * runtime binding surface.
 */

export interface MinimalD1RunResult {
  meta?: { changes?: number };
}

export interface MinimalD1QueryResult<T> {
  results?: T[];
}

export interface MinimalD1Statement {
  bind(...values: unknown[]): MinimalD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<MinimalD1QueryResult<T>>;
  run(): Promise<MinimalD1RunResult>;
}

export interface MinimalD1Database {
  prepare(query: string): MinimalD1Statement;
}
