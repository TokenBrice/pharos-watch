import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { YIELD_HISTORY_MAX_DAYS } from "@shared/lib/yield-history-policy";
import { deleteOrphanYieldRows, deleteStaleYieldRows, purgeYieldHistoryOwnershipHandoffs } from "./history";
import { isMissingColumnError, isMissingTableError } from "../../lib/db";

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

/**
 * Reclassify the historical linked-variant false-switch pattern only after the
 * same coin has published the linked identity cleanly in two consecutive
 * generations. This prevents a one-off winner change from rewriting evidence.
 */
export async function cleanupFalseLinkedVariantSourceSwitches(db: D1Database): Promise<number> {
  try {
    const result = await db
      .prepare(
        `WITH ranked_linked_generations AS (
           SELECT d.stablecoin_id, d.generation_id, d.source_switch,
                  ROW_NUMBER() OVER (
                    PARTITION BY d.stablecoin_id
                    ORDER BY d.created_at DESC, d.generation_id DESC
                  ) AS generation_rank
             FROM yield_source_decisions d
             JOIN yield_publication_generations g
               ON g.generation_id = d.generation_id
              AND g.state = 'published'
            WHERE d.selected_source_key LIKE 'linked-variant:%'
         ), verified_clean_identities AS (
           SELECT stablecoin_id
             FROM ranked_linked_generations
            WHERE generation_rank <= 2
            GROUP BY stablecoin_id
           HAVING COUNT(*) = 2
              AND SUM(CASE WHEN source_switch = 0 THEN 1 ELSE 0 END) = 2
         )
         UPDATE yield_source_decisions
            SET source_switch = 0,
                retention_reason = 'audit'
          WHERE source_switch = 1
            AND selected_source_key LIKE 'linked-variant:%'
            AND previous_best_source_key = 'onchain:' || stablecoin_id
            AND stablecoin_id IN (SELECT stablecoin_id FROM verified_clean_identities)`,
      )
      .run();
    return result.meta?.changes ?? 0;
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return 0;
    throw error;
  }
}

export async function pruneYieldTables(
  db: D1Database,
  startSec: number,
  options?: {
    allowDestructiveCleanup?: boolean;
  },
): Promise<void> {
  const allowDestructiveCleanup = options?.allowDestructiveCleanup ?? true;
  const managedYieldIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  if (allowDestructiveCleanup && managedYieldIds.length > 0) {
    await deleteStaleYieldRows(db, managedYieldIds, startSec);
    await deleteOrphanYieldRows(db, managedYieldIds);
  }

  const pruneCutoff = startSec - YIELD_HISTORY_MAX_DAYS * DAY_SECONDS;
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  await db
    .prepare(`/* pharos:yield-sync:history-retention-delete */ DELETE FROM yield_history WHERE recorded_at < ? ${frozenClause}`)
    .bind(pruneCutoff, ...frozenIdsList)
    .run();

  if (allowDestructiveCleanup) {
    await cleanupFalseLinkedVariantSourceSwitches(db);
    const auditCutoffSec = startSec - AUDIT_DECISION_RETENTION_DAYS * DAY_SECONDS;
    await db
      .prepare(
        `/* pharos:yield-sync:decision-retention-delete */
         DELETE FROM yield_source_decisions
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
        `/* pharos:yield-sync:decision-alternatives-retention-delete */
         DELETE FROM yield_source_decision_alternatives
         WHERE recorded_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM yield_source_decisions d
             WHERE d.generation_id = yield_source_decision_alternatives.generation_id
               AND d.stablecoin_id = yield_source_decision_alternatives.stablecoin_id
           )`,
      )
      .bind(auditCutoffSec)
      .run();
    await purgeYieldHistoryOwnershipHandoffs(db);
  }
}
