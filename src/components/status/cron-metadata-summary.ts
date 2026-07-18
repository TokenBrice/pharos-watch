import {
  readMetadataArray as readArray,
  readMetadataBoolean as readBoolean,
  readMetadataNumber as readNumber,
  readMetadataRecord as readRecord,
  readMetadataString as readString,
} from "@shared/lib/status-metadata";

function formatApiErrorClasses(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;

  const parts = Object.entries(record)
    .map(([key, raw]) => {
      const count = readNumber(raw);
      return count != null ? `${key} x${count}` : null;
    })
    .filter((item): item is string => item != null)
    .sort((a, b) => a.localeCompare(b));

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatSlowestProbes(value: unknown): string | null {
  const probes = readArray(value);
  if (!probes || probes.length === 0) return null;

  const parts = probes
    .map((probe) => {
      const record = readRecord(probe);
      const path = readString(record?.path);
      const latencyMs = readNumber(record?.latencyMs);
      if (!path || latencyMs == null) return null;
      return `${path} ${latencyMs}ms`;
    })
    .filter((item): item is string => item != null)
    .slice(0, 2);

  return parts.length > 0 ? `slowest ${parts.join(", ")}` : null;
}

function formatStringList(value: unknown): string | null {
  const items = readArray(value)?.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items && items.length > 0 ? items.join(", ") : null;
}

function readStringArray(value: unknown): string[] {
  return readArray(value)?.filter((item): item is string => typeof item === "string" && item.length > 0) ?? [];
}

function formatTierBreakdown(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;

  const orderedKeys = ["t1", "t2", "t3", "dormant"] as const;
  const parts = orderedKeys
    .map((key) => {
      const count = readNumber(record[key]);
      return count != null && count > 0 ? `${key} ${count}` : null;
    })
    .filter((item): item is string => item != null);

  return parts.length > 0 ? `eligible tiers ${parts.join(", ")}` : null;
}

function summarizeStatusSelfCheck(metadata: Record<string, unknown>): string[] {
  const sampleCount = readNumber(metadata.sampleCount);
  const failCount = readNumber(metadata.failCount);
  const probeStatus = readString(metadata.probeStatus);
  const rawOverallStatus = readString(metadata.rawOverallStatus);
  const effectiveStatus = readString(metadata.effectiveStatus);
  const discrepancyStreak = readNumber(metadata.discrepancyStreak);
  const probeFailureStreak = readNumber(metadata.probeFailureStreak);
  const p95LatencyMs = readNumber(metadata.p95LatencyMs);
  const probeMode = readString(metadata.probeMode);
  const latencySummary = readRecord(metadata.latencySummary);
  const medianLatencyMs = readNumber(latencySummary?.medianMs);
  const maxLatencyMs = readNumber(latencySummary?.maxMs);
  const slowestProbes = formatSlowestProbes(metadata.slowestProbes);

  return [
    sampleCount != null && failCount != null && probeStatus
      ? `probes ${sampleCount - failCount}/${sampleCount} ok, ${failCount} failed (${probeStatus})`
      : null,
    rawOverallStatus && effectiveStatus ? `status raw ${rawOverallStatus} -> effective ${effectiveStatus}` : null,
    probeMode ? `probe mode ${probeMode}` : null,
    p95LatencyMs != null
      ? `latency${medianLatencyMs != null ? ` median ${medianLatencyMs}ms,` : ""} p95 ${p95LatencyMs}ms${maxLatencyMs != null ? `, max ${maxLatencyMs}ms` : ""}`
      : null,
    slowestProbes,
    discrepancyStreak != null && discrepancyStreak > 0 ? `divergence streak ${discrepancyStreak}` : null,
    probeFailureStreak != null && probeFailureStreak > 0 ? `probe failure streak ${probeFailureStreak}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeDexDiscovery(metadata: Record<string, unknown>): string[] {
  const coinsCrawled = readNumber(metadata.coinsCrawled);
  const poolsDiscovered = readNumber(metadata.poolsDiscovered);
  const runSeq = readNumber(metadata.runSeq);
  const budgetExhausted = readBoolean(metadata.budgetExhausted);
  const failedCoins = readArray(metadata.failedCoins)?.filter((coin): coin is string => typeof coin === "string");

  return [
    coinsCrawled != null && poolsDiscovered != null
      ? `crawled ${coinsCrawled} coins, discovered ${poolsDiscovered} pools${runSeq != null ? ` (run #${runSeq})` : ""}`
      : null,
    formatTierBreakdown(metadata.tierBreakdown),
    budgetExhausted ? "budget exhausted before the full discovery queue finished" : null,
    failedCoins && failedCoins.length > 0 ? `coin crawl failures ${failedCoins.length}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeDexLiquidity(metadata: Record<string, unknown>): string[] {
  const stagedPoolsMerged = readNumber(metadata.stagedPoolsMerged);
  const stagedPoolsSkipped = readNumber(metadata.stagedPoolsSkipped);
  const stagedPoolsSkippedByExactIdentity =
    readNumber(metadata.stagedPoolsSkippedByExactIdentity) ?? readNumber(metadata.stagedPoolsSkippedByAddress);
  const stagedPoolsSkippedByUniqueDerivedIdentity =
    readNumber(metadata.stagedPoolsSkippedByUniqueDerivedIdentity) ?? readNumber(metadata.stagedPoolsSkippedByFingerprint);
  const failedSources = formatStringList(metadata.failedSources);
  const fallbackMode = formatStringList(metadata.fallbackMode);
  const sourceCoverage = readRecord(metadata.sourceCoverage);
  const currentCoverage = readNumber(sourceCoverage?.currentCoverage);
  const previousCoverage = readNumber(sourceCoverage?.previousCoverage);
  const minExpectedCoverage = readNumber(sourceCoverage?.minExpectedCoverage);
  const priceObservationCoins = readNumber(sourceCoverage?.priceObservationCoins);
  const weakCoverageCoins = readNumber(sourceCoverage?.weakCoverageCoins);
  const coverageRecoveredCoins = readNumber(sourceCoverage?.coverageRecoveredCoins);
  const measuredBalanceCoveragePct = readNumber(sourceCoverage?.measuredBalanceCoveragePct);
  const syntheticOnlyCoins = readNumber(sourceCoverage?.syntheticOnlyCoins);
  const coinsWithoutMeasuredBalances = readNumber(sourceCoverage?.coinsWithoutMeasuredBalances);
  const coinsGtOnly = readNumber(sourceCoverage?.coinsGtOnly);
  const coinsCrawlerOnly = readNumber(sourceCoverage?.coinsCrawlerOnly);
  const coinsPriceOnlyNoMeasuredLiquidity = readNumber(sourceCoverage?.coinsPriceOnlyNoMeasuredLiquidity);
  const qualityDriftSeverity = readString(sourceCoverage?.qualityDriftSeverity);
  const qualityDriftFlags = formatStringList(sourceCoverage?.qualityDriftFlags);
  const qualityDriftMetrics = readRecord(sourceCoverage?.qualityDriftMetrics);
  const priceObservationPctDelta = readNumber(qualityDriftMetrics?.priceObservationPctDelta);
  const measuredBalanceCoverageDelta = readNumber(qualityDriftMetrics?.measuredBalanceCoverageDelta);
  const topAssetCoverageDeltas = readArray(sourceCoverage?.topAssetCoverageDeltas);
  const protocolCapReductions = readRecord(sourceCoverage?.protocolCapReductions);
  const cappedPoolCount = readNumber(protocolCapReductions?.cappedPoolCount);
  const reducedTvlUsd = readNumber(protocolCapReductions?.reducedTvlUsd);
  const topProtocols = readArray(protocolCapReductions?.topProtocols);
  const nearCoverageGuard = readBoolean(sourceCoverage?.nearCoverageGuard);
  const skipBreakdown =
    stagedPoolsSkippedByExactIdentity != null || stagedPoolsSkippedByUniqueDerivedIdentity != null
      ? [
          stagedPoolsSkippedByUniqueDerivedIdentity != null ? `derived ${stagedPoolsSkippedByUniqueDerivedIdentity}` : null,
          stagedPoolsSkippedByExactIdentity != null ? `exact ${stagedPoolsSkippedByExactIdentity}` : null,
        ]
          .filter((part): part is string => part != null)
          .join(", ")
      : null;

  return [
    stagedPoolsMerged != null
      ? `staged pools merged ${stagedPoolsMerged}${stagedPoolsSkipped != null ? `, skipped ${stagedPoolsSkipped}${skipBreakdown ? ` (${skipBreakdown})` : ""}` : ""}`
      : null,
    currentCoverage != null
      ? `coverage ${currentCoverage}${previousCoverage != null ? ` vs ${previousCoverage} previous` : ""}${minExpectedCoverage != null ? `, floor ${minExpectedCoverage}` : ""}`
      : null,
    priceObservationCoins != null ? `dex price observations ${priceObservationCoins} coins` : null,
    weakCoverageCoins != null
      ? `weak coverage ${weakCoverageCoins}${coverageRecoveredCoins != null ? `, recovered ${coverageRecoveredCoins}` : ""}`
      : null,
    measuredBalanceCoveragePct != null ? `measured balance coverage ${(measuredBalanceCoveragePct * 100).toFixed(1)}%` : null,
    coinsWithoutMeasuredBalances != null && coinsWithoutMeasuredBalances > 0
      ? `rows without measured balances ${coinsWithoutMeasuredBalances}`
      : null,
    coinsGtOnly != null && coinsGtOnly > 0 ? `GT-only rows ${coinsGtOnly}` : null,
    coinsCrawlerOnly != null && coinsCrawlerOnly > 0 ? `crawler-only rows ${coinsCrawlerOnly}` : null,
    coinsPriceOnlyNoMeasuredLiquidity != null && coinsPriceOnlyNoMeasuredLiquidity > 0
      ? `price-only/no-measured-liquidity rows ${coinsPriceOnlyNoMeasuredLiquidity}`
      : null,
    syntheticOnlyCoins != null && syntheticOnlyCoins > 0 ? `synthetic-only rows ${syntheticOnlyCoins}` : null,
    cappedPoolCount != null && reducedTvlUsd != null && cappedPoolCount > 0
      ? `protocol caps ${cappedPoolCount} pools, ${Math.round(reducedTvlUsd).toLocaleString()} TVL reduced`
      : null,
    topProtocols && topProtocols.length > 0
      ? (() => {
        const parts = topProtocols
          .slice(0, 2)
          .map((entry) => {
            const record = readRecord(entry);
            const protocol = readString(record?.protocol);
            const reduction = readNumber(record?.reducedTvlUsd);
            return protocol && reduction != null ? `${protocol} ${Math.round(reduction).toLocaleString()}` : null;
          })
          .filter((part): part is string => part != null);
        return parts.length > 0 ? `top capped protocols ${parts.join(", ")}` : null;
      })()
      : null,
    qualityDriftSeverity && qualityDriftSeverity !== "none"
      ? `quality drift ${qualityDriftSeverity}${qualityDriftFlags ? ` (${qualityDriftFlags})` : ""}`
      : null,
    priceObservationPctDelta != null && priceObservationPctDelta <= -0.1
      ? `price observations ${(priceObservationPctDelta * 100).toFixed(1)}% vs previous`
      : null,
    measuredBalanceCoverageDelta != null && measuredBalanceCoverageDelta <= -0.05
      ? `measured coverage ${(measuredBalanceCoverageDelta * 100).toFixed(1)}pp vs previous`
      : null,
    topAssetCoverageDeltas && topAssetCoverageDeltas.length > 0
      ? (() => {
        const flagged = topAssetCoverageDeltas
          .map((entry) => readRecord(entry))
          .map((record) => {
            const stablecoinId = readString(record?.stablecoinId);
            const poolCountPctDelta = readNumber(record?.poolCountPctDelta);
            return stablecoinId && poolCountPctDelta != null && poolCountPctDelta <= -0.2
              ? `${stablecoinId} ${(poolCountPctDelta * 100).toFixed(1)}%`
              : null;
          })
          .filter((part): part is string => part != null)
          .slice(0, 2);
        return flagged.length > 0 ? `watchlist pool drops ${flagged.join(", ")}` : null;
      })()
      : null,
    failedSources ? `failed sources ${failedSources}` : null,
    fallbackMode ? `fallback mode ${fallbackMode}` : null,
    nearCoverageGuard ? "coverage near guardrail band" : null,
  ].filter((line): line is string => line != null);
}

function summarizeBlacklist(metadata: Record<string, unknown>): string[] {
  const apiErrors = readNumber(metadata.apiErrors);
  const contractsSkipped = readNumber(metadata.contractsSkipped);
  const budgetUsed = readNumber(metadata.budgetUsed);
  const budgetLimit = readNumber(metadata.budgetLimit);
  const rpcLogConfigs = readNumber(metadata.rpcLogConfigs);
  const apiErrorClasses = formatApiErrorClasses(metadata.apiErrorClasses);

  return [
    apiErrors != null ? `api errors ${apiErrors}` : null,
    contractsSkipped != null && contractsSkipped > 0 ? `contracts skipped ${contractsSkipped}` : null,
    budgetUsed != null && budgetLimit != null ? `budget ${budgetUsed}/${budgetLimit}` : null,
    rpcLogConfigs != null && rpcLogConfigs > 0 ? `rpc-log configs ${rpcLogConfigs}` : null,
    apiErrorClasses ? `error classes ${apiErrorClasses}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeMintBurn(metadata: Record<string, unknown>): string[] {
  const lane = readString(metadata.lane);
  const contractsProcessed = readNumber(metadata.contractsProcessed);
  const contractsSkipped = readNumber(metadata.contractsSkipped);
  const contractsDeferredExtended = readNumber(metadata.contractsDeferredExtended);
  const degradedStreak = readNumber(metadata.degradedStreak);
  const budgetUsed = readNumber(metadata.budgetUsed);
  const budgetLimit = readNumber(metadata.budgetLimit);
  const criticalCoverage = readRecord(metadata.criticalCoverage);
  const criticalSatisfied = readNumber(criticalCoverage?.contractsSatisfied);
  const criticalEnabled = readNumber(criticalCoverage?.contractsEnabled);
  const laggingConfigs = readArray(metadata.laggingConfigs)?.length ?? 0;

  return [
    lane ? `lane ${lane}` : null,
    contractsProcessed != null
      ? `processed ${contractsProcessed}${contractsSkipped != null ? `, skipped ${contractsSkipped}` : ""}`
      : null,
    budgetUsed != null && budgetLimit != null ? `budget ${budgetUsed}/${budgetLimit}` : null,
    criticalEnabled != null && criticalSatisfied != null && criticalEnabled > 0
      ? `critical coverage ${criticalSatisfied}/${criticalEnabled}`
      : null,
    contractsDeferredExtended != null && contractsDeferredExtended > 0
      ? `extended deferred ${contractsDeferredExtended}`
      : null,
    laggingConfigs > 0 ? `lagging configs tracked ${laggingConfigs}` : null,
    degradedStreak != null && degradedStreak > 0 ? `degraded streak ${degradedStreak}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeLiveReserves(metadata: Record<string, unknown>): string[] {
  const synced = readNumber(metadata.synced);
  const failed = readNumber(metadata.failed);
  const skipped = readNumber(metadata.skipped);
  const total = readNumber(metadata.total);
  const warningCount = readNumber(metadata.warningCount);
  const runBudgetTruncated = readBoolean(metadata.runBudgetTruncated);
  const deferredCoins = readNumber(metadata.deferredCoins);
  const nextCursorStablecoinId = readString(metadata.nextCursorStablecoinId);
  const cursorTailState = readString(metadata.cursorTailState);
  const runBudgetTruncationCount = readNumber(metadata.runBudgetTruncationCount);
  const coinsWithWarnings = readArray(metadata.coinsWithWarnings)?.length ?? 0;
  const breakerKeys = formatStringList(metadata.breakerKeys);
  const artifactCleanup = readRecord(metadata.artifactCleanup);
  const artifactSyncStateDeleted = readNumber(artifactCleanup?.syncStateDeleted);
  const artifactCompositionDeleted = readNumber(artifactCleanup?.compositionDeleted);
  const artifactBreakerCacheDeleted = readNumber(artifactCleanup?.breakerCacheDeleted);
  const artifactCleanupWarningCount = readNumber(metadata.artifactCleanupWarningCount);
  const artifactCleanupDeletedTotal =
    (artifactSyncStateDeleted ?? 0) +
    (artifactCompositionDeleted ?? 0) +
    (artifactBreakerCacheDeleted ?? 0);

  return [
    synced != null && total != null
      ? `synced ${synced}/${total}${failed != null ? `, failed ${failed}` : ""}${skipped != null && skipped > 0 ? `, skipped ${skipped}` : ""}`
      : null,
    warningCount != null && warningCount > 0
      ? `warnings ${warningCount}${coinsWithWarnings > 0 ? ` across ${coinsWithWarnings} coin(s)` : ""}`
      : null,
    runBudgetTruncated
      ? `run budget truncated; deferred ${deferredCoins ?? 0}${nextCursorStablecoinId ? `, resumes at ${nextCursorStablecoinId}` : ""}`
      : null,
    cursorTailState
      ? `cursor tail ${cursorTailState}${runBudgetTruncationCount != null && runBudgetTruncationCount > 0 ? `, truncations ${runBudgetTruncationCount}` : ""}`
      : null,
    artifactCleanupDeletedTotal > 0
      ? `artifact cleanup deleted sync ${artifactSyncStateDeleted ?? 0}, composition ${artifactCompositionDeleted ?? 0}, breakers ${artifactBreakerCacheDeleted ?? 0}`
      : null,
    artifactCleanupWarningCount != null && artifactCleanupWarningCount > 0
      ? `artifact cleanup warnings ${artifactCleanupWarningCount}`
      : null,
    breakerKeys ? `breaker keys ${breakerKeys}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeRedemptionBackstops(metadata: Record<string, unknown>): string[] {
  const synced = readNumber(metadata.synced);
  const configured = readNumber(metadata.configured);
  const failed = readNumber(metadata.failed);
  const resolved = readNumber(metadata.resolved);
  const unresolved = readNumber(metadata.unresolved);
  const unresolvedMissingCapacity = readNumber(metadata.unresolvedMissingCapacity);
  const unresolvedCritical = readNumber(metadata.unresolvedCritical);
  const availabilityDegraded = readNumber(metadata.availabilityDegraded);
  const missingCapacityOkThreshold = readNumber(metadata.missingCapacityOkThreshold);
  const coverageRatio = readNumber(metadata.coverageRatio);
  const dynamic = readNumber(metadata.dynamic);
  const estimated = readNumber(metadata.estimated);
  const staticCount = readNumber(metadata.static);
  const missingFromCache = readArray(metadata.missingFromCache)?.length ?? 0;

  return [
    synced != null && configured != null
      ? `synced ${synced}/${configured}${failed != null && failed > 0 ? `, failed ${failed}` : ""}`
      : null,
    resolved != null
      ? `resolved ${resolved}${configured != null ? `/${configured}` : ""}${coverageRatio != null ? ` (${Math.round(coverageRatio * 100)}%)` : ""}${unresolved != null && unresolved > 0 ? `, unrated ${unresolved}` : ""}`
      : null,
    unresolvedMissingCapacity != null && unresolvedMissingCapacity > 0 && unresolvedCritical === 0 && missingCapacityOkThreshold != null
      ? `missing-capacity tail ${unresolvedMissingCapacity}${unresolvedMissingCapacity <= missingCapacityOkThreshold ? ` within ${missingCapacityOkThreshold}-coin tolerance` : ` exceeds ${missingCapacityOkThreshold}-coin tolerance`}`
      : null,
    availabilityDegraded != null && availabilityDegraded > 0
      ? `availability impaired ${availabilityDegraded}`
      : null,
    dynamic != null || estimated != null || staticCount != null
      ? `source mix${dynamic != null ? ` dynamic ${dynamic}` : ""}${estimated != null ? `, estimated ${estimated}` : ""}${staticCount != null ? `, static ${staticCount}` : ""}`
      : null,
    missingFromCache > 0 ? `missing from cache ${missingFromCache}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeTelegramAlerts(metadata: Record<string, unknown>): string[] {
  const safetyAlertSourceState = readString(metadata.safetyAlertSourceState);
  const safetyAlertSourceAgeSeconds = readNumber(metadata.safetyAlertSourceAgeSeconds);
  const safetyAlertsSuppressed = readBoolean(metadata.safetyAlertsSuppressed);
  const safetyAlertSourceGeneration = readString(metadata.safetyAlertSourceGeneration);

  return [
    safetyAlertSourceState ? `safety source ${safetyAlertSourceState}` : null,
    safetyAlertsSuppressed ? "safety alerts suppressed" : null,
    safetyAlertSourceAgeSeconds != null ? `source age ${safetyAlertSourceAgeSeconds}s` : null,
    safetyAlertSourceGeneration ? `generation ${safetyAlertSourceGeneration}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeSnapshotSupply(metadata: Record<string, unknown>): string[] {
  const reason = readString(metadata.reason);
  const validRows = readNumber(metadata.validRows);
  const expectedCount = readNumber(metadata.expectedCount);
  const invalidSupplyIds = readStringArray(metadata.invalidSupplyIds);
  const missingActiveIds = readStringArray(metadata.missingActiveIds);

  return [
    reason ? `reason ${reason}` : null,
    validRows != null && expectedCount != null ? `active supply coverage ${validRows}/${expectedCount}` : null,
    invalidSupplyIds.length > 0 ? `invalid supply ${invalidSupplyIds.join(", ")}` : null,
    missingActiveIds.length > 0 ? `missing active ${missingActiveIds.join(", ")}` : null,
  ].filter((line): line is string => line != null);
}

function summarizeTelegramWatchdog(metadata: Record<string, unknown>): string[] {
  const pending = readRecord(metadata.pendingBacklog);
  const safety = readRecord(metadata.safetySource);
  const zeroSend = readRecord(metadata.zeroSend);
  const executionUnknown = readNumber(pending?.executionUnknown);
  const oldestUnknownAgeSec = readNumber(pending?.oldestExecutionUnknownAgeSec);

  return [
    pending && readBoolean(pending.triggered) ? "pending-delivery incident triggered" : null,
    executionUnknown != null && executionUnknown > 0 ? `execution unknown ${executionUnknown}` : null,
    oldestUnknownAgeSec != null ? `oldest ambiguous effect ${oldestUnknownAgeSec}s` : null,
    pending ? readString(pending.detail) : null,
    safety && readBoolean(safety.triggered) ? "safety-source incident triggered" : null,
    zeroSend && readBoolean(zeroSend.triggered) ? "zero-send incident triggered" : null,
  ].filter((line): line is string => line != null);
}

function summarizeCronDurationWatchdog(metadata: Record<string, unknown>): string[] {
  const runtimeBreaching = readStringArray(metadata.runtimeBreaching);
  const slotBreaching = readStringArray(metadata.slotAbandonmentBreaching);

  return [
    runtimeBreaching.length > 0 ? `runtime breaches ${runtimeBreaching.join(", ")}` : "runtime breaches none",
    slotBreaching.length > 0 ? `slot abandonment ${slotBreaching.join(", ")}` : "slot abandonment none",
  ];
}

const SUMMARIZER_BY_JOB: Record<string, (metadata: Record<string, unknown>) => string[]> = {
  "status-self-check": summarizeStatusSelfCheck,
  "sync-dex-discovery": summarizeDexDiscovery,
  "sync-dex-liquidity": summarizeDexLiquidity,
  "sync-blacklist": summarizeBlacklist,
  "sync-mint-burn": summarizeMintBurn,
  "sync-mint-burn-extended": summarizeMintBurn,
  "sync-live-reserves": summarizeLiveReserves,
  "sync-redemption-backstops": summarizeRedemptionBackstops,
  "dispatch-telegram-alerts": summarizeTelegramAlerts,
  "snapshot-supply": summarizeSnapshotSupply,
  "telegram-degradation-watchdog": summarizeTelegramWatchdog,
  "cron-duration-watchdog": summarizeCronDurationWatchdog,
};

export function summarizeCronMetadata(job: string, metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  return SUMMARIZER_BY_JOB[job]?.(metadata) ?? [];
}
