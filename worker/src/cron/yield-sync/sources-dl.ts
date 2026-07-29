import type { YieldSourceInputMeta } from "@shared/types/yield";
import { CIRCUIT_SOURCE, USER_AGENT } from "../../lib/constants";
import { getCache } from "../../lib/db-cache";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { logWorkerEvent } from "../../lib/structured-log";
import { isYieldRelevantDlPool } from "./pool-filter";
import { filterValidDlPools, parseDlStablecoinPoolsCache } from "./cache/defillama-pool-cache";
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
        logWorkerEvent({
          scope: "lib",
          job: "sync-yield-data",
          level: "warn",
          event: "dl-pool-cache-too-old",
          message: "DL pools cache too old; falling through to direct fetch",
          metadata: { cacheAgeHours: Math.round(cacheAgeSec / 3600) },
        });
        fallbackMode = "cache-too-old";
      } else {
        dlPools = parsed.pools.filter(isYieldRelevantDlPool);
        const droppedNonRelevantCount = parsed.pools.length - dlPools.length;
        if (droppedNonRelevantCount > 0) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "non-yield-dl-pools-dropped",
            message: "Dropped non-yield-relevant cached DL pool rows",
            metadata: { droppedPoolCount: droppedNonRelevantCount },
          });
        }
        if (dlPools.length === 0) {
          fallbackMode = "cache-no-relevant-pools";
        } else {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "info",
            event: "cached-dl-pools-used",
            message: "Using cached stablecoin pools from DEX sync",
            metadata: { poolCount: dlPools.length },
          });
          return {
            pools: dlPools,
            meta: {
              ...parsed.meta,
              poolCount: dlPools.length,
            },
          };
        }
      }
    } else {
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-data",
        level: "warn",
        event: "cached-dl-pools-parse-failed",
        message: "Failed to parse cached DL pools; falling back to direct fetch",
      });
      fallbackMode = "cache-parse-failed";
    }
  }

  if (dlPools.length === 0 && (await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS))) {
    try {
      const result = await fetchJsonWithRetry<{ data?: unknown }>(DL_YIELDS_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
      if (result?.response.ok) {
        const body = result.body;
        if (!Array.isArray(body.data)) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "dl-yields-invalid-payload",
            message: "DL yields direct fetch returned an invalid payload shape",
          });
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
        const validated = filterValidDlPools(body.data, "direct DeFiLlama yields fetch");
        dlPools = validated.pools.filter(isYieldRelevantDlPool);
        if (dlPools.length === 0) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "dl-yields-no-relevant-pools",
            message: "DL yields direct fetch returned no relevant stablecoin pools",
          });
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
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-data",
        level: "warn",
        event: "dl-yields-direct-fetch-failed",
        message: "DL yields direct fetch failed",
        error,
      });
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
