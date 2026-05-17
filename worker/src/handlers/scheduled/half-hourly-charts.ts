/**
 * Half-hourly charts trigger (16,46 * * * *):
 *   sync-stablecoin-charts (1)
 *
 * The charts writer keeps its own lightweight lane so the hourly full-write
 * path does not steal CPU budget from the heavier DEX scoring slot.
 * Successful writes remain cooldown-gated to once per hour.
 */
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildHalfHourlyChartsSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "stablecoin-charts",
      tasks: [
        {
          job: "sync-stablecoin-charts",
          run: (signal) => syncStablecoinCharts(runtime.db, signal),
        },
      ],
    },
  ];
}

export async function runHalfHourlyChartsSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runScheduledSlotGroups(
    runtime,
    "half-hour charts slot",
    buildHalfHourlyChartsSlotGroups(runtime),
  );
}
