import { getStablecoinPublicationImpactStatus } from "@shared/lib/status-thresholds";
import {
  getPublicMintBurnStatus,
  PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER,
} from "@shared/lib/public-health";
import type { HealthResponse, StatusHealthValue } from "@shared/types";
import { formatProseList } from "@shared/lib/format";
import { projectPublicStatus, type PublicStatusProjection } from "@shared/lib/public-status-components";
import type { PublicComponentState, PublicHeadlineState } from "@shared/types";
import { PUBLIC_HEADLINE_TONE } from "@shared/lib/classification";
import { STATUS_PRIORITY } from "@/lib/status/dashboard-presentation";

export interface PublicHealthWarningPresentation {
  title: string;
  detail: string;
}

type ActivePriceCoverage = NonNullable<HealthResponse["activePriceCoverage"]>;

const ACTIVE_PRICE_INCOMPLETE_PREFIX = "active-price-coverage-incomplete:";
const ACTIVE_PRICE_CRITICAL_DURATION_PREFIX = "active-price-coverage-critical-duration:";


function getActivePriceAssetLabels(
  coverage: ActivePriceCoverage | undefined,
  ids: readonly string[],
): string[] {
  const symbolById = new Map(
    coverage?.missingActiveAssets.map((asset) => [asset.stablecoinId, asset.symbol] as const) ?? [],
  );
  const labels = ids.map((id) => {
    const symbol = symbolById.get(id);
    return symbol && symbol !== "unknown" ? symbol : id;
  });
  return [...new Set(labels)];
}

function formatAffectedAssets(count: number, labels: readonly string[]): string {
  const effectiveCount = Math.max(count, labels.length);
  const visibleLabels = labels.slice(0, 6);
  const hiddenCount = Math.max(0, effectiveCount - visibleLabels.length);
  const displayLabels = hiddenCount > 0 ? [...visibleLabels, `${hiddenCount} more`] : visibleLabels;
  const countLabel = effectiveCount === 1
    ? "1 active asset"
    : effectiveCount > 1
      ? `${effectiveCount} active assets`
      : "active assets";
  return displayLabels.length > 0 ? `${countLabel}: ${formatProseList(displayLabels)}` : countLabel;
}

export function getActivePriceCoverageImpactDetail(coverage: ActivePriceCoverage): string {
  const acknowledgedIds = new Set(coverage.acknowledgedGapIds ?? []);
  for (const asset of coverage.missingActiveAssets) {
    if (asset.acknowledgedGap) acknowledgedIds.add(asset.stablecoinId);
  }
  const ids = coverage.alertEligibleIds.filter((id) => !acknowledgedIds.has(id));
  const labels = getActivePriceAssetLabels(coverage, ids);
  const affectedAssets = formatAffectedAssets(ids.length, labels);
  return `Live prices are unavailable for ${affectedAssets}. Stablecoin listings and price-dependent analytics may be incomplete until coverage recovers.`;
}

/** Informational only: these remain real missing prices, not incidents. Name
 * the earliest expiry because that is the next review that can re-alert. */
export function getAcknowledgedPriceGapNotice(coverage: ActivePriceCoverage | undefined): string | null {
  if (!coverage) return null;
  const gaps = coverage.missingActiveAssets.filter((asset) => asset.acknowledgedGap);
  const count = coverage.acknowledgedGapCount ?? gaps.length;
  if (count === 0) return null;
  const nextExpiry = Math.min(...gaps.map((asset) => asset.acknowledgedGap!.expiresAt));
  const deadline = Number.isFinite(nextExpiry)
    ? `; next review expires ${new Date(nextExpiry * 1000).toISOString().slice(0, 10)} (UTC)`
    : "";
  return `${count} acknowledged price gap${count === 1 ? "" : "s"} under review${deadline}. Prices remain unavailable and gaps re-alert when their reviews expire.`;
}

export function getPublicHealthWarningPresentation(
  warning: string,
  healthData: HealthResponse,
): PublicHealthWarningPresentation {
  if (warning === "scheduled_delivery_stalled") return {
    title: "Scheduled delivery stalled",
    detail: `No canonical short-cadence lane has started within the delivery budget${healthData.schedulerLiveness?.ageSeconds != null ? ` (${healthData.schedulerLiveness.ageSeconds}s since delivery)` : ""}. Cached data may remain reachable while new updates stop.`,
  };
  if (warning === "scheduler_liveness_unavailable") return {
    title: "Scheduled delivery evidence unavailable",
    detail: "The live slot-start observation is missing, invalid, or unreadable. Delivery cannot be claimed healthy.",
  };
  if (warning === "heavy_scheduled_delivery_stalled") return {
    title: "Heavy scheduled delivery stalled",
    detail: `The heavy Worker lane has not started within its delivery budget${healthData.schedulerLiveness?.heavy.ageSeconds != null ? ` (${healthData.schedulerLiveness.heavy.ageSeconds}s since delivery)` : ""}. Public delivery can remain healthy while heavy updates stop.`,
  };
  if (warning === "heavy_scheduler_liveness_unavailable") return {
    title: "Heavy scheduled delivery evidence unavailable",
    detail: "The live heavy slot-start observation is missing, invalid, or unreadable. Heavy delivery cannot be claimed healthy.",
  };
  if (warning.startsWith("stablecoin-publication-incomplete:")) {
    const ids = healthData.stablecoinPublication?.missingActiveIds ?? [];
    const publication = healthData.stablecoinPublication;
    const impact = publication && getStablecoinPublicationImpactStatus(
      publication, healthData.activePriceCoverage ?? { missingActiveAssets: [] }, healthData.timestamp,
    );
    return {
      title: "Stablecoin publication coverage",
      detail: ids.length === 0
        ? "Published listing counts do not reconcile. Public health remains degraded until exact coverage is verified."
        : `Published listings are missing ${formatAffectedAssets(ids.length, ids)}. ${
          impact === "healthy"
            ? "These isolated small-asset omissions remain visible warnings without degrading public health."
            : "Material, unverified, or widespread omissions degrade public health until coverage recovers."
        }`,
    };
  }
  if (warning === "stablecoin-publication-unknown") return {
    title: "Stablecoin publication coverage",
    detail: "Exact listing coverage is unavailable; public health degrades until publication evidence recovers.",
  };
  if (warning.startsWith(ACTIVE_PRICE_INCOMPLETE_PREFIX)) {
    const fallbackIds = warning
      .slice(ACTIVE_PRICE_INCOMPLETE_PREFIX.length)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0 && id !== "count-mismatch");
    const coverage = healthData.activePriceCoverage;
    const detail =
      coverage?.status === "incomplete"
        ? getActivePriceCoverageImpactDetail(coverage)
        : `Live prices are unavailable for ${formatAffectedAssets(fallbackIds.length, fallbackIds)}. Stablecoin listings and price-dependent analytics may be incomplete until coverage recovers.`;
    return { title: "Stablecoin price coverage", detail };
  }

  if (warning === "active-price-coverage-unknown") {
    return {
      title: "Stablecoin price coverage",
      detail:
        "Exact live-price coverage is unavailable. Stablecoin listings and price-dependent analytics may be incomplete until telemetry recovers.",
    };
  }

  if (warning.startsWith(ACTIVE_PRICE_CRITICAL_DURATION_PREFIX)) {
    const ids = warning
      .slice(ACTIVE_PRICE_CRITICAL_DURATION_PREFIX.length)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0
        && !(healthData.activePriceCoverage?.acknowledgedGapIds ?? []).includes(id)
        && !(healthData.activePriceCoverage?.missingActiveAssets ?? []).find((asset) => asset.stablecoinId === id)?.acknowledgedGap);
    const labels = getActivePriceAssetLabels(healthData.activePriceCoverage, ids);
    return {
      title: "Long-running price gaps",
      detail: `${formatAffectedAssets(ids.length, labels)} ${ids.length === 1 ? "has" : "have"} had no accepted live price for more than a week. Each is under catalog review to re-source the price or retire the listing; an absent listing has only dated last-known market-cap evidence.`,
    };
  }

  if (warning === "cache-quality-degraded: yield-data:producer-degraded-since-last-clean-run") {
    return {
      title: "Yield data quality",
      detail: "A recent yield update reported incomplete or degraded inputs. Yield data remains degraded until a clean update succeeds.",
    };
  }

  return { title: "Health warning", detail: warning };
}

export { getPublicMintBurnStatus };

/** Plain words for the divergence sentences; raw enum values never reach copy. */
const DIVERGENCE_WORD: Record<StatusHealthValue, string> = {
  healthy: "no problem",
  degraded: "a partial problem",
  stale: "a serious problem",
};

export type PublicDivergenceNotice =
  | { kind: "in-sync" }
  | { kind: "health-degraded-probes-ok"; detail: string }
  | { kind: "probes-degraded-health-ok"; detail: string }
  | { kind: "both-degraded-different-severity"; detail: string };

export function getPublicDivergenceNotice(
  healthStatus: StatusHealthValue,
  probeStatus: StatusHealthValue,
): PublicDivergenceNotice {
  const h = STATUS_PRIORITY[healthStatus];
  const p = STATUS_PRIORITY[probeStatus];
  if (h === p) return { kind: "in-sync" };
  if (h > 0 && p === 0) {
    return {
      kind: "health-degraded-probes-ok",
      detail: `The health check reports ${DIVERGENCE_WORD[healthStatus]} while browser probes pass. This points to a data freshness or ingestion issue rather than an API outage.`,
    };
  }
  if (p > 0 && h === 0) {
    return {
      kind: "probes-degraded-health-ok",
      detail: `Browser probes report ${DIVERGENCE_WORD[probeStatus]} while the health check passes. The problem may be on the network path from this browser.`,
    };
  }
  return {
    kind: "both-degraded-different-severity",
    detail: `The health check reports ${DIVERGENCE_WORD[healthStatus]} and browser probes report ${DIVERGENCE_WORD[probeStatus]}.`,
  };
}

/**
 * The public headline and components for a health payload. The Worker
 * projection is the authority (ADR-32); an older cached payload without it
 * falls back to the same shared projection function.
 */
export function resolvePublicProjection(health: HealthResponse): PublicStatusProjection {
  if (health.headline && health.components) return { headline: health.headline, components: health.components };
  return projectPublicStatus(health);
}

/**
 * Grade an age against the public component bands (the same bands the Worker
 * projection uses): past `delayedAfterSec` is Delayed, past `degradedAfterSec`
 * is Degraded, past the outage grace multiple of that is Outage.
 */
export function getAgeBandState(ageSeconds: number, delayedAfterSec: number, degradedAfterSec: number): PublicComponentState {
  if (ageSeconds > degradedAfterSec * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER) return "outage";
  if (ageSeconds > degradedAfterSec) return "degraded";
  if (ageSeconds > delayedAfterSec) return "delayed";
  return "operational";
}

export interface PublicHeadlineSummary {
  state: PublicHeadlineState | null;
  /** Headline state word ("Operational", "Delayed"...), or "Loading"/"Unavailable" without a payload (R2). */
  label: string;
  /** Headline sentence, when health has loaded. */
  title: string | null;
}

/**
 * What the public `/status/` page shows as its headline, for admin surfaces
 * that summarise public health. A missing payload is "Loading" until the read
 * has failed, never a fabricated state.
 */
export function describePublicHeadline(
  health: HealthResponse | null | undefined,
  loadFailed: boolean,
): PublicHeadlineSummary {
  if (!health) return { state: null, label: loadFailed ? "Unavailable" : "Loading", title: null };
  const { headline } = resolvePublicProjection(health);
  return { state: headline.state, label: PUBLIC_HEADLINE_TONE[headline.state].label, title: headline.title };
}
