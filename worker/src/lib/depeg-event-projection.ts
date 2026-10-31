import { logWorkerEventArgs } from "./structured-log";
import type { DepegEvent } from "@shared/types/market";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { type DepegRow, rowToDepegEvent } from "./depeg-helpers";
import { isMissingTableError } from "./db";
import { toErrorMessage } from "@shared/lib/error-utils";

// Effective current source fragment of a supersession family: the later of the
// canonical's and a superseded alias's current fragment, by `current_started_at`
// then `current_event_id` — the recency rule buildEffectiveIncidentByKey uses.
const ALIAS_FRAGMENT_IS_EFFECTIVE_SQL = `(alias.current_started_at > canonical.current_started_at
        OR (alias.current_started_at = canonical.current_started_at
            AND alias.current_event_id > canonical.current_event_id))`;
const ALIAS_FRAGMENT_LOSES_SQL = `(alias.current_started_at < canonical.current_started_at
        OR (alias.current_started_at = canonical.current_started_at
            AND alias.current_event_id < canonical.current_event_id))`;

export const EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL = `
  id NOT IN (
    SELECT links.event_id
      FROM depeg_resolver_incident_event_links links
      JOIN depeg_resolver_incidents incidents
        ON incidents.incident_key = links.incident_key
     WHERE incidents.incident_state = 'active'
       AND links.event_id != incidents.current_event_id
    UNION
    SELECT canonical.current_event_id
      FROM depeg_resolver_incidents canonical
      JOIN depeg_resolver_incidents alias
        ON alias.superseded_by_incident_key = canonical.incident_key
     WHERE canonical.incident_state = 'active'
       AND alias.incident_state = 'superseded'
       AND alias.current_event_id != canonical.current_event_id
       AND ${ALIAS_FRAGMENT_IS_EFFECTIVE_SQL}
    UNION
    SELECT alias.current_event_id
      FROM depeg_resolver_incidents alias
      JOIN depeg_resolver_incidents canonical
        ON canonical.incident_key = alias.superseded_by_incident_key
     WHERE alias.incident_state = 'superseded'
       AND canonical.incident_state = 'active'
       AND alias.current_event_id != canonical.current_event_id
       AND ${ALIAS_FRAGMENT_LOSES_SQL}
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
    const activeStablecoinFilter = stablecoinId ? " AND incidents.stablecoin_id = ?" : "";
    const aliasStablecoinFilter = stablecoinId ? " AND alias_current_event.stablecoin_id = ?" : "";
    return `SELECT
          incidents.current_event_id,
          incidents.first_started_at,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference,
          first_event.source AS first_source,
          first_event.peg_type AS first_peg_type,
          first_provenance.quote_mode AS first_quote_mode,
          COUNT(DISTINCT links.event_id) AS constituent_event_count,
          CASE WHEN first_event.id IS NOT NULL AND current_event.id IS NOT NULL
            AND MAX(CASE WHEN links.event_id = incidents.first_event_id THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN links.event_id = incidents.current_event_id THEN 1 ELSE 0 END) = 1
            AND COUNT(linked_event.id) = COUNT(links.event_id)
            THEN 1 ELSE 0 END AS references_valid
         FROM depeg_resolver_incidents incidents
         LEFT JOIN depeg_events first_event
           ON first_event.id = incidents.first_event_id
         LEFT JOIN depeg_event_provenance first_provenance
           ON first_provenance.event_id = first_event.id
         LEFT JOIN depeg_events current_event
           ON current_event.id = incidents.current_event_id
         LEFT JOIN depeg_resolver_incident_event_links links
           ON links.incident_key = incidents.incident_key
         LEFT JOIN depeg_events linked_event
           ON linked_event.id = links.event_id
        WHERE incidents.incident_state = 'active'${activeStablecoinFilter}
        GROUP BY incidents.incident_key, incidents.current_event_id, incidents.first_started_at,
                 first_event.start_price, first_event.peg_reference,
                 first_event.source, first_event.peg_type, first_provenance.quote_mode
       UNION ALL
       SELECT
          alias.current_event_id,
          canonical.first_started_at,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference,
          first_event.source AS first_source,
          first_event.peg_type AS first_peg_type,
          first_provenance.quote_mode AS first_quote_mode,
          COUNT(DISTINCT links.event_id) AS constituent_event_count,
          1 AS references_valid
         FROM depeg_resolver_incidents alias
         JOIN depeg_resolver_incidents canonical
           ON canonical.incident_key = alias.superseded_by_incident_key
         JOIN depeg_events first_event
           ON first_event.id = canonical.first_event_id
         LEFT JOIN depeg_event_provenance first_provenance
           ON first_provenance.event_id = first_event.id
         JOIN depeg_events alias_current_event
           ON alias_current_event.id = alias.current_event_id
         LEFT JOIN depeg_resolver_incident_event_links links
           ON links.incident_key IN (canonical.incident_key, alias.incident_key)
        WHERE alias.incident_state = 'superseded'
          AND canonical.incident_state = 'active'
          AND alias.current_event_id != canonical.current_event_id
          AND alias.current_event_id != canonical.first_event_id
          AND ${ALIAS_FRAGMENT_IS_EFFECTIVE_SQL}${aliasStablecoinFilter}
        GROUP BY alias.current_event_id, canonical.first_started_at,
                 first_event.start_price, first_event.peg_reference,
                 first_event.source, first_event.peg_type, first_provenance.quote_mode`;
}

/** Raw fragment clocks remain intact; public pagination uses the projected onset. */
export const PUBLIC_DEPEG_EVENTS_SQL = `(
  SELECT events.*, COALESCE(projection.first_started_at, events.started_at) AS effective_started_at
    FROM depeg_events_with_provenance events
    LEFT JOIN (${activeIncidentProjectionSql(null)}) projection ON projection.current_event_id = events.id
)`;

export type PublicDepegRow = DepegRow & { effective_started_at: number };

export function prepareActiveIncidentProjections(db: D1Database, stablecoinId: string | null): D1PreparedStatement {
  const stmt = db.prepare(`SELECT /* pharos:depeg-event-projection:active-incidents */ *
    FROM (${activeIncidentProjectionSql(stablecoinId)})`);
  return stablecoinId ? stmt.bind(stablecoinId, stablecoinId) : stmt;
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
  const projection = projections.get(row.id);
  if (!projection) return { ...rowToDepegEvent(row), constituentEventCount: 1 };
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
  };
}
