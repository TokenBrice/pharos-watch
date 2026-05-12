/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   serial:
 *     dispatch-telegram-alerts (4) -> telegram-degradation-watchdog (0) -> telegram-disambiguation-cleanup (0)
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
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildTelegramSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "telegram-alerts-and-sidecars",
      tasks: [
        {
          job: "dispatch-telegram-alerts",
          errorMessage: "[cron] dispatch-telegram-alerts failed:",
          run: (signal) => dispatchTelegramAlerts(runtime.db, runtime.env.TELEGRAM_BOT_TOKEN!, signal),
        },
        {
          job: "telegram-degradation-watchdog",
          errorMessage: "[cron] telegram-degradation-watchdog failed:",
          run: (signal) => runTelegramDegradationWatchdog(runtime.db, runtime.alertWebhookUrl, signal),
        },
        {
          job: "telegram-disambiguation-cleanup",
          kind: "db-only-sidecar",
          errorMessage: "[cron] telegram-disambiguation-cleanup failed:",
          run: (signal) => cleanExpiredDisambiguations(runtime.db, signal),
        },
      ],
    },
  ];
}

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

  await runScheduledSlotGroups(runtime, "five-minute telegram slot", buildTelegramSlotGroups(runtime));
}
