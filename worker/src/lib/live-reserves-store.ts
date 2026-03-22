import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import {
  getLiveReserveAdapterDefinition,
  type LiveReserveEvidenceClass,
  type LiveReserveSourceModel,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { LiveReserveWarning, ReserveSlice, ReserveSyncStateView, StablecoinMeta } from "@shared/types";
import { buildInClause } from "./db";
import { chunkArray } from "./collections";
import { decodeJsonString } from "./cache-json";

export const LIVE_RESERVE_FRESHNESS_SEC = 2 * 86400;
const SCORING_LIVE_RESERVE_EVIDENCE_CLASSES: LiveReserveEvidenceClass[] = ["independent"];

export type ReserveSyncStatus = "ok" | "degraded" | "error" | "skipped";

interface ReserveCompositionRow {
  stablecoin_id: string;
  slices: string;
  fetched_at: number;
  source: string;
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

export interface ReserveCompositionRecord {
  stablecoinId: string;
  slices: ReserveSlice[];
  fetchedAt: number;
  source: string;
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
  metadata: Record<string, unknown>;
}

export interface ReserveCompositionOverview {
  configuredCoins: number;
  freshCoins: number;
  staleCoins: number;
  missingCoins: number;
  degradedCoins: number;
  errorCoins: number;
  lastSuccessAt: number | null;
  oldestFreshAgeSec: number | null;
}

export interface AuthoritativeReserveSnapshot {
  stablecoinId: string;
  slices: ReserveSlice[];
  fetchedAt: number;
  source: string;
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

function parseWarnings(value: string | null): LiveReserveWarning[] {
  if (!value) return [];
  const decoded = decodeJsonString<LiveReserveWarning[], "json-parse-failed">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => ({
      ok: true,
      payload: Array.isArray(parsed)
        ? parsed.filter((item): item is LiveReserveWarning =>
          !!item
          && typeof item === "object"
          && typeof (item as LiveReserveWarning).code === "string"
          && typeof (item as LiveReserveWarning).message === "string"
          && ((item as LiveReserveWarning).severity === "info" || (item as LiveReserveWarning).severity === "warning"),
        )
        : [],
    }),
  });
  return decoded.payload ?? [];
}

const VALID_RISKS = new Set(["very-low", "low", "medium", "high", "very-high"]);

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

function parseSlices(value: string): ReserveSlice[] {
  const decoded = decodeJsonString<ReserveSlice[], "json-parse-failed">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => ({
      ok: true,
      payload: Array.isArray(parsed) ? parsed.filter(isValidSlice) : [],
    }),
  });
  return decoded.payload ?? [];
}

export function getConfiguredLiveReserveCoins(): StablecoinMeta[] {
  return ACTIVE_STABLECOINS.filter((coin) => !!coin.liveReservesConfig);
}

function buildReserveCompositionUpsertStatement(
  db: D1Database,
  record: ReserveCompositionRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         slices = excluded.slices,
         fetched_at = excluded.fetched_at,
         source = excluded.source`,
    )
    .bind(record.stablecoinId, JSON.stringify(record.slices), record.fetchedAt, record.source);
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

export async function upsertReserveComposition(
  db: D1Database,
  record: ReserveCompositionRecord,
): Promise<void> {
  await buildReserveCompositionUpsertStatement(db, record).run();
}

export async function upsertReserveSyncState(
  db: D1Database,
  record: ReserveSyncStateRecord,
): Promise<void> {
  await buildReserveSyncStateUpsertStatement(db, record).run();
}

export async function upsertReserveSnapshot(
  db: D1Database,
  composition: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord,
): Promise<void> {
  await db.batch([
    buildReserveCompositionUpsertStatement(db, composition),
    buildReserveSyncStateUpsertStatement(db, syncState),
  ]);
}

export async function getReserveComposition(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveCompositionRecord | null> {
  const row = await db
    .prepare("SELECT stablecoin_id, slices, fetched_at, source FROM reserve_composition WHERE stablecoin_id = ?")
    .bind(stablecoinId)
    .first<ReserveCompositionRow>();

  if (!row) return null;

  return {
    stablecoinId: row.stablecoin_id,
    slices: parseSlices(row.slices),
    fetchedAt: row.fetched_at,
    source: row.source,
  };
}

export async function getReserveSyncState(
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

  return toReserveSyncStateRecord(row);
}

function toReserveSyncStateRecord(
  row: ReserveSyncStateRow,
): ReserveSyncStateRecord {
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
    metadata: parseJsonObject(row.metadata),
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
      result.set(row.stablecoin_id, toReserveSyncStateRecord(row));
    }
  }

  return result;
}

async function loadReserveCompositionMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveCompositionRecord>> {
  if (stablecoinIds.length === 0) return new Map();

  const BATCH_SIZE = 50;
  const result = new Map<string, ReserveCompositionRecord>();

  for (const batch of chunkArray(stablecoinIds, BATCH_SIZE)) {
    const inClause = buildInClause(batch);
    const rows = await db
      .prepare(
        `SELECT stablecoin_id, slices, fetched_at, source
           FROM reserve_composition
          WHERE stablecoin_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ReserveCompositionRow>();

    for (const row of rows.results ?? []) {
      result.set(row.stablecoin_id, {
        stablecoinId: row.stablecoin_id,
        slices: parseSlices(row.slices),
        fetchedAt: row.fetched_at,
        source: row.source,
      });
    }
  }

  return result;
}

function hasConsistentSnapshotRow(
  sync: ReserveSyncStateRow | undefined,
  composition: ReserveCompositionRow | undefined,
): boolean {
  return !!sync
    && !!composition
    && typeof sync.last_success_at === "number"
    && sync.last_success_at > 0
    && sync.last_success_at === composition.fetched_at;
}

function hasConsistentSnapshotRecord(
  sync: ReserveSyncStateRecord | null,
  composition: ReserveCompositionRecord | null,
): composition is ReserveCompositionRecord {
  return !!composition
    && composition.slices.length > 0
    && typeof sync?.lastSuccessAt === "number"
    && sync.lastSuccessAt > 0
    && sync.lastSuccessAt === composition.fetchedAt;
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
      lastSuccessAt: null,
      oldestFreshAgeSec: null,
    };
  }

  const BATCH_SIZE = 50;
  const coinIds = configuredCoins.map((coin) => coin.id);
  const syncById = new Map<string, ReserveSyncStateRow>();
  const compositionById = new Map<string, ReserveCompositionRow>();

  for (const batch of chunkArray(coinIds, BATCH_SIZE)) {
    const idClause = buildInClause(batch);
    const [syncRowsResult, compositionRowsResult] = await Promise.all([
      db
        .prepare(
          `SELECT stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
                  last_status, warning_count, warnings, last_error, metadata
             FROM reserve_sync_state
            WHERE stablecoin_id IN (${idClause.sql})`,
        )
        .bind(...idClause.binds)
        .all<ReserveSyncStateRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, slices, fetched_at, source
             FROM reserve_composition
            WHERE stablecoin_id IN (${idClause.sql})`,
        )
        .bind(...idClause.binds)
        .all<ReserveCompositionRow>(),
    ]);

    for (const row of syncRowsResult.results ?? []) syncById.set(row.stablecoin_id, row);
    for (const row of compositionRowsResult.results ?? []) compositionById.set(row.stablecoin_id, row);
  }

  let freshCoins = 0;
  let staleCoins = 0;
  let missingCoins = 0;
  let degradedCoins = 0;
  let errorCoins = 0;
  let lastSuccessAt: number | null = null;
  let oldestFreshAgeSec: number | null = null;

  for (const coin of configuredCoins) {
    const sync = syncById.get(coin.id);
    const composition = compositionById.get(coin.id);
    const hasSnapshot = hasConsistentSnapshotRow(sync, composition);
    const successAt = hasSnapshot ? sync!.last_success_at : null;

    if (!hasSnapshot) {
      if (sync?.last_status === "error") {
        errorCoins++;
        continue;
      }
      missingCoins++;
      continue;
    }

    if (!successAt || !composition) {
      missingCoins++;
      continue;
    }

    const ageSec = Math.max(0, now - successAt);
    lastSuccessAt = lastSuccessAt == null ? successAt : Math.max(lastSuccessAt, successAt);

    if (ageSec > freshnessSec) {
      staleCoins++;
      continue;
    }

    if (sync && sync.last_status === "error") {
      errorCoins++;
      continue;
    }

    if (sync && (sync.last_status !== "ok" || (sync.last_success_at != null && !hasSnapshot))) {
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
    lastSuccessAt,
    oldestFreshAgeSec,
  };
}

/**
 * Returns the age in seconds of the most recent successful sync across all live-enabled coins.
 * Used to detect missed cron runs: if maxAge > 6 hours, the cron scheduler may be down.
 */
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
    loadReserveCompositionMap(db, coinIds),
  ]);
  const allowedSourceModels = options?.sourceModels ? new Set(options.sourceModels) : null;
  const allowedEvidenceClasses = options?.evidenceClasses ? new Set(options.evidenceClasses) : null;
  const minSlices = options?.minSlices ?? 1;
  const snapshots = new Map<string, AuthoritativeReserveSnapshot>();

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const composition = compositionById.get(coin.id) ?? null;
    const authoritativeSnapshot = hasConsistentSnapshotRecord(syncState, composition)
      ? composition
      : null;
    if (!authoritativeSnapshot) continue;
    if (options?.requireOkStatus && syncState?.lastStatus !== "ok") continue;
    if (now - authoritativeSnapshot.fetchedAt > freshnessSec) continue;
    if (authoritativeSnapshot.slices.length < minSlices) continue;

    const { sourceModel, evidenceClass } = getLiveReserveAdapterDefinition(coin.liveReservesConfig!.adapter);
    if (allowedSourceModels && !allowedSourceModels.has(sourceModel)) {
      continue;
    }
    if (allowedEvidenceClasses && !allowedEvidenceClasses.has(evidenceClass)) {
      continue;
    }

    snapshots.set(coin.id, {
      stablecoinId: coin.id,
      slices: authoritativeSnapshot.slices,
      fetchedAt: authoritativeSnapshot.fetchedAt,
      source: authoritativeSnapshot.source,
      sourceModel,
      evidenceClass,
    });
  }

  return snapshots;
}

/**
 * Load all fresh, authoritative reserve snapshots as a Map<stablecoinId, ReserveSlice[]>.
 * This uses the same sync-state consistency contract as the detail-page API.
 */
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

function buildSyncView(
  syncState: ReserveSyncStateRecord | null,
  stale: boolean,
  overrides: { enabled: boolean; defaultStatus: ReserveSyncStatus; bootstrap: boolean },
): ReserveSyncStateView {
  const warningMessages = syncState?.warnings.map((w) => w.message);
  return {
    enabled: overrides.enabled,
    status: syncState?.lastStatus ?? overrides.defaultStatus,
    stale,
    bootstrap: overrides.bootstrap,
    ...(syncState?.lastAttemptedAt != null ? { lastAttemptedAt: syncState.lastAttemptedAt } : {}),
    ...(syncState?.lastSuccessAt != null ? { lastSuccessAt: syncState.lastSuccessAt } : {}),
    ...(warningMessages && warningMessages.length > 0 ? { warnings: warningMessages } : {}),
    ...(syncState?.lastError ? { lastError: syncState.lastError.slice(0, 200) } : {}),
  };
}

export async function resolveReserveResult(
  db: D1Database,
  stablecoinId: string,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveResult | null> {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;

  const [composition, syncState] = await Promise.all([
    getReserveComposition(db, stablecoinId),
    getReserveSyncState(db, stablecoinId),
  ]);

  const displayUrl = meta.liveReservesConfig?.display?.url;
  const staticFallback = getReserves(meta);
  const liveSnapshot = hasConsistentSnapshotRecord(syncState, composition) ? composition : null;
  const liveAt = liveSnapshot?.fetchedAt ?? null;
  const stale = !!(liveAt && now - liveAt > freshnessSec);

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

  if (staticFallback) {
    return {
      ...staticFallback,
      displayUrl,
      sync: meta.liveReservesConfig
        ? buildSyncView(syncState, stale, {
            enabled: true,
            defaultStatus: "skipped",
            bootstrap: !syncState?.lastSuccessAt,
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
        }),
      }
    : null;
}
