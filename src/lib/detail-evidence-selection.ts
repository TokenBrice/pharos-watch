import type { ApiMeta } from "@/lib/api";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";

export interface DetailEvidence {
  data: StablecoinLiveSummary;
  meta: Extract<ApiMeta, { updatedAt: number }>;
}

export function isRetainableDetailEvidence(evidence: DetailEvidence, nowMs: number): boolean {
  const at = evidence.meta.updatedAt;
  return at != null && at > 0 && nowMs >= at * 1000
    && nowMs - at * 1000 <= HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS
    && [evidence.data.priceUpdatedAt, evidence.data.priceObservedAt, evidence.data.priceSyncedAt,
      evidence.data.supplyObservedAt].every((clock) => clock == null || (clock > 0 && clock * 1000 <= nowMs
        && nowMs - clock * 1000 <= HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS));
}

/** An equal aggregate clock is not an immutable payload identity: current overlays win. */
export function selectDetailEvidence(
  current: { data: StablecoinLiveSummary | undefined; meta: ApiMeta | null | undefined },
  retained: DetailEvidence | null,
  nowMs: number,
  currentIsUnqualified = false,
): { data: StablecoinLiveSummary | undefined; meta: ApiMeta | null; isRetained: boolean } {
  const savedAt = retained?.meta.updatedAt;
  const currentAt = current.meta?.updatedAt;
  // Build seeds and failed refreshes cannot qualify equal-clock older overlays.
  // Explicit current quarantine remains unavailable; never resurrect old supply.
  const newerUnqualifiedOverlay = currentIsUnqualified && retained && current.data && savedAt === currentAt
    && !(current.data.supplyRestored === true && current.data.supplyObservedAt == null)
    && ((retained.data.priceUpdatedAt ?? 0) > (current.data.priceUpdatedAt ?? 0)
      || (retained.data.supplyObservedAt ?? 0) > (current.data.supplyObservedAt ?? 0));
  if (retained && isRetainableDetailEvidence(retained, nowMs)
    && (!current.data || currentAt == null || savedAt! > currentAt || newerUnqualifiedOverlay)) {
    const meta = { ...retained.meta, status: "stale" as const, reason: "retained-browser-evidence" };
    return { data: retained.data, meta, isRetained: true };
  }
  return { data: current.data, meta: current.meta ?? null, isRetained: false };
}
