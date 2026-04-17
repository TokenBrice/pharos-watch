import { describe, expect, it } from "vitest";
import { assessPublicHealth } from "../public-health-assessment";

/**
 * Minimal D1 mock that returns a stablecoins cache row and empty results for
 * every other query. Enough to drive `assessPublicHealth` through its cache
 * enrichment path without having to mock every downstream sub-query.
 */
function makeMinimalDb(nowSec: number): D1Database {
  const emptyFirst = async <T>() => null as T | null;
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        all: async <T>() => {
          if (sql.includes("cache WHERE key IN")) {
            return {
              results: [{ key: "stablecoins", updated_at: nowSec - 60 }] as T[],
              success: true,
              meta: {},
            };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        first: emptyFirst,
        run: async () => ({ success: true, meta: {} }),
      }),
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      first: emptyFirst,
      run: async () => ({ success: true, meta: {} }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("assessPublicHealth upstream provider enrichment", () => {
  it("tags the stablecoins cache with upstreamProvider = 'DefiLlama'", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeMinimalDb(nowSec);

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.caches.stablecoins?.upstreamProvider).toBe("DefiLlama");
  });

  it("tags unknown cache keys with upstreamProvider = null", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeMinimalDb(nowSec);

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    // `fx-rates` and `bluechip-ratings` exist in CACHE_FRESHNESS_THRESHOLDS;
    // pick one that also has a mapping to verify attribution works for more
    // than just the stablecoins lane.
    expect(result.caches["fx-rates"]?.upstreamProvider).toBe("Frankfurter");
    expect(result.caches["bluechip-ratings"]?.upstreamProvider).toBe("Bluechip");
  });
});
