import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type {
  ReserveSlice,
  StablecoinMeta,
} from "@shared/types/core";
import type {
  LiveReserveEvidenceClass,
  LiveReserveSnapshotMetadata,
  LiveReserveSourceModel,
  LiveReserveWarning,
  ReserveSyncStateView,
} from "@shared/types/live-reserves";
import { buildInClause } from "./db";
import { chunkArray } from "./collections";
import {
  buildReserveProvenanceView,
  hasConsistentSnapshotState,
  hasScoringEligibleLiveReserveFreshness,
  hasUncertainWriteState,
  parseReserveCompositionRow,
  parseSnapshotMetadata,
  parseWarnings,
} from "./live-reserves-store-parsing";
import {
  buildReserveCompositionHistoryInsertStatement,
  buildReserveCompositionUpsertStatement,
  buildReserveSyncAttemptHistoryInsertStatement,
  buildReserveSyncAttemptStartStatement,
  buildReserveSyncFinalizeAttemptStatement,
  buildReserveSyncFinalizeSuccessStatement,
} from "./live-reserves-store-statements";

export const LIVE_RESERVE_FRESHNESS_SEC = 2 * DAY_SECONDS;
const LIVE_RESERVE_HISTORY_RETENTION_SEC = 90 * DAY_SECONDS;
const SCORING_LIVE_RESERVE_EVIDENCE_CLASSES: LiveReserveEvidenceClass[] = ["independent"];

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

interface ReserveSyncStateRow {
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

const RESERVE_SYNC_STATE_SELECT_COLUMNS = [
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

function mapReserveSyncStateRow(row: ReserveSyncStateRow): ReserveSyncStateRecord {
  return {
    stablecoinId: row.stablecoin_id,
    adapterKey: row.adapter_key,
    breakerKey: row.breaker_key,
    lastAttemptedAt: row.last_attempted_at,
    lastSuccessAt: row.last_success_at,
    lastStatus: row.last_status,
    warningCount: row.warning_count,
    warnings: parseWarnings(row.warnings),
    lastError: row.last_error,
    metadata: parseSnapshotMetadata(row.metadata),
    lastAttemptId: row.last_attempt_id ?? null,
    pendingAttemptId: row.pending_attempt_id ?? null,
    lastSuccessAttemptId: row.last_success_attempt_id ?? null,
  };
}

export async function upsertReserveComposition(
  db: D1Database,
  record: ReserveCompositionRecord,
): Promise<void> {
  await buildReserveCompositionUpsertStatement(db, record).run();
}

export async function beginReserveSyncAttempt(
  db: D1Database,
  record: ReserveSyncAttemptStartRecord,
): Promise<void> {
  await buildReserveSyncAttemptStartStatement(db, record).run();
}

export async function finalizeReserveSyncSuccess(
  db: D1Database,
  composition: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord,
  finalizeDeadlineMs: number,
): Promise<{ finalized: boolean }> {
  await buildReserveCompositionUpsertStatement(db, composition).run();
  await buildReserveCompositionHistoryInsertStatement(db, composition).run();
  const finalizeResult = await buildReserveSyncFinalizeSuccessStatement(db, syncState, finalizeDeadlineMs).run();
  const finalized = (finalizeResult.meta.changes ?? 0) > 0;

  if (finalized) {
    await buildReserveSyncAttemptHistoryInsertStatement(db, {
      stablecoinId: syncState.stablecoinId,
      attemptedAt: syncState.lastAttemptedAt ?? composition.fetchedAt,
      adapterKey: syncState.adapterKey,
      breakerKey: syncState.breakerKey,
      status: syncState.lastStatus,
      warningCount: syncState.warningCount,
      warnings: syncState.warnings,
      lastError: syncState.lastError,
      metadata: syncState.metadata,
      attemptId: syncState.lastAttemptId ?? null,
    }).run();
  }

  return { finalized };
}

export async function finalizeReserveSyncAttempt(
  db: D1Database,
  syncState: ReserveSyncStateRecord,
): Promise<{ finalized: boolean }> {
  const finalizeResult = await buildReserveSyncFinalizeAttemptStatement(db, syncState).run();
  const finalized = (finalizeResult.meta.changes ?? 0) > 0;

  if (finalized) {
    await buildReserveSyncAttemptHistoryInsertStatement(db, {
      stablecoinId: syncState.stablecoinId,
      attemptedAt: syncState.lastAttemptedAt ?? Math.floor(Date.now() / 1000),
      adapterKey: syncState.adapterKey,
      breakerKey: syncState.breakerKey,
      status: syncState.lastStatus,
      warningCount: syncState.warningCount,
      warnings: syncState.warnings,
      lastError: syncState.lastError,
      metadata: syncState.metadata,
      attemptId: syncState.lastAttemptId ?? null,
    }).run();
  }

  return { finalized };
}

export async function pruneLiveReserveHistory(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  retentionSec = LIVE_RESERVE_HISTORY_RETENTION_SEC,
): Promise<LiveReserveHistoryPruneResult> {
  const cutoff = now - retentionSec;
  const compositionDelete = await db
    .prepare("DELETE FROM reserve_composition_history WHERE fetched_at < ?")
    .bind(cutoff)
    .run();
  const attemptDelete = await db
    .prepare("DELETE FROM reserve_sync_attempt_history WHERE attempted_at < ?")
    .bind(cutoff)
    .run();

  return {
    cutoff,
    compositionHistoryDeleted: compositionDelete.meta.changes ?? 0,
    attemptHistoryDeleted: attemptDelete.meta.changes ?? 0,
  };
}

async function getReserveCompositionRow(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveCompositionRow | null> {
  return db
    .prepare(
      `SELECT stablecoin_id, slices, fetched_at, source, attempt_id, metadata, warning_count, warnings,
              adapter_source_model, adapter_evidence_class
         FROM reserve_composition
        WHERE stablecoin_id = ?`,
    )
    .bind(stablecoinId)
    .first<ReserveCompositionRow>();
}

export async function getReserveComposition(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveCompositionRecord | null> {
  const [row, syncState] = await Promise.all([
    getReserveCompositionRow(db, stablecoinId),
    getReserveSyncState(db, stablecoinId),
  ]);
  if (!row) return null;
  return parseReserveCompositionRow(row, syncState).record;
}

export async function getReserveSyncState(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSyncStateRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${RESERVE_SYNC_STATE_SELECT_COLUMNS}
         FROM reserve_sync_state
        WHERE stablecoin_id = ?`,
    )
    .bind(stablecoinId)
    .first<ReserveSyncStateRow>();

  if (!row) return null;
  return mapReserveSyncStateRow(row);
}

export async function loadReserveSyncStateMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveSyncStateRecord>> {
  if (stablecoinIds.length === 0) return new Map();

  const BATCH_SIZE = 50;
  const result = new Map<string, ReserveSyncStateRecord>();

  for (const batch of chunkArray(stablecoinIds, BATCH_SIZE)) {
    const inClause = buildInClause(batch);
    const rows = await db
      .prepare(
        `SELECT ${RESERVE_SYNC_STATE_SELECT_COLUMNS}
           FROM reserve_sync_state
          WHERE stablecoin_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ReserveSyncStateRow>();

    for (const row of rows.results ?? []) {
      result.set(row.stablecoin_id, mapReserveSyncStateRow(row));
    }
  }

  return result;
}

async function loadReserveCompositionRowMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveCompositionRow>> {
  if (stablecoinIds.length === 0) return new Map();

  const BATCH_SIZE = 50;
  const result = new Map<string, ReserveCompositionRow>();

  for (const batch of chunkArray(stablecoinIds, BATCH_SIZE)) {
    const inClause = buildInClause(batch);
    const rows = await db
      .prepare(
        `SELECT stablecoin_id, slices, fetched_at, source, attempt_id, metadata, warning_count, warnings,
                adapter_source_model, adapter_evidence_class
           FROM reserve_composition
          WHERE stablecoin_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ReserveCompositionRow>();

    for (const row of rows.results ?? []) {
      result.set(row.stablecoin_id, row);
    }
  }

  return result;
}

export async function computeReserveCompositionOverview(
  db: D1Database,
  now: number,
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveCompositionOverview> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  if (configuredCoins.length === 0) {
    return {
      configuredCoins: 0,
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
      lastSuccessAt: null,
      oldestFreshAgeSec: null,
    };
  }

  const coinIds = configuredCoins.map((coin) => coin.id);
  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, coinIds),
    loadReserveCompositionRowMap(db, coinIds),
  ]);

  let freshCoins = 0;
  let staleCoins = 0;
  let missingCoins = 0;
  let degradedCoins = 0;
  let errorCoins = 0;
  let corruptCoins = 0;
  let independentFreshEligible = 0;
  let independentFreshUnverified = 0;
  let staticValidatedFresh = 0;
  let weakProbeFresh = 0;
  let writeTimeoutUncertain = 0;
  let lastSuccessAt: number | null = null;
  let oldestFreshAgeSec: number | null = null;

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const compositionRow = compositionById.get(coin.id);
    if (hasUncertainWriteState(syncState)) {
      writeTimeoutUncertain++;
    }
    const hasSnapshot = hasConsistentSnapshotState(syncState, compositionRow
      ? { fetchedAt: compositionRow.fetched_at, attemptId: compositionRow.attempt_id ?? null }
      : null);

    if (!hasSnapshot || !compositionRow) {
      if (syncState?.lastStatus === "error") {
        errorCoins++;
      } else {
        missingCoins++;
      }
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) {
      corruptCoins++;
      continue;
    }

    const ageSec = Math.max(0, now - parsed.record.fetchedAt);
    lastSuccessAt = lastSuccessAt == null ? parsed.record.fetchedAt : Math.max(lastSuccessAt, parsed.record.fetchedAt);

    if (syncState?.lastStatus === "error") {
      errorCoins++;
      continue;
    }

    if (syncState && syncState.lastStatus !== "ok") {
      degradedCoins++;
      continue;
    }

    if (ageSec > freshnessSec) {
      staleCoins++;
      continue;
    }

    freshCoins++;
    if (parsed.record.adapterEvidenceClass === "independent") {
      if (hasScoringEligibleLiveReserveFreshness(parsed.record.metadata)) {
        independentFreshEligible++;
      } else {
        independentFreshUnverified++;
      }
    } else if (parsed.record.adapterEvidenceClass === "static-validated") {
      staticValidatedFresh++;
    } else if (parsed.record.adapterEvidenceClass === "weak-live-probe") {
      weakProbeFresh++;
    }
    oldestFreshAgeSec = oldestFreshAgeSec == null ? ageSec : Math.max(oldestFreshAgeSec, ageSec);
  }

  return {
    configuredCoins: configuredCoins.length,
    freshCoins,
    staleCoins,
    missingCoins,
    degradedCoins,
    errorCoins,
    corruptCoins,
    independentFreshEligible,
    independentFreshUnverified,
    staticValidatedFresh,
    weakProbeFresh,
    writeTimeoutUncertain,
    lastSuccessAt,
    oldestFreshAgeSec,
  };
}

export async function getMaxSyncAge(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(last_success_at) AS max_ts FROM reserve_sync_state")
    .first<{ max_ts: number | null }>();
  if (!row?.max_ts) return Infinity;
  return now - row.max_ts;
}

async function loadFreshAuthoritativeReserveSnapshots(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  options?: {
    minSlices?: number;
    sourceModels?: readonly LiveReserveSourceModel[];
    evidenceClasses?: readonly LiveReserveEvidenceClass[];
    requireOkStatus?: boolean;
  },
): Promise<Map<string, AuthoritativeReserveSnapshot>> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  const coinIds = configuredCoins.map((coin) => coin.id);
  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, coinIds),
    loadReserveCompositionRowMap(db, coinIds),
  ]);
  const allowedSourceModels = options?.sourceModels ? new Set(options.sourceModels) : null;
  const allowedEvidenceClasses = options?.evidenceClasses ? new Set(options.evidenceClasses) : null;
  const minSlices = options?.minSlices ?? 1;
  const snapshots = new Map<string, AuthoritativeReserveSnapshot>();

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const compositionRow = compositionById.get(coin.id);
    if (!compositionRow || !hasConsistentSnapshotState(syncState, {
      fetchedAt: compositionRow.fetched_at,
      attemptId: compositionRow.attempt_id ?? null,
    })) {
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) continue;
    if (options?.requireOkStatus && syncState?.lastStatus !== "ok") continue;
    if (now - parsed.record.fetchedAt > freshnessSec) continue;
    if (parsed.record.slices.length < minSlices) continue;

    if (allowedSourceModels && !allowedSourceModels.has(parsed.record.adapterSourceModel)) {
      continue;
    }
    if (allowedEvidenceClasses && !allowedEvidenceClasses.has(parsed.record.adapterEvidenceClass)) {
      continue;
    }

    snapshots.set(coin.id, {
      stablecoinId: coin.id,
      slices: parsed.record.slices,
      fetchedAt: parsed.record.fetchedAt,
      source: parsed.record.source,
      metadata: parsed.record.metadata,
      warningCount: parsed.record.warningCount,
      warnings: parsed.record.warnings,
      sourceModel: parsed.record.adapterSourceModel,
      evidenceClass: parsed.record.adapterEvidenceClass,
    });
  }

  return snapshots;
}

export async function loadFreshIndependentLiveReserveMap(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 1,
): Promise<Map<string, ReserveSlice[]>> {
  const snapshots = await loadFreshAuthoritativeReserveSnapshots(db, now, freshnessSec, {
    minSlices,
    evidenceClasses: SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
    requireOkStatus: true,
  });
  return new Map(
    Array.from(snapshots.entries())
      .filter(([, snapshot]) => hasScoringEligibleLiveReserveFreshness(snapshot.metadata))
      .map(([coinId, snapshot]) => [coinId, snapshot.slices]),
  );
}

function buildReserveSnapshotMetadataRecord(
  stablecoinId: string,
  record: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord | null,
): ReserveSnapshotMetadataRecord {
  return {
    stablecoinId,
    fetchedAt: record.fetchedAt,
    source: record.source,
    metadata: record.metadata,
    warningCount: record.warningCount,
    warnings: record.warnings,
    sourceModel: record.adapterSourceModel,
    evidenceClass: record.adapterEvidenceClass,
    syncStatus: syncState?.lastStatus ?? "error",
  };
}

async function loadReserveSnapshotMetadataMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveSnapshotMetadataRecord>> {
  if (stablecoinIds.length === 0) {
    return new Map();
  }

  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, stablecoinIds),
    loadReserveCompositionRowMap(db, stablecoinIds),
  ]);

  const records = new Map<string, ReserveSnapshotMetadataRecord>();
  for (const stablecoinId of stablecoinIds) {
    const syncState = syncById.get(stablecoinId) ?? null;
    const compositionRow = compositionById.get(stablecoinId);
    if (!compositionRow || !hasConsistentSnapshotState(syncState, {
      fetchedAt: compositionRow.fetched_at,
      attemptId: compositionRow.attempt_id ?? null,
    })) {
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) continue;
    records.set(stablecoinId, buildReserveSnapshotMetadataRecord(stablecoinId, parsed.record, syncState));
  }

  return records;
}

export async function getLatestSuccessfulReserveSnapshotMetadata(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSnapshotMetadataRecord | null> {
  const records = await loadReserveSnapshotMetadataMap(db, [stablecoinId]);
  return records.get(stablecoinId) ?? null;
}

function buildSyncView(
  syncState: ReserveSyncStateRecord | null,
  stale: boolean,
  overrides: {
    enabled: boolean;
    defaultStatus: ReserveSyncStatus;
    bootstrap: boolean;
    statusOverride?: ReserveSyncStatus;
    extraWarnings?: string[];
    lastErrorOverride?: string | null;
  },
): ReserveSyncStateView {
  const warningMessages = [
    ...(syncState?.warnings.map((warning) => warning.message) ?? []),
    ...(overrides.extraWarnings ?? []),
  ];
  const lastError = overrides.lastErrorOverride ?? syncState?.lastError ?? null;
  return {
    enabled: overrides.enabled,
    status: overrides.statusOverride ?? syncState?.lastStatus ?? overrides.defaultStatus,
    stale,
    bootstrap: overrides.bootstrap,
    ...(syncState?.lastAttemptedAt != null ? { lastAttemptedAt: syncState.lastAttemptedAt } : {}),
    ...(syncState?.lastSuccessAt != null ? { lastSuccessAt: syncState.lastSuccessAt } : {}),
    ...(warningMessages.length > 0 ? { warnings: warningMessages } : {}),
    ...(lastError ? { lastError: lastError.slice(0, 200) } : {}),
  };
}

function describeSnapshotIssue(issue: SnapshotIntegrityIssue): string {
  switch (issue.code) {
    case "invalid-json":
    case "invalid-payload":
      return "Stored live reserve snapshot is unreadable";
    case "empty-slices":
      return "Stored live reserve snapshot is empty";
    case "invalid-slice":
      return "Stored live reserve snapshot contains invalid slices";
    case "invalid-sum":
      return issue.message;
    default:
      return "Stored live reserve snapshot is invalid";
  }
}

export async function resolveReserveResult(
  db: D1Database,
  stablecoinId: string,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveResult | null> {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;

  const [compositionRow, syncState] = await Promise.all([
    getReserveCompositionRow(db, stablecoinId),
    getReserveSyncState(db, stablecoinId),
  ]);

  const displayUrl = meta.liveReservesConfig?.display?.url;
  const staticFallback = getReserves(meta);
  const consistentSnapshot = compositionRow && hasConsistentSnapshotState(syncState, {
    fetchedAt: compositionRow.fetched_at,
    attemptId: compositionRow.attempt_id ?? null,
  })
    ? parseReserveCompositionRow(compositionRow, syncState)
    : { record: null, issue: null };
  const liveSnapshot = consistentSnapshot.record;
  const liveAtCandidate = liveSnapshot?.fetchedAt
    ?? (
      compositionRow && hasConsistentSnapshotState(syncState, {
        fetchedAt: compositionRow.fetched_at,
        attemptId: compositionRow.attempt_id ?? null,
      })
        ? compositionRow.fetched_at
        : syncState?.lastSuccessAt ?? null
    );
  const stale = !!(liveAtCandidate && now - liveAtCandidate > freshnessSec);

  if (liveSnapshot) {
    const provenance = buildReserveProvenanceView(liveSnapshot, syncState, stale);
    return {
      reserves: liveSnapshot.slices,
      estimated: false,
      mode: stale ? "live-stale" : "live",
      liveAt: liveSnapshot.fetchedAt,
      source: liveSnapshot.source,
      displayUrl,
      provenance,
      sync: buildSyncView(syncState, stale, {
        enabled: !!meta.liveReservesConfig,
        defaultStatus: "ok",
        bootstrap: false,
      }),
    };
  }

  const snapshotIntegrityWarning = consistentSnapshot.issue ? describeSnapshotIssue(consistentSnapshot.issue) : null;
  const statusOverride = snapshotIntegrityWarning
    ? (syncState?.lastStatus === "error" ? "error" : "degraded")
    : undefined;
  const lastErrorOverride = snapshotIntegrityWarning
    ? `Stored live reserve snapshot rejected: ${snapshotIntegrityWarning}`
    : null;

  if (staticFallback) {
    return {
      ...staticFallback,
      displayUrl,
      sync: meta.liveReservesConfig
        ? buildSyncView(syncState, stale, {
            enabled: true,
            defaultStatus: "skipped",
            bootstrap: !syncState?.lastSuccessAt,
            statusOverride,
            extraWarnings: snapshotIntegrityWarning ? [snapshotIntegrityWarning] : undefined,
            lastErrorOverride,
          })
        : undefined,
    };
  }

  return meta.liveReservesConfig
    ? {
        reserves: [],
        estimated: false,
        mode: "unavailable",
        displayUrl,
        sync: buildSyncView(syncState, stale, {
          enabled: true,
          defaultStatus: "skipped",
          bootstrap: !syncState?.lastSuccessAt,
          statusOverride,
          extraWarnings: snapshotIntegrityWarning ? [snapshotIntegrityWarning] : undefined,
          lastErrorOverride,
        }),
      }
    : null;
}
