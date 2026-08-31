import { runCronSlotSweeper } from "../../cron/cron-slot-sweeper";
import { runCronStalenessWatchdog } from "../../cron/cron-staleness-watchdog";
import { runDataInvariantCanary } from "../../cron/data-invariant-canary";
import { runStatusSelfCheck } from "../../cron/status-self-check";
import { buildTelegramOperatorCreds } from "../../lib/runtime-credentials";
import { resolveCloudflareD1StatusConfig } from "../../lib/env";
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
          run: (signal) => runCronSlotSweeper(runtime.db, signal, runtime.workerVersion ?? null),
        },
        {
          job: "status-self-check",
          errorMessage: "[cron] status-self-check failed in isolated slot:",
          run: (signal) =>
            runStatusSelfCheck(runtime.db, {
              selfUrl: runtime.env.SELF_URL,
              signal,
              ctx: runtime.ctx,
              mintBurnFreshnessConfig: runtime.mintBurnFreshnessConfig,
              siteApiSharedSecret: runtime.env.SITE_API_SHARED_SECRET,
              d1StatusConfig: resolveCloudflareD1StatusConfig(runtime.env) ?? undefined,
            }),
        },
        {
          job: "data-invariant-canary",
          errorMessage: "[cron] data-invariant-canary failed in isolated slot:",
          run: (signal) =>
            runDataInvariantCanary(runtime.db, {
              mode: runtime.env.WORKER_CANARY_MODE,
              // The serial slot can reach the canary after a newer producer
              // publication. Freshness checks must use execution time; the
              // scheduled slot clock remains available in cron telemetry.
              observedAt: Math.max(
                runtime.slotStartedAt,
                Math.floor(Date.now() / 1_000),
              ),
              signal,
            }),
        },
        {
          job: "cron-staleness-watchdog",
          errorMessage: "[cron] cron-staleness-watchdog failed in isolated slot:",
          run: (signal) =>
            runCronStalenessWatchdog(runtime.db, signal, {
              operatorTelegramCreds: buildTelegramOperatorCreds(runtime.env),
            }),
        },
      ],
    },
  ];
}

export async function runStatusSelfCheckSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "isolated status self-check slot", buildStatusSelfCheckSlotGroups(runtime));
}
