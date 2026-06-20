import { runCronSlotSweeper } from "../../cron/cron-slot-sweeper";
import { runCronStalenessWatchdog } from "../../cron/cron-staleness-watchdog";
import { runStatusSelfCheck } from "../../cron/status-self-check";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildStatusSelfCheckSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "status-self-check",
      tasks: [
        {
          job: "cron-slot-sweeper",
          errorMessage: "[cron] cron-slot-sweeper failed in isolated slot:",
          run: (signal) => runCronSlotSweeper(runtime.db, runtime.alertWebhookUrl, signal),
        },
        {
          job: "status-self-check",
          errorMessage: "[cron] status-self-check failed in isolated slot:",
          run: (signal) =>
            runStatusSelfCheck(
              runtime.db,
              runtime.env.SELF_URL,
              signal,
              runtime.ctx,
              runtime.mintBurnFreshnessConfig,
              runtime.alertWebhookUrl,
              runtime.env.SITE_API_SHARED_SECRET,
            ),
        },
        {
          job: "cron-staleness-watchdog",
          errorMessage: "[cron] cron-staleness-watchdog failed in isolated slot:",
          run: (signal) =>
            runCronStalenessWatchdog(
              runtime.db,
              runtime.alertWebhookUrl,
              signal,
            ),
        },
      ],
    },
  ];
}

export async function runStatusSelfCheckSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(
    runtime,
    "isolated status self-check slot",
    buildStatusSelfCheckSlotGroups(runtime),
  );
}
