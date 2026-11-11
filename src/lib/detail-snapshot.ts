import type { QueryClient } from "@tanstack/react-query";
import type { ApiMeta, SavedSafetyAssessment, StablecoinDetailSnapshot } from "@/lib/api";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
} from "@/lib/api-query-descriptors";

export function readSavedSafetyAssessment(snapshot: StablecoinDetailSnapshot | null | undefined): SavedSafetyAssessment | null {
  const lane = snapshot?.lanes.safetyAssessment;
  const asOfMs = snapshot?.updatedAt?.safetyAssessment;
  if (!lane || asOfMs == null || !Number.isFinite(asOfMs) || asOfMs <= 0) return null;
  return { ...lane, asOfMs };
}
const detailSnapshotReads = new WeakMap<object, { dataUpdateCount: number; errorUpdateCount: number }>();

/** A real success/error settles a seed permanently, including across route remounts. */
export function isDetailSnapshotQuery(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
  const state = queryClient.getQueryState<object>(queryKey);
  const seeded = state?.data && detailSnapshotReads.get(state.data);
  return Boolean(state && seeded
    && state.dataUpdateCount === seeded.dataUpdateCount
    && state.errorUpdateCount === seeded.errorUpdateCount);
}


/** Seed only coin-scoped detail queries without resetting their producer clocks. */
export function seedStablecoinDetailQueryCache(
  queryClient: QueryClient,
  snapshot: StablecoinDetailSnapshot,
): void {
  const seedIfCurrent = <T>(queryKey: readonly unknown[], data: T, sourceUpdatedAt: number | undefined): void => {
    // Old artifacts without source clocks may render, but must immediately refetch.
    const updatedAt = sourceUpdatedAt != null && Number.isFinite(sourceUpdatedAt) && sourceUpdatedAt > 0
      ? sourceUpdatedAt
      : 0;
    const existingState = queryClient.getQueryState<{ data: T; meta: ApiMeta | null }>(queryKey);
    const existingUpdatedAt = existingState?.data?.meta?.updatedAt;
    if (existingUpdatedAt != null && existingUpdatedAt * 1000 >= updatedAt) return;
    const meta: ApiMeta = updatedAt > 0
      ? { updatedAt: updatedAt / 1000, ageSeconds: Math.max(0, (Date.now() - updatedAt) / 1000), status: "fresh" }
      : { updatedAt: null, ageSeconds: null, status: "unknown", reason: "snapshot-producer-timestamp-unavailable" };
    const envelope = queryClient.setQueryData(queryKey, { data, meta }, { updatedAt });
    const state = queryClient.getQueryState(queryKey);
    if (envelope && state) {
      detailSnapshotReads.set(envelope, {
        dataUpdateCount: state.dataUpdateCount,
        errorUpdateCount: state.errorUpdateCount,
      });
    }
  };

  if (snapshot.lanes.liveSummary) {
    seedIfCurrent(
      FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(snapshot.stablecoinId).queryKey,
      snapshot.lanes.liveSummary,
      snapshot.updatedAt?.liveSummary,
    );
  }

  if (snapshot.lanes.supplyHistory) {
    seedIfCurrent(
      FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory(
        snapshot.stablecoinId,
        STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
      ).queryKey,
      snapshot.lanes.supplyHistory,
      snapshot.updatedAt?.supplyHistory,
    );
  }
}
