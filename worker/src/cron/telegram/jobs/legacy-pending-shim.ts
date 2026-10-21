import { TELEGRAM_PENDING_DRAIN_BUDGET } from "../../../telegram/common/constants";
import { cleanupExpiredPendingAlerts } from "../delivery/cleanup";
import { drainPendingQueue, reconcilePendingQueueMaintenance } from "../delivery/drain";

export interface LegacyPendingShimResult {
  active: boolean;
  attempted: number;
  sent: number;
  expiredOrPruned: number;
}

/**
 * Temporary drain-only shim for `telegram_pending_alerts` (delivery v2
 * cutover). Nothing enqueues there any more: this drains what is left (2 h
 * TTL), lets stale `sending` rows become `execution_unknown` (never replayed)
 * and ages out the 24 h `sent` rows that still back cross-pipeline duplicate
 * suppression. Old `execution_unknown` rows are terminal and left alone.
 * Deleted with the legacy pipeline (PR D).
 */
export async function runLegacyPendingDrainShim(
  db: D1Database,
  botToken: string,
  nowSec: number,
  options: { signal?: AbortSignal; softDeadlineAtMs?: number | null; transportAllowed: boolean; onDeliveryStarted?: () => void },
): Promise<LegacyPendingShimResult> {
  const live = await db.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM telegram_pending_alerts WHERE delivery_state IN ('pending', 'sending')) AS open_rows,
       EXISTS (SELECT 1 FROM telegram_pending_alerts WHERE delivery_state = 'sent') AS sent_rows`,
  ).first<{ open_rows: number; sent_rows: number }>();
  const openRows = Number(live?.open_rows ?? 0) === 1;
  if (!openRows && Number(live?.sent_rows ?? 0) !== 1) {
    return { active: false, attempted: 0, sent: 0, expiredOrPruned: 0 };
  }
  let attempted = 0;
  let sent = 0;
  if (openRows && options.transportAllowed) {
    const maintenanceResult = await reconcilePendingQueueMaintenance(db, nowSec);
    const drain = await drainPendingQueue(db, botToken, TELEGRAM_PENDING_DRAIN_BUDGET, options.signal, {
      softDeadlineAtMs: options.softDeadlineAtMs ?? undefined,
      maintenanceResult,
      ...(options.onDeliveryStarted ? { markTelegramDeliveryStarted: options.onDeliveryStarted } : {}),
    });
    attempted = drain.attempted;
    sent = drain.sent;
  }
  const expiredOrPruned = await cleanupExpiredPendingAlerts(db, nowSec);
  return { active: true, attempted, sent, expiredOrPruned };
}
