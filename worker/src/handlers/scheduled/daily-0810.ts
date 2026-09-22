/**
 * Daily 08:10 UTC trigger (10 8 * * *):
 *   weekly-recap (1)             ← Monday-only
 *   sync-cl-exit-depth shadow (3) ← daily, independent task
 *
 * Weekly generation is isolated from the daily digest's 14-minute budget.
 * Connection budget: 4/6 peak on Mondays, 3/6 otherwise.
 */
import { syncDexShadowMeasuredExecution } from "../../cron/measured-execution/sync";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";
import { settleMeasuredExecutionLane } from "./half-hourly-measured-execution";
import { runWeeklyRecapForRuntime } from "./weekly-recap-invocation";

export function buildDaily0810SlotGroups(runtime: ScheduledRuntimeContext) {
  return bindScheduledSlotPlan("daily0810Utc", {
    mode: "parallel-serial",
    label: "weekly-jobs",
    chainLabels: ["weekly-recap", "measured-execution-shadow"],
    implementations: {
      "weekly-recap": (signal, reportProgress) => runWeeklyRecapForRuntime(runtime, signal, reportProgress),
      "sync-cl-exit-depth": (signal, reportProgress) =>
        settleMeasuredExecutionLane(
          "evm-shadow",
          syncDexShadowMeasuredExecution(runtime.db, runtime.chainRpcs, signal, reportProgress),
        ),
    },
  });
}

export async function runDaily0810Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "daily 08:10 slot", buildDaily0810SlotGroups(runtime));
}
