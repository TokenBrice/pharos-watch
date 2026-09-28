import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import {
  API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  measureFreshnessAge,
} from "./api-freshness-age";

export function addFreshnessHeaders(
  headers: Record<string, string>,
  updatedAt: number,
  maxAgeSec: number,
  options: { assessedAt?: number; freshBudgetSec?: number } = {},
): Record<string, string> {
  const assessedAt = options.assessedAt ?? Date.now() / 1000;
  const freshBudgetSec = options.freshBudgetSec ?? FRESHNESS_RATIOS.FRESH * maxAgeSec;
  const { ageSeconds: age, futureSkewSeconds } = measureFreshnessAge(
    assessedAt,
    updatedAt,
    API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  );
  const result: Record<string, string> = { ...headers, "X-Data-Age": String(age) };
  if (futureSkewSeconds > API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC) {
    result.Warning = `199 - "Response timestamp is ${futureSkewSeconds}s in the future"`;
    result["Cache-Control"] = "no-store";
    return result;
  }
  if (age > freshBudgetSec) {
    result.Warning = `110 - "Response is stale (${age}s old, fresh budget ${freshBudgetSec}s)"`;
    result["Cache-Control"] = "no-store";
    return result;
  }
  // Round down the unrounded source-clock runway: a fractional assessment
  // must not grant another full second across the verdict boundary.
  const runway = Math.floor(updatedAt + freshBudgetSec - assessedAt);
  if (!Number.isFinite(runway) || runway <= 0) {
    result["Cache-Control"] = "no-store";
    return result;
  }
  const cacheControl = result["Cache-Control"];
  if (cacheControl && !/\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) {
    let longestTtl = 0;
    const bounded = cacheControl.replace(/\b(s-maxage|max-age)\s*=\s*(\d+)/gi, (_, name: string, value: string) => {
      const ttl = Math.min(Number(value), runway);
      longestTtl = Math.max(longestTtl, ttl);
      return `${name}=${ttl}`;
    });
    // SWR extends the base lifetime; clamping each directive independently
    // would still let the combined window cross the freshness boundary.
    result["Cache-Control"] = bounded.replace(/\bstale-while-revalidate\s*=\s*(\d+)/gi, (_, value: string) =>
      `stale-while-revalidate=${Math.min(Number(value), runway - longestTtl)}`);
    if (longestTtl > 0 && result.Date == null) {
      result.Date = new Date(assessedAt * 1000).toUTCString();
    }
  }
  return result;
}
