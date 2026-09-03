import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";
import { runPruneCronHistory } from "../../cron/prune-cron-history";
import { runPruneDetailCache } from "../../cron/prune-detail-cache";
import { runTelegramInactiveCleanup } from "../../cron/telegram-inactive-cleanup";
import { runTelegramRetentionCleanup } from "../../cron/telegram-retention-cleanup";
import { runCronSentinel } from "../../cron/cron-sentinel";
import { resolveDdrRepairTaskRunnerConfig } from "../../lib/env";
import { logWorkerEvent } from "../../lib/structured-log";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

function buildDaily0300SlotGroups(runtime: ScheduledRuntimeContext) {
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

  return bindScheduledSlotPlan("daily0300Utc", {
    mode: "serial",
    label: "retention-and-telegram-housekeeping",
    implementations: {
      "cron-sentinel": (signal) => runCronSentinel(runtime.db, {
        mode: "daily",
        nowSec: Math.floor(Date.now() / 1_000),
        repairRunnerEnabled: ddrRepairTaskRunner.enabled,
        signal,
      }),
      "prune-status-probe-runs": (signal) => runPruneStatusProbeRuns(runtime.db, signal),
      "prune-cron-history": (signal) => runPruneCronHistory(runtime.db, signal),
      "prune-detail-cache": (signal) => runPruneDetailCache(runtime.db, signal),
      "telegram-inactive-cleanup": (signal) => runTelegramInactiveCleanup(runtime.db, signal),
      "telegram-retention-cleanup": (signal) => runTelegramRetentionCleanup(runtime.db, signal),
    },
  });
}

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "daily 03:00 slot", buildDaily0300SlotGroups(runtime));
}
