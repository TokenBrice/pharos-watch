import { CACHE_FRESHNESS_LANES, type CacheFreshnessLaneConfig } from "@shared/lib/api-freshness";
import { CRON_JOB_DEFINITIONS, getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
import { assessBluechipRating } from "@shared/lib/bluechip-freshness";
import { formatIsoDate } from "@shared/lib/format";
import type { BluechipRatingsMap } from "@shared/types/bluechip";
import type { CacheStatus } from "@shared/types/status";
import { HOUR_SECONDS } from "@shared/lib/time-constants";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { getCache, getCaches } from "../lib/db-cache";
import { cronEventCacheKey } from "../lib/cron-logger";
import { loadFxAdmissionCoverage } from "../lib/fx-admission-coverage";
import { OXR_LAST_SUCCESS_KEY, REALTIME_FX_CURRENCY_TO_PEG } from "../lib/fx-config";
import { parseJsonObject } from "../lib/json-parse";
import { readBluechipRatingsCache } from "../lib/bluechip-cache";
import { includeActiveTrackedIds } from "./shared/exclude-frozen";
import type { OperatorWatchCondition } from "./operator-watch-types";

/**
 * Pricing and FX operator conditions for the freshness sentinel.
 *
 * FX alerts use committed producer events and the admission coverage of the
 * served stablecoins generation. An unreadable coverage row remains unknown.
 */

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
  // Only a parsed FX generation carries a source status and sync mode. Without
  // both, the cache row or its metadata is absent or unreadable: hold the prior
  // state rather than reporting a recovery nothing measured (R2).
  const unknown = fx.mode == null && fx.sourceStatus == null;
  return [
    {
      section: "fx-rates",
      id: "source-stale",
      label: `source stale${details}`,
      active: fx.sourceStatus === "stale",
      unknown,
    },
    {
      section: "fx-rates",
      id: "cached-fallback",
      label: `cached fallback (${fx.consecutiveFallbackRuns ?? 0} consecutive runs)${details}`,
      active: fx.mode === "cached-fallback",
      unknown,
    },
  ];
}

const publicationAlerts = ["fx-regime-shift-confirmed", "fx-reference-regression"] as const;
const quotaAlert = "openexchange-rates-quota-limited";

async function fxEvidenceConditions(db: D1Database, now: number): Promise<OperatorWatchCondition[]> {
  const eventKey = (type: string) => cronEventCacheKey("sync-fx-rates", type);
  const rows = await getCaches(db, [OXR_LAST_SUCCESS_KEY, eventKey(quotaAlert), ...publicationAlerts.map(eventKey)]);
  const metadata = (type: string) => {
    const event = parseJsonObject(rows.get(eventKey(type))?.value);
    return event?.job === "sync-fx-rates" && event.eventType === type &&
      event.metadata && typeof event.metadata === "object" ? event.metadata as Record<string, unknown> : null;
  };
  const quota = metadata(quotaAlert);
  const attemptedAt = quota?.attemptedAt;
  const restricted = (quota?.statusCode === 429 || quota?.statusCode === 403) &&
    typeof attemptedAt === "number" && Number.isSafeInteger(attemptedAt) && attemptedAt > 0 && attemptedAt <= now;
  const successAt = Number(rows.get(OXR_LAST_SUCCESS_KEY)?.value);
  const recovered = Number.isSafeInteger(successAt) && successAt > 0 && successAt <= now;
  const conditions: OperatorWatchCondition[] = [{
    section: "fx-rates", id: quotaAlert, active: restricted && !(recovered && successAt > attemptedAt),
    unknown: !restricted,
    label: `Open Exchange Rates HTTP ${quota?.statusCode} access restriction (${attemptedAt})`,
  }];
  for (const type of publicationAlerts) {
    const event = metadata(type);
    const generation = event?.publishedGeneration;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0 ||
        generation > now || generation !== event?.generation) continue;
    conditions.push({
      section: "fx-rates", id: `${type}:${generation}`, active: true,
      label: type === "fx-reference-regression"
        ? `T1 FX reference regression for ${event.pegKey} in generation ${generation} (rollback decision for both Workers)`
        : `Confirmed FX regime change for ${event.pegKey} in generation ${generation}`,
    });
  }
  const coverage = await loadFxAdmissionCoverage(db, now).catch(() => null);
  const session = getReferenceSessionState("fx", now);
  for (const currency of Object.keys(REALTIME_FX_CURRENCY_TO_PEG)) {
    const row = coverage?.currencies[currency];
    const measured = row != null && row.decisionAt <= now && row.sessionOpenedAt === session.sessionOpenedAtSec;
    const age = measured && row.missingSince != null ? row.decisionAt - row.missingSince : 0;
    conditions.push({
      section: "fx-rates", id: `reference-admission-outage:${currency}`,
      active: session.open && measured && age >= 2 * HOUR_SECONDS, unknown: session.open && !measured,
      label: `${currency} without an admitted reference for ${Math.floor(age / 60)} open-session minutes`,
    });
  }
  return conditions;
}

function dailyLaneConditions(input: PricingOperatorWatchInput): OperatorWatchCondition[] {
  const laneByProducer = new Map<string, CacheFreshnessLaneConfig>(
    Object.values(CACHE_FRESHNESS_LANES).map((lane) => [lane.producerJob, lane] as const),
  );
  const conditions: OperatorWatchCondition[] = [];
  for (const definition of CRON_JOB_DEFINITIONS) {
    if (definition.operatorCompletionGraceSec == null) continue;
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
        && input.nowSec > slotStartedAtSec + definition.operatorCompletionGraceSec
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
  const read = cache?.value
    ? readBluechipRatingsCache(cache.value, "operator-watch-pricing:bluechip")
    : { ratings: {}, droppedIds: [] };
  // A missing or unusable map is not evidence that a constituent went stale:
  // `producer-stale` owns an absent cache, and a corrupt payload keeps this
  // condition's prior state instead of paging as a coverage failure. A dropped
  // expected entry is unreadable evidence, not a missing constituent.
  if (Object.keys(read.ratings).length === 0
    || read.droppedIds.some((stablecoinId) => expectedIds.includes(stablecoinId))) {
    return { section: "daily-lane", id, active: false, unknown: true };
  }
  const gaps = countBluechipCoverageGaps(read.ratings, expectedIds, nowSec);
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
      const [rule] = condition.id.split(":");
      fired.add(rule === "source-stale" || rule === "cached-fallback" ? `fx-${rule}` : rule);
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
    ...await fxEvidenceConditions(db, input.nowSec),
    ...dailyLaneConditions(input),
    await bluechipCoverageCondition(db, input.nowSec, signal),
  ];
}
