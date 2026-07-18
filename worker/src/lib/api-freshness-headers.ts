import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";

export function addFreshnessHeaders(
  headers: Record<string, string>,
  updatedAt: number,
  maxAgeSec: number,
): Record<string, string> {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  const result: Record<string, string> = { ...headers, "X-Data-Age": String(age) };
  if (age > FRESHNESS_RATIOS.FRESH * maxAgeSec) {
    result.Warning = `110 - "Response is stale (${age}s old, max ${maxAgeSec}s)"`;
    result["Cache-Control"] = "no-store";
  }
  return result;
}
