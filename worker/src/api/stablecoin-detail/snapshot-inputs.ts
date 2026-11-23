import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DETAIL_SNAPSHOT_INPUT_ENTRY_MAX_BYTES,
  DETAIL_SNAPSHOT_SUPPLY_HISTORY_DAYS,
  detailSnapshotSourceUpdatedAt,
} from "@shared/lib/detail-snapshot-inputs";
import { DETAIL_SNAPSHOT_INPUT_MAX_BATCH_SIZE } from "@shared/types/detail-snapshot-inputs";
import type { DetailSnapshotInputEntry } from "@shared/types/detail-snapshot-inputs";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { WORKER_TRACKED_META_BY_ID, type WorkerRuntimeStablecoinMeta } from "@shared/lib/stablecoins/worker-runtime-registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { StablecoinDetailResponseSchema, SupplyHistoryResponseSchema } from "@shared/types/supply";
import { errorResponse, jsonResponse } from "../../lib/api-response";
import { getCache } from "../../lib/db-cache";
import { isCoinGeckoHistoryAllowed } from "../../lib/solomon-usdv-identity";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { getCompletedSupplySnapshot } from "../../lib/supply-snapshot-completion";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { loadBatchedSupplyHistory, mapSupplyHistoryRow, resolveSupplyHistoryUpdatedAtMs } from "../supply-history";
import { buildCacheFallbackTokens } from "./cache-fallback";
import { overlayCanonicalDetailObject } from "./price";
import {
  admitCommodityDetailCache,
  buildFallbackDetailFromTokens,
  CACHE_TTL_SECONDS,
  createFreshCacheHitHeaders,
  DETAIL_STALE_CACHE_MAX_AGE_SECONDS,
  fetchSupplyHistoryFallback,
  getLatestDetailTokenDate,
} from "./shared";

function isD1OnlyCacheBackedActiveCoin(meta: WorkerRuntimeStablecoinMeta): boolean {
  if (!isActiveStablecoinMeta(meta)) return false;
  const isCommodity = (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") && Boolean(meta.geckoId);
  if (isCommodity) return false;
  return meta.detailProvider === "coingecko" && (!meta.geckoId || !isCoinGeckoHistoryAllowed(meta.geckoId));
}

function boundSnapshotEntry(
  entry: DetailSnapshotInputEntry,
  sources: DetailSnapshotInputEntry["sources"],
): DetailSnapshotInputEntry {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength > DETAIL_SNAPSHOT_INPUT_ENTRY_MAX_BYTES
    ? { id: entry.id, status: "unavailable", reason: "entry-too-large", sources }
    : entry;
}

/**
 * Internal build transport, not a provider/refresh endpoint. HTTP authentication is
 * enforced by the ordinary API/site-key gates before dispatch. No waitUntil, provider
 * fetch, refresh slot, or cache write occurs here. One full detail body at a time,
 * one frozen publication, supply marker, and batched 90-day supply_history query per
 * batch, at most one D1 read in flight.
 */
export async function handleDetailSnapshotInputs(db: D1Database, url: URL): Promise<Response> {
  const rawIds = url.searchParams.getAll("ids");
  const ids = rawIds.length === 1 ? rawIds[0].split(",") : [];
  if (ids.length < 1 || ids.length > DETAIL_SNAPSHOT_INPUT_MAX_BATCH_SIZE ||
      ids.some((id) => !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) || new Set(ids).size !== ids.length) {
    return errorResponse(400, `Provide 1-${DETAIL_SNAPSHOT_INPUT_MAX_BATCH_SIZE} unique canonical coin ids in ?ids=`);
  }

  // Reads are deliberately sequential: there is no benefit to competing for D1's
  // serialized queue, and large history-heavy cached details must not accumulate.
  const publication = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
  const completedSnapshot = await getCompletedSupplySnapshot(db);
  const supplyHistoryIds = completedSnapshot
    ? ids.filter((id) => {
        const meta = WORKER_TRACKED_META_BY_ID.get(id);
        return meta != null && (!isActiveStablecoinMeta(meta) || publication.kind === "ok");
      })
    : [];
  let supplyHistoryById: Awaited<ReturnType<typeof loadBatchedSupplyHistory>> = new Map();
  let supplyHistoryError: unknown = null;
  if (completedSnapshot && supplyHistoryIds.length > 0) {
    const batchNow = Math.floor(Date.now() / 1000);
    try {
      supplyHistoryById = await loadBatchedSupplyHistory(
        db,
        supplyHistoryIds,
        batchNow - DETAIL_SNAPSHOT_SUPPLY_HISTORY_DAYS * DAY_SECONDS,
        completedSnapshot,
        batchNow,
      );
    } catch (error) {
      supplyHistoryError = error;
    }
  }

  const readHistoryLane = (id: string, nowSec: number) => {
    if (supplyHistoryError) throw supplyHistoryError;
    const rows = supplyHistoryById.get(id) ?? [];
    return {
      supplyHistory: SupplyHistoryResponseSchema.parse(rows.map(mapSupplyHistoryRow)),
      updatedAt: resolveSupplyHistoryUpdatedAtMs(rows, nowSec),
    };
  };

  const entries: DetailSnapshotInputEntry[] = [];
  for (const id of ids) {
    const sources = {
      detailCacheUpdatedAt: null as number | null,
      publicationUpdatedAt: publication.kind === "ok" ? publication.updatedAt : null,
      supplySnapshotUpdatedAt: completedSnapshot?.updatedAt ?? null,
      supplySnapshotDate: completedSnapshot?.snapshotDate ?? null,
    };
    const meta = WORKER_TRACKED_META_BY_ID.get(id);
    if (!meta) {
      entries.push({ id, status: "unavailable", reason: "unknown-id", sources });
      continue;
    }
    try {
      const cached = await getCache(db, `detail:${id}`);
      sources.detailCacheUpdatedAt = cached?.updatedAt ?? null;
      if (!cached) {
        if (!isActiveStablecoinMeta(meta)) {
          if (!completedSnapshot) {
            entries.push({ id, status: "unavailable", reason: "supply-marker-missing", sources });
            continue;
          }
          const now = Math.floor(Date.now() / 1000);
          const { supplyHistory, updatedAt: supplyHistoryUpdatedAt } = readHistoryLane(id, now);
          if (supplyHistoryUpdatedAt === null) {
            entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
            continue;
          }
          entries.push(boundSnapshotEntry({
            id,
            status: "history-only",
            reason: "detail-cache-missing",
            supplyHistory,
            updatedAt: { supplyHistory: supplyHistoryUpdatedAt },
            freshness: {
              supplyHistory: {
                status: Date.now() - supplyHistoryUpdatedAt < API_FRESHNESS_MAX_AGE_SEC.supplyHistory * 1000 ? "fresh" : "stale",
                maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.supplyHistory,
              },
            },
            sources,
          }, sources));
          continue;
        }
        if (isD1OnlyCacheBackedActiveCoin(meta)) {
          if (publication.kind !== "ok" || !completedSnapshot) {
            entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
            continue;
          }
          const pegType = `pegged${meta.flags.pegCurrency ?? "USD"}`;
          let tokens = await fetchSupplyHistoryFallback(db, id, pegType);
          if (tokens.length === 0) {
            const coin = publication.payload.peggedAssets.find((item) => item.id === id);
            if (!coin) {
              entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
              continue;
            }
            tokens = buildCacheFallbackTokens(coin, publication.updatedAt, pegType);
            if (tokens.length === 0) {
              entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
              continue;
            }
          }
          const fallback = buildFallbackDetailFromTokens(tokens, getLatestDetailTokenDate(tokens));
          const overlaid = await overlayCanonicalDetailObject(
            db,
            id,
            { detail: fallback.detail, status: 200, headers: fallback.headers },
            publication,
          );
          if (!overlaid.ok || overlaid.unavailableResponse) {
            entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
            continue;
          }
          const now = Math.floor(Date.now() / 1000);
          const { supplyHistory, updatedAt: supplyHistoryUpdatedAt } = readHistoryLane(id, now);
          const liveSummaryUpdatedAt = detailSnapshotSourceUpdatedAt(overlaid.detail, overlaid.headers);
          if (liveSummaryUpdatedAt === null || supplyHistoryUpdatedAt === null) {
            entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
            continue;
          }
          entries.push(boundSnapshotEntry({
            id,
            status: "available",
            liveSummary: projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(overlaid.detail), id),
            supplyHistory,
            updatedAt: { liveSummary: liveSummaryUpdatedAt, supplyHistory: supplyHistoryUpdatedAt },
            freshness: {
              liveSummary: {
                status: Date.now() - liveSummaryUpdatedAt < CACHE_TTL_SECONDS * 1000 ? "fresh" : "stale",
                maxAgeSec: CACHE_TTL_SECONDS,
              },
              supplyHistory: {
                status: Date.now() - supplyHistoryUpdatedAt < API_FRESHNESS_MAX_AGE_SEC.supplyHistory * 1000 ? "fresh" : "stale",
                maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.supplyHistory,
              },
            },
            sources,
          }, sources));
          continue;
        }
        entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
        continue;
      }
      if (!admitCommodityDetailCache(id, cached)) {
        entries.push({ id, status: "unavailable", reason: "invalid-cache-input", sources });
        continue;
      }
      const now = Math.floor(Date.now() / 1000);
      const age = now - cached.updatedAt;
      if (!Number.isFinite(age) || cached.updatedAt <= 0 || age < 0) {
        sources.detailCacheUpdatedAt = null;
        entries.push({ id, status: "unavailable", reason: "detail-cache-invalid-clock", sources });
        continue;
      }
      if (isActiveStablecoinMeta(meta) && age >= DETAIL_STALE_CACHE_MAX_AGE_SECONDS) {
        entries.push({ id, status: "unavailable", reason: "detail-cache-too-old", sources });
        continue;
      }
      if (isActiveStablecoinMeta(meta) && publication.kind !== "ok") {
        entries.push({ id, status: "unavailable", reason: "publication-unavailable", sources });
        continue;
      }
      if (!completedSnapshot) {
        entries.push({ id, status: "unavailable", reason: "supply-marker-missing", sources });
        continue;
      }

      // Curated addresses never enter the projection. Use the exact same enrichment
      // and schema/projection as the per-coin route, but never call its refresh router.
      let detail: unknown = JSON.parse(cached.value);
      let detailHeaders = createFreshCacheHitHeaders(age, cached.updatedAt);
      if (isActiveStablecoinMeta(meta) && detail && typeof detail === "object" && !Array.isArray(detail)) {
        const overlaid = await overlayCanonicalDetailObject(
          db,
          id,
          { detail: detail as Record<string, unknown>, status: 200, headers: detailHeaders },
          publication,
        );
        detail = overlaid.unavailableResponse ? {} : overlaid.detail;
        detailHeaders = overlaid.headers;
      }
      const { supplyHistory, updatedAt: supplyHistoryUpdatedAt } = readHistoryLane(id, now);
      const liveSummaryUpdatedAt = detailSnapshotSourceUpdatedAt(detail, detailHeaders);
      if (liveSummaryUpdatedAt === null || supplyHistoryUpdatedAt === null) {
        entries.push({ id, status: "unavailable", reason: "source-clock-unavailable", sources });
        continue;
      }
      entries.push(boundSnapshotEntry({
        id,
        status: "available",
        liveSummary: projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail), id),
        supplyHistory,
        updatedAt: { liveSummary: liveSummaryUpdatedAt, supplyHistory: supplyHistoryUpdatedAt },
        freshness: {
          liveSummary: {
            status: Date.now() - liveSummaryUpdatedAt < CACHE_TTL_SECONDS * 1000 ? "fresh" : "stale",
            maxAgeSec: CACHE_TTL_SECONDS,
          },
          supplyHistory: {
            status: Date.now() - supplyHistoryUpdatedAt < API_FRESHNESS_MAX_AGE_SEC.supplyHistory * 1000 ? "fresh" : "stale",
            maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.supplyHistory,
          },
        },
        sources,
      }, sources));
    } catch (error) {
      logWorkerEventArgs("api", "warn", `[detail-snapshot-inputs] cache input unavailable stablecoin=${id}`, error);
      entries.push({ id, status: "unavailable", reason: error instanceof SyntaxError ||
        (error instanceof Error && error.name === "ZodError") ? "invalid-cache-input" : "cache-read-failed", sources });
    }
  }
  // No batch/edge reuse: independent lanes can be stale and the consumer needs their
  // actual source clocks, not an aggregate cache timestamp or a last-good bundle.
  return jsonResponse({ version: 1, entries }, { headers: { "Cache-Control": "no-store" } });
}
