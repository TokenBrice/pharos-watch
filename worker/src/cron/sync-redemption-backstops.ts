import { getConfiguredRedemptionBackstopIds, getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS } from "@shared/lib/report-card-active-depeg";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { resolveCapacityConfidence } from "@shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/redemption-backstop-version";
import { toErrorMessage } from "../lib/error-utils";
import {
  REDEMPTION_EFFECTIVE_EXIT_MODEL,
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import type { CronResult } from "../lib/cron-logger";
import { loadDexLiquiditySnapshot } from "../lib/dex-liquidity";
import { loadReserveSnapshotMetadataMap, type ReserveSnapshotMetadataRecord } from "../lib/live-reserves-store";
import { upsertRedemptionBackstopSnapshots } from "../lib/redemption-backstops-store";
import {
  buildFailedRedemptionBackstopEntry,
  buildRedemptionBackstopEntry,
  resolveRedemptionBackstopEntry,
} from "../lib/redemption-backstop-sources";
import {
  formatUtcDate,
  loadSevereActiveDepegAvailabilityMap,
} from "../lib/redemption-backstop-availability";
import { REDEMPTION_ROUTE_STATUS_PRODUCER } from "../lib/redemption-backstop-route-status";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { throwIfAborted } from "../lib/abort";
import { fnv1aHash } from "../lib/hash";

const MISSING_CAPACITY_OK_RATIO = 0.01;

const DEX_LIQUIDITY_FRESHNESS_SEC = CRON_INTERVALS["sync-dex-liquidity"] * 2;

function getAllowedMissingCapacityCount(configuredCount: number): number {
  if (configuredCount <= 0) return 0;
  return Math.max(1, Math.ceil(configuredCount * MISSING_CAPACITY_OK_RATIO));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function stableHash(value: unknown): string {
  return fnv1aHash(stableStringify(value));
}

function capStringList(values: readonly string[], limit = 25): string[] {
  return values.slice(0, limit);
}

function buildRegistryMetadata(
  configuredIds: readonly string[],
  configById: Map<string, ReturnType<typeof getRedemptionBackstopConfig>>,
) {
  const familyCounts: Record<string, number> = {};
  let strongProxyCount = 0;
  let heuristicCount = 0;
  const registryDigest = configuredIds.map((stablecoinId) => {
    const config = configById.get(stablecoinId);
    if (!config) return [stablecoinId, "missing"];
    familyCounts[config.routeFamily] = (familyCounts[config.routeFamily] ?? 0) + 1;
    const confidence = resolveCapacityConfidence(config.capacityModel);
    if (confidence === "heuristic") {
      heuristicCount += 1;
    } else {
      strongProxyCount += 1;
    }
    return {
      stablecoinId,
      config,
      resolvedCapacityConfidence: confidence,
    };
  });

  return {
    registryHash: stableHash(registryDigest),
    familyCounts,
    strongProxyCount,
    heuristicCount,
    validatorVersion: 4,
    configMethodologyVersion: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
    v4ScoringParametersHash: stableHash({
      componentWeights: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
      routeFamilyCaps: REDEMPTION_ROUTE_FAMILY_CAPS,
      effectiveExitModel: REDEMPTION_EFFECTIVE_EXIT_MODEL,
    }),
  };
}

export async function syncRedemptionBackstops(db: D1Database, signal: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);

  const stablecoinsCache = await loadStablecoinsCache(db, {
    mode: "strict",
    allowLegacyArray: true,
  });
  if (!hasUsableStablecoinsPayload(stablecoinsCache)) {
    return {
      status: "error",
      metadata: JSON.stringify({
        reason: `stablecoins-cache:${stablecoinsCache.reason}`,
      }),
    };
  }

  const configuredIds = getConfiguredRedemptionBackstopIds();
  const configById = new Map(
    configuredIds.map((stablecoinId) => [stablecoinId, getRedemptionBackstopConfig(stablecoinId)]),
  );
  const stablecoinAssetById = new Map(stablecoinsCache.payload.peggedAssets.map((asset) => [asset.id, asset]));
  const now = Math.floor(Date.now() / 1000);
  const preloadWarnings: string[] = [];
  let dexLiquidityMap: Awaited<ReturnType<typeof loadDexLiquiditySnapshot>>["map"] = {};
  let latestUpdatedAt: number | null = null;
  try {
    const dexSnapshot = await loadDexLiquiditySnapshot(db);
    dexLiquidityMap = dexSnapshot.map;
    latestUpdatedAt = dexSnapshot.latestUpdatedAt;
  } catch (error) {
    const message = toErrorMessage(error);
    console.warn("[sync-redemption-backstops] DEX liquidity preload failed; continuing without DEX input:", error);
    preloadWarnings.push(`dex-liquidity:${message}`);
  }

  let reserveSnapshotMetadataById = new Map<string, ReserveSnapshotMetadataRecord>();
  try {
    reserveSnapshotMetadataById = await loadReserveSnapshotMetadataMap(db, configuredIds);
  } catch (error) {
    const message = toErrorMessage(error);
    console.warn(
      "[sync-redemption-backstops] Reserve metadata preload failed; live capacity will fail closed to static/fallback rows:",
      error,
    );
    preloadWarnings.push(`reserve-metadata:${message}`);
  }

  const routeAvailabilityById = await loadSevereActiveDepegAvailabilityMap(db, formatUtcDate(now));
  const registryMetadata = buildRegistryMetadata(configuredIds, configById);

  // Staleness is tracked for operational visibility (degraded-run signal +
  // metadata) but no longer suppresses effectiveExitScore. Aligns with the
  // report-card path, which also uses the last-known DEX score when stale —
  // see the native capture at `worker/src/lib/safety-score-v9-capture.ts`.
  let liquidityStale = false;
  if (latestUpdatedAt == null) {
    console.warn("[sync-redemption-backstops] Liquidity data is missing");
    liquidityStale = true;
  } else {
    const ageSec = now - latestUpdatedAt;
    if (ageSec > DEX_LIQUIDITY_FRESHNESS_SEC) {
      console.warn(`[sync-redemption-backstops] Liquidity data is stale (age: ${ageSec}s)`);
      liquidityStale = true;
    }
  }

  const snapshots = [];
  const failedIds: string[] = [];

  for (const stablecoinId of configuredIds) {
    throwIfAborted(signal);

    try {
      const asset = stablecoinAssetById.get(stablecoinId);
      const dexLiquidityScore = dexLiquidityMap[stablecoinId]?.liquidityScore ?? null;
      const routeAvailability = routeAvailabilityById.get(stablecoinId) ?? null;
      let resolved = null;

      if (asset) {
        resolved = await resolveRedemptionBackstopEntry(db, asset, dexLiquidityScore, now, {
          reserveSnapshotMetadata: reserveSnapshotMetadataById.get(stablecoinId) ?? null,
          routeAvailability,
        });
      } else {
        const config = configById.get(stablecoinId);
        if (config) {
          resolved = await buildRedemptionBackstopEntry(db, stablecoinId, config, null, dexLiquidityScore, now, {
            reserveSnapshotMetadata: reserveSnapshotMetadataById.get(stablecoinId) ?? null,
            routeAvailability,
          });
        }
      }

      if (resolved) snapshots.push(resolved);
    } catch (error) {
      console.error(`[sync-redemption-backstops] Failed for ${stablecoinId}:`, error);
      failedIds.push(stablecoinId);
      const config = configById.get(stablecoinId);
      if (config) {
        snapshots.push(buildFailedRedemptionBackstopEntry(stablecoinId, config, now));
      }
    }
  }
  throwIfAborted(signal);

  const dynamicCount = snapshots.filter((entry) => entry.sourceMode === "dynamic").length;
  const estimatedCount = snapshots.filter((entry) => entry.sourceMode === "estimated").length;
  const staticCount = snapshots.filter((entry) => entry.sourceMode === "static").length;
  const resolvedCount = snapshots.filter((entry) => entry.resolutionState === "resolved").length;
  const unresolvedCount = snapshots.length - resolvedCount;
  const missingCapacityCount = snapshots.filter((entry) => entry.resolutionState === "missing-capacity").length;
  const familyMissingCapacityBy: Record<string, number> = {};
  const providerMissingCapacityBy: Record<string, number> = {};
  for (const entry of snapshots) {
    if (entry.resolutionState !== "missing-capacity") continue;
    familyMissingCapacityBy[entry.routeFamily] = (familyMissingCapacityBy[entry.routeFamily] ?? 0) + 1;
    providerMissingCapacityBy[entry.provider] = (providerMissingCapacityBy[entry.provider] ?? 0) + 1;
  }
  const availabilityDegradedIds = snapshots
    .filter((entry) => entry.resolutionState === "impaired")
    .map((entry) => entry.stablecoinId);
  const availabilityDegradedCount = availabilityDegradedIds.length;
  const missingFromCache = configuredIds.filter((stablecoinId) => !stablecoinAssetById.has(stablecoinId));
  const cacheAbsentConfiguredCount = missingFromCache.length;
  const activeConfiguredCount = Math.max(0, configuredIds.length - cacheAbsentConfiguredCount);
  const criticalUnresolvedCount = snapshots.filter(
    (entry) =>
      entry.resolutionState !== "resolved" &&
      entry.resolutionState !== "missing-capacity" &&
      entry.resolutionState !== "impaired" &&
      entry.resolutionState !== "missing-cache",
  ).length;
  const coverageDenominator = activeConfiguredCount > 0 ? activeConfiguredCount : configuredIds.length;
  const coverageRatio = coverageDenominator > 0 ? resolvedCount / coverageDenominator : 1;
  const allowedMissingCapacityCount = getAllowedMissingCapacityCount(activeConfiguredCount);
  const missingCapacityWithinTolerance = missingCapacityCount <= allowedMissingCapacityCount;
  const hasNoActiveConfiguredRows = configuredIds.length > 0 && activeConfiguredCount === 0;
  const hasBlockingUnresolved = failedIds.length > 0 || criticalUnresolvedCount > 0;
  const hasDegradedSyncSignal =
    hasBlockingUnresolved || !missingCapacityWithinTolerance || liquidityStale || hasNoActiveConfiguredRows;
  const runMetadata: Record<string, unknown> = {
    synced: snapshots.length,
    failed: failedIds.length,
    configured: configuredIds.length,
    activeConfigured: activeConfiguredCount,
    cacheAbsentConfigured: cacheAbsentConfiguredCount,
    resolved: resolvedCount,
    unresolved: unresolvedCount,
    unresolvedMissingCapacity: missingCapacityCount,
    ...(missingCapacityCount > 0 ? { familyMissingCapacityBy, providerMissingCapacityBy } : {}),
    unresolvedCritical: criticalUnresolvedCount,
    availabilityDegraded: availabilityDegradedCount,
    severeActiveDepegThresholdBps: REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS,
    missingCapacityOkThreshold: allowedMissingCapacityCount,
    coverageRatio,
    dynamic: dynamicCount,
    estimated: estimatedCount,
    static: staticCount,
    liquidityStale,
    routeStatusProducer: REDEMPTION_ROUTE_STATUS_PRODUCER.model,
    routeStatusProducerFetches: REDEMPTION_ROUTE_STATUS_PRODUCER.fetchesDuringRedemptionSync,
    preloadDegraded: preloadWarnings.length > 0,
    ...(preloadWarnings.length > 0 ? { preloadWarnings: capStringList(preloadWarnings) } : {}),
    ...registryMetadata,
    ...(failedIds.length > 0 ? { failedIds: capStringList(failedIds), failedIdsTruncated: failedIds.length > 25 } : {}),
    ...(availabilityDegradedIds.length > 0
      ? {
          availabilityDegradedIds: capStringList(availabilityDegradedIds),
          availabilityDegradedIdsTruncated: availabilityDegradedIds.length > 25,
        }
      : {}),
    ...(missingFromCache.length > 0
      ? { missingFromCache: capStringList(missingFromCache), missingFromCacheTruncated: missingFromCache.length > 25 }
      : {}),
  };

  const writeResult = await upsertRedemptionBackstopSnapshots(db, snapshots, {
    expectedCount: configuredIds.length,
    metadata: runMetadata,
  });
  throwIfAborted(signal);

  Object.assign(runMetadata, {
    snapshotRunId: writeResult.runId,
    attemptedCount: writeResult.attemptedCount,
    runRowsWrittenCount: writeResult.runRowsWrittenCount,
    historyWrittenCount: writeResult.historyWrittenCount,
    ...(writeResult.retentionCutoff != null ? { retentionCutoff: writeResult.retentionCutoff } : {}),
    ...(writeResult.retentionRunRowsDeletedCount != null
      ? { retentionRunRowsDeletedCount: writeResult.retentionRunRowsDeletedCount }
      : {}),
    ...(writeResult.retentionRunsDeletedCount != null
      ? { retentionRunsDeletedCount: writeResult.retentionRunsDeletedCount }
      : {}),
    failedWriteCount: Math.max(0, writeResult.attemptedCount - writeResult.runRowsWrittenCount),
    writeStatus: writeResult.warnings.length > 0 ? "completed-with-warnings" : "completed",
    writePhase: "retention",
    ...(writeResult.warnings.length > 0 ? { writeWarnings: writeResult.warnings } : {}),
  });

  const hasZeroResolvedCapacityFailure = resolvedCount === 0 && missingCapacityCount > 0;
  const hasPostWriteDegradation = preloadWarnings.length > 0 || writeResult.warnings.length > 0;
  // `impaired` rows are intentional market-evidence signals (e.g. severe
  // active depegs), not sync failures: they are excluded from
  // criticalUnresolvedCount above and never degrade run status on their own.
  const status: CronResult["status"] =
    resolvedCount === 0 && (hasBlockingUnresolved || hasZeroResolvedCapacityFailure || hasNoActiveConfiguredRows)
      ? "error"
      : hasDegradedSyncSignal || hasPostWriteDegradation
        ? "degraded"
        : "ok";

  return {
    status,
    itemCount: snapshots.length,
    metadata: JSON.stringify(runMetadata),
  };
}
