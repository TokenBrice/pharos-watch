import type { D1Database } from "@shared/types/cloudflare-runtime";

type NoopD1Overrides = Record<string, unknown>;

function unexpectedAccess(method: string): never {
  throw new Error(`makeNoopD1: unexpected D1 access through ${method}()`);
}

/**
 * D1-shaped test double for paths that explicitly must not touch the database.
 * Supply only the methods a focused test needs to observe or fault.
 */
export function makeNoopD1<T extends NoopD1Overrides = Record<never, never>>(
  overrides?: T,
): D1Database & T {
  const database = {
    prepare: () => unexpectedAccess("prepare"),
    batch: async () => unexpectedAccess("batch"),
    exec: async () => unexpectedAccess("exec"),
    dump: async () => unexpectedAccess("dump"),
  };

  return Object.assign(database, overrides ?? {}) as unknown as D1Database & T;
}
