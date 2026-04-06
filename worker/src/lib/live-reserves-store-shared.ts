import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveEvidenceClass,
  LiveReserveSnapshotMetadata,
  LiveReserveSourceModel,
  LiveReserveWarning,
} from "@shared/types/live-reserves";

export const LIVE_RESERVE_FRESHNESS_SEC = 2 * DAY_SECONDS;
export const LIVE_RESERVE_HISTORY_RETENTION_SEC = 90 * DAY_SECONDS;
export const SCORING_LIVE_RESERVE_EVIDENCE_CLASSES: LiveReserveEvidenceClass[] = ["independent"];

export type ReserveSyncStatus = "ok" | "degraded" | "error" | "skipped";

export interface ReserveCompositionRow {
  stablecoin_id: string;
  slices: string;
  fetched_at: number;
  source: string;
  attempt_id?: string | null;
  metadata?: string | null;
  warning_count?: number | null;
  warnings?: string | null;
  adapter_source_model?: string | null;
  adapter_evidence_class?: string | null;
}

export interface ReserveSyncStateRow {
  stablecoin_id: string;
  adapter_key: string;
  breaker_key: string;
  last_attempted_at: number | null;
  last_success_at: number | null;
  last_status: ReserveSyncStatus;
  warning_count: number;
  warnings: string | null;
  last_error: string | null;
  metadata: string;
  last_attempt_id?: string | null;
  pending_attempt_id?: string | null;
  last_success_attempt_id?: string | null;
}

export interface SnapshotIntegrityIssue {
  code:
    | "invalid-json"
    | "invalid-payload"
    | "empty-slices"
    | "invalid-slice"
    | "invalid-sum";
  message: string;
}

export interface ReserveCompositionRecord {
  stablecoinId: string;
  slices: ReserveSlice[];
  fetchedAt: number;
  source: string;
  attemptId?: string | null;
  metadata: LiveReserveSnapshotMetadata;
  warningCount: number;
  warnings: LiveReserveWarning[];
  adapterSourceModel: LiveReserveSourceModel;
  adapterEvidenceClass: LiveReserveEvidenceClass;
}

export interface ReserveSyncStateRecord {
  stablecoinId: string;
  adapterKey: string;
  breakerKey: string;
  lastAttemptedAt: number | null;
  lastSuccessAt: number | null;
  lastStatus: ReserveSyncStatus;
  warningCount: number;
  warnings: LiveReserveWarning[];
  lastError: string | null;
  metadata: LiveReserveSnapshotMetadata;
  lastAttemptId?: string | null;
  pendingAttemptId?: string | null;
  lastSuccessAttemptId?: string | null;
}

export interface ReserveSyncAttemptHistoryRecord {
  stablecoinId: string;
  attemptedAt: number;
  adapterKey: string;
  breakerKey: string;
  status: ReserveSyncStatus;
  warningCount: number;
  warnings: LiveReserveWarning[];
  lastError: string | null;
  metadata: LiveReserveSnapshotMetadata;
  attemptId?: string | null;
}

export interface ReserveSyncAttemptStartRecord {
  stablecoinId: string;
  adapterKey: string;
  breakerKey: string;
  attemptedAt: number;
  attemptId: string;
}

export interface LiveReserveHistoryPruneResult {
  cutoff: number;
  compositionHistoryDeleted: number;
  attemptHistoryDeleted: number;
}

export interface ReserveCompositionOverview {
  configuredCoins: number;
  freshCoins: number;
  staleCoins: number;
  missingCoins: number;
  degradedCoins: number;
  errorCoins: number;
  corruptCoins: number;
  independentFreshEligible: number;
  independentFreshUnverified: number;
  staticValidatedFresh: number;
  weakProbeFresh: number;
  writeTimeoutUncertain: number;
  lastSuccessAt: number | null;
  oldestFreshAgeSec: number | null;
}

export interface AuthoritativeReserveSnapshot {
  stablecoinId: string;
  slices: ReserveSlice[];
  fetchedAt: number;
  source: string;
  metadata: LiveReserveSnapshotMetadata;
  warningCount: number;
  warnings: LiveReserveWarning[];
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
}

export interface ReserveSnapshotMetadataRecord {
  stablecoinId: string;
  fetchedAt: number;
  source: string;
  metadata: LiveReserveSnapshotMetadata;
  warningCount: number;
  warnings: LiveReserveWarning[];
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
  syncStatus: ReserveSyncStatus;
}

export const RESERVE_SYNC_STATE_SELECT_COLUMNS = [
  "stablecoin_id",
  "adapter_key",
  "breaker_key",
  "last_attempted_at",
  "last_success_at",
  "last_status",
  "warning_count",
  "warnings",
  "last_error",
  "metadata",
  "last_attempt_id",
  "pending_attempt_id",
  "last_success_attempt_id",
].join(", ");

export function getConfiguredLiveReserveCoins(): StablecoinMeta[] {
  return ACTIVE_STABLECOINS.filter((coin) => !!coin.liveReservesConfig);
}

export function createReserveSyncAttemptId(stablecoinId: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return `${stablecoinId}:${cryptoObj.randomUUID()}`;
  }
  return `${stablecoinId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function didReserveSyncAttemptFinalizeAsSuccess(
  syncState: Pick<ReserveSyncStateRecord, "lastSuccessAttemptId"> | null | undefined,
  attemptId: string,
): boolean {
  return syncState?.lastSuccessAttemptId === attemptId;
}
