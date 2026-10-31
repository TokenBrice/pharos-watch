import type {
  StatusDiscrepancy,
  StatusDiscrepancyReason,
  StatusProbeSummary,
} from "@shared/types/status";
import type { StatusHealthValue } from "@shared/types/status/core";
import {
  SEVERITY,
  STATUS_SYSTEM_FRESHNESS_SEC,
} from "./status-reliability-shared";
import { assessFreshnessTimestamp } from "./api-freshness-age";

export function hasDivergence(
  overallStatus: StatusHealthValue,
  probe: StatusProbeSummary,
  now: number,
): boolean {
  if (probe.status === "unknown" || probe.timestamp == null) {
    return false;
  }
  const timestamp = assessFreshnessTimestamp(now, probe.timestamp);
  if (timestamp.reason != null) return false;
  const probeAgeSeconds = timestamp.ageSeconds;
  const severityDelta = SEVERITY[overallStatus] - SEVERITY[probe.status];
  const freshProbe = probeAgeSeconds <= STATUS_SYSTEM_FRESHNESS_SEC;
  return freshProbe && Math.abs(severityDelta) >= 1;
}

export function buildDiscrepancy(
  overallStatus: StatusHealthValue | null,
  probe: StatusProbeSummary,
  now: number,
  consecutiveDivergent: number | null,
  statusUnavailableReason: "status-missing" | "status-unreadable" = "status-missing",
  probeUnavailableReason: "probe-missing" | "probe-unreadable" = "probe-missing",
): StatusDiscrepancy {
  if (overallStatus == null) {
    return {
      hasDivergence: false,
      severityDelta: null,
      statusSeverity: null,
      probeSeverity: probe.status === "unknown" ? -1 : SEVERITY[probe.status],
      details: "Status comparison authority unavailable.",
      probeAgeSeconds: assessFreshnessTimestamp(now, probe.timestamp).ageSeconds,
      consecutiveDivergent,
      discrepancyReason: statusUnavailableReason,
    };
  }
  if (probe.status === "unknown" || probe.timestamp == null) {
    // A failed probe read is not an observed absence: its verdict and delta are
    // unavailable, while a successful read with no row stays `probe-missing`.
    const unreadable = probeUnavailableReason === "probe-unreadable";
    return {
      hasDivergence: false,
      severityDelta: unreadable ? null : 0,
      statusSeverity: SEVERITY[overallStatus],
      probeSeverity: -1,
      details: unreadable ? "Probe comparison authority unavailable." : null,
      probeAgeSeconds: null,
      consecutiveDivergent,
      discrepancyReason: probeUnavailableReason,
    };
  }

  const timestamp = assessFreshnessTimestamp(now, probe.timestamp);
  const probeAgeSeconds = timestamp.ageSeconds;
  const statusSeverity = SEVERITY[overallStatus];
  const probeSeverity = SEVERITY[probe.status];
  const severityDelta = statusSeverity - probeSeverity;
  const freshProbe = probeAgeSeconds != null && probeAgeSeconds <= STATUS_SYSTEM_FRESHNESS_SEC;
  const divergent = hasDivergence(overallStatus, probe, now);

  const discrepancyReason: StatusDiscrepancyReason = timestamp.reason != null
    ? "probe-invalid-timestamp"
    : !freshProbe
      ? "probe-stale"
      : divergent
        ? "probe-disagrees"
        : "in-sync";

  return {
    hasDivergence: divergent,
    severityDelta,
    statusSeverity,
    probeSeverity,
    details: divergent ? `status=${overallStatus}, probe=${probe.status}, probeAge=${probeAgeSeconds}s` : null,
    probeAgeSeconds,
    consecutiveDivergent,
    discrepancyReason,
  };
}
