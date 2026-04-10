import { runStatusSelfCheck } from "../../cron/status-self-check";
import type { ScheduledRuntimeContext } from "./context";

export async function runStatusSelfCheckSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("status-self-check", (signal) => runStatusSelfCheck(
      runtime.db,
      runtime.env.SELF_URL,
      signal,
      runtime.ctx,
      runtime.mintBurnFreshnessConfig,
      runtime.alertWebhookUrl,
    ));
  } catch (err) {
    console.error("[cron] status-self-check failed in isolated slot:", err);
  }
}
