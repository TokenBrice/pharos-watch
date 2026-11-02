import { DEPEG_PENDING_EXPIRY_SEC, DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { logWorkerEventArgs } from "../lib/structured-log";
import { resolveOrReject, parseBooleanParam } from "../lib/api-params";
import { buildMethodologyEnvelope } from "../lib/api-methodology";
import { buildPaginatedEventResponse, parsePaginatedEventParams } from "../lib/api-pagination";
import { jsonResponse } from "../lib/api-response";

import {
  normalizePendingDepegRow,
  SELECT_PENDING_DEPEGS_SQL,
  type PendingDepegRow,
} from "../lib/depeg-pending";
import { isMissingTableError } from "../lib/db";
import {
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  decodeActiveIncidentProjections,
  IncidentProjectionUnavailableError,
  prepareActiveIncidentProjections,
  type ActiveIncidentProjectionLoad,
  type PublicDepegRow,
  rowToPublicDepegEvent,
} from "../lib/depeg-event-projection";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { WORKER_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { DepegEvent, DepegPendingIncident } from "@shared/types/market";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isTrustedDexPriceRow } from "../lib/depeg-trust-policy";
import { prepareDepegEventsCountStatements } from "../lib/depeg-events-count-cache";

type ConfirmationCategory = "offchain" | "dex" | "pool";

/** Stored-field refusals from the shared row parser, named for the public reason. */
const DEPEG_ROW_PARSE_FAILURE = /^\[depeg-helpers\] Invalid (direction|source|close_reason)\b/;

class DepegEventRowUnreadableError extends Error {
  constructor(
    readonly eventId: number,
    readonly reason: string,
  ) {
    super(`Unreadable depeg event row ${eventId}`);
    this.name = "DepegEventRowUnreadableError";
  }
}

function depegRowFailureReason(error: unknown): string {
  const field = DEPEG_ROW_PARSE_FAILURE.exec(toErrorMessage(error))?.[1];
  return field ? `invalid-${field.replaceAll("_", "-")}` : "unreadable-row";
}

interface DexAvailabilityRow {
  stablecoin_id: string;
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
           stablecoin_id, source_total_tvl, updated_at FROM dex_prices${where}`,
      );
    const result = stablecoinId
      ? await stmt.bind(stablecoinId).all<DexAvailabilityRow>()
      : await stmt.all<DexAvailabilityRow>();
    return new Map((result.results ?? []).map((row) => [
      row.stablecoin_id,
      typeof row.updated_at === "number" &&
        typeof row.source_total_tvl === "number" &&
        isTrustedDexPriceRow({ updated_at: row.updated_at, source_total_tvl: row.source_total_tvl }, nowSec, "depeg"),
    ]));
  } catch (err) {
    const msg = toErrorMessage(err);
    if (isMissingTableError(err)) return new Map();
    logWorkerEventArgs("api", "error", "[depeg-events] Unexpected error loading DEX availability:", msg);
    throw err;
  }
}

async function loadPoolAvailability(
  db: D1Database,
  stablecoinId: string | null,
  nowSec: number,
): Promise<Map<string, boolean>> {
  try {
    const where = stablecoinId ? " WHERE stablecoin_id = ?" : " WHERE stablecoin_id != '__global__'";
    const stmt = db.prepare(
      `SELECT /* pharos:depeg-events:pool-availability */ stablecoin_id, snapshot_at, has_rows
         FROM (
           SELECT heads.stablecoin_id, publication.snapshot_at,
                  CASE WHEN heads.source_coverage_complete = 1 THEN heads.has_rows ELSE 0 END AS has_rows
             FROM dex_price_challenger_heads_v2 heads
             JOIN dex_price_challenger_publications_v2 publication
               ON publication.publication_id = heads.publication_id AND publication.sealed = 1
           UNION ALL
           SELECT snapshots.stablecoin_id, snapshots.snapshot_at,
                  CASE WHEN snapshots.source_coverage_complete = 1 THEN snapshots.has_rows ELSE 0 END AS has_rows
             FROM dex_price_challenger_snapshots snapshots
            WHERE NOT EXISTS (SELECT 1 FROM dex_price_challenger_heads_v2 heads
                               WHERE heads.stablecoin_id = snapshots.stablecoin_id)
         )${where}`,
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
    if (isMissingTableError(err)) return new Map();
    logWorkerEventArgs("api", "error", "[depeg-events] Unexpected error loading pool availability:", msg);
    throw err;
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


export const handleDepegEvents = async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
    const stablecoin = params.get("stablecoin");
    const active = parseBooleanParam(params.get("active"), "active", false);
    if (active instanceof Response) {
      return active;
    }
    const includePending = parseBooleanParam(params.get("includePending"), "includePending", false);
    if (includePending instanceof Response) {
      return includePending;
    }
    const pagination = { defaultLimit: 100, minLimit: 1, maxLimit: 1000, maxOffset: 50_000 };
    const cursor = {
      version: 2,
      columns: [
        { column: "effective_started_at", type: "number" as const, direction: "DESC" as const, getValue: (row: PublicDepegRow) => row.effective_started_at },
        { column: "id", type: "number" as const, direction: "DESC" as const, getValue: (row: PublicDepegRow) => row.id },
      ],
    };
    const parsedPagination = parsePaginatedEventParams(params, pagination, cursor);
    if (parsedPagination instanceof Response) {
      return parsedPagination;
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
    if (active) {
      conditions.push("ended_at IS NULL");
    }
    let activeIncidentProjectionLoad: Extract<ActiveIncidentProjectionLoad, { available: true }>;
    conditions.push(EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL);

    try {
    return await buildPaginatedEventResponse<PublicDepegRow, DepegEvent>(db, {
      tableName: "depeg_events_public",
      orderBy: "effective_started_at DESC, id DESC",
      queryComment: "pharos:depeg-events",
      conditions,
      filterBindings,
      countStatements: parsedPagination.includeTotal
        ? prepareDepegEventsCountStatements(db, stablecoinId, active)
        : undefined,
      snapshot: {
        statement: prepareActiveIncidentProjections(db, stablecoinId),
        onResult: (result) => {
          const projection = decodeActiveIncidentProjections(result);
          if (!projection.available) throw new IncidentProjectionUnavailableError(projection.reason);
          activeIncidentProjectionLoad = projection;
        },
        onError: (error) => {
          logWorkerEventArgs("api", "error", "[depeg-events] Canonical incident snapshot read failed:", toErrorMessage(error));
          throw new IncidentProjectionUnavailableError();
        },
      },
      mapRow: (row) => {
        // The shared parser stays the single admission authority; one refused
        // row fails the whole page instead of publishing a partial ledger.
        try {
          return rowToPublicDepegEvent(row, activeIncidentProjectionLoad.projections);
        } catch (error) {
          throw new DepegEventRowUnreadableError(row.id, depegRowFailureReason(error));
        }
      },
      searchParams: params,
      pagination,
      parsedPagination,
      cursor,
      freshness: {
        producerJob: "sync-stablecoins",
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegEvents,
      },
      cacheControl: CACHE_PROFILES.producerBacked,
      buildExtraBody: async (events) => {
        const latestEventTs = events[0]?.startedAt ?? Math.floor(Date.now() / 1000);
        const methodologyVersion = getMethodologyVersionAt("depeg-dews", latestEventTs);
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
    } catch (error) {
      if (error instanceof DepegEventRowUnreadableError) {
        // Keep the refused row visible to operators: this named 503 replaces the
        // generic route_handler_error log the previous throw produced.
        logWorkerEventArgs(
          "api",
          "error",
          `[depeg-events] Refused stored depeg event ${error.eventId}: ${error.reason}`,
          { eventId: error.eventId, reason: error.reason },
        );
        return jsonResponse({
          error: "Depeg event row unreadable",
          reason: error.reason,
          eventId: error.eventId,
        }, { status: 503, headers: { "Cache-Control": CACHE_PROFILES.noStore } });
      }
      if (!(error instanceof IncidentProjectionUnavailableError)) throw error;
      return jsonResponse({
        error: "Canonical incident history unavailable",
        reason: error.reason,
      }, { status: 503, headers: { "Cache-Control": CACHE_PROFILES.noStore } });
    }
  };
