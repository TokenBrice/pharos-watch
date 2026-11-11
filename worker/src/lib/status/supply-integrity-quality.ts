import {
  STATUS_SUPPLY_VALUE_THRESHOLDS,
  STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC,
  getActiveAssetServiceBreadthThreshold,
} from "@shared/lib/status-thresholds";
import type { StatusCause, StatusHealthValue } from "@shared/types/status";
import { STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE } from "../market-supply/stablecoin-publication-coverage";
import type { SupplyIntegrityReport } from "../market-supply/supply-integrity";
import { expiringReviews } from "./evaluation-causes";

export interface SupplyIntegrityAssessment {
  status: StatusHealthValue;
  causes: StatusCause[];
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function isoDay(seconds: number | null): string {
  return seconds == null ? "none" : new Date(seconds * 1000).toISOString().slice(0, 10);
}

function isoInstant(seconds: number | null): string {
  return seconds == null ? "unknown" : new Date(seconds * 1000).toISOString();
}

function cause(
  code: string,
  severity: StatusCause["severity"],
  message: string,
  details: Pick<StatusCause, "metric" | "value" | "threshold"> = {},
): StatusCause {
  return { code, layer: "data-quality", severity, message, ...details };
}

/**
 * Ops-only supply integrity causes. These code names are deliberately absent
 * from `shared/lib/status-public-impact.ts`: value/carry/partial findings name
 * producers and budgets on `/status` and the operator alert, never a reader
 * warning (ADR-42). Value drift and a stopped daily snapshot degrade the
 * data-quality verdict because the published supply surface is then wrong or
 * absent; carried supply and a sub-breadth partial snapshot remain warnings.
 */
export function assessSupplyIntegrityQuality(
  report: SupplyIntegrityReport | null,
): SupplyIntegrityAssessment {
  if (report == null) {
    return {
      status: "healthy",
      causes: [cause(
        "supply_integrity_unknown",
        "info",
        "Supply integrity evidence could not be read; cached supply values, carry and daily snapshot coverage are unknown, not healthy.",
      )],
    };
  }

  const causes: StatusCause[] = [];
  const unknownReasons: string[] = [];
  let status: StatusHealthValue = "healthy";
  const degrade = () => {
    status = "degraded";
  };

  const value = report.value;
  const expectedActive = value.expectedActiveCount;
  if (value.status === "unknown") {
    unknownReasons.push(`value drift (${value.reason ?? "unknown"})`);
  }
  if (value.heldDriftUnknownReason != null) {
    unknownReasons.push(`held value drift (${value.heldDriftUnknownReason})`);
  }
  const heldDrift = value.heldDriftFindings;
  const aggregateBreached = value.aggregateRatio != null
    && (value.aggregateRatio < STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioFloor
      || value.aggregateRatio > STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioCeiling);
  if (value.driftFindings.length + heldDrift.length > 0 || value.frozen || aggregateBreached) {
    const examples = [...value.driftFindings, ...heldDrift].slice(0, 5)
      .map((finding) => `${finding.stablecoinId} ${finding.ratio.toFixed(2)}x`)
      .join(", ");
    const findingCount = value.driftFindings.length + heldDrift.length;
    causes.push(cause(
      "supply_value_drift",
      "warning",
      `Cached supply moved outside the generation-over-generation invariant against the previous daily row`
        + `${examples ? ` (${examples}${findingCount > 5 ? `, +${findingCount - 5} more` : ""})` : ""}`
        + `${heldDrift.length > 0 ? `; ${heldDrift.length} still outside the band against the pre-rollover daily baseline` : ""}`
        + `${aggregateBreached && value.aggregateRatio != null ? `; comparable total ${value.aggregateRatio.toFixed(2)}x` : ""}`
        + `${value.frozen ? "; comparable total is unchanged across generations" : ""}. `
        + `Producer sync-stablecoins, cache generation ${isoInstant(value.cacheUpdatedAt)}, budget per-asset `
        + `${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioFloor}-${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling}x, total `
        + `${STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioFloor}-${STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioCeiling}x.`,
      {
        metric: findingCount > 0 ? "supplyValueDriftCount" : "supplyValueAggregateRatio",
        value: findingCount > 0 ? findingCount : value.aggregateRatio ?? undefined,
        threshold: findingCount > 0
          ? STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling
          : STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioCeiling,
      },
    ));
    degrade();
  }

  // Carry evidence comes from the stablecoins cache and survives a failed
  // history read, so it is graded even when the value comparison is unknown.
  if (value.acknowledgedCarryReviews.length > 0) causes.push(cause(
    "supply_carry_reviews_acknowledged", "info",
    `Reviewed carried supply: ${value.acknowledgedCarryReviews.map((review) =>
      `${review.stablecoinId} (expires ${isoInstant(review.expiresAt)})`).join(", ")}. Published values and carry ceilings are unchanged.`,
  ));
  if (value.expiredCarryReviewIds.length > 0) causes.push(cause(
    "supply_carry_reviews_expired", "info",
    `Expired supply-carry reviews: ${value.expiredCarryReviewIds.join(", ")}; carry gates re-armed.`,
  ));
  const expiring = expiringReviews(value.acknowledgedCarryReviews.map((review) => ({
    id: review.stablecoinId, expiresAt: review.expiresAt,
  })), report.observedAt);
  if (expiring.length > 0) causes.push(cause(
    "supply_carry_reviews_expiring", "info",
    `Supply-carry review(s) currently acknowledging carried supply expire within 48h: ${expiring.map((review) =>
      `${review.id} (expires ${isoInstant(review.expiresAt)}, ${Math.floor(review.remainingSec / 3600)}h left)`).join(", ")}. Renew with fresh evidence or let the carry re-alert; expiry re-arms carry gates automatically.`,
    { metric: "supplyCarryReviewsExpiringSoonestSec", value: expiring[0].remainingSec, threshold: STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC },
  ));
  if (value.unacknowledgedCarryIds.length > 0) {
    const carryThreshold = Math.max(
      1,
      Math.ceil(expectedActive * STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold),
    );
    const carryBreadth = getActiveAssetServiceBreadthThreshold(expectedActive);
    const carryStale = value.unacknowledgedCarryIds.length >= carryThreshold
      || (value.unacknowledgedCarryOldestAgeSec != null && value.unacknowledgedCarryOldestAgeSec > STATUS_SUPPLY_VALUE_THRESHOLDS.carryStaleAfterSec);
    if (carryStale) {
      causes.push(cause(
        "supply_carry_stale",
        "warning",
        `${value.unacknowledgedCarryIds.length} active asset(s) publish carried supply (${value.unacknowledgedCarryIds.slice(0, 8).join(", ")}`
          + `${value.unacknowledgedCarryIds.length > 8 ? `, +${value.unacknowledgedCarryIds.length - 8} more` : ""}); oldest `
          + `${value.unacknowledgedCarryOldestAgeSec == null ? "age unknown" : `${Math.floor(value.unacknowledgedCarryOldestAgeSec / 3600)}h`}`
          + `${value.unacknowledgedCarryUnclockedCount > 0 ? `, ${value.unacknowledgedCarryUnclockedCount} without an observation clock` : ""}. `
          + `Producer sync-stablecoins, cache generation ${isoInstant(value.cacheUpdatedAt)}; budget `
          + `${Math.round(STATUS_SUPPLY_VALUE_THRESHOLDS.carryStaleAfterSec / 3600)}h or `
          + `${percent(STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold)} of active.`,
        {
          metric: "supplyCarryCount",
          value: value.unacknowledgedCarryIds.length,
          threshold: carryThreshold,
        },
      ));
      if (carryBreadth != null && value.unacknowledgedCarryIds.length >= carryBreadth) degrade();
    }
  }

  const availability = report.availability;
  if (availability.status === "unknown") {
    unknownReasons.push(`availability (${availability.reason ?? "unknown"})`);
  } else if (availability.consecutiveGenerations >= 2 && availability.share != null) {
    const unavailable = availability.unavailableCount ?? 0;
    const breadth = getActiveAssetServiceBreadthThreshold(
      (availability.observedCount ?? 0) + unavailable,
    );
    causes.push(cause(
      "supply_availability_degraded",
      "warning",
      `${unavailable} active asset(s) (${percent(availability.share)}) have unavailable supply for `
        + `${availability.consecutiveGenerations} consecutive generation(s). Producer sync-stablecoins, generation `
        + `${isoInstant(availability.latestRunStartedAt)}, budget ${percent(STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold)} for 2 generations.`,
      {
        metric: "supplyUnavailableCount",
        value: unavailable,
        threshold: Math.max(1, Math.ceil(((availability.observedCount ?? 0) + unavailable)
          * STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold)),
      },
    ));
    if (breadth != null && unavailable >= breadth) degrade();
  }

  const charts = report.availability.charts;
  if (charts.status === "truncated") {
    causes.push(cause(
      "chart_history_truncated",
      "warning",
      `The published stablecoin chart history failed continuity against the previous payload`
        + `${charts.codes.length > 0 ? ` (${charts.codes.join(", ")})` : ""}. `
        + `Producer sync-stablecoin-charts, generation ${isoInstant(charts.runStartedAt)}, budget 80% of the prior point count.`,
      { metric: "chartContinuityFindings", value: charts.codes.length },
    ));
    degrade();
  } else if (charts.status === "unknown" && charts.runStartedAt != null) {
    unknownReasons.push(`chart continuity (${charts.reason ?? "unknown"})`);
  }

  const snapshot = report.snapshot;
  if (snapshot.status === "unknown") {
    unknownReasons.push(`snapshot coverage (${snapshot.reason ?? "unknown"})`);
  }
  if (snapshot.status === "ok" && snapshot.due && !snapshot.current) {
    causes.push(cause(
      "supply_snapshot_overdue",
      "warning",
      `The daily supply snapshot has no row for ${isoDay(snapshot.expectedDate)} (last marker ${isoDay(snapshot.snapshotDate)}). `
        + `Producer snapshot-supply; budget ${Math.round(STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec / 60)}m after UTC midnight.`,
      { metric: "supplySnapshotAgeDays", value: Math.max(0, (snapshot.expectedDate - (snapshot.snapshotDate ?? 0)) / 86400) },
    ));
    degrade();
  }
  if (snapshot.current && snapshot.status === "ok") {
    const band = snapshot.band;
    const rowsMissing = snapshot.persistedRows != null && snapshot.writtenRows != null
      && snapshot.persistedRows < snapshot.writtenRows;
    if (rowsMissing || band === "elevated" || band === "systemic") {
      const share = band != null && snapshot.expectedActiveCount != null
        ? `${snapshot.unavailableActiveIds?.length ?? 0}/${snapshot.expectedActiveCount} (${percent((snapshot.unavailableActiveIds?.length ?? 0) / snapshot.expectedActiveCount)})`
        : `${snapshot.unavailableActiveIds?.length ?? 0} active asset(s)`;
      causes.push(cause(
        "supply_snapshot_partial",
        "warning",
        `${share} have non-restored unavailable supply on the ${isoDay(snapshot.snapshotDate)} snapshot`
          + `${rowsMissing ? `; ${snapshot.persistedRows} of ${snapshot.writtenRows} written rows persisted` : ""}. `
          + `Producer snapshot-supply, snapshot generation ${isoDay(snapshot.snapshotDate)}, budget `
          + `${percent(STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE)}.`,
        {
          metric: "supplySnapshotUnavailableCount",
          value: snapshot.unavailableActiveIds?.length ?? 0,
          threshold: snapshot.expectedActiveCount == null
            ? undefined
            : Math.max(1, Math.ceil(snapshot.expectedActiveCount * STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE)),
        },
      ));
      if (rowsMissing || band === "systemic") degrade();
    }
  }

  if (unknownReasons.length > 0) {
    causes.unshift(cause(
      "supply_integrity_unknown",
      "info",
      `Supply integrity evidence is unknown for: ${unknownReasons.join("; ")}. Unknown is not healthy and never clears a finding.`,
    ));
  }
  return { status, causes };
}
