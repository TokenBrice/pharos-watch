import type { YieldSourceInputMeta } from "@shared/types/yield";
import { CIRCUIT_SOURCE, USER_AGENT } from "../../lib/constants";
import { getCache } from "../../lib/db-cache";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { isYieldRelevantDlPool } from "./pool-filter";
import { parseDlStablecoinPoolsCache } from "./cache";
import type { DlPool } from "./types";

const DL_YIELDS_URL = "https://yields.llama.fi/pools";
const MAX_DL_CACHE_AGE_SEC = 6 * 3600;

export async function loadDlStablecoinPools(
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ pools: DlPool[]; meta: YieldSourceInputMeta }> {
  const nowSec = Math.floor(Date.now() / 1000);
  let dlPools: DlPool[] = [];
  let fallbackMode: string | null = null;
  const cachedPools = await getCache(db, "dl-stablecoin-pools");
  if (cachedPools) {
    const parsed = parseDlStablecoinPoolsCache(cachedPools.value, cachedPools.updatedAt, nowSec);
    if (parsed) {
      const cacheAgeSec = parsed.meta.ageSeconds ?? 0;
      if (cacheAgeSec > MAX_DL_CACHE_AGE_SEC) {
        console.warn(
          `[sync-yield-data] DL pools cache too old (${Math.round(cacheAgeSec / 3600)}h), falling through to direct fetch`,
        );
        fallbackMode = "cache-too-old";
      } else {
        dlPools = parsed.pools;
        console.log(`[sync-yield-data] Using ${dlPools.length} cached stablecoin pools from DEX sync`);
        return parsed;
      }
    } else {
      console.warn("[sync-yield-data] Failed to parse cached DL pools, falling back to direct fetch");
      fallbackMode = "cache-parse-failed";
    }
  }

  if (dlPools.length === 0 && (await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS))) {
    try {
      const res = await fetchWithRetry(DL_YIELDS_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
      if (res?.ok) {
        const body = (await res.json()) as { data?: unknown };
        if (!Array.isArray(body.data)) {
          console.warn("[sync-yield-data] DL yields direct fetch returned invalid payload shape");
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
          fallbackMode = "direct-fetch-invalid-payload";
          return {
            pools: [],
            meta: {
              mode: "unavailable",
              updatedAt: cachedPools?.updatedAt ?? null,
              ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
              poolCount: 0,
              fallbackMode,
            },
          };
        }
        dlPools = (body.data as DlPool[]).filter(isYieldRelevantDlPool);
        if (dlPools.length === 0) {
          console.warn("[sync-yield-data] DL yields direct fetch returned no relevant stablecoin pools");
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
          fallbackMode = "direct-fetch-empty";
          return {
            pools: [],
            meta: {
              mode: "unavailable",
              updatedAt: cachedPools?.updatedAt ?? null,
              ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
              poolCount: 0,
              fallbackMode,
            },
          };
        }
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
        return {
          pools: dlPools,
          meta: {
            mode: "direct-fetch",
            updatedAt: nowSec,
            ageSeconds: 0,
            poolCount: dlPools.length,
            fallbackMode,
          },
        };
      }
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      fallbackMode = "direct-fetch-failed";
    } catch (error) {
      console.warn("[sync-yield-data] DL yields direct fetch failed:", error);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      fallbackMode = "direct-fetch-exception";
    }
  } else if (dlPools.length === 0) {
    fallbackMode = "circuit-open";
  }

  return {
    pools: dlPools,
    meta: {
      mode: "unavailable",
      updatedAt: cachedPools?.updatedAt ?? null,
      ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
      poolCount: dlPools.length,
      fallbackMode,
    },
  };
}
