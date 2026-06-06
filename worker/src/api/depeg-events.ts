import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
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

type ConfirmationCategory = "offchain" | "dex" | "pool";

const EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL = `
  id NOT IN (
    SELECT links.event_id
      FROM depeg_resolver_incident_event_links links
      JOIN depeg_resolver_incidents incidents
        ON incidents.incident_key = links.incident_key
     WHERE incidents.incident_state = 'active'
       AND links.event_id != incidents.current_event_id
  )
`;

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

interface ActiveIncidentProjectionRow {
  current_event_id: number | null;
  first_started_at: number | null;
  first_start_price: number | null;
  first_peg_reference: number | null;
}

interface ActiveIncidentProjection {
  startedAt: number;
  startPrice: number | null;
  pegReference: number | null;
}

interface ActiveIncidentProjectionLoad {
  projections: Map<number, ActiveIncidentProjection>;
  available: boolean;
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
    const msg = err instanceof Error ? err.message : String(err);
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
    const msg = err instanceof Error ? err.message : String(err);
    if (!isMissingTableError(err)) {
      console.error("[depeg-events] Unexpected error loading pool availability:", msg);
    }
    return new Map();
  }
}

function normalizeActiveIncidentProjection(row: ActiveIncidentProjectionRow): [number, ActiveIncidentProjection] | null {
  if (
    typeof row.current_event_id !== "number" ||
    !Number.isFinite(row.current_event_id) ||
    typeof row.first_started_at !== "number" ||
    !Number.isFinite(row.first_started_at) ||
    row.first_started_at <= 0
  ) {
    return null;
  }

  return [
    row.current_event_id,
    {
      startedAt: row.first_started_at,
      startPrice:
        typeof row.first_start_price === "number" && Number.isFinite(row.first_start_price)
          ? row.first_start_price
          : null,
      pegReference:
        typeof row.first_peg_reference === "number" && Number.isFinite(row.first_peg_reference)
          ? row.first_peg_reference
          : null,
    },
  ];
}

async function loadActiveIncidentProjections(
  db: D1Database,
  stablecoinId: string | null,
): Promise<ActiveIncidentProjectionLoad> {
  try {
    const stablecoinFilter = stablecoinId ? " AND current_event.stablecoin_id = ?" : "";
    const stmt = db.prepare(
      `SELECT /* pharos:depeg-events:active-incident-projections */
          incidents.current_event_id,
          incidents.first_started_at,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference
         FROM depeg_resolver_incidents incidents
         JOIN depeg_events first_event
           ON first_event.id = incidents.first_event_id
         JOIN depeg_events current_event
           ON current_event.id = incidents.current_event_id
        WHERE incidents.incident_state = 'active'
          AND incidents.current_event_id != incidents.first_event_id${stablecoinFilter}`,
    );
    const result = stablecoinId
      ? await stmt.bind(stablecoinId).all<ActiveIncidentProjectionRow>()
      : await stmt.all<ActiveIncidentProjectionRow>();
    const projections = new Map<number, ActiveIncidentProjection>();
    for (const row of result.results ?? []) {
      const normalized = normalizeActiveIncidentProjection(row);
      if (normalized) projections.set(normalized[0], normalized[1]);
    }
    return { projections, available: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isMissingTableError(err)) {
      console.error("[depeg-events] Unexpected error loading active incident projections:", msg);
    }
    return { projections: new Map(), available: false };
  }
}

function rowToPublicDepegEvent(row: DepegRow, projections: Map<number, ActiveIncidentProjection>) {
  const projection = projections.get(row.id);
  if (!projection) return rowToDepegEvent(row);
  return rowToDepegEvent({
    ...row,
    started_at: projection.startedAt,
    start_price: projection.startPrice ?? row.start_price,
    peg_reference: projection.pegReference ?? row.peg_reference,
  });
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

    return buildPaginatedEventResponse<DepegRow, ReturnType<typeof rowToDepegEvent>>(db, {
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
      cacheControl: CACHE_PROFILES.realtime,
      buildExtraBody: async (_events, _total, latestEventTs) => {
        const methodologyVersion = getDepegDewsMethodologyVersionAt(latestEventTs);
        return {
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
