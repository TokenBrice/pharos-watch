import type { StatusResponse } from "@shared/types";
import { healthSeverity, worstSeverity } from "@/lib/status/workspace-mode";
import {
  PIPELINE_MODES,
  collectPipelineLoaderErrors,
  type PipelineMode,
  type PipelineModeSummary,
  type PipelineSeverity,
} from "@/lib/pipeline-workspace-model";
import { buildPipelineIntegrityModel } from "@/lib/pipeline-workspace-integrity-builder";
import { buildPipelineQualityModel } from "@/lib/pipeline-workspace-quality-builder";

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
