import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";
import { runPruneCronHistory } from "../../cron/prune-cron-history";

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("prune-status-probe-runs", () =>
      runPruneStatusProbeRuns(runtime.db),
    );
  } catch (err) {
    console.error("[cron] prune-status-probe-runs failed in daily 03:00 slot:", err);
  }

  try {
    await runtime.runLeasedCron("prune-cron-history", () =>
      runPruneCronHistory(runtime.db),
    );
  } catch (err) {
    console.error("[cron] prune-cron-history failed in daily 03:00 slot:", err);
  }
}
