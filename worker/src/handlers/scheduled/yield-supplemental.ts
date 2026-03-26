import { syncYieldSupplemental } from "../../cron/sync-yield-supplemental";
import type { ScheduledRuntimeContext } from "./context";

export async function runYieldSupplementalSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("sync-yield-supplemental", (signal) =>
      syncYieldSupplemental(runtime.db, signal, runtime.chainRpcs),
    );
  } catch (err) {
    console.error("[cron] sync-yield-supplemental failed in multi-hour yield slot:", err);
  }
}
