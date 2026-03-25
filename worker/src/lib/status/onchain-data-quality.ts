import {
  STATUS_ONCHAIN_THRESHOLDS,
  hasRepresentativeOnchainRatioSample,
} from "@shared/lib/status-thresholds";
import type { StatusCause, StatusResponse } from "@shared/types/status";

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export interface OnchainDataQualityAssessment {
  causes: StatusCause[];
  representative: boolean;
  status: StatusResponse["dataQualityStatus"];
}

export function assessOnchainDataQuality(input: {
  monitoring: StatusResponse["dataQuality"]["onchainSupplyMonitoring"];
  trackedCoins: number;
  staleSupply: number;
  staleRatio: number;
  divergences: number;
  divergenceRatio: number;
}): OnchainDataQualityAssessment {
  const representative = hasRepresentativeOnchainRatioSample(input.trackedCoins);
  const causes: StatusCause[] = [];

  if (input.monitoring !== "active") {
    if (input.monitoring === "unavailable") {
      causes.push({
        code: "onchain_monitor_unavailable",
        layer: "data-quality",
        severity: "info",
        message: "On-chain supply monitor has no active producer. On-chain integrity checks are skipped.",
      });
    }

    return {
      causes,
      representative,
      status: "healthy",
    };
  }

  const status: StatusResponse["dataQualityStatus"] =
    input.staleSupply >= STATUS_ONCHAIN_THRESHOLDS.staleAbsoluteStale ||
    input.divergences >= STATUS_ONCHAIN_THRESHOLDS.divergenceAbsoluteStale ||
    (representative && input.staleRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale) ||
    (representative && input.divergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale)
      ? "stale"
      : representative &&
          (
            input.staleRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
            input.divergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded
          )
        ? "degraded"
        : "healthy";

  if (
    representative &&
    (
      input.staleRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale ||
      input.divergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale
    )
  ) {
    causes.push({
      code: "onchain_integrity_stale",
      layer: "data-quality",
      severity: "critical",
      message: `On-chain integrity stale (stale=${formatRatio(input.staleRatio)}, divergence=${formatRatio(input.divergenceRatio)}).`,
      metric: "onchainStaleRatio",
      value: input.staleRatio,
      threshold: STATUS_ONCHAIN_THRESHOLDS.ratioStale,
    });
  } else if (
    representative &&
    (
      input.staleRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
      input.divergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded
    )
  ) {
    causes.push({
      code: "onchain_integrity_degraded",
      layer: "data-quality",
      severity: "warning",
      message:
        `On-chain integrity degraded (stale=${formatRatio(input.staleRatio)}, ` +
        `divergence=${formatRatio(input.divergenceRatio)}).`,
      metric: "onchainStaleRatio",
      value: input.staleRatio,
      threshold: STATUS_ONCHAIN_THRESHOLDS.ratioDegraded,
    });
  } else if (!representative && input.trackedCoins > 0 && (input.staleSupply > 0 || input.divergences > 0)) {
    causes.push({
      code: "onchain_monitor_low_sample",
      layer: "data-quality",
      severity: "info",
      message:
        `On-chain monitor has only ${input.trackedCoins} recently refreshed coin(s); ratio-based stale/degraded thresholds stay inactive until ` +
        `${STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins} coins are live.`,
      metric: "onchainSupplyTrackedCoins",
      value: input.trackedCoins,
      threshold: STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins,
    });
  }

  return {
    causes,
    representative,
    status,
  };
}
