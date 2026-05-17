import { syncYieldData } from "../../cron/sync-yield-data";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildHourlyYieldSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "yield-data",
      tasks: [
        {
          job: "sync-yield-data",
          run: (signal) =>
            syncYieldData(
              runtime.db,
              signal,
              runtime.chainRpcs,
              runtime.coingeckoApiKey,
              runtime.env.ETHERSCAN_API_KEY ?? null,
            ),
        },
      ],
    },
  ];
}

export async function runHourlyYieldSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runScheduledSlotGroups(runtime, "hourly yield slot", buildHourlyYieldSlotGroups(runtime));
}
