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
import { syncTronDexMeasuredExecution } from "../../cron/measured-execution/tron-sync";
import { throwIfAborted } from "../../lib/abort";
import { buildTelegramCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";
import { mergeMeasuredExecutionResults, settleMeasuredExecutionLane } from "./half-hourly-measured-execution";

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
          run: async (signal, reportProgress) => {
            const evm = await settleMeasuredExecutionLane(
              "evm-shadow",
              syncDexShadowMeasuredExecution(runtime.db, runtime.chainRpcs, signal, reportProgress),
            );
            throwIfAborted(signal);
            const solana = {
              status: "skipped_neutral" as const,
              itemCount: 0,
              metadata: JSON.stringify({ reason: "half-hour-native-lane" }),
              productivity: { productive: false, reason: "half-hour-native-lane" },
            };
            const tron = await settleMeasuredExecutionLane(
              "tron-shadow",
              syncTronDexMeasuredExecution(runtime.db, runtime.env.TRONGRID_API_KEY, signal, reportProgress),
            );
            throwIfAborted(signal);
            return mergeMeasuredExecutionResults(evm, solana, tron);
          },
        },
      ],
    },
  ]);
}
