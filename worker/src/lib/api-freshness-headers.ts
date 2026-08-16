import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import {
  API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  measureFreshnessAge,
} from "./api-freshness-age";

export function addFreshnessHeaders(
  headers: Record<string, string>,
  updatedAt: number,
  maxAgeSec: number,
): Record<string, string> {
  const { ageSeconds: age, futureSkewSeconds } = measureFreshnessAge(
    Date.now() / 1000,
    updatedAt,
    API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  );
  const result: Record<string, string> = { ...headers, "X-Data-Age": String(age) };
  if (futureSkewSeconds > API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC) {
    result.Warning = `199 - "Response timestamp is ${futureSkewSeconds}s in the future"`;
    result["Cache-Control"] = "no-store";
    return result;
  }
  if (age > FRESHNESS_RATIOS.FRESH * maxAgeSec) {
    result.Warning = `110 - "Response is stale (${age}s old, max ${maxAgeSec}s)"`;
    result["Cache-Control"] = "no-store";
  }
  return result;
}
