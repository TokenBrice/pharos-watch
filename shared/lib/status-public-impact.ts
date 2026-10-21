import type { StatusCause } from "../types/status";

/**
 * Cause codes that correspond to things a public /status/ page viewer will
 * actually notice in the user-facing product. Admin-only data-quality
 * concerns (aggregate missing-price ratios, blacklist ratio drift, reserve
 * coverage, on-chain monitor) are intentionally excluded so the public
 * transition history and the `/api/health`-backed hero badge tell one
 * coherent story. Warning/critical causes denote service-wide impact; bounded
 * listing omissions and fresh, healthy mint/burn execution notices retain their
 * cause codes at info severity, so admin triage watches them without opening
 * public uptime incidents. Unknown coverage remains public-impacting. Ordinary
 * incomplete price coverage is a Watch; a persistent material gap escalates
 * through `active_price_coverage_duration_degraded`.
 *
 * The 2026-04-13 status-stability hardening defined the included/excluded
 * code list.
 */
const PUBLIC_IMPACT_CODES: ReadonlySet<string> = new Set([
  "cache_ratio_stale",
  "cache_ratio_degraded",
  "cache_freshness_query_failed",
  "cache_freshness_unavailable",
  "cache_warning",
  "fx_cached_fallback",
  "mint_burn_public_stale",
  "mint_burn_public_degraded",
  "mint_burn_health_query_failed",
  "safety_score_publication_unavailable",
  "safety_score_publication_missing",
  "safety_score_publication_held",
  "safety_score_publication_stale",
  "active_price_coverage_duration_degraded",
  "active_price_coverage_unknown",
  "stablecoin_publication_incomplete",
  "stablecoin_publication_unknown",
  "open_circuit_groups",
  "circuit_query_failed",
  "cron_error_runs",
  "multiple_unhealthy_crons",
  "unhealthy_crons_present",
  "db_unhealthy",
  "scheduled_delivery_stalled",
  "scheduler_liveness_unavailable",
  "heavy_scheduled_delivery_stalled",
  "heavy_scheduler_liveness_unavailable",
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
