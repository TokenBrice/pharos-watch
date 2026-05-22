import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { deleteOrphanYieldRows, deleteStaleYieldRows } from "./history";

export {
  readPreviousYieldRankingsCount,
  persistEvaluatedYieldSources,
  validateYieldRankingsPayloadForPublish,
} from "./publication-decision-persistence";
export {
  attachYieldPublicationMetadata,
  buildYieldPublicationGenerationId,
  finalizeYieldPublicationGeneration,
  repairPublishedYieldGenerationFromCache,
  stageYieldPublicationGeneration,
} from "./publication-lifecycle";
export { buildYieldRankingsPayloadFromEvaluatedSources } from "./publication-ranking-payload";

/** Days to retain audit-only yield_source_decisions rows. Trend-tagged rows
 *  (source switches, anomalies, rejected higher-confidence sources) are
 *  preserved beyond this window for long-running analytics. */
const AUDIT_DECISION_RETENTION_DAYS = 30;

export async function pruneYieldTables(
  db: D1Database,
  startSec: number,
  options?: {
    allowDestructiveCleanup?: boolean;
  },
): Promise<void> {
  const managedYieldIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  if ((options?.allowDestructiveCleanup ?? true) && managedYieldIds.length > 0) {
    await deleteStaleYieldRows(db, managedYieldIds, startSec);
    await deleteOrphanYieldRows(db, managedYieldIds);
  }

  const pruneCutoff = startSec - 365 * DAY_SECONDS;
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  await db
    .prepare(`DELETE FROM yield_history WHERE recorded_at < ? ${frozenClause}`)
    .bind(pruneCutoff, ...frozenIdsList)
    .run();

  if (options?.allowDestructiveCleanup ?? true) {
    const auditCutoffSec = startSec - AUDIT_DECISION_RETENTION_DAYS * DAY_SECONDS;
    await db
      .prepare(
        `DELETE FROM yield_source_decisions
         WHERE created_at < ?
           AND (
             retention_reason = 'audit'
             OR (
               retention_reason IS NULL
               AND COALESCE(source_switch, 0) != 1
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(
                   CASE
                     WHEN json_valid(yield_source_decisions.alternatives_json)
                     THEN yield_source_decisions.alternatives_json
                     ELSE '[]'
                   END
                 ) AS alternative
                 WHERE CASE
                   WHEN json_valid(alternative.value) AND json_type(alternative.value, '$.anomalies') = 'array'
                   THEN COALESCE(json_array_length(json_extract(alternative.value, '$.anomalies')), 0)
                   ELSE 0
                 END > 0
                   OR (
                     json_valid(alternative.value)
                     AND
                     json_extract(alternative.value, '$.rejected') = 1
                     AND CASE json_extract(alternative.value, '$.confidenceTier')
                       WHEN 'deterministic' THEN 4
                       WHEN 'curated' THEN 3
                       WHEN 'discovered' THEN 2
                       ELSE 1
                     END > CASE selected_confidence_tier
                       WHEN 'deterministic' THEN 4
                       WHEN 'curated' THEN 3
                       WHEN 'discovered' THEN 2
                       ELSE 1
                     END
                   )
               )
             )
           )`,
      )
      .bind(auditCutoffSec)
      .run();
    await db
      .prepare(
        `DELETE FROM yield_source_decision_alternatives
         WHERE recorded_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM yield_source_decisions d
             WHERE d.generation_id = yield_source_decision_alternatives.generation_id
               AND d.stablecoin_id = yield_source_decision_alternatives.stablecoin_id
           )`,
      )
      .bind(auditCutoffSec)
      .run();
  }
}
