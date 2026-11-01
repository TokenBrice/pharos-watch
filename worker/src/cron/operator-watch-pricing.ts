import { CACHE_FRESHNESS_LANES, type CacheFreshnessLaneConfig } from "@shared/lib/api-freshness";
import { CRON_JOB_DEFINITIONS, getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
import { assessBluechipRating } from "@shared/lib/bluechip-freshness";
import { formatIsoDate } from "@shared/lib/format";
import type { BluechipRatingsMap } from "@shared/types/market";
import type { CacheStatus } from "@shared/types/status";
import { getCache } from "../lib/db-cache";
import { parseBluechipRatingsCache } from "../lib/bluechip-cache";
import { includeActiveTrackedIds } from "./shared/exclude-frozen";
import type { OperatorWatchCondition } from "./cron-staleness-watchdog";

/**
 * Pricing and FX operator conditions for the freshness sentinel.
 *
 * These read state the sentinel already built (`buildCacheStatuses`) plus one
 * bounded `bluechip-ratings` cache row. Producer absence stays with the existing
 * `producer-stale` condition: a missing cache row or clock is `unknown`, never a
 * coverage failure, so a failed read cannot page as if the producer failed (R2).
 */

/** A daily lane gets this long past its slot before an absent publication is a miss. */
export const DAILY_LANE_COMPLETION_GRACE_SEC = 2 * 3600;
const BLUECHIP_COVERAGE_LABEL_LIMIT = 5;

type CachedStatus = Pick<CacheStatus, "publishedAt"> & Partial<Pick<
  CacheStatus,
  "sourceStatus" | "mode" | "consecutiveFallbackRuns" | "warning"
>>;

export interface PricingOperatorWatchInput {
  caches: Record<string, CachedStatus | undefined>;
  nowSec: number;
}

function fxConditions(fx: CachedStatus | undefined): OperatorWatchCondition[] {
  if (!fx) return [];
  const details = fx.warning ? `: ${fx.warning}` : "";
  return [
    {
      section: "fx-rates",
      id: "source-stale",
      label: `source stale${details}`,
      active: fx.sourceStatus === "stale",
    },
    {
      section: "fx-rates",
      id: "cached-fallback",
      label: `cached fallback (${fx.consecutiveFallbackRuns ?? 0} consecutive runs)${details}`,
      active: fx.mode === "cached-fallback",
    },
  ];
}

function dailyLaneConditions(input: PricingOperatorWatchInput): OperatorWatchCondition[] {
  const laneByProducer = new Map<string, CacheFreshnessLaneConfig>(
    Object.values(CACHE_FRESHNESS_LANES).map((lane) => [lane.producerJob, lane] as const),
  );
  const conditions: OperatorWatchCondition[] = [];
  for (const definition of CRON_JOB_DEFINITIONS) {
    if (definition.scheduleKey !== "daily0800Utc" && definition.scheduleKey !== "daily0805Utc") continue;
    const lane = laneByProducer.get(definition.job);
    if (!lane) continue;
    const slotStartedAtSec = getCronSlotStartedAtForSchedule(definition.scheduleKey, input.nowSec * 1000);
    const publishedAt = input.caches[lane.cacheKey]?.publishedAt ?? null;
    conditions.push({
      section: "daily-lane",
      id: `${definition.job}-slot`,
      label: `${lane.cacheKey} (${definition.job} last published ${publishedAt == null
        ? "unknown"
        : formatIsoDate(publishedAt)}, slot ${formatIsoDate(slotStartedAtSec)} missing)`,
      active: publishedAt != null
        && input.nowSec > slotStartedAtSec + DAILY_LANE_COMPLETION_GRACE_SEC
        && publishedAt < slotStartedAtSec,
      unknown: publishedAt == null,
    });
  }
  return conditions;
}

function countBluechipCoverageGaps(
  ratings: BluechipRatingsMap,
  expectedIds: readonly string[],
  nowSec: number,
): string[] {
  const gaps: string[] = [];
  for (const stablecoinId of expectedIds) {
    const rating = ratings[stablecoinId];
    if (!rating) {
      gaps.push(`${stablecoinId}:missing`);
      continue;
    }
    const assessed = assessBluechipRating(rating, nowSec);
    if (assessed.observationState === "stale" || assessed.observationState === "unknown") {
      gaps.push(`${stablecoinId}:${assessed.observationReason ?? assessed.observationState}`);
    }
  }
  return gaps;
}

async function bluechipCoverageCondition(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<OperatorWatchCondition> {
  const cacheKey = CACHE_FRESHNESS_LANES.bluechipRatings.cacheKey;
  const expectedIds = includeActiveTrackedIds(
    Object.entries(BLUECHIP_SLUG_MAP),
    ([, pharosId]) => pharosId,
  ).map(([, pharosId]) => pharosId);
  const id = `${cacheKey}-coverage`;
  let cache: { value: string; updatedAt: number } | null;
  try {
    cache = await getCache(db, cacheKey, signal);
  } catch {
    return { section: "daily-lane", id, active: false, unknown: true };
  }
  const ratings = cache?.value ? parseBluechipRatingsCache(cache.value, "operator-watch-pricing:bluechip") : {};
  // A missing or unusable map is not evidence that a constituent went stale:
  // `producer-stale` owns an absent cache, and a corrupt payload keeps this
  // condition's prior state instead of paging as a coverage failure.
  if (Object.keys(ratings).length === 0) {
    return { section: "daily-lane", id, active: false, unknown: true };
  }
  const gaps = countBluechipCoverageGaps(ratings, expectedIds, nowSec);
  return {
    section: "daily-lane",
    id,
    label: `${cacheKey} (${gaps.length}/${expectedIds.length} unobserved: ${
      gaps.slice(0, BLUECHIP_COVERAGE_LABEL_LIMIT).join(", ")}${gaps.length > BLUECHIP_COVERAGE_LABEL_LIMIT ? ", +more" : ""})`,
    active: gaps.length > 0,
    unknown: false,
  };
}

/** Freshness rule ids this module can raise, for the sentinel's `firedRuleIds`. */
export function pricingOperatorRuleIds(conditions: readonly OperatorWatchCondition[]): string[] {
  const fired = new Set<string>();
  for (const condition of conditions) {
    if (!condition.active || condition.unknown) continue;
    if (condition.section === "fx-rates") {
      fired.add(condition.id === "source-stale" ? "fx-source-stale" : "fx-cached-fallback");
    } else if (condition.section === "daily-lane") {
      fired.add(condition.id.endsWith("-coverage") ? "bluechip-coverage" : "daily-lane-completion");
    }
  }
  return [...fired];
}

export async function buildPricingOperatorConditions(
  db: D1Database,
  input: PricingOperatorWatchInput,
  signal?: AbortSignal,
): Promise<OperatorWatchCondition[]> {
  return [
    ...fxConditions(input.caches[CACHE_FRESHNESS_LANES.fxRates.cacheKey]),
    ...dailyLaneConditions(input),
    await bluechipCoverageCondition(db, input.nowSec, signal),
  ];
}
