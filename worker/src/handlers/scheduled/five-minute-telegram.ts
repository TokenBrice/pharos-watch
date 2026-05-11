/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   dispatch-telegram-alerts (4) -> telegram-degradation-watchdog (0) -> telegram-disambiguation-cleanup (1)
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 4/6 peak
 */
import { dispatchTelegramAlerts } from "../../cron/dispatch-telegram-alerts";
import { runTelegramDegradationWatchdog } from "../../cron/telegram-degradation-watchdog";
import { cleanExpiredDisambiguations } from "../../cron/telegram-quiet-hours";
import { logTelegramEvent } from "../../lib/telegram-log";
import {
  reconcileTelegramCommandRegistration,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
} from "../../lib/telegram-webhook-registration";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  if (!runtime.env.TELEGRAM_BOT_TOKEN) {
    return;
  }

  try {
    const commandsResult = await reconcileTelegramCommandRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
    });
    if (commandsResult.attempted) {
      console.log("[cron] Reconciled Telegram command suggestions");
    }

    const profileResult = await reconcileTelegramProfileRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
    });
    if (profileResult.attempted) {
      console.log("[cron] Reconciled Telegram bot profile metadata");
    }

    const result = await reconcileTelegramWebhookRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: runtime.env.TELEGRAM_WEBHOOK_SECRET,
      selfUrl: runtime.env.SELF_URL,
    });
    if (result.attempted) {
      console.log(`[cron] Reconciled Telegram webhook registration: ${result.expectedUrl}`);
    }
  } catch (err) {
    logTelegramEvent({
      message: "registration reconciliation failed",
      action: "reconcile-registration",
      module: "five-minute-telegram",
      err: err instanceof Error ? err.message : String(err),
    });
  }

  await runBestEffortScheduledJob(
    runtime,
    "five-minute telegram slot",
    "dispatch-telegram-alerts",
    (signal) => dispatchTelegramAlerts(runtime.db, runtime.env.TELEGRAM_BOT_TOKEN!, signal),
    { errorMessage: "[cron] dispatch-telegram-alerts failed:" },
  );

  await runBestEffortScheduledJob(
    runtime,
    "five-minute telegram slot",
    "telegram-degradation-watchdog",
    (signal) => runTelegramDegradationWatchdog(runtime.db, runtime.alertWebhookUrl, signal),
    { errorMessage: "[cron] telegram-degradation-watchdog failed:" },
  );

  await runBestEffortScheduledJob(
    runtime,
    "five-minute telegram slot",
    "telegram-disambiguation-cleanup",
    (signal) => cleanExpiredDisambiguations(runtime.db, signal),
    { errorMessage: "[cron] telegram-disambiguation-cleanup failed:" },
  );
}
