import { dispatchTelegramAlerts } from "../../cron/dispatch-telegram-alerts";
import { announceCemeteryAdditions } from "../../cron/announce-cemetery-additions";
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

    if (!runtime.env.TELEGRAM_CHAT_ID) return;

    try {
      await runtime.runLeasedCron("announce-cemetery-additions", () =>
        announceCemeteryAdditions(runtime.db, runtime.env.TELEGRAM_BOT_TOKEN!, runtime.env.TELEGRAM_CHAT_ID!),
      );
    } catch (err) {
      console.error("[cron] announce-cemetery-additions failed:", err);
    }
  })());
}
