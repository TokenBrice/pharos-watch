/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   dispatch-telegram-alerts (1)
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 1/6 peak
 */
import { dispatchTelegramAlerts } from "../../cron/dispatch-telegram-alerts";
import type { ScheduledRuntimeContext } from "./context";

export function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext): void {
  if (!runtime.env.TELEGRAM_BOT_TOKEN) {
    return;
  }

  runtime.ctx.waitUntil((async () => {
    try {
      await runtime.runLeasedCron("dispatch-telegram-alerts", (signal) =>
        dispatchTelegramAlerts(runtime.db, runtime.env.TELEGRAM_BOT_TOKEN!, signal),
      );
    } catch (err) {
      console.error("[cron] dispatch-telegram-alerts failed:", err);
    }
  })());
}
