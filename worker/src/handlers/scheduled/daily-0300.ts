import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";
import { runPruneCronHistory } from "../../cron/prune-cron-history";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "daily 03:00 slot", "prune-status-probe-runs", (signal) =>
    runPruneStatusProbeRuns(runtime.db, signal),
  );

  await runBestEffortScheduledJob(runtime, "daily 03:00 slot", "prune-cron-history", (signal) =>
    runPruneCronHistory(runtime.db, signal),
  );
}
