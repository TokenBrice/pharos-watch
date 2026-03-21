import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { LiveReserveWarning, ReserveSlice, ReserveSyncStateView, StablecoinMeta } from "@shared/types";
import { buildInClause } from "./db";
import { chunkArray } from "./collections";
import { decodeJsonString } from "./cache-json";

export const LIVE_RESERVE_FRESHNESS_SEC = 2 * 86400;

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

  const idClause = buildInClause(configuredCoins.map((coin) => coin.id));
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

  const syncById = new Map(
    (syncRowsResult.results ?? []).map((row) => [row.stablecoin_id, row]),
  );
  const compositionById = new Map(
    (compositionRowsResult.results ?? []).map((row) => [row.stablecoin_id, row]),
  );

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
 * Load all fresh live reserve snapshots as a Map<stablecoinId, ReserveSlice[]>.
 * Only includes snapshots with ≥2 slices that are fresher than `freshnessSec`.
 */
export async function loadFreshLiveReserveMap(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 2,
): Promise<Map<string, ReserveSlice[]>> {
  const cutoff = now - freshnessSec;
  const rows = await db
    .prepare(
      "SELECT stablecoin_id, slices FROM reserve_composition WHERE fetched_at > ?",
    )
    .bind(cutoff)
    .all<{ stablecoin_id: string; slices: string }>();

  const map = new Map<string, ReserveSlice[]>();
  for (const row of rows.results) {
    try {
      const raw: unknown[] = JSON.parse(row.slices);
      const slices = raw.filter(isValidSlice);
      if (slices.length >= minSlices) {
        map.set(row.stablecoin_id, slices);
      }
    } catch {
      console.warn(`[live-reserves-store] Skipping malformed slices JSON for ${row.stablecoin_id}`);
    }
  }
  return map;
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
