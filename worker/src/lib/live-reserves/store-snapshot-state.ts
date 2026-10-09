import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { AcceptedReserveSnapshot } from "@shared/types/accepted-reserve-generation";
import type {
  LiveReserveAdapterValidationPolicy,
  LiveReserveAdmissionRejectionCode,
  LiveReserveSnapshotMetadata,
  ReserveFreshnessView,
} from "@shared/types/live-reserves";
import { LIVE_RESERVE_FRESHNESS_SEC, selectScoringDegradedWarnings, type ReserveCompositionRecord, type ReserveSyncStateRecord } from "./store-shared";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { isCarryEligible } from "@shared/lib/evidence-loss";
import { reserveLossLineage } from "./loss";

export function hasConsistentSnapshotState(
  syncState: Pick<ReserveSyncStateRecord, "lastSuccessAt" | "lastSuccessAttemptId"> | null | undefined,
  snapshot: {
    fetchedAt: number | null | undefined;
    attemptId?: string | null;
  } | null | undefined,
): boolean {
  const fetchedAt = snapshot?.fetchedAt;
  const snapshotAttemptId = snapshot?.attemptId ?? null;
  const successAttemptId = syncState?.lastSuccessAttemptId ?? null;
  const hasAttemptMatch = typeof successAttemptId === "string"
    || typeof snapshotAttemptId === "string";
  if (hasAttemptMatch) {
    return typeof successAttemptId === "string"
      && successAttemptId.length > 0
      && typeof snapshotAttemptId === "string"
      && snapshotAttemptId.length > 0
      && successAttemptId === snapshotAttemptId
      && typeof syncState?.lastSuccessAt === "number"
      && syncState.lastSuccessAt > 0
      && typeof fetchedAt === "number"
      && fetchedAt > 0
      && syncState.lastSuccessAt === fetchedAt;
  }

  return typeof syncState?.lastSuccessAt === "number"
    && syncState.lastSuccessAt > 0
    && typeof fetchedAt === "number"
    && fetchedAt > 0
    && syncState.lastSuccessAt === fetchedAt;
}

export function hasScoringEligibleLiveReserveFreshness(
  metadata: LiveReserveSnapshotMetadata,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (metadata.diag?.invalidFreshness === true) return false;
  if (metadata.freshnessMode === "not-applicable") return true;
  return metadata.freshnessMode === "verified"
    && typeof metadata.sourceTimestamp === "number"
    && Number.isFinite(metadata.sourceTimestamp)
    && metadata.sourceTimestamp > 0
    && metadata.sourceTimestamp <= now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC;
}

export function hasUncertainWriteState(syncState: ReserveSyncStateRecord | null | undefined): boolean {
  return syncState?.metadata.uncertainWrite === true;
}

export function shouldUseLegacySnapshotFallback(
  syncState: ReserveSyncStateRecord | null,
  snapshot: {
    fetchedAt: number | null | undefined;
    attemptId?: string | null;
  } | null | undefined,
): boolean {
  if (syncState?.lastSuccessAttemptId || snapshot?.attemptId) {
    return false;
  }

  return hasConsistentSnapshotState(syncState, snapshot)
    && typeof syncState?.lastAttemptedAt === "number"
    && syncState.lastAttemptedAt === syncState.lastSuccessAt
    && syncState.lastStatus !== "error"
    && syncState.lastStatus !== "skipped";
}

interface ReserveGeneration {
  fetchedAt: number | null;
  attemptId?: string | null;
  metadata?: Pick<LiveReserveSnapshotMetadata, "freshnessMode" | "diag">;
}

/** The single fetch-age rule; `null` generation (nothing ever fetched) is never stale. */
export function assessReserveFetchFreshness(
  generation: ReserveGeneration,
  now: number,
  fetchFreshnessSec: number,
): ReserveFreshnessView {
  const fetchAgeSec = generation.fetchedAt == null ? null : now - generation.fetchedAt;
  const invalidFetchClock = fetchAgeSec != null && fetchAgeSec < 0;
  const fetchStale = fetchAgeSec != null && fetchAgeSec > fetchFreshnessSec;
  return {
    stale: fetchStale || invalidFetchClock,
    staleReasons: invalidFetchClock ? ["invalid-fetch-clock"] : fetchStale ? ["fetch-age"] : [],
    assessedAt: now,
    fetchedAt: generation.fetchedAt,
    attemptId: generation.attemptId ?? null,
    fetchAgeSec,
    fetchBudgetSec: fetchFreshnessSec,
    freshnessMode: generation.metadata?.freshnessMode ?? null,
    sourceFreshnessInvalid: generation.metadata?.diag?.invalidFreshness === true,
    sourceTimestamp: null,
    sourceAgeSec: null,
    sourceAgeBudgetSec: null,
    sourceAgeBudgetCap: null,
  };
}

/**
 * Fetch liveness and disclosure age have separate budgets (monthly reports are
 * not daily feeds). The effective source budget is min(coin scoring cap,
 * adapter validation cap), falling back to the fetch budget when neither is
 * declared; it applies only to `verified` snapshots with a finite source
 * timestamp. Returns the verdict with every value it used (ADR-30).
 */
export function assessReserveSnapshotFreshness(
  record: Pick<ReserveCompositionRecord, "fetchedAt" | "attemptId" | "metadata">,
  coin: Pick<StablecoinMeta, "liveReservesConfig">,
  now: number,
  fetchFreshnessSec: number,
): ReserveFreshnessView {
  const fetch = assessReserveFetchFreshness(record, now, fetchFreshnessSec);
  if (record.metadata.freshnessMode !== "verified") return fetch;
  const sourceTimestamp = record.metadata.sourceTimestamp;
  if (typeof sourceTimestamp !== "number" || !Number.isFinite(sourceTimestamp)) return fetch;
  const config = coin.liveReservesConfig;
  const adapter = config && getLiveReserveAdapterDefinition(config.adapter);
  const validation: LiveReserveAdapterValidationPolicy | undefined = adapter && "validation" in adapter ? adapter.validation : undefined;
  const { sourceAgeBudgetSec, sourceAgeBudgetCap } = resolveLiveReserveSourceAgeBudget(
    config?.scoring?.maxSourceAgeSec, validation?.maxSourceAgeSec, fetchFreshnessSec,
  );
  const sourceAgeSec = now - sourceTimestamp;
  const sourceStale = sourceAgeSec > sourceAgeBudgetSec;
  return {
    ...fetch,
    stale: fetch.stale || sourceStale,
    staleReasons: sourceStale ? [...fetch.staleReasons, "source-age"] : fetch.staleReasons,
    sourceTimestamp,
    sourceAgeSec,
    sourceAgeBudgetSec,
    sourceAgeBudgetCap,
  };
}

export interface LiveReserveAdmissionResult {
  eligible: boolean;
  reasons: LiveReserveAdmissionRejectionCode[];
  /** The freshness assessment behind any `stale` reason; `null` without a snapshot or coin. */
  freshness: ReserveFreshnessView | null;
}

/** Later refresh loss may reuse only proved operational evidence; sticky revocations survive skips. */
export function evaluateLiveReserveAdmission(
  record: ReserveCompositionRecord | AcceptedReserveSnapshot | null,
  syncState: Pick<ReserveSyncStateRecord, "lastSuccessAt" | "lastSuccessAttemptId">
    & Partial<Pick<ReserveSyncStateRecord, "lastAttemptedAt" | "lastAttemptId" | "pendingAttemptId" | "lastStatus" | "metadata">> | null,
  coin: Pick<StablecoinMeta, "liveReservesConfig"> | undefined,
  now: number,
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 1,
): LiveReserveAdmissionResult {
  const reasons: LiveReserveAdmissionRejectionCode[] = [];
  const config = coin?.liveReservesConfig;
  if (!config) reasons.push("unconfigured");
  if (config?.suspended) reasons.push("suspended");
  if (!record) {
    reasons.push("missing-snapshot");
    return { eligible: false, reasons, freshness: null };
  }
  if (!hasConsistentSnapshotState(syncState, record)) reasons.push("inconsistent-snapshot");
  const lineage = reserveLossLineage(syncState ? { ...syncState, stablecoinId: record.stablecoinId,
    configFingerprint: record.configFingerprint, metadata: syncState.metadata ?? {} } : null);
  if (lineage.invalidations.composition) reasons.push("live-scope-invalidated");
  const pending = syncState?.pendingAttemptId != null;
  const laterAttempt = !pending && typeof syncState?.lastAttemptedAt === "number"
    && (syncState.lastAttemptedAt > record.fetchedAt
      || (syncState.lastAttemptId != null && syncState.lastAttemptId !== record.attemptId));
  if (laterAttempt || lineage.latest?.scope.key === "composition") {
    const loss = lineage.latest;
    if (!loss || loss.scope.assetId !== record.stablecoinId || loss.scope.key !== "composition"
      || loss.sourceId !== record.configFingerprint
      || (!pending && ((syncState?.lastAttemptId != null && loss.attemptId !== syncState.lastAttemptId)
        || loss.observedAtSec !== syncState?.lastAttemptedAt))
      || loss.priorEvidence?.ref !== `reserve-composition:${record.stablecoinId}:${record.attemptId}`
      || !isCarryEligible(loss, now)) reasons.push("refresh-loss-unproved");
  }
  if (config) {
    if (typeof record.configFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(record.configFingerprint)
      || record.configFingerprint !== computeLiveReserveConfigFingerprint(config)) {
      reasons.push("config-mismatch");
    }
  }
  if (record.adapterEvidenceClass !== "independent") reasons.push("non-independent");
  const freshness = coin ? assessReserveSnapshotFreshness(record, coin, now, freshnessSec) : null;
  if (freshness?.stale) reasons.push("stale");
  if (freshness?.staleReasons.includes("invalid-fetch-clock")
    || !hasScoringEligibleLiveReserveFreshness(record.metadata, now)) reasons.push("invalid-freshness");
  if (selectScoringDegradedWarnings(record.warnings, config).length > 0) reasons.push("degraded-snapshot");
  if (("sliceCount" in record ? record.sliceCount : record.slices.length) < minSlices) reasons.push("insufficient-slices");
  return { eligible: reasons.length === 0, reasons, freshness };
}
