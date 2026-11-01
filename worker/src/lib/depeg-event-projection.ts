import { logWorkerEventArgs } from "./structured-log";
import type { DepegEvent } from "@shared/types/market";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { isRetiredFromCatalog } from "@shared/lib/stablecoin-lifecycle";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { type DepegRow, rowToDepegEvent } from "./depeg-helpers";
import { isMissingTableError } from "./db";
import { toErrorMessage } from "@shared/lib/error-utils";

/**
 * Later of a canonical incident's own current fragment and its superseded
 * aliases' current fragments, by `current_started_at` then `current_event_id`
 * (the `buildEffectiveIncidentByKey` recency rule). One public row per logical
 * incident is this effective fragment; every other linked event is absorbed.
 */
function effectiveAliasIncidentKeySql(canonical: string): string {
  return `(SELECT alias.incident_key
             FROM depeg_resolver_incidents alias
            WHERE alias.superseded_by_incident_key = ${canonical}.incident_key
              AND alias.incident_state = 'superseded'
              AND (alias.current_started_at > ${canonical}.current_started_at
                OR (alias.current_started_at = ${canonical}.current_started_at
                    AND alias.current_event_id > ${canonical}.current_event_id))
            ORDER BY alias.current_started_at DESC, alias.current_event_id DESC
            LIMIT 1)`;
}

function effectiveAliasJoinSql(canonical: string): string {
  return `LEFT JOIN depeg_resolver_incidents effective_alias
      ON effective_alias.incident_key = ${effectiveAliasIncidentKeySql(canonical)}`;
}

function effectiveCurrentEventSql(canonical: string): string {
  return `COALESCE(effective_alias.current_event_id, ${canonical}.current_event_id)`;
}

/** Incident links stay append-only; the projection only decides visibility. */
export const EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL = `
  id NOT IN (
    SELECT links.event_id
      FROM depeg_resolver_incident_event_links links
      JOIN depeg_resolver_incidents owner
        ON owner.incident_key = links.incident_key
      JOIN depeg_resolver_incidents canonical
        ON canonical.incident_key = COALESCE(owner.superseded_by_incident_key, owner.incident_key)
      ${effectiveAliasJoinSql("canonical")}
     WHERE canonical.incident_state = 'active'
       AND links.event_id != ${effectiveCurrentEventSql("canonical")}
  )
`;

interface ActiveIncidentProjectionRow {
  current_event_id: number | null;
  first_started_at: number | null;
  first_start_price: number | null;
  first_peg_reference: number | null;
  first_source?: string | null;
  first_peg_type?: string | null;
  first_quote_mode?: string | null;
  constituent_event_count: number | null;
  references_valid: number;
}

interface ActiveIncidentProjection {
  startedAt: number;
  startPrice: number | null;
  pegReference: number | null;
  /** First constituent's quote domain; null when its reference cannot classify one. */
  nativePeg: boolean | null;
  constituentEventCount: number;
}

export type IncidentProjectionUnavailableReason =
  | "incident-projection-read-failed"
  | "incident-projection-invalid"
  | "incident-projection-dangling-reference";

export type ActiveIncidentProjectionLoad =
  | { available: true; projections: Map<number, ActiveIncidentProjection> }
  | { available: false; reason: IncidentProjectionUnavailableReason };

export class IncidentProjectionUnavailableError extends Error {
  constructor(readonly reason: IncidentProjectionUnavailableReason = "incident-projection-read-failed") {
    super(reason);
    this.name = "IncidentProjectionUnavailableError";
  }
}

function normalizeActiveIncidentProjection(row: ActiveIncidentProjectionRow): [number, ActiveIncidentProjection] | null {
  if (
    !row || typeof row !== "object" ||
    row.references_valid !== 1 ||
    typeof row.current_event_id !== "number" ||
    !Number.isSafeInteger(row.current_event_id) ||
    row.current_event_id <= 0 ||
    typeof row.first_started_at !== "number" ||
    !Number.isSafeInteger(row.first_started_at) ||
    row.first_started_at <= 0 ||
    !(row.first_start_price === null ||
      (typeof row.first_start_price === "number" && Number.isFinite(row.first_start_price) && row.first_start_price >= 0)) ||
    !(row.first_peg_reference === null ||
      (typeof row.first_peg_reference === "number" && Number.isFinite(row.first_peg_reference) && row.first_peg_reference > 0)) ||
    !(row.first_source == null || typeof row.first_source === "string") ||
    !(row.first_peg_type == null || typeof row.first_peg_type === "string") ||
    !(row.first_quote_mode == null || typeof row.first_quote_mode === "string") ||
    typeof row.constituent_event_count !== "number" ||
    !Number.isSafeInteger(row.constituent_event_count) ||
    row.constituent_event_count <= 0
  ) {
    return null;
  }

  return [
    row.current_event_id,
    {
      startedAt: row.first_started_at,
      startPrice: row.first_start_price,
      pegReference: row.first_peg_reference,
      nativePeg: row.first_peg_reference == null
        ? null
        : isNativePegEvent({
          source: row.first_source ?? undefined,
          peg_type: row.first_peg_type ?? undefined,
          peg_reference: row.first_peg_reference,
          quote_mode: row.first_quote_mode ?? null,
        }),
      constituentEventCount: row.constituent_event_count,
    },
  ];
}

function activeIncidentProjectionSql(stablecoinId: string | null): string {
    const stablecoinFilter = stablecoinId ? " AND incidents.stablecoin_id = ?" : "";
    const effectiveCurrentEvent = effectiveCurrentEventSql("incidents");
    return `SELECT
          ${effectiveCurrentEvent} AS current_event_id,
          incidents.first_started_at,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference,
          first_event.source AS first_source,
          first_event.peg_type AS first_peg_type,
          first_provenance.quote_mode AS first_quote_mode,
          COUNT(DISTINCT linked_event.id) AS constituent_event_count,
          CASE WHEN first_event.id IS NOT NULL AND current_event.id IS NOT NULL
            AND canonical_current_event.id IS NOT NULL
            AND MAX(CASE WHEN links.event_id = incidents.first_event_id THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN links.event_id = incidents.current_event_id THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN links.event_id = ${effectiveCurrentEvent} THEN 1 ELSE 0 END) = 1
            AND COUNT(CASE WHEN links.incident_key = incidents.incident_key THEN linked_event.id END)
              = COUNT(CASE WHEN links.incident_key = incidents.incident_key THEN links.event_id END)
            THEN 1 ELSE 0 END AS references_valid
         FROM depeg_resolver_incidents incidents
         LEFT JOIN depeg_events first_event
           ON first_event.id = incidents.first_event_id
         LEFT JOIN depeg_event_provenance first_provenance
           ON first_provenance.event_id = first_event.id
         ${effectiveAliasJoinSql("incidents")}
         LEFT JOIN depeg_events current_event
           ON current_event.id = ${effectiveCurrentEvent}
         LEFT JOIN depeg_events canonical_current_event
           ON canonical_current_event.id = incidents.current_event_id
         LEFT JOIN depeg_resolver_incident_event_links links
           ON links.incident_key = incidents.incident_key
           OR links.incident_key IN (
                SELECT alias.incident_key
                  FROM depeg_resolver_incidents alias
                 WHERE alias.superseded_by_incident_key = incidents.incident_key
                   AND alias.incident_state = 'superseded'
              )
         LEFT JOIN depeg_events linked_event
           ON linked_event.id = links.event_id
        WHERE incidents.incident_state = 'active'${stablecoinFilter}
        GROUP BY incidents.incident_key, incidents.first_started_at,
                 first_event.start_price, first_event.peg_reference,
                 first_event.source, first_event.peg_type, first_provenance.quote_mode,
                 ${effectiveCurrentEvent}`;
}

/**
 * Raw fragment clocks remain intact; public pagination uses the projected onset.
 * A projection row is keyed by its effective fragment's `current_event_id`, and
 * an incident's current event is one linked event (links are unique per event),
 * so the fragment is recoverable from the page row's own id. Resolving it as one
 * correlated lookup keeps the page's reads proportional to the scanned events
 * instead of cross-joining them with the whole materialized projection.
 */
export const PUBLIC_DEPEG_EVENTS_SQL = `(
  SELECT events.*, COALESCE((
        SELECT canonical.first_started_at
          FROM depeg_resolver_incidents owner
          JOIN depeg_resolver_incidents canonical
            ON canonical.incident_key = COALESCE(owner.superseded_by_incident_key, owner.incident_key)
         WHERE owner.current_event_id = events.id
           AND canonical.incident_state = 'active'
           AND COALESCE(${effectiveAliasIncidentKeySql("canonical")}, canonical.incident_key) = owner.incident_key
      ), events.started_at) AS effective_started_at
    FROM depeg_events_with_provenance events
)`;

export type PublicDepegRow = DepegRow & { effective_started_at: number };

export function prepareActiveIncidentProjections(db: D1Database, stablecoinId: string | null): D1PreparedStatement {
  const stmt = db.prepare(`SELECT /* pharos:depeg-event-projection:active-incidents */ *
    FROM (${activeIncidentProjectionSql(stablecoinId)})`);
  return stablecoinId ? stmt.bind(stablecoinId) : stmt;
}

export function decodeActiveIncidentProjections(
  result: { success?: boolean; results?: unknown[] },
): ActiveIncidentProjectionLoad {
    if (result.success === false) {
      return { available: false, reason: "incident-projection-read-failed" };
    }
    if (!Array.isArray(result.results)) {
      return { available: false, reason: "incident-projection-invalid" };
    }
    const projections = new Map<number, ActiveIncidentProjection>();
    for (const value of result.results) {
      const row = value as ActiveIncidentProjectionRow;
      const normalized = normalizeActiveIncidentProjection(row);
      if (!normalized) return {
        available: false,
        reason: row?.references_valid === 0
          ? "incident-projection-dangling-reference"
          : "incident-projection-invalid",
      };
      projections.set(normalized[0], normalized[1]);
    }
    return { projections, available: true };
}

export async function loadActiveIncidentProjections(
  db: D1Database,
  stablecoinId: string | null,
): Promise<ActiveIncidentProjectionLoad> {
  try {
    return decodeActiveIncidentProjections(
      await prepareActiveIncidentProjections(db, stablecoinId).all<ActiveIncidentProjectionRow>(),
    );
  } catch (err) {
    const msg = toErrorMessage(err);
    if (!isMissingTableError(err)) {
      logWorkerEventArgs("lib", "error", "[depeg-event-projection] Unexpected error loading active incident projections:", msg);
    }
    return { available: false, reason: "incident-projection-read-failed" };
  }
}

/** Backfilled rows carry their structured quote domain in the public provenance JSON. */
function rowQuoteMode(row: DepegRow): string | null {
  if (row.provenance_json == null) return null;
  try {
    const parsed = JSON.parse(row.provenance_json) as { quoteMode?: unknown } | null;
    return parsed != null && typeof parsed === "object" && typeof parsed.quoteMode === "string"
      ? parsed.quoteMode
      : null;
  } catch {
    return null;
  }
}

export function rowToPublicDepegEvent(
  row: DepegRow,
  projections: Map<number, ActiveIncidentProjection>,
): DepegEvent {
  const retiredMarker = isRetiredFromCatalog(row.stablecoin_id, WORKER_TRACKED_META_BY_ID)
    ? { retired: true as const }
    : {};
  const projection = projections.get(row.id);
  if (!projection) return { ...rowToDepegEvent(row), constituentEventCount: 1, ...retiredMarker };
  // The onset clock is domain-free, but a first constituent's start price and
  // reference are not: publishing a native-domain onset against a USD-domain
  // peak (or the reverse) yields a pair whose implied deviation cannot be the
  // stored one. Keep the row's own price pair when the domains differ.
  const currentNativePeg = isNativePegEvent({
    source: row.source,
    peg_type: row.peg_type,
    peg_reference: row.peg_reference,
    quote_mode: rowQuoteMode(row),
  });
  const sameQuoteDomain = projection.nativePeg == null || projection.nativePeg === currentNativePeg;
  return {
    ...rowToDepegEvent({
      ...row,
      started_at: projection.startedAt,
      ...(sameQuoteDomain
        ? {
            start_price: projection.startPrice ?? row.start_price,
            peg_reference: projection.pegReference ?? row.peg_reference,
          }
        : {}),
    }),
    constituentEventCount: projection.constituentEventCount,
    ...retiredMarker,
  };
}
