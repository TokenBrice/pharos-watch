import type { YieldSourceInputMeta } from "@shared/types/yield";
import { CIRCUIT_SOURCE, USER_AGENT } from "../../lib/constants";
import { getCache } from "../../lib/db-cache";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { logWorkerEvent } from "../../lib/structured-log";
import { isYieldRelevantDlPool } from "./pool-filter";
import { filterValidDlPools, parseDlStablecoinPoolsCache } from "./cache/defillama-pool-cache";
import { STALE_THRESHOLD_MS } from "../../lib/yield-ranking-helpers";
import type { DlPool } from "./types";

const DL_YIELDS_URL = "https://yields.llama.fi/pools";
/**
 * B10 — row staleness and cache acceptance must agree. `evaluation.ts` nulls a DL
 * row's PYS as `source-stale` past `STALE_THRESHOLD_MS` (3x the hourly
 * `sync-yield-data` interval), so serving a 6h-old snapshot kept ~68 board rows on
 * one timestamp and flipped the whole DL tier at once when the loader finally
 * refetched. Derive the acceptance bound from the same contract: past it, prefer a
 * direct fetch (or publish the snapshot with a non-null `fallbackMode`).
 */
const MAX_DL_CACHE_AGE_SEC = STALE_THRESHOLD_MS / 1000;

/**
 * B12/SRC-SUPP-3: the loader always fills `envelopeRejectedCount` (0 when the
 * envelope dropped nothing); it is optional only so callers that already mock
 * this result by shape — `yield-coverage-audit.test.ts` — keep type-checking
 * while the count travels through `YieldSyncLoadedState`.
 */
export async function loadDlStablecoinPools(
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ pools: DlPool[]; meta: YieldSourceInputMeta; envelopeRejectedCount?: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  let dlPools: DlPool[] = [];
  let fallbackMode: string | null = null;
  // B12/SRC-SUPP-3: rows dropped by the APY envelope are a source-math signal,
  // not noise — the loader carries the count out on every path so the run
  // metadata can publish it instead of losing it at the return.
  let envelopeRejectedCount = 0;
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
        envelopeRejectedCount = parsed.envelopeRejectedCount;
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
            envelopeRejectedCount,
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
            envelopeRejectedCount,
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
        envelopeRejectedCount = validated.envelopeRejectedCount;
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
            envelopeRejectedCount,
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
          envelopeRejectedCount,
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
    envelopeRejectedCount,
    meta: {
      mode: "unavailable",
      updatedAt: cachedPools?.updatedAt ?? null,
      ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
      poolCount: dlPools.length,
      fallbackMode,
    },
  };
}
