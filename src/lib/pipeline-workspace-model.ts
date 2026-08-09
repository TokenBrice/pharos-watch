import { formatElapsedSeconds } from "@shared/lib/format";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";
import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
  STATUS_ONCHAIN_THRESHOLDS,
  hasRepresentativeOnchainRatioSample,
} from "@shared/lib/status-thresholds";
import type { DataQuality, StatusResponse, StatusSectionKey } from "@shared/types";
import {
  buildWorkspaceModeUrl,
  healthSeverity,
  parseWorkspaceMode,
  pickInitialMode,
  worstSeverity,
  SEVERITY_RANK,
  type WorkspaceSeverity,
} from "@/lib/status/workspace-mode";

export const PIPELINE_MODES = [
  { id: "quality", label: "Quality" },
  { id: "markets", label: "Markets" },
  { id: "reserves", label: "Reserves" },
  { id: "yield", label: "Yield" },
  { id: "storage", label: "Storage" },
  { id: "integrity", label: "Integrity" },
] as const;

export type PipelineMode = (typeof PIPELINE_MODES)[number]["id"];
export type PipelineSeverity = WorkspaceSeverity;

/**
 * The pipeline severity chip vocabulary — label plus the fill-badge class the
 * `StatusPill` wears. Declared once here because the integrity panel and the
 * quality table rendered diff-identical copies of it (WS8.9).
 */
export const PIPELINE_STATE_META: Record<PipelineSeverity, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  watch: { label: "Watch", className: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  critical: { label: "Critical", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
  unknown: { label: "Unknown", className: "bg-muted text-muted-foreground" },
};

export interface PipelineModeSummary {
  id: PipelineMode;
  label: string;
  issueCount: number;
  severity: PipelineSeverity;
}

export interface PipelineLoaderError {
  mode: PipelineMode;
  label: string;
  rawKey: StatusSectionKey;
  code: string;
  message: string;
}

export interface PipelineQualityRow {
  id: "missing-prices" | "blacklist-gaps" | "onchain-divergences" | "stale-onchain";
  label: string;
  rawCode: string;
  currentValue: string;
  eligiblePopulation: string;
  warningThreshold: string;
  staleThreshold: string;
  state: PipelineSeverity;
  stateDetail: string;
  trend: string;
}

export interface PipelineQualityModel {
  rows: PipelineQualityRow[];
  activeDepegs: {
    currentValue: string;
    detail: string;
    rawCode: string;
    unavailable: boolean;
  };
}

export interface PipelineIntegrityRow {
  id: string;
  label: string;
  rawCode: string;
  state: PipelineSeverity;
  currentValue: string;
  detail: string;
}

export interface PipelineIntegrityModel {
  publicationRows: PipelineIntegrityRow[];
  dependencyRows: PipelineIntegrityRow[];
  controlRows: PipelineIntegrityRow[];
  issueCount: number;
  severity: PipelineSeverity;
}

const PIPELINE_ERROR_META: Partial<Record<StatusSectionKey, { mode: PipelineMode; label: string }>> = {
  priceSourceHealth: { mode: "markets", label: "Price source health" },
  liquidityHealth: { mode: "markets", label: "Liquidity health" },
  coingeckoPriceDiff: { mode: "markets", label: "CoinGecko comparison" },
  reserveComposition: { mode: "reserves", label: "Reserve composition" },
  mintBurnReconciliation: { mode: "reserves", label: "Mint/burn reconciliation" },
  reserveDrift: { mode: "reserves", label: "Reserve drift" },
  classificationWarnings: { mode: "reserves", label: "Classification warnings" },
  yieldHealth: { mode: "yield", label: "Yield health" },
  d1Usage: { mode: "storage", label: "D1 usage" },
  publicationHealth: { mode: "integrity", label: "Publication health" },
  dependencyHealth: { mode: "integrity", label: "Dependency health" },
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatAge(ageSeconds: number | null, suffix = "since last sample"): string {
  if (ageSeconds == null) return "Last sample not reported";
  return `${formatElapsedSeconds(ageSeconds)} ${suffix}`;
}

function thresholdState(value: number, warning: number, stale: number, inclusive = false): PipelineSeverity {
  if (inclusive ? value >= stale : value > stale) return "critical";
  if (inclusive ? value >= warning : value > warning) return "watch";
  return "healthy";
}

export function parsePipelineMode(search: string | URLSearchParams): PipelineMode | null {
  return parseWorkspaceMode(PIPELINE_MODES, search);
}

export function buildPipelineModeUrl(
  location: Pick<Location, "pathname" | "search" | "hash">,
  mode: PipelineMode,
): string {
  return buildWorkspaceModeUrl(location, mode);
}

export function collectPipelineLoaderErrors(data: StatusResponse): PipelineLoaderError[] {
  return (Object.entries(data.sectionErrors) as Array<[StatusSectionKey, StatusResponse["sectionErrors"][StatusSectionKey]]>)
    .flatMap(([rawKey, error]) => {
      const meta = PIPELINE_ERROR_META[rawKey];
      if (!meta || !error) return [];
      return [{ ...meta, rawKey, code: error.code, message: error.message }];
    })
    .sort((left, right) => {
      const modeOrder = PIPELINE_MODES.findIndex((mode) => mode.id === left.mode)
        - PIPELINE_MODES.findIndex((mode) => mode.id === right.mode);
      return modeOrder || left.label.localeCompare(right.label);
    });
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
      currentValue: missingUnknown ? "Unknown" : `${missingPrices} (${formatPct(missingRatio)})`,
      eligiblePopulation:
        totalStablecoins != null && totalStablecoins > 0
          ? `${totalStablecoins} active stablecoins returned by the cache`
          : "Unknown active stablecoin population",
      warningThreshold: `>${formatPct(STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded, 0)}`,
      staleThreshold: `>${formatPct(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale, 0)}`,
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
        : `${blacklistMissing} (${formatPct(blacklistRatio, 2)}); ${blacklistRecent} recent`,
      eligiblePopulation:
        blacklistTotal != null && blacklistTotal > 0
          ? `${blacklistTotal} retained blacklist events`
          : "Unknown retained-event population",
      warningThreshold: `>=${formatPct(STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded, 0)} or >=${STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded} recent`,
      staleThreshold: `>=${formatPct(STATUS_BLACKLIST_THRESHOLDS.missingRatioStale, 0)} or >=${STATUS_BLACKLIST_THRESHOLDS.missingRecentStale} recent`,
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
      currentValue: divergenceUnknown ? "Unknown" : `${divergenceCount} (${formatPct(divergenceRatio)})`,
      eligiblePopulation: onchainPopulation,
      warningThreshold: `>=${formatPct(STATUS_ONCHAIN_THRESHOLDS.ratioDegraded, 0)}`,
      staleThreshold: `>=${formatPct(STATUS_ONCHAIN_THRESHOLDS.ratioStale, 0)} or >=${STATUS_ONCHAIN_THRESHOLDS.divergenceAbsoluteStale} coins`,
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
      currentValue: staleUnknown ? "Unknown" : `${staleCount} (${formatPct(staleRatio)})`,
      eligiblePopulation: onchainPopulation,
      warningThreshold: `>=${formatPct(STATUS_ONCHAIN_THRESHOLDS.ratioDegraded, 0)}`,
      staleThreshold: `>=${formatPct(STATUS_ONCHAIN_THRESHOLDS.ratioStale, 0)} or >=${STATUS_ONCHAIN_THRESHOLDS.staleAbsoluteStale} coins`,
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

export function buildPipelineIntegrityModel(data: StatusResponse): PipelineIntegrityModel {
  const publicationRows: PipelineIntegrityRow[] = [];
  const publication = data.publicationHealth;
  if (publication) {
    const failures = new Map((publication.failedSurfaces ?? []).map((failure) => [failure.surface, failure]));
    Object.values(publication.surfaces).forEach((surface) => {
      if (!surface) return;
      const failure = failures.get(surface.surface);
      const attemptState = surface.lastAttemptedGeneration?.state;
      const state: PipelineSeverity = failure || attemptState === "failed" || attemptState === "rejected"
        ? "critical"
        : surface.lastPublishedGeneration
          ? "healthy"
          : "unknown";
      publicationRows.push({
        id: `publication-${surface.surface}`,
        label: surface.label,
        rawCode: surface.surface,
        state,
        currentValue: failure ? "Failed" : surface.lastPublishedGeneration ? "Published" : "Unknown",
        detail: failure
          ? `${failure.message} (${failure.code}; source ${surface.sourceOfTruth})`
          : `Source ${surface.sourceOfTruth}; latest attempt ${attemptState ?? "not reported"}.`,
      });
      failures.delete(surface.surface);
    });
    failures.forEach((failure, surface) => {
      publicationRows.push({
        id: `publication-${surface}`,
        label: surface,
        rawCode: surface,
        state: "critical",
        currentValue: "Failed",
        detail: `${failure.message} (${failure.code})`,
      });
    });
  } else {
    publicationRows.push({
      id: "publication-unavailable",
      label: "Publication health",
      rawCode: "publicationHealth",
      state: "unknown",
      currentValue: "Unknown",
      detail: "No publication-health payload was returned.",
    });
  }

  const dependencyRows: PipelineIntegrityRow[] = [];
  const dependencyHealth = data.dependencyHealth;
  if (dependencyHealth) {
    Object.values(dependencyHealth.dependencies)
      .sort((left, right) => SEVERITY_RANK[healthSeverity(right.status)] - SEVERITY_RANK[healthSeverity(left.status)])
      .forEach((dependency) => {
        dependencyRows.push({
          id: `dependency-${dependency.id}`,
          label: dependency.label,
          rawCode: dependency.id,
          state: healthSeverity(dependency.status),
          currentValue: dependency.status === "unknown" ? "Unknown" : dependency.status,
          detail: [
            dependency.reason,
            `source ${dependency.sourceOfTruth}`,
            dependency.producerJob ? `producer ${dependency.producerJob}` : null,
            dependency.consumers.length > 0 ? `consumers ${dependency.consumers.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("; "),
        });
      });
    if (dependencyRows.length === 0) {
      dependencyRows.push({
        id: "dependency-empty",
        label: "Dependency inventory",
        rawCode: "dependencyHealth.dependencies",
        state: "unknown",
        currentValue: "Unknown",
        detail: "Dependency health returned an empty inventory.",
      });
    }
  } else {
    dependencyRows.push({
      id: "dependency-unavailable",
      label: "Dependency health",
      rawCode: "dependencyHealth",
      state: "unknown",
      currentValue: "Unknown",
      detail: "No dependency-health payload was returned.",
    });
  }

  const stablecoinPublication = data.dataQuality.stablecoinPublication;
  const repairDebt = data.dataQuality.repairDebt;
  const controlRows: PipelineIntegrityRow[] = [
    stablecoinPublication
      ? {
          id: "stablecoin-publication",
          label: "Stablecoin publication coverage",
          rawCode: "stablecoin_publication",
          state:
            stablecoinPublication.status === "complete"
              ? "healthy"
              : stablecoinPublication.status === "incomplete"
                ? "critical"
                : "unknown",
          currentValue:
            stablecoinPublication.status === "unknown"
              ? "Unknown"
              : `${stablecoinPublication.presentActiveCount + stablecoinPublication.waivedActiveCount}/${stablecoinPublication.expectedActiveCount}`,
          detail: `${stablecoinPublication.missingActiveIds.length} missing; ${stablecoinPublication.waivedActiveCount} waived; ${stablecoinPublication.expiredWaiverIds.length} expired waivers.`,
        }
      : {
          id: "stablecoin-publication",
          label: "Stablecoin publication coverage",
          rawCode: "stablecoin_publication",
          state: "unknown",
          currentValue: "Unknown",
          detail: "The status payload did not include publication coverage.",
        },
    repairDebt
      ? {
          id: "repair-debt",
          label: "Pipeline repair debt",
          rawCode: "repair_debt",
          state: repairDebt.status === "ok" ? "healthy" : repairDebt.status === "present" ? "watch" : "unknown",
          currentValue: repairDebt.status === "unknown" ? "Unknown" : String(repairDebt.openCount),
          detail: `Source ${repairDebt.source}; oldest ${repairDebt.oldestAgeSec == null ? "unknown" : formatAge(repairDebt.oldestAgeSec, "old")}.`,
        }
      : {
          id: "repair-debt",
          label: "Pipeline repair debt",
          rawCode: "repair_debt",
          state: "unknown",
          currentValue: "Unknown",
          detail: "The status payload did not include repair-debt evidence.",
        },
  ];

  const rows = [...publicationRows, ...dependencyRows, ...controlRows];
  const issueCount = rows.filter((row) => row.state !== "healthy").length;
  return {
    publicationRows,
    dependencyRows,
    controlRows,
    issueCount,
    severity: worstSeverity(rows.map((row) => row.state)),
  };
}

function payloadIssueCount(payloadPresent: boolean, count: number): number {
  return payloadPresent ? count : 1;
}

export function buildPipelineModeSummaries(data: StatusResponse): PipelineModeSummary[] {
  const loaderErrors = collectPipelineLoaderErrors(data);
  const loaderErrorCount = (mode: PipelineMode) => loaderErrors.filter((error) => error.mode === mode).length;
  const quality = buildPipelineQualityModel(data);
  const qualityStates = quality.rows.map((row) => row.state);
  const qualityCount = qualityStates.filter((state) => state !== "healthy").length;

  const marketStates: PipelineSeverity[] = [];
  let marketCount = loaderErrorCount("markets");
  if (data.priceSourceHealth) {
    if (data.priceSourceHealth.totalAssets <= 0) {
      marketStates.push("unknown");
      marketCount += 1;
    } else {
      const missing = finiteNumber(data.priceSourceHealth.sourceDistribution.missing);
      if (missing == null) {
        marketStates.push("unknown");
        marketCount += 1;
      } else if (missing > 0) {
        marketStates.push(missing > 3 ? "critical" : "watch");
        marketCount += missing;
      } else {
        marketStates.push("healthy");
      }
    }
  } else {
    marketStates.push("unknown");
    marketCount += payloadIssueCount(Boolean(data.sectionErrors.priceSourceHealth), 0);
  }
  if (data.liquidityHealth) {
    const guardCount = [
      data.liquidityHealth.nearCoverageGuard,
      data.liquidityHealth.nearValueGuard,
      data.liquidityHealth.nearMajorCoverageGuard,
    ].filter(Boolean).length;
    const liquidityCount = data.liquidityHealth.failedSources.length + guardCount;
    marketCount += liquidityCount;
    marketStates.push(liquidityCount > 0 ? "watch" : "healthy");
  } else {
    marketStates.push("unknown");
    marketCount += payloadIssueCount(Boolean(data.sectionErrors.liquidityHealth), 0);
  }
  if (data.coingeckoPriceDiff) {
    marketCount += data.coingeckoPriceDiff.mismatchedCount;
    marketStates.push(data.coingeckoPriceDiff.mismatchedCount > 0 ? "watch" : "healthy");
  } else {
    marketStates.push("unknown");
    marketCount += payloadIssueCount(Boolean(data.sectionErrors.coingeckoPriceDiff), 0);
  }
  if (loaderErrorCount("markets") > 0) marketStates.push("unknown");

  const reserveStates: PipelineSeverity[] = [healthSeverity(data.reserveComposition.status)];
  const reserveOperationalCount =
    data.reserveComposition.deferredCoins +
    data.reserveComposition.staleCoins +
    data.reserveComposition.missingCoins +
    data.reserveComposition.degradedCoins +
    data.reserveComposition.errorCoins +
    data.reserveComposition.corruptCoins +
    data.reserveComposition.writeTimeoutUncertain;
  let reserveCount = reserveOperationalCount + loaderErrorCount("reserves");
  if (reserveOperationalCount > 0) reserveStates.push("watch");
  if (data.reserveComposition.errorCoins > 0 || data.reserveComposition.corruptCoins > 0) reserveStates.push("critical");
  if (data.reserveDrift) {
    reserveCount += data.reserveDrift.length;
    if (data.reserveDrift.length > 0) reserveStates.push("watch");
  } else {
    reserveCount += payloadIssueCount(Boolean(data.sectionErrors.reserveDrift), 0);
    reserveStates.push("unknown");
  }
  if (data.classificationWarnings) {
    reserveCount += data.classificationWarnings.length;
    if (data.classificationWarnings.length > 0) reserveStates.push("watch");
  } else {
    reserveCount += payloadIssueCount(Boolean(data.sectionErrors.classificationWarnings), 0);
    reserveStates.push("unknown");
  }
  if (data.mintBurnReconciliation) {
    reserveCount += data.mintBurnReconciliation.criticalCount + data.mintBurnReconciliation.warnCount;
    if (data.mintBurnReconciliation.criticalCount > 0) reserveStates.push("critical");
    else if (data.mintBurnReconciliation.warnCount > 0) reserveStates.push("watch");
  } else {
    reserveCount += payloadIssueCount(Boolean(data.sectionErrors.mintBurnReconciliation), 0);
    reserveStates.push("unknown");
  }
  if (loaderErrorCount("reserves") > 0) reserveStates.push("unknown");

  let yieldCount = loaderErrorCount("yield");
  const yieldStates: PipelineSeverity[] = [];
  if (data.yieldHealth) {
    const state = healthSeverity(data.yieldHealth.status);
    yieldStates.push(state);
    if (state !== "healthy") yieldCount += 1;
  } else {
    yieldStates.push("unknown");
    yieldCount += payloadIssueCount(Boolean(data.sectionErrors.yieldHealth), 0);
  }

  const freshnessMissing = Object.values(data.datasetFreshness).filter((value) => value == null).length;
  const storageStates: PipelineSeverity[] = [];
  let storageCount = loaderErrorCount("storage") + freshnessMissing;
  if (freshnessMissing > 0) storageStates.push("unknown");
  if (data.d1Usage) storageStates.push("healthy");
  else {
    storageStates.push("unknown");
    storageCount += payloadIssueCount(Boolean(data.sectionErrors.d1Usage), 0);
  }

  const integrity = buildPipelineIntegrityModel(data);
  const integrityCount = integrity.issueCount + loaderErrorCount("integrity");
  const integrityStates = [integrity.severity, ...(loaderErrorCount("integrity") > 0 ? ["unknown" as const] : [])];

  const byMode: Record<PipelineMode, { issueCount: number; severity: PipelineSeverity }> = {
    quality: { issueCount: qualityCount, severity: worstSeverity(qualityStates) },
    markets: { issueCount: marketCount, severity: worstSeverity(marketStates) },
    reserves: { issueCount: reserveCount, severity: worstSeverity(reserveStates) },
    yield: { issueCount: yieldCount, severity: worstSeverity(yieldStates) },
    storage: { issueCount: storageCount, severity: worstSeverity(storageStates) },
    integrity: { issueCount: integrityCount, severity: worstSeverity(integrityStates) },
  };

  return PIPELINE_MODES.map((mode) => ({ ...mode, ...byMode[mode.id] }));
}

export function deriveInitialPipelineMode(data: StatusResponse): PipelineMode {
  return pickInitialMode(buildPipelineModeSummaries(data), PIPELINE_MODES, "quality");
}
