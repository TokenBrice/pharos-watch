import { disputedAuditVerdictSql } from "./depeg-audit";
import { EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL } from "./depeg-event-projection";

// Migration 0271 invalidates this one summary transactionally with every mutation
// that can change public membership, stablecoin filters or active filters.
// The summary stores every public membership row; reviewed disputes are
// subtracted from the current provenance at read time, so a pre-change cached
// generation can never publish a pre-change count.
export const DEPEG_EVENTS_COUNT_CACHE_KEY = "depeg-events:counts:v1";

const DISPUTED_PROVENANCE = disputedAuditVerdictSql("disputed.provenance_audit_verdict");

/** Run both statements in the same atomic batch as the event page. */
export function prepareDepegEventsCountStatements(
  db: D1Database,
  stablecoinId: string | null,
  active: boolean,
): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO cache /* pharos:depeg-events:count-summary */ (key, value, updated_at)
      SELECT ?, (
        SELECT json_group_array(json_object('stablecoinId', stablecoin_id, 'active', active, 'total', total))
          FROM (
            SELECT stablecoin_id, ended_at IS NULL AS active, COUNT(*) AS total
              FROM depeg_events
             WHERE ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}
             GROUP BY stablecoin_id, ended_at IS NULL
          )
      ), unixepoch()
      WHERE NOT EXISTS (SELECT 1 FROM cache WHERE key = ?)`)
      .bind(DEPEG_EVENTS_COUNT_CACHE_KEY, DEPEG_EVENTS_COUNT_CACHE_KEY),
    db.prepare(`SELECT /* pharos:depeg-events:count */
        COALESCE(SUM(json_extract(groups.value, '$.total')), 0) - COALESCE((
          SELECT COUNT(*)
            FROM depeg_events_with_provenance disputed
           WHERE ${DISPUTED_PROVENANCE.sql}
             AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}
             AND (? IS NULL OR disputed.stablecoin_id = ?)
             AND (? = 0 OR disputed.ended_at IS NULL)
        ), 0) AS total
        FROM cache, json_each(cache.value) groups
       WHERE cache.key = ?
         AND (? IS NULL OR json_extract(groups.value, '$.stablecoinId') = ?)
         AND (? = 0 OR json_extract(groups.value, '$.active') = 1)`)
      .bind(
        ...DISPUTED_PROVENANCE.binds,
        stablecoinId,
        stablecoinId,
        active ? 1 : 0,
        DEPEG_EVENTS_COUNT_CACHE_KEY,
        stablecoinId,
        stablecoinId,
        active ? 1 : 0,
      ),
  ];
}
