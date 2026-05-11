import {
  ALERT_SAFETY_SOURCE_CACHE_KEY,
  assessAlertSafetySourceCache,
} from "../lib/alert-safety-source-cache";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { sendAlert } from "../lib/alerts";
import type { CronResult } from "../lib/cron-logger";
import { logTelegramEvent } from "../lib/telegram-log";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";

/**
 * Telegram dispatch degradation watchdog. Reads fresh signals after each
 * 5-minute dispatch run and fires a one-shot alert when delivery health
 * crosses a documented threshold. Clearing the threshold emits a single
 * "recovered" alert and resets the corresponding cache flag.
 */

export const PENDING_BACKLOG_THRESHOLD = 500;
export const PENDING_BACKLOG_SUSTAINED_SEC = 20 * 60;
export const ZERO_SEND_STREAK_THRESHOLD = 3;

export const WATCHDOG_KEYS = {
  pendingSince: "telegram:degradation:pending-since",
  safetySourceSince: "telegram:degradation:safety-source-since",
  zeroSendStreak: "telegram:degradation:zero-send-streak",
} as const;

interface WatchdogAlertOutcome {
  triggered: boolean;
  recovered: boolean;
  alertSent: boolean;
  detail: string | null;
}

interface WatchdogResult {
  pendingBacklog: WatchdogAlertOutcome & { count: number | null };
  safetySource: WatchdogAlertOutcome & { state: string | null };
  zeroSend: WatchdogAlertOutcome & { streak: number };
}

function emptyOutcome(): WatchdogAlertOutcome {
  return { triggered: false, recovered: false, alertSent: false, detail: null };
}

async function readPendingCount(db: D1Database): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts")
      .first<{ n: number | null }>();
    return row?.n ?? 0;
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "pending count unavailable",
      action: "read-pending-count",
      module: "telegram-degradation-watchdog",
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function readLatestDispatchMetadata(db: D1Database) {
  try {
    const row = await db
      .prepare(
        "SELECT metadata FROM cron_runs WHERE job = 'dispatch-telegram-alerts' ORDER BY started_at DESC LIMIT 1",
      )
      .first<{ metadata: string | null }>();
    if (!row?.metadata) return null;
    return parseTelegramDispatchCronMetadata(JSON.parse(row.metadata));
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "dispatch metadata unavailable",
      action: "read-dispatch-metadata",
      module: "telegram-degradation-watchdog",
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function readCachedTimestamp(db: D1Database, key: string): Promise<number | null> {
  const cached = await getCache(db, key);
  if (!cached) return null;
  const parsed = Number(cached.value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readCachedInteger(db: D1Database, key: string): Promise<number> {
  const cached = await getCache(db, key);
  if (!cached) return 0;
  const parsed = Number(cached.value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

async function evaluatePendingBacklog(
  db: D1Database,
  alertWebhookUrl: string | null,
  nowSec: number,
): Promise<WatchdogResult["pendingBacklog"]> {
  const count = await readPendingCount(db);
  const flagSince = await readCachedTimestamp(db, WATCHDOG_KEYS.pendingSince);
  const outcome: WatchdogResult["pendingBacklog"] = { ...emptyOutcome(), count };

  if (count == null) {
    return outcome;
  }

  if (count > PENDING_BACKLOG_THRESHOLD) {
    if (flagSince == null) {
      await setCache(db, WATCHDOG_KEYS.pendingSince, String(nowSec));
      outcome.detail = `pending=${count} (newly tripped, watching for sustained breach)`;
      return outcome;
    }
    const ageSec = Math.max(0, nowSec - flagSince);
    if (ageSec >= PENDING_BACKLOG_SUSTAINED_SEC) {
      outcome.triggered = true;
      outcome.alertSent = await sendAlert(
        alertWebhookUrl,
        "Telegram pending backlog sustained",
        `pending=${count} > ${PENDING_BACKLOG_THRESHOLD} for ${Math.round(ageSec / 60)}min`,
      );
      outcome.detail = `pending=${count}, sustainedSec=${ageSec}`;
    } else {
      outcome.detail = `pending=${count}, ageSec=${ageSec}`;
    }
    return outcome;
  }

  if (flagSince != null) {
    await deleteCache(db, WATCHDOG_KEYS.pendingSince);
    outcome.recovered = true;
    outcome.alertSent = await sendAlert(
      alertWebhookUrl,
      "Telegram pending backlog recovered",
      `pending=${count} (cleared after sustained breach)`,
    );
    outcome.detail = `pending=${count}, recovered`;
  }
  return outcome;
}

async function evaluateSafetySource(
  db: D1Database,
  alertWebhookUrl: string | null,
  nowSec: number,
): Promise<WatchdogResult["safetySource"]> {
  const producerIntervalSec = CRON_INTERVALS["publish-report-card-cache"];
  const sustainedSec = producerIntervalSec * 2;
  const cached = await getCache(db, ALERT_SAFETY_SOURCE_CACHE_KEY);
  const assessment = assessAlertSafetySourceCache(cached, { nowSec, producerIntervalSec });
  const flagSince = await readCachedTimestamp(db, WATCHDOG_KEYS.safetySourceSince);
  const outcome: WatchdogResult["safetySource"] = { ...emptyOutcome(), state: assessment.state };

  if (assessment.state !== "ok") {
    if (flagSince == null) {
      await setCache(db, WATCHDOG_KEYS.safetySourceSince, String(nowSec));
      outcome.detail = `state=${assessment.state} (newly tripped)`;
      return outcome;
    }
    const ageSec = Math.max(0, nowSec - flagSince);
    if (ageSec >= sustainedSec) {
      outcome.triggered = true;
      outcome.alertSent = await sendAlert(
        alertWebhookUrl,
        "Telegram safety-source cache degraded",
        `state=${assessment.state} for ${Math.round(ageSec / 60)}min ` +
          `(>${Math.round(sustainedSec / 60)}min, ageSeconds=${assessment.ageSeconds ?? "n/a"})`,
      );
      outcome.detail = `state=${assessment.state}, sustainedSec=${ageSec}`;
    } else {
      outcome.detail = `state=${assessment.state}, ageSec=${ageSec}`;
    }
    return outcome;
  }

  if (flagSince != null) {
    await deleteCache(db, WATCHDOG_KEYS.safetySourceSince);
    outcome.recovered = true;
    outcome.alertSent = await sendAlert(
      alertWebhookUrl,
      "Telegram safety-source cache recovered",
      "state=ok",
    );
    outcome.detail = "state=ok, recovered";
  }
  return outcome;
}

function sumEvents(metadata: ReturnType<typeof parseTelegramDispatchCronMetadata>): number {
  const events = metadata?.eventsDetected;
  if (!events) return 0;
  return (
    (events.dews ?? 0) +
    (events.depeg ?? 0) +
    (events.safety ?? 0) +
    (events.launch ?? 0)
  );
}

async function evaluateZeroSendStreak(
  db: D1Database,
  alertWebhookUrl: string | null,
): Promise<WatchdogResult["zeroSend"]> {
  const metadata = await readLatestDispatchMetadata(db);
  const priorStreak = await readCachedInteger(db, WATCHDOG_KEYS.zeroSendStreak);
  const outcome: WatchdogResult["zeroSend"] = { ...emptyOutcome(), streak: priorStreak };

  if (!metadata) {
    return outcome;
  }

  const events = sumEvents(metadata);
  const messagesSent = metadata.messagesSent ?? 0;
  const zeroSendRun = events > 0 && messagesSent === 0;

  if (zeroSendRun) {
    const nextStreak = priorStreak + 1;
    await setCache(db, WATCHDOG_KEYS.zeroSendStreak, String(nextStreak));
    outcome.streak = nextStreak;
    if (nextStreak >= ZERO_SEND_STREAK_THRESHOLD) {
      outcome.triggered = true;
      outcome.alertSent = await sendAlert(
        alertWebhookUrl,
        "Telegram dispatch sent zero messages with pending events",
        `eventsDetected=${events}, messagesSent=0, consecutiveZeroSendRuns=${nextStreak}`,
      );
      outcome.detail = `eventsDetected=${events}, streak=${nextStreak}`;
    } else {
      outcome.detail = `eventsDetected=${events}, streak=${nextStreak}`;
    }
    return outcome;
  }

  if (priorStreak >= ZERO_SEND_STREAK_THRESHOLD) {
    await deleteCache(db, WATCHDOG_KEYS.zeroSendStreak);
    outcome.streak = 0;
    outcome.recovered = true;
    outcome.alertSent = await sendAlert(
      alertWebhookUrl,
      "Telegram dispatch zero-send streak recovered",
      `messagesSent=${messagesSent}, eventsDetected=${events}`,
    );
    outcome.detail = `recovered after streak=${priorStreak}`;
    return outcome;
  }

  if (priorStreak > 0) {
    await deleteCache(db, WATCHDOG_KEYS.zeroSendStreak);
    outcome.streak = 0;
    outcome.detail = `streak reset (priorStreak=${priorStreak})`;
  }
  return outcome;
}

export async function runTelegramDegradationWatchdog(
  db: D1Database,
  alertWebhookUrl: string | null,
  signal?: AbortSignal,
): Promise<CronResult> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("telegram-degradation-watchdog aborted");
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const pendingBacklog = await evaluatePendingBacklog(db, alertWebhookUrl, nowSec);
  const safetySource = await evaluateSafetySource(db, alertWebhookUrl, nowSec);
  const zeroSend = await evaluateZeroSendStreak(db, alertWebhookUrl);

  const result: WatchdogResult = { pendingBacklog, safetySource, zeroSend };
  const degraded = pendingBacklog.triggered || safetySource.triggered || zeroSend.triggered;

  return {
    status: degraded ? "degraded" : "ok",
    metadata: JSON.stringify(result),
  };
}
