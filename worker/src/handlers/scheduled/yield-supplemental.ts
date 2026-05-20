import { syncYieldSupplemental } from "../../cron/sync-yield-supplemental";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildYieldSupplementalSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "yield-supplemental",
      tasks: [
        {
          job: "sync-yield-supplemental",
          errorMessage: "[cron] sync-yield-supplemental failed in multi-hour yield slot:",
          run: (signal) => syncYieldSupplemental(runtime.db, signal, runtime.chainRpcs),
        },
      ],
    },
  ];
}

export async function runYieldSupplementalSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runScheduledSlotGroups(
    runtime,
    "multi-hour yield slot",
    buildYieldSupplementalSlotGroups(runtime),
  );
}
