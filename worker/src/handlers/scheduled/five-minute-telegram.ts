/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   dispatch-telegram-alerts (4)
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 4/6 peak
 */
import { dispatchTelegramAlerts } from "../../cron/dispatch-telegram-alerts";
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
    console.error("[cron] Telegram registration reconciliation failed:", err);
  }

  await runBestEffortScheduledJob(
    runtime,
    "five-minute telegram slot",
    "dispatch-telegram-alerts",
    (signal) => dispatchTelegramAlerts(runtime.db, runtime.env.TELEGRAM_BOT_TOKEN!, signal),
    { errorMessage: "[cron] dispatch-telegram-alerts failed:" },
  );
}
