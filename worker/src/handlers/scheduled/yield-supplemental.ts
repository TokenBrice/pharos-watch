import { syncYieldSupplemental } from "../../cron/sync-yield-supplemental";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runYieldSupplementalSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "multi-hour yield slot", "sync-yield-supplemental", (signal) =>
    syncYieldSupplemental(runtime.db, signal, runtime.chainRpcs),
    { errorMessage: "[cron] sync-yield-supplemental failed in multi-hour yield slot:" },
  );
}
