import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";
import { runPruneCronHistory } from "../../cron/prune-cron-history";
import { runRepairTaskRunner } from "../../cron/repair-task-runner";
import { runPruneDetailCache } from "../../cron/prune-detail-cache";
import { runTelegramInactiveCleanup } from "../../cron/telegram-inactive-cleanup";
import { runTelegramRetentionCleanup } from "../../cron/telegram-retention-cleanup";
import { runMintBurnGrowthWatchdog } from "../../cron/mint-burn-growth-watchdog";
import { runCronDurationWatchdog } from "../../cron/cron-duration-watchdog";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildDaily0300SlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "retention-and-telegram-housekeeping",
      tasks: [
        {
          job: "prune-status-probe-runs",
          run: (signal) => runPruneStatusProbeRuns(runtime.db, signal),
        },
        {
          job: "prune-cron-history",
          run: (signal) => runPruneCronHistory(runtime.db, signal),
        },
        {
          job: "worker-repair-runner",
          run: (signal) => runRepairTaskRunner(runtime.db, signal),
        },
        {
          job: "prune-detail-cache",
          run: (signal) => runPruneDetailCache(runtime.db, signal),
        },
        {
          job: "telegram-inactive-cleanup",
          run: (signal) => runTelegramInactiveCleanup(runtime.db, signal),
        },
        {
          job: "telegram-retention-cleanup",
          run: (signal) => runTelegramRetentionCleanup(runtime.db, signal),
        },
        {
          job: "mint-burn-growth-watchdog",
          run: (signal) => runMintBurnGrowthWatchdog(
            runtime.db,
            runtime.alertWebhookUrl,
            signal,
          ),
        },
        {
          job: "cron-duration-watchdog",
          run: (signal) => runCronDurationWatchdog(
            runtime.db,
            runtime.alertWebhookUrl,
            signal,
          ),
        },
      ],
    },
  ];
}

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "daily 03:00 slot", buildDaily0300SlotGroups(runtime));
}
