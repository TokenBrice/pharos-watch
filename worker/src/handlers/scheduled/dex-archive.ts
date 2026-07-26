import { runDexArchiveFoundation } from "../../cron/dex-archive/job";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export function runDexArchiveSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "isolated DEX archive slot", {
    job: "archive-dex-generations",
    run: (signal) => runDexArchiveFoundation(runtime.db, runtime.env, signal),
  });
}
