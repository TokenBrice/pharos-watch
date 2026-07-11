/**
 * Daily 08:10 UTC trigger (10 8 * * *):
 *   discovery-scan (1)  ← parallel chain, Monday-only
 *   weekly-recap (1)    ← parallel chain, Monday-only
 *
 * Weekly generation is isolated from the daily digest's 14-minute budget.
 * Connection budget: 2/6 peak on Mondays.
 */
import { runDiscoveryScan } from "../../cron/discovery-scan";
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
          job: "discovery-scan",
          run: (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey),
        },
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
