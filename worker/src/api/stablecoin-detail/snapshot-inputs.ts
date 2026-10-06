import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DETAIL_SNAPSHOT_INPUT_ENTRY_MAX_BYTES,
  DETAIL_SNAPSHOT_SUPPLY_HISTORY_DAYS,
  detailSnapshotSourceUpdatedAt,
} from "@shared/lib/detail-snapshot-inputs";
import { DETAIL_SNAPSHOT_INPUT_BATCH_SIZE } from "@shared/types/detail-snapshot-inputs";
import type { DetailSnapshotInputEntry } from "@shared/types/detail-snapshot-inputs";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { StablecoinDetailResponseSchema, SupplyHistoryResponseSchema } from "@shared/types/market";
import { errorResponse, jsonResponse } from "../../lib/api-response";
import { getCache } from "../../lib/db-cache";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { getCompletedSupplySnapshot } from "../../lib/supply-snapshot-completion";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { handleSupplyHistory } from "../supply-history";
import { enrichMissingDetailPrice } from "./price";
import { CACHE_TTL_SECONDS, DETAIL_STALE_CACHE_MAX_AGE_SECONDS, createFreshCacheHitResponse } from "./shared";

/**
 * Internal build transport, not a provider/refresh endpoint. HTTP authentication is
 * enforced by the ordinary API/site-key gates before dispatch. No waitUntil, provider
 * fetch, refresh slot, or cache write occurs here. One full detail body at a time,
 * one frozen publication and supply marker per batch, at most one D1 read in flight.
 */
export async function handleDetailSnapshotInputs(db: D1Database, url: URL): Promise<Response> {
  const rawIds = url.searchParams.getAll("ids");
  const ids = rawIds.length === 1 ? rawIds[0].split(",") : [];
  if (ids.length < 1 || ids.length > DETAIL_SNAPSHOT_INPUT_BATCH_SIZE ||
      ids.some((id) => !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) || new Set(ids).size !== ids.length) {
    return errorResponse(400, `Provide 1-${DETAIL_SNAPSHOT_INPUT_BATCH_SIZE} unique canonical coin ids in ?ids=`);
  }

  // Reads are deliberately sequential: there is no benefit to competing for D1's
  // serialized queue, and large history-heavy cached details must not accumulate.
  const publication = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
  const completedSnapshot = await getCompletedSupplySnapshot(db);
  const entries: DetailSnapshotInputEntry[] = [];
  for (const id of ids) {
    const sources = {
      detailCacheUpdatedAt: null as number | null,
      publicationUpdatedAt: publication.kind === "ok" ? publication.updatedAt : null,
      supplySnapshotUpdatedAt: completedSnapshot?.updatedAt ?? null,
      supplySnapshotDate: completedSnapshot?.snapshotDate ?? null,
    };
    const meta = TRACKED_META_BY_ID.get(id);
    if (!meta) {
      entries.push({ id, status: "unavailable", reason: "unknown-id", sources });
      continue;
    }
    try {
      const cached = await getCache(db, `detail:${id}`);
      sources.detailCacheUpdatedAt = cached?.updatedAt ?? null;
      if (!cached) {
        entries.push({ id, status: "unavailable", reason: "detail-cache-missing", sources });
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
      let detailResponse = createFreshCacheHitResponse(cached.value, age, cached.updatedAt);
      if (isActiveStablecoinMeta(meta)) {
        detailResponse = await enrichMissingDetailPrice(db, id, detailResponse, publication);
      }
      const detail: unknown = await detailResponse.json();
      const historyResponse = await handleSupplyHistory(
        db,
        new URL(API_PATHS.supplyHistory(id, DETAIL_SNAPSHOT_SUPPLY_HISTORY_DAYS), url.origin),
        completedSnapshot,
      );
      const history: unknown = await historyResponse.json();
      if (!historyResponse.ok) {
        entries.push({ id, status: "unavailable", reason: "invalid-cache-input", sources });
        continue;
      }
      const liveSummaryUpdatedAt = detailSnapshotSourceUpdatedAt(detail, detailResponse.headers);
      const supplyHistoryUpdatedAt = detailSnapshotSourceUpdatedAt(history, historyResponse.headers);
      const entry: DetailSnapshotInputEntry = {
        id,
        status: "available",
        liveSummary: projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail)),
        supplyHistory: SupplyHistoryResponseSchema.parse(history),
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
      };
      entries.push(new TextEncoder().encode(JSON.stringify(entry)).byteLength > DETAIL_SNAPSHOT_INPUT_ENTRY_MAX_BYTES
        ? { id, status: "unavailable", reason: "entry-too-large", sources }
        : entry);
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
