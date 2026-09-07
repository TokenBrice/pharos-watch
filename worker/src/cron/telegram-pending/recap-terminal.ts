import {
  projectTelegramRecapTerminalOutcome,
  type TelegramRecapTerminalOutcome,
} from "../../lib/telegram/recap-store";
import type { DeadLetterPendingRow, PendingAlertRow } from "./types";

type RecapPendingRow = Pick<
  PendingAlertRow | DeadLetterPendingRow,
  "source_type" | "source_event_id"
>;

function recapKeyForPending(row: RecapPendingRow): string | null {
  return row.source_type === "personalized_recap" && typeof row.source_event_id === "string"
    ? row.source_event_id
    : null;
}

/** Project a terminal delivery result without routing recap rows through alert targets. */
export async function projectRecapPendingTerminalOutcome(
  db: D1Database,
  row: RecapPendingRow,
  outcome: TelegramRecapTerminalOutcome,
  nowSec: number,
  reason?: string | null,
): Promise<void> {
  const recapKey = recapKeyForPending(row);
  if (!recapKey) return;
  await projectTelegramRecapTerminalOutcome(db, recapKey, outcome, nowSec, reason);
}

/**
 * Repair the only two durable states that may survive a process crash after a
 * Bot API effect: accepted sends and ambiguous sends. Other terminal paths
 * project before their queue row is deleted.
 */
export async function reconcileRecapPendingTerminalOutcomes(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const rows = await db.prepare(`
    SELECT pending.source_type, pending.source_event_id, pending.delivery_state, pending.last_error_class
      FROM telegram_pending_alerts pending
      JOIN telegram_recap_targets t ON t.recap_key = pending.source_event_id
     WHERE pending.source_type = 'personalized_recap'
       AND pending.delivery_state IN ('sent', 'execution_unknown')
       AND t.status IN ('planned', 'queued')
     ORDER BY pending.id ASC
  `).all<{
    source_type: string | null;
    source_event_id: string | null;
    delivery_state: "sent" | "execution_unknown";
    last_error_class: string | null;
  }>();
  let projected = 0;
  for (const row of rows.results ?? []) {
    const outcome = row.delivery_state === "sent" ? "accepted" : "execution_unknown";
    await projectRecapPendingTerminalOutcome(db, row, outcome, nowSec, row.last_error_class);
    projected++;
  }
  return projected;
}
