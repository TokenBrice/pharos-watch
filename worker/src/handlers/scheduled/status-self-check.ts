import { runStatusSelfCheck } from "../../cron/status-self-check";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runStatusSelfCheckSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "isolated status self-check slot", "status-self-check", (signal) =>
    runStatusSelfCheck(
      runtime.db,
      runtime.env.SELF_URL,
      signal,
      runtime.ctx,
      runtime.mintBurnFreshnessConfig,
      runtime.alertWebhookUrl,
    ),
    { errorMessage: "[cron] status-self-check failed in isolated slot:" },
  );
}
