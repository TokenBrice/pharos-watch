/**
 * Daily 08:10 UTC trigger (10 8 * * *):
 *   weekly-recap (1)             ← Monday-only
 *   sync-cl-exit-depth shadow (3) ← daily, independent task
 *
 * Weekly generation is isolated from the daily digest's 14-minute budget.
 * Connection budget: 4/6 peak on Mondays, 3/6 otherwise.
 */
import { generateWeeklyRecap } from "../../cron/weekly-recap";
import { syncDexShadowMeasuredExecution } from "../../cron/measured-execution/sync";
import { buildTelegramCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";
import { settleMeasuredExecutionLane } from "./half-hourly-measured-execution";

export async function runDaily0810Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "daily 08:10 slot", [
    {
      mode: "parallel",
      label: "weekly-jobs",
      tasks: [
        {
          job: "weekly-recap",
          run: (signal, reportProgress) =>
            generateWeeklyRecap(
              runtime.db,
              runtime.env.ANTHROPIC_API_KEY ?? null,
              buildTelegramCreds(runtime.env),
              signal,
              reportProgress,
            ),
        },
        {
          job: "sync-cl-exit-depth",
          run: (signal, reportProgress) =>
            settleMeasuredExecutionLane(
              "evm-shadow",
              syncDexShadowMeasuredExecution(runtime.db, runtime.chainRpcs, signal, reportProgress),
            ),
        },
      ],
    },
  ]);
}
