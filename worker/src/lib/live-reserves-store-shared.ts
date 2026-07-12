import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveEvidenceClass,
  LiveReserveSnapshotMetadata,
  LiveReserveSourceModel,
  LiveReserveWarning,
  ReserveCompositionOverview,
} from "@shared/types/live-reserves";
export type { ReserveCompositionOverview } from "@shared/types/live-reserves";

export const LIVE_RESERVE_FRESHNESS_SEC = 2 * DAY_SECONDS;
export const LIVE_RESERVE_HISTORY_RETENTION_SEC = 90 * DAY_SECONDS;
export const PERSISTENTLY_STALE_INDEPENDENT_THRESHOLD_SEC = 14 * DAY_SECONDS;
export const SCORING_LIVE_RESERVE_EVIDENCE_CLASSES: LiveReserveEvidenceClass[] = ["independent"];
const RESERVE_COMPOSITION_COLUMN_NAMES = [
  "stablecoin_id",
  "slices",
  "fetched_at",
  "source",
  "attempt_id",
  "metadata",
  "warning_count",
  "warnings",
  "adapter_source_model",
  "adapter_evidence_class",
] as const;

export const RESERVE_COMPOSITION_INSERT_COLUMNS = RESERVE_COMPOSITION_COLUMN_NAMES.map(
  (column) => `         ${column}`,
).join(",\n");
export const RESERVE_COMPOSITION_SELECT_COLUMNS = RESERVE_COMPOSITION_COLUMN_NAMES.join(", ");
export const RESERVE_COMPOSITION_CONFLICT_ASSIGNMENTS = RESERVE_COMPOSITION_COLUMN_NAMES.filter(
  (column) => column !== "stablecoin_id",
)
  .map((column) => `         ${column} = excluded.${column}`)
  .join(",\n");

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
    "invalid-json" | "invalid-payload" | "empty-slices" | "invalid-slice" | "invalid-sum" | "unknown-adapter-source";
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

export function emptyReserveCompositionOverview(configuredCoins = 0): ReserveCompositionOverview {
  return {
    configuredCoins,
    freshCoins: 0,
    staleCoins: 0,
    missingCoins: 0,
    degradedCoins: 0,
    errorCoins: 0,
    corruptCoins: 0,
    independentFreshEligible: 0,
    independentFreshUnverified: 0,
    staticValidatedFresh: 0,
    weakProbeFresh: 0,
    writeTimeoutUncertain: 0,
    deferredCoins: 0,
    runBudgetTruncated: false,
    deferredAt: null,
    nextCursorStablecoinId: null,
    cursorTailState: null,
    cursorTailError: null,
    cursorRecordedAt: null,
    cursorTailCompletedAt: null,
    cursorTailFailedAt: null,
    runBudgetTruncationCount: 0,
    historyWriteGaps: [],
    persistentlyStaleIndependentCoins: [],
    lastSuccessAt: null,
    oldestFreshAgeSec: null,
  };
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

export interface LiveReserveSnapshotProvenance {
  source: string;
  fetchedAt: number;
}

export interface LiveReserveScoringMap extends Map<string, ReserveSlice[]> {
  readonly provenanceById: ReadonlyMap<string, LiveReserveSnapshotProvenance>;
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
