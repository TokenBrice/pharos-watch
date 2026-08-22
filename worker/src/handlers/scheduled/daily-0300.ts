import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";
import { runPruneCronHistory } from "../../cron/prune-cron-history";
import { runRepairTaskRunner } from "../../cron/repair-task-runner";
import { runPruneDetailCache } from "../../cron/prune-detail-cache";
import { runTelegramInactiveCleanup } from "../../cron/telegram-inactive-cleanup";
import { runTelegramRetentionCleanup } from "../../cron/telegram-retention-cleanup";
import { runMintBurnGrowthWatchdog } from "../../cron/mint-burn-growth-watchdog";
import { runCronDurationWatchdog } from "../../cron/cron-duration-watchdog";
import { resolveDdrRepairTaskRunnerConfig } from "../../lib/env";
import { logWorkerEvent } from "../../lib/structured-log";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildDaily0300SlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  const ddrRepairTaskRunner = resolveDdrRepairTaskRunnerConfig(runtime.env);
  if (ddrRepairTaskRunner.warning) {
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "ddr_repair_task_runner_invalid_env",
      message: ddrRepairTaskRunner.warning.message,
      job: "worker-repair-runner",
      metadata: {
        binding: "DDR_REPAIR_TASK_RUNNER_ENABLED",
        code: ddrRepairTaskRunner.warning.code,
        fallback: "disabled",
      },
    });
  }

  return [
    {
      mode: "serial",
      label: "retention-and-telegram-housekeeping",
      tasks: [
        {
          job: "mint-burn-growth-watchdog",
          run: (signal) => runMintBurnGrowthWatchdog(runtime.db, signal),
        },
        {
          job: "cron-duration-watchdog",
          run: (signal) => runCronDurationWatchdog(runtime.db, signal),
        },
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
          run: (signal) => runRepairTaskRunner(
            runtime.db,
            signal,
            ddrRepairTaskRunner.enabled,
          ),
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
      ],
    },
  ];
}

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "daily 03:00 slot", buildDaily0300SlotGroups(runtime));
}
