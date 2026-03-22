import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import {
  getLiveReserveAdapterDefinition,
  type LiveReserveAdapterKey,
  type LiveReserveEvidenceClass,
  type LiveReserveSourceModel,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type {
  LiveReserveFreshnessMode,
  LiveReserveSnapshotMetadata,
  LiveReserveWarning,
  ReserveSlice,
  ReserveSyncStateView,
  StablecoinMeta,
} from "@shared/types";
import { buildInClause } from "./db";
import { chunkArray } from "./collections";
import { decodeJsonString } from "./cache-json";

export const LIVE_RESERVE_FRESHNESS_SEC = 2 * 86400;
const SCORING_LIVE_RESERVE_EVIDENCE_CLASSES: LiveReserveEvidenceClass[] = ["independent"];
const VALID_RISKS = new Set(["very-low", "low", "medium", "high", "very-high"]);
const VALID_SOURCE_MODELS = new Set<LiveReserveSourceModel>(["dynamic-mix", "validated-static", "single-bucket"]);
const VALID_EVIDENCE_CLASSES = new Set<LiveReserveEvidenceClass>(["independent", "static-validated", "weak-live-probe"]);
const VALID_WARNING_EFFECTS = new Set(["info", "degraded", "fatal"]);
const VALID_FRESHNESS_MODES = new Set<LiveReserveFreshnessMode>(["verified", "unverified", "not-applicable"]);
const STORED_SLICE_SUM_TOLERANCE = 2;

export type ReserveSyncStatus = "ok" | "degraded" | "error" | "skipped";

interface ReserveCompositionRow {
  stablecoin_id: string;
  slices: string;
  fetched_at: number;
  source: string;
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
}

interface SnapshotIntegrityIssue {
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
}

export interface ReserveCompositionOverview {
  configuredCoins: number;
  freshCoins: number;
  staleCoins: number;
  missingCoins: number;
  degradedCoins: number;
  errorCoins: number;
  corruptCoins: number;
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
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const decoded = decodeJsonString<Record<string, unknown>, "json-parse-failed" | "invalid-payload">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => (
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ok: true, payload: parsed as Record<string, unknown> }
        : { ok: false, reason: "invalid-payload" }
    ),
  });
  return decoded.payload ?? {};
}

function coerceFiniteMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSnapshotMetadata(metadata: Record<string, unknown>): LiveReserveSnapshotMetadata {
  const normalized: LiveReserveSnapshotMetadata = { ...metadata };
  const knownNumberKeys: Array<keyof LiveReserveSnapshotMetadata> = [
    "sourceTimestamp",
    "unknownExposurePct",
    "supplyUsd",
    "totalReserveUsd",
    "immediateRedeemableUsd",
    "immediateRedeemableRatio",
    "redemptionFeeBps",
    "buyFeeBpsMin",
    "buyFeeBpsMax",
  ];

  for (const key of knownNumberKeys) {
    const value = coerceFiniteMetadataNumber(metadata[key]);
    if (value == null) {
      delete normalized[key];
    } else {
      normalized[key] = value;
    }
  }

  const freshnessMode = metadata.freshnessMode;
  if (typeof freshnessMode === "string" && VALID_FRESHNESS_MODES.has(freshnessMode as LiveReserveFreshnessMode)) {
    normalized.freshnessMode = freshnessMode as LiveReserveFreshnessMode;
  } else {
    delete normalized.freshnessMode;
  }

  if (metadata.details && typeof metadata.details === "object" && !Array.isArray(metadata.details)) {
    normalized.details = metadata.details as Record<string, unknown>;
  } else {
    delete normalized.details;
  }

  return normalized;
}

function parseSnapshotMetadata(value: string | null | undefined): LiveReserveSnapshotMetadata {
  return normalizeSnapshotMetadata(parseJsonObject(value));
}

function parseWarnings(value: string | null): LiveReserveWarning[] {
  if (!value) return [];
  const decoded = decodeJsonString<LiveReserveWarning[], "json-parse-failed">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => ({
      ok: true,
      payload: Array.isArray(parsed)
        ? parsed.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const code = typeof item.code === "string" ? item.code : null;
          const message = typeof item.message === "string" ? item.message : null;
          if (!code || !message) return [];
          const severity = item.severity === "info" ? "info" : "warning";
          const effect = typeof item.effect === "string" && VALID_WARNING_EFFECTS.has(item.effect)
            ? item.effect as LiveReserveWarning["effect"]
            : severity === "info"
              ? "info"
              : "degraded";
          return [{ code, message, severity, effect }];
        })
        : [],
    }),
  });
  return decoded.payload ?? [];
}

function isValidSlice(item: unknown): item is ReserveSlice {
  if (!item || typeof item !== "object") return false;
  const slice = item as Partial<ReserveSlice>;
  return (
    typeof slice.name === "string"
    && slice.name.length > 0
    && typeof slice.pct === "number"
    && Number.isFinite(slice.pct)
    && slice.pct > 0
    && typeof slice.risk === "string"
    && VALID_RISKS.has(slice.risk)
  );
}

function parseSlicesStrict(value: string): { slices: ReserveSlice[] } | { issue: SnapshotIntegrityIssue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      issue: {
        code: "invalid-json",
        message: "stored reserve snapshot JSON could not be parsed",
      },
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      issue: {
        code: "invalid-payload",
        message: "stored reserve snapshot is not a slice array",
      },
    };
  }

  if (parsed.length === 0) {
    return {
      issue: {
        code: "empty-slices",
        message: "stored reserve snapshot contains zero slices",
      },
    };
  }

  const slices: ReserveSlice[] = [];
  for (const item of parsed) {
    if (!isValidSlice(item)) {
      return {
        issue: {
          code: "invalid-slice",
          message: "stored reserve snapshot contains invalid slice entries",
        },
      };
    }
    slices.push(item);
  }

  const sum = slices.reduce((acc, slice) => acc + slice.pct, 0);
  if (Math.abs(sum - 100) > STORED_SLICE_SUM_TOLERANCE) {
    return {
      issue: {
        code: "invalid-sum",
        message: `stored reserve snapshot percentages sum to ${sum.toFixed(1)}%`,
      },
    };
  }

  return { slices };
}

function hasConsistentSnapshotState(
  syncState: Pick<ReserveSyncStateRecord, "lastSuccessAt"> | null | undefined,
  fetchedAt: number | null | undefined,
): boolean {
  return typeof syncState?.lastSuccessAt === "number"
    && syncState.lastSuccessAt > 0
    && typeof fetchedAt === "number"
    && fetchedAt > 0
    && syncState.lastSuccessAt === fetchedAt;
}

function canUseLegacySnapshotFallback(
  syncState: ReserveSyncStateRecord | null,
  fetchedAt: number | null | undefined,
): boolean {
  return hasConsistentSnapshotState(syncState, fetchedAt)
    && typeof syncState?.lastAttemptedAt === "number"
    && syncState.lastAttemptedAt === syncState.lastSuccessAt
    && syncState.lastStatus !== "error"
    && syncState.lastStatus !== "skipped";
}

function isEmptyMetadata(metadata: LiveReserveSnapshotMetadata): boolean {
  return Object.keys(metadata).length === 0;
}

function resolveSnapshotSourceModel(
  row: ReserveCompositionRow,
  fallbackAdapterKey: string,
): LiveReserveSourceModel {
  if (row.adapter_source_model && VALID_SOURCE_MODELS.has(row.adapter_source_model as LiveReserveSourceModel)) {
    return row.adapter_source_model as LiveReserveSourceModel;
  }
  return getLiveReserveAdapterDefinition(fallbackAdapterKey as LiveReserveAdapterKey).sourceModel;
}

function resolveSnapshotEvidenceClass(
  row: ReserveCompositionRow,
  fallbackAdapterKey: string,
): LiveReserveEvidenceClass {
  if (row.adapter_evidence_class && VALID_EVIDENCE_CLASSES.has(row.adapter_evidence_class as LiveReserveEvidenceClass)) {
    return row.adapter_evidence_class as LiveReserveEvidenceClass;
  }
  return getLiveReserveAdapterDefinition(fallbackAdapterKey as LiveReserveAdapterKey).evidenceClass;
}

function parseReserveCompositionRow(
  row: ReserveCompositionRow,
  syncState: ReserveSyncStateRecord | null,
): { record: ReserveCompositionRecord | null; issue: SnapshotIntegrityIssue | null } {
  const parsedSlices = parseSlicesStrict(row.slices);
  if ("issue" in parsedSlices) {
    return { record: null, issue: parsedSlices.issue };
  }

  const fallbackAdapterKey = syncState?.adapterKey
    ?? TRACKED_META_BY_ID.get(row.stablecoin_id)?.liveReservesConfig?.adapter
    ?? row.source;
  const metadata = parseSnapshotMetadata(row.metadata);
  const warnings = parseWarnings(row.warnings ?? null);
  const legacyMetadata = canUseLegacySnapshotFallback(syncState, row.fetched_at)
    ? normalizeSnapshotMetadata(syncState?.metadata ?? {})
    : {};
  const finalMetadata = isEmptyMetadata(metadata) && !isEmptyMetadata(legacyMetadata) ? legacyMetadata : metadata;
  const finalWarnings = warnings.length === 0 && canUseLegacySnapshotFallback(syncState, row.fetched_at)
    ? syncState?.warnings ?? []
    : warnings;
  const warningCount = typeof row.warning_count === "number" && Number.isFinite(row.warning_count)
    ? row.warning_count
    : finalWarnings.length;

  return {
    record: {
      stablecoinId: row.stablecoin_id,
      slices: parsedSlices.slices,
      fetchedAt: row.fetched_at,
      source: row.source,
      metadata: finalMetadata,
      warningCount,
      warnings: finalWarnings,
      adapterSourceModel: resolveSnapshotSourceModel(row, fallbackAdapterKey),
      adapterEvidenceClass: resolveSnapshotEvidenceClass(row, fallbackAdapterKey),
    },
    issue: null,
  };
}

function buildReserveCompositionUpsertStatement(
  db: D1Database,
  record: ReserveCompositionRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_composition (
         stablecoin_id,
         slices,
         fetched_at,
         source,
         metadata,
         warning_count,
         warnings,
         adapter_source_model,
         adapter_evidence_class
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         slices = excluded.slices,
         fetched_at = excluded.fetched_at,
         source = excluded.source,
         metadata = excluded.metadata,
         warning_count = excluded.warning_count,
         warnings = excluded.warnings,
         adapter_source_model = excluded.adapter_source_model,
         adapter_evidence_class = excluded.adapter_evidence_class`,
    )
    .bind(
      record.stablecoinId,
      JSON.stringify(record.slices),
      record.fetchedAt,
      record.source,
      JSON.stringify(record.metadata),
      record.warningCount,
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.adapterSourceModel,
      record.adapterEvidenceClass,
    );
}

function buildReserveCompositionHistoryInsertStatement(
  db: D1Database,
  record: ReserveCompositionRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_composition_history (
         stablecoin_id,
         fetched_at,
         adapter_key,
         slices,
         metadata,
         warnings,
         warning_count,
         adapter_source_model,
         adapter_evidence_class
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.stablecoinId,
      record.fetchedAt,
      record.source,
      JSON.stringify(record.slices),
      JSON.stringify(record.metadata),
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.warningCount,
      record.adapterSourceModel,
      record.adapterEvidenceClass,
    );
}

function buildReserveSyncStateUpsertStatement(
  db: D1Database,
  record: ReserveSyncStateRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_sync_state (
         stablecoin_id,
         adapter_key,
         breaker_key,
         last_attempted_at,
         last_success_at,
         last_status,
         warning_count,
         warnings,
         last_error,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         adapter_key = excluded.adapter_key,
         breaker_key = excluded.breaker_key,
         last_attempted_at = excluded.last_attempted_at,
         last_success_at = excluded.last_success_at,
         last_status = excluded.last_status,
         warning_count = excluded.warning_count,
         warnings = excluded.warnings,
         last_error = excluded.last_error,
         metadata = excluded.metadata`,
    )
    .bind(
      record.stablecoinId,
      record.adapterKey,
      record.breakerKey,
      record.lastAttemptedAt,
      record.lastSuccessAt,
      record.lastStatus,
      record.warningCount,
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.lastError,
      JSON.stringify(record.metadata),
    );
}

function buildReserveSyncAttemptHistoryInsertStatement(
  db: D1Database,
  record: ReserveSyncAttemptHistoryRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_sync_attempt_history (
         stablecoin_id,
         attempted_at,
         adapter_key,
         breaker_key,
         status,
         warnings,
         warning_count,
         last_error,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.stablecoinId,
      record.attemptedAt,
      record.adapterKey,
      record.breakerKey,
      record.status,
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.warningCount,
      record.lastError,
      JSON.stringify(record.metadata),
    );
}

export function getConfiguredLiveReserveCoins(): StablecoinMeta[] {
  return ACTIVE_STABLECOINS.filter((coin) => !!coin.liveReservesConfig);
}

export async function upsertReserveComposition(
  db: D1Database,
  record: ReserveCompositionRecord,
): Promise<void> {
  await buildReserveCompositionUpsertStatement(db, record).run();
}

export async function recordReserveSyncAttempt(
  db: D1Database,
  syncState: ReserveSyncStateRecord,
): Promise<void> {
  await db.batch([
    buildReserveSyncStateUpsertStatement(db, syncState),
    buildReserveSyncAttemptHistoryInsertStatement(db, {
      stablecoinId: syncState.stablecoinId,
      attemptedAt: syncState.lastAttemptedAt ?? Math.floor(Date.now() / 1000),
      adapterKey: syncState.adapterKey,
      breakerKey: syncState.breakerKey,
      status: syncState.lastStatus,
      warningCount: syncState.warningCount,
      warnings: syncState.warnings,
      lastError: syncState.lastError,
      metadata: syncState.metadata,
    }),
  ]);
}

export async function upsertReserveSnapshot(
  db: D1Database,
  composition: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord,
): Promise<void> {
  await db.batch([
    buildReserveCompositionUpsertStatement(db, composition),
    buildReserveSyncStateUpsertStatement(db, syncState),
    buildReserveCompositionHistoryInsertStatement(db, composition),
    buildReserveSyncAttemptHistoryInsertStatement(db, {
      stablecoinId: syncState.stablecoinId,
      attemptedAt: syncState.lastAttemptedAt ?? composition.fetchedAt,
      adapterKey: syncState.adapterKey,
      breakerKey: syncState.breakerKey,
      status: syncState.lastStatus,
      warningCount: syncState.warningCount,
      warnings: syncState.warnings,
      lastError: syncState.lastError,
      metadata: syncState.metadata,
    }),
  ]);
}

async function getReserveCompositionRow(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveCompositionRow | null> {
  return db
    .prepare(
      `SELECT stablecoin_id, slices, fetched_at, source, metadata, warning_count, warnings,
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

async function getReserveSyncState(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSyncStateRecord | null> {
  const row = await db
    .prepare(
      `SELECT stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
              last_status, warning_count, warnings, last_error, metadata
         FROM reserve_sync_state
        WHERE stablecoin_id = ?`,
    )
    .bind(stablecoinId)
    .first<ReserveSyncStateRow>();

  if (!row) return null;

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
  };
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
        `SELECT stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
                last_status, warning_count, warnings, last_error, metadata
           FROM reserve_sync_state
          WHERE stablecoin_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ReserveSyncStateRow>();

    for (const row of rows.results ?? []) {
      result.set(row.stablecoin_id, {
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
      });
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
        `SELECT stablecoin_id, slices, fetched_at, source, metadata, warning_count, warnings,
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
  let lastSuccessAt: number | null = null;
  let oldestFreshAgeSec: number | null = null;

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const compositionRow = compositionById.get(coin.id);
    const hasSnapshot = hasConsistentSnapshotState(syncState, compositionRow?.fetched_at);

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

    if (ageSec > freshnessSec) {
      staleCoins++;
      continue;
    }

    if (syncState?.lastStatus === "error") {
      errorCoins++;
      continue;
    }

    if (syncState && syncState.lastStatus !== "ok") {
      degradedCoins++;
      continue;
    }

    freshCoins++;
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
    if (!compositionRow || !hasConsistentSnapshotState(syncState, compositionRow.fetched_at)) {
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

async function loadFreshLiveReserveMap(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  options?: {
    minSlices?: number;
    sourceModels?: readonly LiveReserveSourceModel[];
    evidenceClasses?: readonly LiveReserveEvidenceClass[];
    requireOkStatus?: boolean;
  },
): Promise<Map<string, ReserveSlice[]>> {
  const snapshots = await loadFreshAuthoritativeReserveSnapshots(db, now, freshnessSec, options);
  return new Map(Array.from(snapshots.entries()).map(([coinId, snapshot]) => [coinId, snapshot.slices]));
}

export async function loadFreshIndependentLiveReserveMap(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 1,
): Promise<Map<string, ReserveSlice[]>> {
  return loadFreshLiveReserveMap(db, now, freshnessSec, {
    minSlices,
    evidenceClasses: SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
    requireOkStatus: true,
  });
}

export async function getLatestSuccessfulReserveSnapshotMetadata(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSnapshotMetadataRecord | null> {
  const [compositionRow, syncState] = await Promise.all([
    getReserveCompositionRow(db, stablecoinId),
    getReserveSyncState(db, stablecoinId),
  ]);

  if (!compositionRow || !hasConsistentSnapshotState(syncState, compositionRow.fetched_at)) {
    return null;
  }

  const parsed = parseReserveCompositionRow(compositionRow, syncState);
  if (!parsed.record) return null;

  return {
    stablecoinId,
    fetchedAt: parsed.record.fetchedAt,
    source: parsed.record.source,
    metadata: parsed.record.metadata,
    warningCount: parsed.record.warningCount,
    warnings: parsed.record.warnings,
    sourceModel: parsed.record.adapterSourceModel,
    evidenceClass: parsed.record.adapterEvidenceClass,
  };
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
  const consistentSnapshot = compositionRow && hasConsistentSnapshotState(syncState, compositionRow.fetched_at)
    ? parseReserveCompositionRow(compositionRow, syncState)
    : { record: null, issue: null };
  const liveSnapshot = consistentSnapshot.record;
  const liveAtCandidate = liveSnapshot?.fetchedAt
    ?? (compositionRow && hasConsistentSnapshotState(syncState, compositionRow.fetched_at) ? compositionRow.fetched_at : syncState?.lastSuccessAt ?? null);
  const stale = !!(liveAtCandidate && now - liveAtCandidate > freshnessSec);

  if (liveSnapshot) {
    return {
      reserves: liveSnapshot.slices,
      estimated: false,
      mode: stale ? "live-stale" : "live",
      liveAt: liveSnapshot.fetchedAt,
      source: liveSnapshot.source,
      displayUrl,
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
