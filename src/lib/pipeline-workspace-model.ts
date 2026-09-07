import type { StatusResponse, StatusSectionKey } from "@shared/types";
import { healthSeverity, pickInitialMode, worstSeverity, type WorkspaceSeverity } from "@/lib/status/workspace-mode";
import { buildPipelineIntegrityModel } from "@/lib/pipeline-workspace-integrity-builder";
import { buildPipelineQualityModel } from "@/lib/pipeline-workspace-quality-builder";

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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export { buildPipelineQualityModel, buildPipelineIntegrityModel };

export function deriveInitialPipelineMode(data: StatusResponse): PipelineMode {
  return pickInitialMode(buildPipelineModeSummaries(data), PIPELINE_MODES, "quality");
}
