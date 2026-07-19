/**
 * Daily 08:10 UTC trigger (10 8 * * *):
 *   weekly-recap (1)  ← Monday-only
 *
 * Weekly generation is isolated from the daily digest's 14-minute budget.
 * Connection budget: 1/6 peak on Mondays.
 */
import { generateWeeklyRecap } from "../../cron/weekly-recap";
import { buildTelegramCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";

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
      ],
    },
  ]);
}
