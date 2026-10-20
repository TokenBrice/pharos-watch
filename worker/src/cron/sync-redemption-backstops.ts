import { logWorkerEventArgs } from "../lib/structured-log";
import { ZodError } from "zod";
import { getConfiguredRedemptionBackstopIds, getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS } from "@shared/lib/report-card-active-depeg";
import { DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/cron-cadences";
import { REDEMPTION_BACKSTOP_RESOLVE_CONCURRENCY } from "@shared/lib/cron-jobs";
import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { resolveCapacityConfidence } from "@shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { toErrorMessage } from "@shared/lib/error-utils";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { validateExitExecutionModelReviews } from "@shared/lib/safety-score-v9/exit-execution";
import exitExecutionModelReviews from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import {
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import type { RedemptionReserveRunMetadata } from "@shared/types/reserve-input";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { createCronResult, type CronMetadataRecord } from "../lib/cron-result";
import { loadDexLiquidityScores } from "../lib/dex-liquidity";
import { AcceptedReserveViewError, acceptedReserveMetadataMap, consumedReserveInput, loadAcceptedReserveGeneration } from "../lib/accepted-reserve-generation";
import { upsertRedemptionBackstopSnapshots, validateRedemptionBackstopSnapshot } from "../lib/redemption-backstops-store-write";
import {
  applyOutputDependencyResolution,
  buildFailedRedemptionBackstopEntry,
  buildRedemptionBackstopEntry,
  resolveRedemptionBackstopEntry,
} from "../lib/redemption-backstop/sources";
import {
  buildRedemptionCurrentDepegObservationMap,
  formatUtcDate,
  loadSevereActiveDepegAvailabilityMap,
} from "../lib/redemption-backstop/availability";
import { REDEMPTION_ROUTE_STATUS_PRODUCER, type DirectObserverExecutionEvent } from "../lib/redemption-backstop/route-status";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { throwIfAborted } from "../lib/abort";
import { mapWithConcurrency } from "../lib/concurrency";
import { fnv1aHash } from "../lib/hash";
import type { EvmRpcOptions } from "../lib/evm-rpc";
import { safeErrorMessage } from "../lib/safe-error-message";
import { EvmCodeIdentityError } from "../lib/evm-code-identity-error";

const MISSING_CAPACITY_OK_RATIO = 0.01;

interface RouteFailureReason {
  code: string;
  message: string;
  schemaPath?: string;
  schemaReason?: string;
}

function describeRouteFailure(error: unknown): RouteFailureReason {
  const issue = error instanceof ZodError ? error.issues[0] : undefined;
  return {
    code: issue ? "redemption-snapshot-schema-invalid" :
      error instanceof EvmCodeIdentityError ? error.rejectionCode : "route-resolution-failed",
    message: safeErrorMessage(error, 240).slice(0, 240),
    ...(issue ? { schemaPath: issue.path.join(".") || "$", schemaReason: issue.code } : {}),
  };
}

const DEX_LIQUIDITY_FRESHNESS_SEC = DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC;

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
  const registryDigest = [...configuredIds].sort().map((stablecoinId) => {
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
    }),
  };
}

export async function syncRedemptionBackstops(
  db: D1Database,
  signal: AbortSignal,
  rpcOptions?: EvmRpcOptions,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  await reportProgress?.({ stage: "loading-redemption-reserves" });
  let acceptedReserveGeneration;
  try {
    acceptedReserveGeneration = await loadAcceptedReserveGeneration(db);
  } catch (error) {
    return createCronResult({ status: "error", metadata: { reason: error instanceof AcceptedReserveViewError ? error.reason : "accepted-reserve-view-unavailable" } });
  }

  await reportProgress?.({ stage: "loading-redemption-stablecoins" });
  const stablecoinsCache = await loadStablecoinsCache(db, {
    mode: "strict",
  });
  if (!hasUsableStablecoinsPayload(stablecoinsCache)) {
    return createCronResult({
      status: "error",
      metadata: { reason: `stablecoins-cache:${stablecoinsCache.reason}` },
    });
  }
  const supplyMaxAgeSec = STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC;
  const supplyUpdatedAt = stablecoinsCache.updatedAt;
  if (
    supplyUpdatedAt == null ||
    !Number.isSafeInteger(supplyUpdatedAt) ||
    supplyUpdatedAt <= 0 ||
    supplyUpdatedAt > now ||
    now - supplyUpdatedAt > supplyMaxAgeSec
  ) {
    return createCronResult({
      status: "error",
      metadata: { reason: "stablecoins-cache:invalid-supply-generation" },
    });
  }

  const configuredIds = getConfiguredRedemptionBackstopIds();
  const configById = new Map(
    configuredIds.map((stablecoinId) => [stablecoinId, getRedemptionBackstopConfig(stablecoinId)]),
  );
  const stablecoinAssetById = new Map(stablecoinsCache.payload.peggedAssets.map((asset) => [asset.id, asset]));
  const exitExecutionEnvelope = loadV9CandidateMethodologyPolicy(now);
  const exitExecutionReviews = validateExitExecutionModelReviews(exitExecutionModelReviews, exitExecutionEnvelope);
  const currentDepegObservationsById = buildRedemptionCurrentDepegObservationMap({
    peggedAssets: stablecoinsCache.payload.peggedAssets,
    fxFallbackRates: stablecoinsCache.payload.fxFallbackRates,
    stablecoinsGenerationAt: stablecoinsCache.updatedAt,
    now,
  });
  const preloadWarnings: string[] = [];
  let dexLiquidityMap: Awaited<ReturnType<typeof loadDexLiquidityScores>>["map"] = {};
  let latestUpdatedAt: number | null = null;
  await reportProgress?.({ stage: "loading-redemption-liquidity" });
  try {
    const dexSnapshot = await loadDexLiquidityScores(db);
    dexLiquidityMap = dexSnapshot.map;
    latestUpdatedAt = dexSnapshot.latestUpdatedAt;
  } catch (error) {
    const message = toErrorMessage(error);
    logWorkerEventArgs("handler", "warn", "[sync-redemption-backstops] DEX liquidity preload failed; continuing without DEX input:", error);
    preloadWarnings.push(`dex-liquidity:${message}`);
  }

  const reserveSnapshotMetadataById = acceptedReserveMetadataMap(acceptedReserveGeneration, now);

  await reportProgress?.({ stage: "loading-redemption-availability" });
  const routeAvailabilityById = await loadSevereActiveDepegAvailabilityMap(
    db,
    formatUtcDate(now),
    currentDepegObservationsById,
    { metadataById: reserveSnapshotMetadataById, now },
  );
  const registryMetadata = buildRegistryMetadata(configuredIds, configById);

  // Staleness is tracked for operational visibility (degraded-run signal +
  // metadata) and does not suppress the route score. Aligns with the
  // report-card path, which also uses the last-known DEX score when stale —
  // see the native capture at `worker/src/lib/safety-score-v9/capture.ts`.
  let liquidityStale = false;
  if (latestUpdatedAt == null) {
    logWorkerEventArgs("handler", "warn", "[sync-redemption-backstops] Liquidity data is missing");
    liquidityStale = true;
  } else {
    const ageSec = now - latestUpdatedAt;
    if (ageSec > DEX_LIQUIDITY_FRESHNESS_SEC) {
      logWorkerEventArgs("handler", "warn", `[sync-redemption-backstops] Liquidity data is stale (age: ${ageSec}s)`);
      liquidityStale = true;
    }
  }

  let completedCount = 0;
  let lastReportedCount = 0;
  let lastProgressAtMs = Date.now();
  let progressReporting = Promise.resolve();

  await reportProgress?.({ stage: "resolving-redemption-backstops", itemsDone: 0, itemsTotal: configuredIds.length });
  const results = await mapWithConcurrency(configuredIds, REDEMPTION_BACKSTOP_RESOLVE_CONCURRENCY, async (stablecoinId) => {
    let resolved: RedemptionBackstopEntry | null = null;
    let failed = false;
    let failureReason: RouteFailureReason | null = null;
    let directObserverAttempted = false;
    let directObserverConsumed = false;
    const onDirectObserverExecution = (event: DirectObserverExecutionEvent) => {
      if (event === "attempted") directObserverAttempted = true;
      else directObserverConsumed = true;
    };
    try {
      const asset = stablecoinAssetById.get(stablecoinId);
      const dexLiquidityScore = dexLiquidityMap[stablecoinId]?.liquidityScore ?? null;
      const routeAvailability = routeAvailabilityById.get(stablecoinId) ?? null;
      // Every resolver owns its sequential, body-draining observer requests.

      if (asset) {
        resolved = await resolveRedemptionBackstopEntry(db, asset, dexLiquidityScore, now, {
          signal,
          reserveSnapshotMetadata: reserveSnapshotMetadataById.get(stablecoinId) ?? null,
          ...(reserveSnapshotMetadataById.has(stablecoinId) ? { reserveInput: consumedReserveInput(acceptedReserveGeneration, stablecoinId, reserveSnapshotMetadataById.get(stablecoinId)!) } : {}),
          routeAvailability,
          rpcOptions,
          stablecoinsCache, exitExecutionEnvelope, exitExecutionReviews,
          onDirectObserverExecution,
        });
      } else {
        const config = configById.get(stablecoinId);
        if (config) {
          resolved = await buildRedemptionBackstopEntry(db, stablecoinId, config, null, dexLiquidityScore, now, {
            signal,
            reserveSnapshotMetadata: reserveSnapshotMetadataById.get(stablecoinId) ?? null,
            ...(reserveSnapshotMetadataById.has(stablecoinId) ? { reserveInput: consumedReserveInput(acceptedReserveGeneration, stablecoinId, reserveSnapshotMetadataById.get(stablecoinId)!) } : {}),
            routeAvailability,
            rpcOptions,
            stablecoinsCache, exitExecutionEnvelope, exitExecutionReviews,
            onDirectObserverExecution,
          });
        }
      }

      if (!resolved) throw new Error(`Configured redemption route ${stablecoinId} returned no snapshot`);
      validateRedemptionBackstopSnapshot(resolved);
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      logWorkerEventArgs("handler", "error", `[sync-redemption-backstops] Failed for ${stablecoinId}:`, error);
      failed = true;
      failureReason = describeRouteFailure(error);
      const config = configById.get(stablecoinId);
      if (config) {
        resolved = buildFailedRedemptionBackstopEntry(stablecoinId, config, now);
      }
    }
    completedCount++;
    if (completedCount === configuredIds.length || completedCount - lastReportedCount >= 10 || Date.now() - lastProgressAtMs >= 15_000) {
      const itemsDone = completedCount;
      lastReportedCount = itemsDone;
      lastProgressAtMs = Date.now();
      // Serialize coalesced reports so a slow write cannot overwrite newer progress.
      progressReporting = progressReporting.then(() => reportProgress?.({
        stage: "resolving-redemption-backstops", itemsDone, itemsTotal: configuredIds.length,
      }));
      await progressReporting;
    }
    return { snapshot: resolved, failed, failureReason, directObserverAttempted, directObserverConsumed };
  }, { signal });
  throwIfAborted(signal);
  const collectedSnapshots = results.map(({ snapshot }, index) => {
    if (!snapshot) throw new Error(`Missing redemption placeholder for ${configuredIds[index]}`);
    return snapshot;
  });
  let snapshots: RedemptionBackstopEntry[];
  for (;;) {
    snapshots = applyOutputDependencyResolution(collectedSnapshots, configById);
    let quarantined = false;
    for (let index = 0; index < snapshots.length; index++) {
      try {
        validateRedemptionBackstopSnapshot(snapshots[index]);
      } catch (error) {
        throwIfAborted(signal);
        const stablecoinId = configuredIds[index];
        const config = configById.get(stablecoinId);
        // A broken placeholder/config is a global hold, never a short census.
        if (!config || results[index].failed) throw error;
        logWorkerEventArgs("handler", "error", `[sync-redemption-backstops] Final admission failed for ${stablecoinId}:`, error);
        results[index].failed = true;
        results[index].failureReason = describeRouteFailure(error);
        collectedSnapshots[index] = buildFailedRedemptionBackstopEntry(stablecoinId, config, now);
        validateRedemptionBackstopSnapshot(collectedSnapshots[index]);
        quarantined = true;
      }
    }
    if (!quarantined) break;
    // Rebuild disclosures against explicit failed members before final admission.
  }
  throwIfAborted(signal);
  const failedIds = configuredIds.filter((_id, index) => results[index].failed);
  const directObserverAttemptedCount = results.filter((result) => result.directObserverAttempted).length;
  const directObserverConsumedCount = results.filter((result) => result.directObserverConsumed && !result.failed).length;

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
  const marketImpliedDegradedIds = snapshots
    .filter((entry) => entry.routeStatus === "degraded" && entry.routeStatusSource === "market-implied")
    .map((entry) => entry.stablecoinId);
  const marketEvidenceUncertainIds = snapshots
    .filter((entry) => entry.routeStatus === "unknown" && entry.routeStatusSource === "market-implied")
    .map((entry) => entry.stablecoinId);
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
  const activeResolvedCount = snapshots.filter(
    (entry) => entry.resolutionState === "resolved" && stablecoinAssetById.has(entry.stablecoinId),
  ).length;
  const coverageRatio = activeConfiguredCount > 0 ? activeResolvedCount / activeConfiguredCount : 0;
  const allowedMissingCapacityCount = getAllowedMissingCapacityCount(activeConfiguredCount);
  const missingCapacityWithinTolerance = missingCapacityCount <= allowedMissingCapacityCount;
  const hasNoActiveConfiguredRows = configuredIds.length > 0 && activeConfiguredCount === 0;
  const hasBlockingUnresolved = failedIds.length > 0 || criticalUnresolvedCount > 0;
  // The capacity coverage floor is an input-evidence condition: the sync wrote
  // every snapshot it could resolve, so it travels as quality, not a degraded run.
  const capacityCoverageFloorBreached = !missingCapacityWithinTolerance;
  const hasDegradedSyncSignal = hasBlockingUnresolved || liquidityStale || hasNoActiveConfiguredRows;
  const runMetadata: CronMetadataRecord & RedemptionReserveRunMetadata = {
    reserveViewSchemaVersion: 2,
    reserveGenerationId: acceptedReserveGeneration.generationId,
    reserveContentSha256: acceptedReserveGeneration.contentSha256,
    runClockSec: now,
    stablecoinsInput: { updatedAt: supplyUpdatedAt, assessedAt: now, maxAgeSec: supplyMaxAgeSec },
    consumedReserveInputs: Object.fromEntries(
      snapshots.flatMap((entry) => entry.reserveInput ? [[entry.stablecoinId, entry.reserveInput]] : []),
    ),
    synced: snapshots.length,
    failed: failedIds.length,
    configured: configuredIds.length,
    activeConfigured: activeConfiguredCount,
    cacheAbsentConfigured: cacheAbsentConfiguredCount,
    resolved: resolvedCount,
    activeResolved: activeResolvedCount,
    unresolved: unresolvedCount,
    unresolvedMissingCapacity: missingCapacityCount,
    ...(missingCapacityCount > 0 ? { familyMissingCapacityBy, providerMissingCapacityBy } : {}),
    unresolvedCritical: criticalUnresolvedCount,
    availabilityDegraded: availabilityDegradedCount,
    marketImpliedDegraded: marketImpliedDegradedIds.length,
    marketEvidenceUncertain: marketEvidenceUncertainIds.length,
    severeActiveDepegThresholdBps: REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS,
    missingCapacityOkThreshold: allowedMissingCapacityCount,
    coverageRatio,
    dynamic: dynamicCount,
    estimated: estimatedCount,
    static: staticCount,
    liquidityStale,
    routeStatusProducer: REDEMPTION_ROUTE_STATUS_PRODUCER.model,
    routeStatusProducerFetches: directObserverAttemptedCount > 0,
    directObserverAttemptedCount,
    directObserverConsumedCount,
    directObserverUnavailableCount: results.filter((result) =>
      result.directObserverAttempted && (!result.directObserverConsumed || result.failed),
    ).length,
    preloadDegraded: preloadWarnings.length > 0,
    ...(preloadWarnings.length > 0 ? { preloadWarnings: capStringList(preloadWarnings) } : {}),
    ...registryMetadata,
    ...(failedIds.length > 0 ? { failedIds: capStringList(failedIds), failedIdsTruncated: failedIds.length > 25 } : {}),
    ...(failedIds.length > 0 ? {
      sourceFailureReasons: Object.fromEntries(results.flatMap(({ failureReason }, index) =>
        failureReason ? [[configuredIds[index], failureReason]] : [],
      ).slice(0, 25)),
      sourceFailureReasonsTruncated: failedIds.length > 25,
    } : {}),
    ...(availabilityDegradedIds.length > 0
      ? {
          availabilityDegradedIds: capStringList(availabilityDegradedIds),
          availabilityDegradedIdsTruncated: availabilityDegradedIds.length > 25,
        }
      : {}),
    ...(marketImpliedDegradedIds.length > 0
      ? {
          marketImpliedDegradedIds: capStringList(marketImpliedDegradedIds),
          marketImpliedDegradedIdsTruncated: marketImpliedDegradedIds.length > 25,
        }
      : {}),
    ...(marketEvidenceUncertainIds.length > 0
      ? {
          marketEvidenceUncertainIds: capStringList(marketEvidenceUncertainIds),
          marketEvidenceUncertainIdsTruncated: marketEvidenceUncertainIds.length > 25,
        }
      : {}),
    ...(missingFromCache.length > 0
      ? { missingFromCache: capStringList(missingFromCache), missingFromCacheTruncated: missingFromCache.length > 25 }
      : {}),
    ...(capacityCoverageFloorBreached
      ? {
          quality: {
            reason: "capacity-coverage-floor",
            unresolvedMissingCapacity: missingCapacityCount,
            missingCapacityOkThreshold: allowedMissingCapacityCount,
          },
        }
      : {}),
  };

  await reportProgress?.({ stage: "publishing-redemption-backstops", itemsDone: configuredIds.length, itemsTotal: configuredIds.length });
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

  if (status !== "ok") {
    runMetadata.reason = hasBlockingUnresolved
      ? "unresolved-backstop-routes"
      : hasNoActiveConfiguredRows
        ? "no-active-configured-rows"
        : hasZeroResolvedCapacityFailure
          ? "no-resolved-backstop-capacity"
          : liquidityStale
            ? "liquidity-evidence-stale"
            : "post-write-warnings";
  }

  return createCronResult({
    status,
    itemCount: snapshots.length,
    productivity: { productive: writeResult.runRowsWrittenCount > 0 },
    metadata: {
      ...runMetadata,
      ...(writeResult.runRowsWrittenCount > 0 ? { outputPublishedAt: now } : {}),
      reason: typeof runMetadata.reason === "string" ? runMetadata.reason : "backstops-published",
    },
  });
}
