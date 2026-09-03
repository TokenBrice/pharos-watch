import type { LiveReserveSnapshotMetadata } from "@shared/types/live-reserves";
import type { ReserveSyncStateRecord } from "./store-shared";

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

export function hasScoringEligibleLiveReserveFreshness(metadata: LiveReserveSnapshotMetadata): boolean {
  if (metadata.freshnessMode === "unverified") {
    return false;
  }

  if (metadata.freshnessMode === "not-applicable") {
    return true;
  }

  const hasVerifiedTimestamp =
    typeof metadata.sourceTimestamp === "number" &&
    Number.isFinite(metadata.sourceTimestamp) &&
    metadata.sourceTimestamp > 0;
  return hasVerifiedTimestamp;
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
