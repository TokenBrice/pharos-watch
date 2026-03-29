import type {
  StatusDiscrepancy,
  StatusProbeSummary,
} from "@shared/types/status";
import {
  SEVERITY,
  STATUS_SYSTEM_FRESHNESS_SEC,
  type StatusLevel,
} from "./status-reliability-shared";

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
    };
  }

  const probeAgeSeconds = Math.max(0, now - probe.timestamp);
  const statusSeverity = SEVERITY[overallStatus];
  const probeSeverity = SEVERITY[probe.status];
  const severityDelta = statusSeverity - probeSeverity;
  const freshProbe = probeAgeSeconds <= STATUS_SYSTEM_FRESHNESS_SEC;
  const hasDivergence = freshProbe && Math.abs(severityDelta) >= 1;

  return {
    hasDivergence,
    severityDelta,
    statusSeverity,
    probeSeverity,
    details: hasDivergence ? `status=${overallStatus}, probe=${probe.status}, probeAge=${probeAgeSeconds}s` : null,
    probeAgeSeconds,
    consecutiveDivergent,
  };
}
