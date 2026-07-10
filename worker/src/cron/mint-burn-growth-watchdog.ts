import { deliverOperationalAlert } from "../lib/operational-alert";
import { readAlertMarker } from "../lib/alert-marker";
import type { CronResult } from "../lib/cron-logger";
import { getCache, setCache } from "../lib/db-cache";
import { throwIfAborted } from "../lib/abort";

/**
 * `mint_burn_events` is append-only by product decision: it is the immutable
 * on-chain event log behind /flows history and Telegram flow alerts, and no
 * retention pruning is applied. This watchdog enforces the agreed growth
 * budget instead — at ~1.43M rows the database sat at 3.09 GB of the 10 GB D1
 * cap, so ~2.3M rows extrapolates to the agreed ~5 GB revisit point. Crossing
 * the threshold alerts (with weekly redelivery) so the append-only decision
 * gets actively revisited instead of silently drifting toward the cap.
 * D1 disallows PRAGMA page_count, hence the row-count proxy.
 */
export const MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD = 2_300_000;
const ALERT_COOLDOWN_SEC = 7 * 86400;
const ALERT_MARKER_KEY = "mint-burn-growth-watchdog:alert";

interface AlertMarker {
  lastAlertedAt: number;
  rowCount: number;
}

function readMarker(value: string | null | undefined): AlertMarker | null {
  return readAlertMarker<AlertMarker>(
    value,
    (p): p is AlertMarker =>
      typeof p.lastAlertedAt === "number" && typeof p.rowCount === "number",
  );
}

export async function runMintBurnGrowthWatchdog(
  db: D1Database,
  alertWebhookUrl: string | null,
  signal?: AbortSignal,
  alertBrokerMode?: string,
): Promise<CronResult> {
  throwIfAborted(signal);
  const row = await db
    .prepare("SELECT COUNT(*) AS row_count FROM mint_burn_events")
    .first<{ row_count: number }>();
  throwIfAborted(signal);
  const rowCount = row?.row_count ?? 0;

  if (rowCount < MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD) {
    if (alertBrokerMode != null) {
      await deliverOperationalAlert({
        db,
        conditionKey: "capacity:mint-burn-events-growth",
        active: false,
        severity: "warning",
        title: "mint_burn_events growth budget exceeded",
        message: `Row count ${rowCount} is below the configured growth threshold.`,
        recoveryTitle: "mint_burn_events growth budget recovered",
        recoveryMessage: "The append-only mint/burn event table is below its review threshold.",
        webhookUrl: alertWebhookUrl,
        brokerMode: alertBrokerMode,
      });
    }
    return {
      itemCount: rowCount,
      metadata: JSON.stringify({ rowCount, thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD }),
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const marker = readMarker((await getCache(db, ALERT_MARKER_KEY))?.value);
  throwIfAborted(signal);

  let alerted = false;
  const dueForAlert = alertBrokerMode != null
    || nowSec - (marker?.lastAlertedAt ?? 0) >= ALERT_COOLDOWN_SEC;
  if (dueForAlert) {
    alerted = await deliverOperationalAlert({
      db,
      conditionKey: "capacity:mint-burn-events-growth",
      active: true,
      severity: "warning",
      title: "mint_burn_events growth budget exceeded",
      message: [
        `mint_burn_events has ${rowCount.toLocaleString("en-US")} rows (threshold ${MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD.toLocaleString("en-US")}, ~5 GB D1 revisit point).`,
        "The table is append-only by product decision (docs/mint-burn-flows.md § Retention).",
        "Revisit retention: document a raised budget, or archive older rows into the dated snapshot export.",
      ].join("\n"),
      recoveryTitle: "mint_burn_events growth budget recovered",
      recoveryMessage: "The append-only mint/burn event table is below its review threshold.",
      fingerprint: { capacity: "mint-burn-events-growth" },
      metadata: { rowCount, thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD },
      webhookUrl: alertWebhookUrl,
      brokerMode: alertBrokerMode,
      cooldownSec: ALERT_COOLDOWN_SEC,
    });
    if (alerted) {
      await setCache(db, ALERT_MARKER_KEY, JSON.stringify({ lastAlertedAt: nowSec, rowCount } satisfies AlertMarker));
    }
  }

  return {
    status: "degraded",
    itemCount: rowCount,
    metadata: JSON.stringify({
      rowCount,
      thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
      alerted,
      suppressedByCooldown: !dueForAlert,
    }),
  };
}
