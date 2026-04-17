import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("prune-status-probe-runs", () =>
      runPruneStatusProbeRuns(runtime.db),
    );
  } catch (err) {
    console.error("[cron] prune-status-probe-runs failed in daily 03:00 slot:", err);
  }
}
