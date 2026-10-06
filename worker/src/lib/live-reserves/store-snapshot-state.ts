import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveAdapterValidationPolicy,
  LiveReserveAdmissionRejectionCode,
  LiveReserveSnapshotMetadata,
  ReserveFreshnessView,
} from "@shared/types/live-reserves";
import { LIVE_RESERVE_FRESHNESS_SEC, selectScoringDegradedWarnings, type ReserveCompositionRecord, type ReserveSyncStateRecord } from "./store-shared";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "../../cron/reserve-adapters/validate";

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
  attemptId: string | null;
}

/** The single fetch-age rule; `null` generation (nothing ever fetched) is never stale. */
export function assessReserveFetchFreshness(
  generation: ReserveGeneration,
  now: number,
  fetchFreshnessSec: number,
): ReserveFreshnessView {
  const fetchAgeSec = generation.fetchedAt == null ? null : now - generation.fetchedAt;
  const fetchStale = fetchAgeSec != null && fetchAgeSec > fetchFreshnessSec;
  return {
    stale: fetchStale,
    staleReasons: fetchStale ? ["fetch-age"] : [],
    assessedAt: now,
    fetchedAt: generation.fetchedAt,
    attemptId: generation.attemptId,
    fetchAgeSec,
    fetchBudgetSec: fetchFreshnessSec,
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
  const fetch = assessReserveFetchFreshness({ fetchedAt: record.fetchedAt, attemptId: record.attemptId ?? null }, now, fetchFreshnessSec);
  if (record.metadata.freshnessMode !== "verified") return fetch;
  const sourceTimestamp = record.metadata.sourceTimestamp;
  if (typeof sourceTimestamp !== "number" || !Number.isFinite(sourceTimestamp)) return fetch;
  const config = coin.liveReservesConfig;
  const adapter = config && getLiveReserveAdapterDefinition(config.adapter);
  const validation: LiveReserveAdapterValidationPolicy | undefined = adapter && "validation" in adapter ? adapter.validation : undefined;
  const scoringMaxAge = config?.scoring?.maxSourceAgeSec;
  const cappedMaxAge = Math.min(scoringMaxAge ?? Infinity, validation?.maxSourceAgeSec ?? Infinity);
  const sourceAgeBudgetSec = Number.isFinite(cappedMaxAge) ? cappedMaxAge : fetchFreshnessSec;
  const sourceAgeBudgetCap = !Number.isFinite(cappedMaxAge) ? "fetch-budget" : cappedMaxAge === scoringMaxAge ? "scoring" : "adapter";
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

/** Snapshot admission deliberately does not depend on a later attempt's status. */
export function evaluateLiveReserveAdmission(
  record: ReserveCompositionRecord | null,
  syncState: ReserveSyncStateRecord | null,
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
  if (config) {
    if (record.configFingerprint == null) {
      console.info("[live-reserves] Legacy snapshot has no config fingerprint", { stablecoinId: record.stablecoinId });
    } else if (record.configFingerprint !== computeLiveReserveConfigFingerprint(config)) {
      reasons.push("config-mismatch");
    }
  }
  if (record.adapterEvidenceClass !== "independent") reasons.push("non-independent");
  const freshness = coin ? assessReserveSnapshotFreshness(record, coin, now, freshnessSec) : null;
  if (freshness?.stale) reasons.push("stale");
  if (!hasScoringEligibleLiveReserveFreshness(record.metadata, now)) reasons.push("invalid-freshness");
  if (selectScoringDegradedWarnings(record.warnings, config).length > 0) reasons.push("degraded-snapshot");
  if (record.slices.length < minSlices) reasons.push("insufficient-slices");
  return { eligible: reasons.length === 0, reasons, freshness };
}
