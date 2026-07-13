import { CRON_INTERVALS } from "../cron-jobs";
import { V9_RELEASE_COVERAGE_FLOORS } from "../../types/safety-score-v9-coverage";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

export const V9_SHADOW_REQUIRED_COVERAGE_FLOOR_IDS = [
  "active-result-count",
  "minimum-rateable-assets",
  "ratified-release-coverage",
  "scheduled-start-latency",
] as const;

export const V9_SHADOW_MINIMUM_QUALIFYING_DAYS = 14;
export const V9_SHADOW_MINIMUM_PRODUCER_CYCLES = 2;
export const V9_SHADOW_DAILY_START_OFFSET_SEC = 30 * 60;
export const V9_SHADOW_MAX_START_DELAY_SEC = 60 * 60;
export const V9_SHADOW_DIFF_ABSOLUTE_REVIEW_DELTA = 5;
export const V9_SHADOW_DIFF_TOP_CUTOFF_REVIEW_DELTA = 2;
const V9_SHADOW_ARCHIVE_SELECTION_POLICY = "first-final-distinct-anomaly-v1";

export const V9_SHADOW_SCORE_BEARING_PRODUCER_INTERVALS_SEC = Object.freeze({
  "sync-stablecoins": CRON_INTERVALS["sync-stablecoins"],
  "sync-dex-liquidity": CRON_INTERVALS["sync-dex-liquidity"],
  "sync-live-reserves": CRON_INTERVALS["sync-live-reserves"],
  "sync-redemption-backstops": CRON_INTERVALS["sync-redemption-backstops"],
});
export const V9_SHADOW_SLOWEST_SCORE_BEARING_SOURCE_KEYS = ["liveReserves", "redemption"] as const;

export const V9_CONSUMER_SCORE_THRESHOLD_REGISTRY = [
  {
    id: "depeg-resolver:mean-reversion-high",
    label: "Depeg resolver high safety anchor",
    score: 85,
    comparison: "at-least" as const,
  },
  {
    id: "depeg-resolver:mean-reversion-moderate",
    label: "Depeg resolver moderate safety anchor",
    score: 70,
    comparison: "at-least" as const,
  },
  {
    id: "selector:safety-recommendation",
    label: "Selector safety recommendation floor",
    score: 88,
    comparison: "at-least" as const,
  },
  {
    id: "yield:eligibility",
    label: "Yield eligibility safety floor",
    score: 50,
    comparison: "at-least" as const,
  },
] as const;

function digest(domain: string, payload: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}

export const V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST = digest("safety-score-v9.shadow-release-coverage-policy.v1", {
  requiredFloorIds: V9_SHADOW_REQUIRED_COVERAGE_FLOOR_IDS,
  releaseCoverageFloors: V9_RELEASE_COVERAGE_FLOORS,
  window: {
    minimumQualifyingDays: V9_SHADOW_MINIMUM_QUALIFYING_DAYS,
    minimumProducerCycles: V9_SHADOW_MINIMUM_PRODUCER_CYCLES,
    dailyStartOffsetSec: V9_SHADOW_DAILY_START_OFFSET_SEC,
    maximumStartDelaySec: V9_SHADOW_MAX_START_DELAY_SEC,
    scoreBearingProducerIntervalsSec: V9_SHADOW_SCORE_BEARING_PRODUCER_INTERVALS_SEC,
    slowestScoreBearingSourceKeys: V9_SHADOW_SLOWEST_SCORE_BEARING_SOURCE_KEYS,
  },
  movementReview: {
    absoluteScoreDelta: V9_SHADOW_DIFF_ABSOLUTE_REVIEW_DELTA,
    topCutoffScoreDelta: V9_SHADOW_DIFF_TOP_CUTOFF_REVIEW_DELTA,
  },
  archiveSelectionPolicy: V9_SHADOW_ARCHIVE_SELECTION_POLICY,
});

export const V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST = digest(
  "safety-score-v9.consumer-score-threshold-registry.v1",
  V9_CONSUMER_SCORE_THRESHOLD_REGISTRY,
);
