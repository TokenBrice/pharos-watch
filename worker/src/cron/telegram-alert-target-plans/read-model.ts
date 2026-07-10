import { parsePendingAlertScope, parsePendingMarkupPolicy } from "../../lib/telegram-pending-provenance";

export async function loadTelegramTargetPlanProgress(
  db: D1Database,
  sourceEventId: string,
): Promise<{
  state: string;
  generation: number;
  capturedSubscribers: number;
  planningOutcomes: Record<string, number>;
  plans: number;
  targets: number;
  expiry: null | {
    state: string;
    processed: number;
    remaining: number;
    oldestUpdatedAt: number;
  };
}> {
  const source = await db
    .prepare(
      `SELECT target_plan_state, target_plan_generation
         FROM telegram_alert_source_events WHERE source_event_id = ?`,
    )
    .bind(sourceEventId)
    .first<{ target_plan_state: string; target_plan_generation: number }>();
  if (!source) throw new Error("Telegram source event was not found");
  const [subscriberCounts, planCounts] = await Promise.all([
    db
      .prepare(
        `SELECT planning_outcome, COUNT(*) AS count
           FROM telegram_alert_planning_subscribers
          WHERE source_event_id = ? AND plan_generation = ?
          GROUP BY planning_outcome`,
      )
      .bind(sourceEventId, source.target_plan_generation)
      .all<{ planning_outcome: string; count: number }>(),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM telegram_alert_target_plans
             WHERE source_event_id = ? AND plan_generation = ?) AS plans,
           (SELECT COUNT(*) FROM telegram_alert_job_targets
             WHERE source_event_id = ? AND plan_generation = ?) AS targets`,
      )
      .bind(
        sourceEventId,
        source.target_plan_generation,
        sourceEventId,
        source.target_plan_generation,
      )
      .first<{ plans: number; targets: number }>(),
  ]);
  const planningOutcomes: Record<string, number> = {};
  let capturedSubscribers = 0;
  for (const row of subscriberCounts.results ?? []) {
    planningOutcomes[row.planning_outcome] = Number(row.count);
    capturedSubscribers += Number(row.count);
  }
  const expiryRow = await db
    .prepare(
      `SELECT state,
              processed_subscribers + processed_pages + processed_plans + processed_targets AS processed,
              remaining_subscribers + remaining_pages + remaining_plans + remaining_targets AS remaining,
              updated_at
         FROM telegram_alert_target_expiry_progress
        WHERE source_event_id = ? AND plan_generation = ?`,
    )
    .bind(sourceEventId, source.target_plan_generation)
    .first<{ state: string; processed: number; remaining: number; updated_at: number }>();
  return {
    state: source.target_plan_state,
    generation: Number(source.target_plan_generation),
    capturedSubscribers,
    planningOutcomes,
    plans: Number(planCounts?.plans ?? 0),
    targets: Number(planCounts?.targets ?? 0),
    expiry: expiryRow
      ? {
          state: expiryRow.state,
          processed: Number(expiryRow.processed),
          remaining: Number(expiryRow.remaining),
          oldestUpdatedAt: Number(expiryRow.updated_at),
        }
      : null,
  };
}

export function validatePersistedTargetColumns(row: {
  alertScopeJson: string;
  markupPolicyJson: string;
}): boolean {
  return parsePendingAlertScope(row.alertScopeJson).kind === "ok" &&
    parsePendingMarkupPolicy(row.markupPolicyJson).kind === "ok";
}
