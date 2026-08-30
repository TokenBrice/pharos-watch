import { formatPercentFromRatio } from "@shared/lib/format";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";
import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
  STATUS_ONCHAIN_THRESHOLDS,
  hasRepresentativeOnchainRatioSample,
} from "@shared/lib/status-thresholds";
import type { DataQuality, StatusResponse } from "@shared/types";
import { formatAge } from "@/lib/pipeline-workspace-format";
import { worstSeverity } from "@/lib/status/workspace-mode";
import type { PipelineQualityModel, PipelineQualityRow, PipelineSeverity } from "@/lib/pipeline-workspace-model";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function thresholdState(value: number, warning: number, stale: number, inclusive = false): PipelineSeverity {
  if (inclusive ? value >= stale : value > stale) return "critical";
  if (inclusive ? value >= warning : value > warning) return "watch";
  return "healthy";
}

export function buildPipelineQualityModel(data: StatusResponse): PipelineQualityModel {
  const dq = data.dataQuality as DataQuality & Record<string, unknown>;
  const totalStablecoins = finiteNumber(dq.totalStablecoins);
  const missingPrices = finiteNumber(dq.missingPrices);
  const missingRatio =
    totalStablecoins != null && totalStablecoins > 0 && missingPrices != null ? missingPrices / totalStablecoins : null;
  const missingUnknown = dq.stablecoinsCacheStatus === "error" || missingRatio == null;
  let missingState: PipelineSeverity = missingUnknown
    ? "unknown"
    : thresholdState(
        missingRatio,
        STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded,
        STATUS_MISSING_PRICE_THRESHOLDS.ratioStale,
      );
  if (missingState === "healthy" && dq.stablecoinsCacheStatus === "degraded") missingState = "watch";

  const blacklistTotal = finiteNumber(dq.blacklistTotal);
  const blacklistMissing = finiteNumber(dq.blacklistMissingAmounts);
  const blacklistRecent = finiteNumber(dq.blacklistRecentMissingAmounts);
  const blacklistWindow = finiteNumber(dq.blacklistRecentWindowSec);
  const blacklistRatio =
    blacklistTotal != null && blacklistTotal > 0 && blacklistMissing != null
      ? blacklistMissing / blacklistTotal
      : null;
  const blacklistUnknown =
    dq.blacklistGapStatus === "failed" || blacklistRatio == null || blacklistRecent == null || blacklistWindow == null;
  const blacklistState = blacklistUnknown
    ? "unknown"
    : worstSeverity([
        thresholdState(
          blacklistRatio,
          STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded,
          STATUS_BLACKLIST_THRESHOLDS.missingRatioStale,
          true,
        ),
        thresholdState(
          blacklistRecent,
          STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded,
          STATUS_BLACKLIST_THRESHOLDS.missingRecentStale,
          true,
        ),
      ]);

  const trackedCoins = finiteNumber(dq.onchainSupplyTrackedCoins);
  const onchainActive = dq.onchainSupplyQueryStatus === "ok" && dq.onchainSupplyMonitoring === "active";
  const ratioGateActive = trackedCoins != null && hasRepresentativeOnchainRatioSample(trackedCoins);
  const onchainLatestAt = finiteNumber(dq.onchainSupplyLatestAt);
  const onchainAge = onchainLatestAt == null ? null : Math.max(0, data.timestamp - onchainLatestAt);

  const divergenceCount = finiteNumber(dq.onchainSupplyDivergences);
  const divergenceRatio = finiteNumber(dq.onchainDivergenceRatio);
  const divergenceUnknown = !onchainActive || !ratioGateActive || divergenceCount == null || divergenceRatio == null;
  const divergenceState = divergenceUnknown
    ? "unknown"
    : worstSeverity([
        thresholdState(
          divergenceRatio,
          STATUS_ONCHAIN_THRESHOLDS.ratioDegraded,
          STATUS_ONCHAIN_THRESHOLDS.ratioStale,
          true,
        ),
        divergenceCount >= STATUS_ONCHAIN_THRESHOLDS.divergenceAbsoluteStale ? "critical" : "healthy",
      ]);

  const staleCount = finiteNumber(dq.staleOnchainSupply);
  const staleRatio = finiteNumber(dq.onchainStaleRatio);
  const staleUnknown = !onchainActive || !ratioGateActive || staleCount == null || staleRatio == null;
  const staleState = staleUnknown
    ? "unknown"
    : worstSeverity([
        thresholdState(
          staleRatio,
          STATUS_ONCHAIN_THRESHOLDS.ratioDegraded,
          STATUS_ONCHAIN_THRESHOLDS.ratioStale,
          true,
        ),
        staleCount >= STATUS_ONCHAIN_THRESHOLDS.staleAbsoluteStale ? "critical" : "healthy",
      ]);

  const onchainPopulation =
    trackedCoins == null
      ? "Unknown monitored population"
      : `${trackedCoins} monitored stablecoins; ratio gate requires ${STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins}`;
  const onchainUnknownReason = !onchainActive
    ? dq.onchainSupplyQueryStatus === "failed"
      ? "On-chain loader failed; observed counts are not treated as current."
      : "On-chain monitoring is unavailable."
    : !ratioGateActive
      ? `Confidence floor is inactive below ${STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins} monitored coins.`
      : "Required on-chain fields are absent from the payload.";

  const rows: PipelineQualityRow[] = [
    {
      id: "missing-prices",
      label: "Missing prices",
      rawCode: "missing_prices",
      currentValue: missingUnknown ? "Unknown" : `${missingPrices} (${formatPercentFromRatio(missingRatio, 1)})`,
      eligiblePopulation:
        totalStablecoins != null && totalStablecoins > 0
          ? `${totalStablecoins} active stablecoins returned by the cache`
          : "Unknown active stablecoin population",
      warningThreshold: `>${formatPercentFromRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded, 0)}`,
      staleThreshold: `>${formatPercentFromRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale, 0)}`,
      state: missingState,
      stateDetail: missingUnknown
        ? dq.stablecoinsCacheStatus === "error"
          ? `Stablecoin cache failed${dq.stablecoinsCacheReason ? `: ${dq.stablecoinsCacheReason}` : "."}`
          : "The payload did not provide a usable count and denominator."
        : dq.stablecoinsCacheStatus === "degraded"
          ? `Counts are present, but the cache is degraded${dq.stablecoinsCacheReason ? `: ${dq.stablecoinsCacheReason}` : "."}`
          : "Ratio is evaluated against the active cache population.",
      trend: dq.stablecoinsCacheReason ?? "Last change is not reported by the status payload",
    },
    {
      id: "blacklist-gaps",
      label: "Blacklist amount gaps",
      rawCode: "blacklist_missing_amounts",
      currentValue: blacklistUnknown
        ? "Unknown"
        : `${blacklistMissing} (${formatPercentFromRatio(blacklistRatio, 2)}); ${blacklistRecent} recent`,
      eligiblePopulation:
        blacklistTotal != null && blacklistTotal > 0
          ? `${blacklistTotal} retained blacklist events`
          : "Unknown retained-event population",
      warningThreshold: `>=${formatPercentFromRatio(STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded, 0)} or >=${STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded} recent`,
      staleThreshold: `>=${formatPercentFromRatio(STATUS_BLACKLIST_THRESHOLDS.missingRatioStale, 0)} or >=${STATUS_BLACKLIST_THRESHOLDS.missingRecentStale} recent`,
      state: blacklistState,
      stateDetail: blacklistUnknown
        ? dq.blacklistGapStatus === "failed"
          ? "Blacklist coverage query failed; zero-valued fields are not treated as healthy."
          : "No eligible event denominator was reported, so the ratio is unknown."
        : `Recent count covers the trailing ${formatApproxDurationSeconds(blacklistWindow)} window.`,
      trend:
        blacklistUnknown || blacklistRecent == null || blacklistWindow == null
          ? "Trend unavailable"
          : `${blacklistRecent} missing amounts in the trailing ${formatApproxDurationSeconds(blacklistWindow)}`,
    },
    {
      id: "onchain-divergences",
      label: "On-chain supply divergences",
      rawCode: "onchain_supply_divergences",
      currentValue: divergenceUnknown ? "Unknown" : `${divergenceCount} (${formatPercentFromRatio(divergenceRatio, 1)})`,
      eligiblePopulation: onchainPopulation,
      warningThreshold: `>=${formatPercentFromRatio(STATUS_ONCHAIN_THRESHOLDS.ratioDegraded, 0)}`,
      staleThreshold: `>=${formatPercentFromRatio(STATUS_ONCHAIN_THRESHOLDS.ratioStale, 0)} or >=${STATUS_ONCHAIN_THRESHOLDS.divergenceAbsoluteStale} coins`,
      state: divergenceState,
      stateDetail: divergenceUnknown
        ? onchainUnknownReason
        : "A coin is divergent when on-chain supply differs from the reference by more than 5%.",
      trend: formatAge(onchainAge),
    },
    {
      id: "stale-onchain",
      label: "Stale on-chain snapshots",
      rawCode: "stale_onchain_supply",
      currentValue: staleUnknown ? "Unknown" : `${staleCount} (${formatPercentFromRatio(staleRatio, 1)})`,
      eligiblePopulation: onchainPopulation,
      warningThreshold: `>=${formatPercentFromRatio(STATUS_ONCHAIN_THRESHOLDS.ratioDegraded, 0)}`,
      staleThreshold: `>=${formatPercentFromRatio(STATUS_ONCHAIN_THRESHOLDS.ratioStale, 0)} or >=${STATUS_ONCHAIN_THRESHOLDS.staleAbsoluteStale} coins`,
      state: staleState,
      stateDetail: staleUnknown
        ? onchainUnknownReason
        : "Snapshots older than two hours count as stale for this threshold.",
      trend: formatAge(onchainAge),
    },
  ];

  const activeDepegCount = finiteNumber(dq.activeDepegs);
  const activeDepegUnavailable = dq.activeDepegStatus === "failed" || activeDepegCount == null;

  return {
    rows,
    activeDepegs: {
      currentValue: activeDepegUnavailable ? "Unknown" : String(activeDepegCount),
      detail: activeDepegUnavailable
        ? "The active-depeg query failed or returned no count. This does not become a zero."
        : "Informational market context only; active depegs do not change data-quality health.",
      rawCode: "active_depegs",
      unavailable: activeDepegUnavailable,
    },
  };
}
