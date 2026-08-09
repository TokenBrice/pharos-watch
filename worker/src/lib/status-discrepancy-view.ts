import type {
  StatusDiscrepancy,
  StatusDiscrepancyReason,
  StatusProbeSummary,
} from "@shared/types/status";
import {
  SEVERITY,
  STATUS_SYSTEM_FRESHNESS_SEC,
  type StatusLevel,
} from "./status-reliability-shared";

export function hasDivergence(
  overallStatus: StatusLevel,
  probe: StatusProbeSummary,
  now: number,
): boolean {
  if (probe.status === "unknown" || probe.timestamp == null) {
    return false;
  }
  const probeAgeSeconds = Math.max(0, now - probe.timestamp);
  const severityDelta = SEVERITY[overallStatus] - SEVERITY[probe.status];
  const freshProbe = probeAgeSeconds <= STATUS_SYSTEM_FRESHNESS_SEC;
  return freshProbe && Math.abs(severityDelta) >= 1;
}

export function buildDiscrepancy(
  overallStatus: StatusLevel,
  probe: StatusProbeSummary,
  now: number,
  consecutiveDivergent: number,
): StatusDiscrepancy {
  if (probe.status === "unknown" || probe.timestamp == null) {
    return {
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: SEVERITY[overallStatus],
      probeSeverity: -1,
      details: null,
      probeAgeSeconds: null,
      consecutiveDivergent,
      discrepancyReason: "probe-missing",
    };
  }

  const probeAgeSeconds = Math.max(0, now - probe.timestamp);
  const statusSeverity = SEVERITY[overallStatus];
  const probeSeverity = SEVERITY[probe.status];
  const severityDelta = statusSeverity - probeSeverity;
  const freshProbe = probeAgeSeconds <= STATUS_SYSTEM_FRESHNESS_SEC;
  const divergent = hasDivergence(overallStatus, probe, now);

  const discrepancyReason: StatusDiscrepancyReason = !freshProbe
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
