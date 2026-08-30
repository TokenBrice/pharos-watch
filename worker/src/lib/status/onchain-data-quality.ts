import {
  STATUS_ONCHAIN_THRESHOLDS,
  hasRepresentativeOnchainRatioSample,
} from "@shared/lib/status-thresholds";
import { formatPercentFromRatio } from "@shared/lib/format";
import type { StatusCause, StatusResponse } from "@shared/types/status";

/**
 * Minimum `trackedCoins` value at which the `onchain_monitor_low_sample` info
 * cause becomes meaningful. Below this floor, the tracked set is structurally
 * limited (only sync-kinesis-supply writes to onchain_supply, producing 2
 * tracked coins: KAU + KAG) and the cause adds no actionable signal. Between
 * this floor and `STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins` (10), the
 * cause is legitimate partial-coverage drift worth surfacing.
 *
 * Added during 2026-04-13 status-stability hardening.
 */
const ONCHAIN_LOW_SAMPLE_STRUCTURAL_FLOOR = 3;

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
      message: `On-chain integrity stale (stale=${formatPercentFromRatio(input.staleRatio)}, divergence=${formatPercentFromRatio(input.divergenceRatio)}).`,
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
        `On-chain integrity degraded (stale=${formatPercentFromRatio(input.staleRatio)}, ` +
        `divergence=${formatPercentFromRatio(input.divergenceRatio)}).`,
      metric: "onchainStaleRatio",
      value: input.staleRatio,
      threshold: STATUS_ONCHAIN_THRESHOLDS.ratioDegraded,
    });
  } else if (
    !representative
    // Structural floor: only emit the low-sample cause when the tracked count
    // is in the legitimate partial-coverage band. Current prod has exactly 2
    // tracked coins (KAU + KAG from sync-kinesis-supply), which will never
    // reach the 10-coin ratio threshold with the current writer set — firing
    // the cause forever adds noise without actionable signal.
    && input.trackedCoins >= ONCHAIN_LOW_SAMPLE_STRUCTURAL_FLOOR
    && (input.staleSupply > 0 || input.divergences > 0)
  ) {
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
