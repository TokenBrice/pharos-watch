import type { BluechipRating } from "../types/bluechip";
import { CRON_INTERVALS } from "./cron-jobs";

// Two scheduled observations: daily0805Utc in cron-jobs.ts; docs/bluechip-ratings.md.
// This is the polling cadence, not a claim about Bluechip's editorial review cadence.
export const BLUECHIP_OBSERVATION_MAX_AGE_SEC = 2 * CRON_INTERVALS["sync-bluechip"];

export function assessBluechipRating(rating: BluechipRating, nowSeconds: number): BluechipRating {
  if (rating.lastObservedAt == null || !Number.isFinite(rating.lastObservedAt) || rating.lastObservedAt > nowSeconds) {
    return { ...rating, lastObservedAt: rating.lastObservedAt ?? null, observationState: "unknown",
      observationReason: rating.lastObservedAt == null ? "legacy-observation-unknown" : "observation-in-future" };
  }
  if (nowSeconds - rating.lastObservedAt > BLUECHIP_OBSERVATION_MAX_AGE_SEC) {
    return { ...rating, observationState: "stale", observationReason: rating.observationReason ?? "observation-expired" };
  }
  return rating;
}

export function isBluechipRatingCurrent(rating: BluechipRating | null | undefined, nowSeconds: number): boolean {
  if (!rating) return false;
  const assessed = assessBluechipRating(rating, nowSeconds);
  return (assessed.observationState === "current" || assessed.observationState === "retained")
    && assessed.observationReason !== "http-404"
    && assessed.observationReason !== "empty-data"
    && assessed.observationReason !== "no-grade";
}

export function bluechipObservationLabel(rating: BluechipRating, nowSeconds: number): string | null {
  const assessed = assessBluechipRating(rating, nowSeconds);
  switch (assessed.observationState) {
    case "current": return null;
    case "retained": return "retained";
    case "stale": return "stale retained";
    case "unknown": return "observation unknown";
  }
}
