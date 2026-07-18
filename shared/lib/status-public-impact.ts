import type { StatusCause } from "../types/status";

/**
 * Cause codes that correspond to things a public /status/ page viewer will
 * actually notice in the user-facing product. Admin-only data-quality
 * concerns (low-ratio exact price gaps, blacklist ratio drift, reserve
 * coverage, on-chain monitor) are intentionally excluded so the public
 * transition history and the `/api/health`-backed hero badge tell one
 * coherent story. Exact active-price coverage opens a public incident only
 * when telemetry is unreadable or the missing-price ratio crosses the shared
 * degraded/stale bands.
 *
 * The 2026-04-13 status-stability hardening defined the included/excluded
 * code list.
 */
const PUBLIC_IMPACT_CODES: ReadonlySet<string> = new Set([
  "cache_ratio_stale",
  "cache_ratio_degraded",
  "cache_freshness_query_failed",
  "cache_warning",
  "fx_cached_fallback",
  "mint_burn_public_stale",
  "mint_burn_public_degraded",
  "mint_burn_health_query_failed",
  "active_price_coverage_unknown",
  "missing_prices_degraded",
  "missing_prices_stale",
  "open_circuit_groups",
  "circuit_query_failed",
  "cron_error_runs",
  "multiple_unhealthy_crons",
  "unhealthy_crons_present",
  "db_unhealthy",
]);

/**
 * `info`-severity causes never count as public-impacting, regardless of
 * the cause code. A cause is public-impacting only when both (a) its
 * severity is `warning` or `critical` AND (b) its code is in the
 * public-impact allowlist.
 */
function causeIsPublicImpacting(cause: StatusCause): boolean {
  if (cause.severity === "info") return false;
  return PUBLIC_IMPACT_CODES.has(cause.code);
}

/** A transition has public impact when at least one of its causes does. */
export function transitionHasPublicImpact(causes: StatusCause[]): boolean {
  return causes.some(causeIsPublicImpacting);
}
