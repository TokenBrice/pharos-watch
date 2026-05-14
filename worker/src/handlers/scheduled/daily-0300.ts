import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";
import { runPruneCronHistory } from "../../cron/prune-cron-history";
import { runTelegramInactiveCleanup } from "../../cron/telegram-inactive-cleanup";
import { runTelegramRetentionCleanup } from "../../cron/telegram-retention-cleanup";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildDaily0300SlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "retention-and-telegram-housekeeping",
      tasks: [
        {
          job: "prune-status-probe-runs",
          kind: "db-only-sidecar",
          run: (signal) => runPruneStatusProbeRuns(runtime.db, signal),
        },
        {
          job: "prune-cron-history",
          kind: "db-only-sidecar",
          run: (signal) => runPruneCronHistory(runtime.db, signal),
        },
        {
          job: "telegram-inactive-cleanup",
          kind: "db-only-sidecar",
          run: (signal) =>
            runTelegramInactiveCleanup(runtime.db, signal, runtime.env.TELEGRAM_BOT_TOKEN),
        },
        {
          job: "telegram-retention-cleanup",
          kind: "db-only-sidecar",
          run: (signal) => runTelegramRetentionCleanup(runtime.db, signal),
        },
      ],
    },
  ];
}

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runScheduledSlotGroups(runtime, "daily 03:00 slot", buildDaily0300SlotGroups(runtime));
}
