import { syncYieldSupplemental } from "../../cron/sync-yield-supplemental";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runYieldSupplementalSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "multi-hour yield slot", {
    job: "sync-yield-supplemental",
    errorMessage: "[cron] sync-yield-supplemental failed in multi-hour yield slot:",
    run: (signal, reportProgress) =>
      syncYieldSupplemental(runtime.db, signal, runtime.chainRpcs, reportProgress),
  });
}
