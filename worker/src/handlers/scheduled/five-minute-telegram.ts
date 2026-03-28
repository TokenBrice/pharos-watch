/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   dispatch-telegram-alerts (1)
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 1/6 peak
 */
import { dispatchTelegramAlerts } from "../../cron/dispatch-telegram-alerts";
import { reconcileTelegramWebhookRegistration } from "../../lib/telegram-webhook-registration";
import type { ScheduledRuntimeContext } from "./context";

export async function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  if (!runtime.env.TELEGRAM_BOT_TOKEN) {
    return;
  }

  try {
    const result = await reconcileTelegramWebhookRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: runtime.env.TELEGRAM_WEBHOOK_SECRET,
      selfUrl: runtime.env.SELF_URL,
    });
    if (result.attempted) {
      console.log(`[cron] Reconciled Telegram webhook registration: ${result.expectedUrl}`);
    }
  } catch (err) {
    console.error("[cron] Telegram webhook reconciliation failed:", err);
  }

  try {
    await runtime.runLeasedCron("dispatch-telegram-alerts", (signal) =>
      dispatchTelegramAlerts(runtime.db, runtime.env.TELEGRAM_BOT_TOKEN!, signal),
    );
  } catch (err) {
    console.error("[cron] dispatch-telegram-alerts failed:", err);
  }
}
