function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

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
  const items = readArray(value)
    ?.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items && items.length > 0 ? items.join(", ") : null;
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
  const stagedPoolsSkippedByAddress = readNumber(metadata.stagedPoolsSkippedByAddress);
  const stagedPoolsSkippedByFingerprint = readNumber(metadata.stagedPoolsSkippedByFingerprint);
  const failedSources = formatStringList(metadata.failedSources);
  const fallbackMode = formatStringList(metadata.fallbackMode);
  const sourceCoverage = readRecord(metadata.sourceCoverage);
  const currentCoverage = readNumber(sourceCoverage?.currentCoverage);
  const previousCoverage = readNumber(sourceCoverage?.previousCoverage);
  const minExpectedCoverage = readNumber(sourceCoverage?.minExpectedCoverage);
  const priceObservationCoins = readNumber(sourceCoverage?.priceObservationCoins);
  const nearCoverageGuard = readBoolean(sourceCoverage?.nearCoverageGuard);
  const skipBreakdown =
    stagedPoolsSkippedByAddress != null || stagedPoolsSkippedByFingerprint != null
      ? [
          stagedPoolsSkippedByFingerprint != null ? `fp ${stagedPoolsSkippedByFingerprint}` : null,
          stagedPoolsSkippedByAddress != null ? `addr ${stagedPoolsSkippedByAddress}` : null,
        ].filter((part): part is string => part != null).join(", ")
      : null;

  return [
    stagedPoolsMerged != null
      ? `staged pools merged ${stagedPoolsMerged}${stagedPoolsSkipped != null ? `, skipped ${stagedPoolsSkipped}${skipBreakdown ? ` (${skipBreakdown})` : ""}` : ""}`
      : null,
    currentCoverage != null
      ? `coverage ${currentCoverage}${previousCoverage != null ? ` vs ${previousCoverage} previous` : ""}${minExpectedCoverage != null ? `, floor ${minExpectedCoverage}` : ""}`
      : null,
    priceObservationCoins != null ? `dex price observations ${priceObservationCoins} coins` : null,
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
  const coinsWithWarnings = readArray(metadata.coinsWithWarnings)?.length ?? 0;
  const breakerKeys = formatStringList(metadata.breakerKeys);

  return [
    synced != null && total != null
      ? `synced ${synced}/${total}${failed != null ? `, failed ${failed}` : ""}${skipped != null && skipped > 0 ? `, skipped ${skipped}` : ""}`
      : null,
    warningCount != null && warningCount > 0
      ? `warnings ${warningCount}${coinsWithWarnings > 0 ? ` across ${coinsWithWarnings} coin(s)` : ""}`
      : null,
    breakerKeys ? `breaker keys ${breakerKeys}` : null,
  ].filter((line): line is string => line != null);
}

const SUMMARIZER_BY_JOB: Record<string, (metadata: Record<string, unknown>) => string[]> = {
  "status-self-check": summarizeStatusSelfCheck,
  "sync-dex-discovery": summarizeDexDiscovery,
  "sync-dex-liquidity": summarizeDexLiquidity,
  "sync-blacklist": summarizeBlacklist,
  "sync-mint-burn": summarizeMintBurn,
  "sync-mint-burn-extended": summarizeMintBurn,
  "sync-live-reserves": summarizeLiveReserves,
};

export function summarizeCronMetadata(job: string, metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  return SUMMARIZER_BY_JOB[job]?.(metadata) ?? [];
}
