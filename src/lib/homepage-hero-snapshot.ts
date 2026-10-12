import type { HomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import { deriveDataHealth, type DataHealthInfo } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

// A checked-in build snapshot is only a short outage bridge, never an
// indefinitely current headline.
export const HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS = 72 * 60 * 60 * 1000;

export type HomepageHeroSelection =
  | {
      status: "available";
      source: "live" | "retained" | "fallback";
      snapshot: HomepageHeroSnapshot;
    }
  | {
      status: "unavailable";
      source: "unavailable";
      snapshot: null;
    };

export function selectHomepageHeroSnapshot({
  liveSnapshot,
  fallbackSnapshot,
  nowMs,
  liveHealth,
}: {
  liveSnapshot: HomepageHeroSnapshot | null;
  fallbackSnapshot: HomepageHeroSnapshot;
  nowMs: number;
  liveHealth?: DataHealthInfo;
}): HomepageHeroSelection {
  if (liveSnapshot?.totalUsd != null) {
    const health = liveHealth ?? deriveDataHealth({
      ...DATA_HEALTH_PRESETS.stablecoins,
      dataUpdatedAt: liveSnapshot.asOfISO ? Date.parse(liveSnapshot.asOfISO) : 0,
      hasData: true,
    }, nowMs);
    return { status: "available", source: health.state === "fresh" ? "live" : "retained", snapshot: liveSnapshot };
  }

  const fallbackTimestamp = fallbackSnapshot.asOfISO ? Date.parse(fallbackSnapshot.asOfISO) : Number.NaN;
  const fallbackAgeMs = nowMs - fallbackTimestamp;
  if (
    fallbackSnapshot.totalUsd !== null
    && Number.isFinite(fallbackTimestamp)
    && fallbackAgeMs >= 0
    && fallbackAgeMs <= HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS
  ) {
    return { status: "available", source: "fallback", snapshot: fallbackSnapshot };
  }

  return { status: "unavailable", source: "unavailable", snapshot: null };
}
