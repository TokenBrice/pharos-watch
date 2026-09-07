import { buildDlStablecoinPoolsCache, buildYieldSupplementalFamilyCache } from "../yield-sync/cache";
import type { ResolvedYieldCandidate } from "../yield-sync/types";

export type CacheRow = {
  value: string;
  updatedAt: number;
};

export type YieldCacheFixture =
  | CacheRow
  | null
  | Error
  | { throw: unknown }
  | (() => YieldCacheFixture | Promise<YieldCacheFixture>);

export type YieldCacheFixtureMap = Readonly<Record<string, YieldCacheFixture>>;

export type YieldCacheReaderOptions = {
  /** Additional exact keys, useful for the per-family supplemental cache. */
  supplementalFamilies?: YieldCacheFixtureMap;
  /** Resolve deliberate test-only misses or provider-shaped failures. */
  fallback?: (key: string, db: D1Database, signal?: AbortSignal) => YieldCacheFixture | Promise<YieldCacheFixture>;
  /** Fail loudly when the production code asks for a key not in the scenario. */
  requireKnownKey?: boolean;
};

export type YieldCacheReader = (
  db: D1Database,
  key: string,
  signal?: AbortSignal,
) => YieldCacheFixture | Promise<YieldCacheFixture>;

export function cacheRow(value: string | unknown, updatedAt: number): CacheRow {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return {
    value: serialized ?? String(value),
    updatedAt,
  };
}

export function dlPoolsCacheRow(
  pools: Parameters<typeof buildDlStablecoinPoolsCache>[0],
  updatedAt: number,
) {
  return cacheRow(buildDlStablecoinPoolsCache(pools, updatedAt), updatedAt);
}

export function supplementalFamilyCacheRow(
  candidates: ResolvedYieldCandidate[],
  updatedAt: number,
) {
  return cacheRow(buildYieldSupplementalFamilyCache(candidates, updatedAt), updatedAt);
}

async function resolveFixture(
  fixture: YieldCacheFixture,
  db: D1Database,
  key: string,
  signal?: AbortSignal,
): Promise<CacheRow | null> {
  if (typeof fixture === "function") return resolveFixture(await fixture(), db, key, signal);
  if (fixture instanceof Error) throw fixture;
  if (fixture !== null && "throw" in fixture) throw fixture.throw;
  return fixture;
}

export function makeYieldCacheReader(
  fixtures: YieldCacheFixtureMap,
  options: YieldCacheReaderOptions = {},
): (db: D1Database, key: string, signal?: AbortSignal) => Promise<CacheRow | null> {
  const entries = new Map<string, YieldCacheFixture>(Object.entries(fixtures));
  for (const [key, fixture] of Object.entries(options.supplementalFamilies ?? {})) {
    entries.set(key, fixture);
  }

  return async (db, key, signal) => {
    const fixture = entries.get(key);
    if (fixture !== undefined) return resolveFixture(fixture, db, key, signal);
    if (options.fallback) {
      return resolveFixture(await options.fallback(key, db, signal), db, key, signal);
    }
    if (options.requireKnownKey) {
      throw new Error(`yield-cache.test-support: unexpected cache key ${key}`);
    }
    return null;
  };
}

export function installYieldCacheReader(
  mock: {
    mockImplementation(
      implementation: (db: D1Database, key: string, signal?: AbortSignal) => Promise<CacheRow | null>,
    ): unknown;
  },
  fixtures: YieldCacheFixtureMap | YieldCacheReader,
  options?: YieldCacheReaderOptions,
): void {
  const reader = typeof fixtures === "function"
    ? async (db: D1Database, key: string, signal?: AbortSignal) =>
      resolveFixture(await fixtures(db, key, signal), db, key, signal)
    : makeYieldCacheReader(fixtures, options);
  mock.mockImplementation(reader);
}
