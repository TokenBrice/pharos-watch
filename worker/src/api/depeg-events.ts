import { type DepegRow } from "../lib/depeg-helpers";
import {
  withErrorHandler,
  resolveOrReject,
  buildMethodologyEnvelope,
  buildPaginatedEventResponse,
  parseBooleanParam,
} from "../lib/api-utils";
import { CACHE_PROFILES, DEPEG_PENDING_EXPIRY_SEC, DEX_FRESHNESS_SEC } from "../lib/constants";
import {
  normalizePendingDepegRow,
  SELECT_PENDING_DEPEGS_SQL,
  type PendingDepegRow,
} from "../lib/depeg-pending";
import { isMissingTableError } from "../lib/db";
import {
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  loadActiveIncidentProjections,
  rowToPublicDepegEvent,
} from "../lib/depeg-event-projection";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
} from "@shared/lib/depeg-dews-version";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-version";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { DepegPendingIncident } from "@shared/types/market";
import { toErrorMessage } from "../lib/error-utils";
import { logWorkerEvent } from "../lib/structured-log";

type ConfirmationCategory = "offchain" | "dex" | "pool";

interface DexAvailabilityRow {
  stablecoin_id: string;
  source_pool_count: number | null;
  source_total_tvl: number | null;
  updated_at: number | null;
}

interface PoolAvailabilityRow {
  stablecoin_id: string;
  snapshot_at: number | null;
  has_rows: number | null;
}

function isFreshTimestamp(timestamp: number | null | undefined, nowSec: number, maxAgeSec: number): boolean {
  return typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp > 0 &&
    timestamp <= nowSec &&
    nowSec - timestamp <= maxAgeSec;
}

async function loadDexAvailability(
  db: D1Database,
  stablecoinId: string | null,
  nowSec: number,
): Promise<Map<string, boolean>> {
  try {
    const where = stablecoinId ? " WHERE stablecoin_id = ?" : "";
    const stmt = db
      .prepare(
        `SELECT /* pharos:depeg-events:dex-availability */
           stablecoin_id, source_pool_count, source_total_tvl, updated_at FROM dex_prices${where}`,
      );
    const result = stablecoinId
      ? await stmt.bind(stablecoinId).all<DexAvailabilityRow>()
      : await stmt.all<DexAvailabilityRow>();
    return new Map((result.results ?? []).map((row) => [
      row.stablecoin_id,
      isFreshTimestamp(row.updated_at, nowSec, DEX_FRESHNESS_SEC) &&
        ((row.source_pool_count ?? 0) > 0 || (row.source_total_tvl ?? 0) > 0),
    ]));
  } catch (err) {
    const msg = toErrorMessage(err);
    if (!isMissingTableError(err)) {
      console.error("[depeg-events] Unexpected error loading DEX availability:", msg);
    }
    return new Map();
  }
}

async function loadPoolAvailability(
  db: D1Database,
  stablecoinId: string | null,
  nowSec: number,
): Promise<Map<string, boolean>> {
  try {
    const where = stablecoinId ? " WHERE stablecoin_id = ?" : " WHERE stablecoin_id != '__global__'";
    const stmt = db
      .prepare(
        `SELECT /* pharos:depeg-events:pool-availability */
           stablecoin_id, snapshot_at, has_rows FROM dex_price_challenger_snapshots${where}`,
      );
    const result = stablecoinId
      ? await stmt.bind(stablecoinId).all<PoolAvailabilityRow>()
      : await stmt.all<PoolAvailabilityRow>();
    return new Map((result.results ?? []).map((row) => [
      row.stablecoin_id,
      row.has_rows === 1 && isFreshTimestamp(row.snapshot_at, nowSec, DEX_FRESHNESS_SEC),
    ]));
  } catch (err) {
    const msg = toErrorMessage(err);
    if (!isMissingTableError(err)) {
      console.error("[depeg-events] Unexpected error loading pool availability:", msg);
    }
    return new Map();
  }
}


function buildConfirmationCategories(
  stablecoinId: string,
  dexAvailability: Map<string, boolean>,
  poolAvailability: Map<string, boolean>,
): { available: ConfirmationCategory[]; missing: ConfirmationCategory[] } {
  const available: ConfirmationCategory[] = [];
  const missing: ConfirmationCategory[] = [];
  const meta = ACTIVE_META_BY_ID.get(stablecoinId);

  if (meta?.geckoId) {
    available.push("offchain");
  } else {
    missing.push("offchain");
  }

  if (dexAvailability.get(stablecoinId) === true) {
    available.push("dex");
  } else {
    missing.push("dex");
  }

  if (poolAvailability.get(stablecoinId) === true) {
    available.push("pool");
  } else {
    missing.push("pool");
  }

  return { available, missing };
}

async function loadPendingIncidents(
  db: D1Database,
  stablecoinId: string | null,
): Promise<DepegPendingIncident[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const where = stablecoinId ? " WHERE stablecoin_id = ?" : "";
  const pendingSelect = SELECT_PENDING_DEPEGS_SQL.replace(
    /^\s*SELECT\s+/i,
    "\n  SELECT /* pharos:depeg-events:pending-incidents */ ",
  );
  const pendingQuery = `${pendingSelect}${where} ORDER BY first_seen_at DESC, id DESC`;
  const pendingResult = stablecoinId
    ? await db.prepare(pendingQuery).bind(stablecoinId).all<PendingDepegRow>()
    : await db.prepare(pendingQuery).all<PendingDepegRow>();
  const rows = pendingResult.results ?? [];
  if (rows.length === 0) return [];

  const [dexAvailability, poolAvailability] = await Promise.all([
    loadDexAvailability(db, stablecoinId, nowSec),
    loadPoolAvailability(db, stablecoinId, nowSec),
  ]);

  return rows.map((row) => {
    const pending = normalizePendingDepegRow(row);
    const categories = buildConfirmationCategories(row.stablecoin_id, dexAvailability, poolAvailability);
    return {
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      direction: pending.direction,
      firstSeenAt: pending.firstSeenAt,
      lastSeenAt: pending.lastSeenAt,
      firstSeenBps: pending.firstSeenBps,
      lastSeenBps: pending.lastSeenBps,
      peakSeenBps: pending.peakSeenBps,
      reason: pending.reason,
      ageSec: Math.max(0, nowSec - pending.firstSeenAt),
      expiresAt: pending.firstSeenAt + DEPEG_PENDING_EXPIRY_SEC,
      availableConfirmationCategories: categories.available,
      missingConfirmationCategories: categories.missing,
    };
  });
}

async function loadThresholdCrossingCount(db: D1Database, stablecoinId: string): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        `SELECT /* pharos:depeg-events:threshold-crossing-count */ COUNT(*) AS total
           FROM depeg_events_with_provenance
          WHERE stablecoin_id = ?`,
      )
      .bind(stablecoinId)
      .first<{ total: number }>();
    return typeof row?.total === "number" && Number.isFinite(row.total) ? Math.max(0, row.total) : null;
  } catch (err) {
    if (!isMissingTableError(err)) {
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "threshold_crossing_count_failed",
        route: "depeg-events",
        message: "Unexpected error loading threshold-crossing count",
        error: toErrorMessage(err),
      });
    }
    return null;
  }
}

export const handleDepegEvents = withErrorHandler(
  "depeg-events",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
    const stablecoin = params.get("stablecoin");
    const active = params.get("active");
    const includePending = parseBooleanParam(params.get("includePending"), "includePending", false);
    if (includePending instanceof Response) {
      return includePending;
    }

    const conditions: string[] = [];
    const filterBindings: (string | number)[] = [];
    let stablecoinId: string | null = null;

    if (stablecoin) {
      const resolved = resolveOrReject(stablecoin);
      if (resolved instanceof Response) {
        return resolved;
      }
      conditions.push("stablecoin_id = ?");
      filterBindings.push(resolved.canonicalId);
      stablecoinId = resolved.canonicalId;
    }
    if (active === "true") {
      conditions.push("ended_at IS NULL");
    }
    const activeIncidentProjectionLoad = await loadActiveIncidentProjections(db, stablecoinId);
    if (activeIncidentProjectionLoad.available) {
      conditions.push(EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL);
    }

    return buildPaginatedEventResponse<DepegRow, ReturnType<typeof rowToPublicDepegEvent>>(db, {
      tableName: "depeg_events_with_provenance",
      orderBy: "started_at DESC, id DESC",
      queryComment: "pharos:depeg-events",
      conditions,
      filterBindings,
      mapRow: (row) => rowToPublicDepegEvent(row, activeIncidentProjectionLoad.projections),
      searchParams: params,
      pagination: { defaultLimit: 100, minLimit: 1, maxLimit: 1000, maxOffset: 50_000 },
      cursor: {
        columns: [
          { column: "started_at", type: "number", direction: "DESC", getValue: (row) => row.started_at },
          { column: "id", type: "number", direction: "DESC", getValue: (row) => row.id },
        ],
      },
      freshness: {
        producerJob: "sync-stablecoins",
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegEvents,
        fallbackTimestamp: (events) => (events.length > 0 ? events[0].startedAt : Math.floor(Date.now() / 1000)),
      },
      cacheControl: CACHE_PROFILES.producerBacked,
      buildExtraBody: async (_events, total, latestEventTs) => {
        const methodologyVersion = getDepegDewsMethodologyVersionAt(latestEventTs);
        const thresholdCrossingCount = stablecoinId != null &&
          active !== "true" &&
          params.get("includeTotal") !== "false"
          ? await loadThresholdCrossingCount(db, stablecoinId)
          : null;
        return {
          ...(thresholdCrossingCount != null
            ? { counts: { incidents: total, thresholdCrossings: thresholdCrossingCount } }
            : {}),
          ...(includePending ? { pending: await loadPendingIncidents(db, stablecoinId) } : {}),
          methodology: buildMethodologyEnvelope({
            version: methodologyVersion,
            versionLabel: toMethodologyVersionLabel(methodologyVersion),
            currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
            currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
            changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
            asOf: latestEventTs,
          }),
        };
      },
    });
  },
);
