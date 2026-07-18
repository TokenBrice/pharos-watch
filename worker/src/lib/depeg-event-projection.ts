import type { DepegEvent } from "@shared/types/market";
import { type DepegRow, rowToDepegEvent } from "./depeg-helpers";
import { isMissingTableError } from "./db";
import { toErrorMessage } from "./error-utils";

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
  )
`;

interface ActiveIncidentProjectionRow {
  current_event_id: number | null;
  first_started_at: number | null;
  first_start_price: number | null;
  first_peg_reference: number | null;
  constituent_event_count: number | null;
}

interface ActiveIncidentProjection {
  startedAt: number;
  startPrice: number | null;
  pegReference: number | null;
  constituentEventCount: number;
}

export interface ActiveIncidentProjectionLoad {
  projections: Map<number, ActiveIncidentProjection>;
  available: boolean;
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
      constituentEventCount:
        typeof row.constituent_event_count === "number" && Number.isFinite(row.constituent_event_count)
          ? Math.max(1, Math.floor(row.constituent_event_count))
          : 1,
    },
  ];
}

export async function loadActiveIncidentProjections(
  db: D1Database,
  stablecoinId: string | null,
): Promise<ActiveIncidentProjectionLoad> {
  try {
    const activeStablecoinFilter = stablecoinId ? " AND current_event.stablecoin_id = ?" : "";
    const aliasStablecoinFilter = stablecoinId ? " AND alias_current_event.stablecoin_id = ?" : "";
    const stmt = db.prepare(
      `SELECT /* pharos:depeg-event-projection:active-incidents */
          incidents.current_event_id,
          incidents.first_started_at,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference,
          COUNT(DISTINCT links.event_id) AS constituent_event_count
         FROM depeg_resolver_incidents incidents
         JOIN depeg_events first_event
           ON first_event.id = incidents.first_event_id
         JOIN depeg_events current_event
           ON current_event.id = incidents.current_event_id
         LEFT JOIN depeg_resolver_incident_event_links links
           ON links.incident_key = incidents.incident_key
        WHERE incidents.incident_state = 'active'
          AND incidents.current_event_id != incidents.first_event_id${activeStablecoinFilter}
        GROUP BY incidents.current_event_id, incidents.first_started_at,
                 first_event.start_price, first_event.peg_reference
       UNION ALL
       SELECT
          alias.current_event_id,
          canonical.first_started_at,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference,
          COUNT(DISTINCT links.event_id) AS constituent_event_count
         FROM depeg_resolver_incidents alias
         JOIN depeg_resolver_incidents canonical
           ON canonical.incident_key = alias.superseded_by_incident_key
         JOIN depeg_events first_event
           ON first_event.id = canonical.first_event_id
         JOIN depeg_events alias_current_event
           ON alias_current_event.id = alias.current_event_id
         LEFT JOIN depeg_resolver_incident_event_links links
           ON links.incident_key = canonical.incident_key
        WHERE alias.incident_state = 'superseded'
          AND canonical.incident_state = 'active'
          AND alias.current_event_id != canonical.current_event_id
          AND alias.current_event_id != canonical.first_event_id${aliasStablecoinFilter}
        GROUP BY alias.current_event_id, canonical.first_started_at,
                 first_event.start_price, first_event.peg_reference`,
    );
    const result = stablecoinId
      ? await stmt.bind(stablecoinId, stablecoinId).all<ActiveIncidentProjectionRow>()
      : await stmt.all<ActiveIncidentProjectionRow>();
    const projections = new Map<number, ActiveIncidentProjection>();
    for (const row of result.results ?? []) {
      const normalized = normalizeActiveIncidentProjection(row);
      if (normalized) projections.set(normalized[0], normalized[1]);
    }
    return { projections, available: true };
  } catch (err) {
    const msg = toErrorMessage(err);
    if (!isMissingTableError(err)) {
      console.error("[depeg-event-projection] Unexpected error loading active incident projections:", msg);
    }
    return { projections: new Map(), available: false };
  }
}

export function rowToPublicDepegEvent(
  row: DepegRow,
  projections: Map<number, ActiveIncidentProjection>,
): DepegEvent {
  const projection = projections.get(row.id);
  if (!projection) return { ...rowToDepegEvent(row), constituentEventCount: 1 };
  return {
    ...rowToDepegEvent({
      ...row,
      started_at: projection.startedAt,
      start_price: projection.startPrice ?? row.start_price,
      peg_reference: projection.pegReference ?? row.peg_reference,
    }),
    constituentEventCount: projection.constituentEventCount,
  };
}
