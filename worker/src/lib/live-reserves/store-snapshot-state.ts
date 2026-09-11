import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveAdapterValidationPolicy, LiveReserveSnapshotMetadata } from "@shared/types/live-reserves";
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

/** Fetch liveness and disclosure age have separate budgets (monthly reports are not daily feeds). */
export function isReserveSnapshotStale(
  record: Pick<ReserveCompositionRecord, "fetchedAt" | "metadata">,
  coin: StablecoinMeta,
  now: number,
  fetchFreshnessSec: number,
): boolean {
  if (now - record.fetchedAt > fetchFreshnessSec) return true;
  if (record.metadata.freshnessMode !== "verified") return false;
  const sourceTimestamp = record.metadata.sourceTimestamp;
  if (typeof sourceTimestamp !== "number" || !Number.isFinite(sourceTimestamp)) return false;
  const config = coin.liveReservesConfig;
  const adapter = config && getLiveReserveAdapterDefinition(config.adapter);
  const validation: LiveReserveAdapterValidationPolicy | undefined = adapter && "validation" in adapter ? adapter.validation : undefined;
  const adapterMaxAge = validation?.maxSourceAgeSec;
  const sourceMaxAge = Math.min(config?.scoring?.maxSourceAgeSec ?? Infinity, adapterMaxAge ?? Infinity);
  return now - sourceTimestamp > (Number.isFinite(sourceMaxAge) ? sourceMaxAge : fetchFreshnessSec);
}

export type AdmissionRejectionCode =
  | "unconfigured" | "suspended" | "missing-snapshot" | "inconsistent-snapshot"
  | "config-mismatch" | "non-independent" | "stale" | "invalid-freshness"
  | "degraded-snapshot" | "insufficient-slices";

export interface LiveReserveAdmissionResult {
  eligible: boolean;
  reasons: AdmissionRejectionCode[];
}

/** Snapshot admission deliberately does not depend on a later attempt's status. */
export function evaluateLiveReserveAdmission(
  record: ReserveCompositionRecord | null,
  syncState: ReserveSyncStateRecord | null,
  coin: StablecoinMeta | undefined,
  now: number,
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 1,
): LiveReserveAdmissionResult {
  const reasons: AdmissionRejectionCode[] = [];
  const config = coin?.liveReservesConfig;
  if (!config) reasons.push("unconfigured");
  if (config?.suspended) reasons.push("suspended");
  if (!record) {
    reasons.push("missing-snapshot");
    return { eligible: false, reasons };
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
  if (coin && isReserveSnapshotStale(record, coin, now, freshnessSec)) reasons.push("stale");
  if (!hasScoringEligibleLiveReserveFreshness(record.metadata, now)) reasons.push("invalid-freshness");
  if (selectScoringDegradedWarnings(record.warnings, config).length > 0) reasons.push("degraded-snapshot");
  if (record.slices.length < minSlices) reasons.push("insufficient-slices");
  return { eligible: reasons.length === 0, reasons };
}
