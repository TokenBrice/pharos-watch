/**
 * Daily 08:10 UTC trigger (10 8 * * *):
 *   discovery-scan (1)
 *
 * This isolates the weekly CoinGecko coverage scan from the 08:05 digest and
 * Bluechip lane so both triggers retain connection headroom.
 */
import { runDiscoveryScan } from "../../cron/discovery-scan";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildDaily0810SlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "discovery-scan",
      tasks: [
        {
          job: "discovery-scan",
          run: (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey),
        },
      ],
    },
  ];
}

export async function runDaily0810Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runScheduledSlotGroups(runtime, "daily 08:10 slot", buildDaily0810SlotGroups(runtime));
}
