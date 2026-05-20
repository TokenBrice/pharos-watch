/**
 * Daily 08:00 UTC trigger (0 8 * * *):
 *   snapshot-supply (0)
 *   snapshot-safety-grade-history (0) → snapshot-psi (0) → snapshot-public-dataset (0)
 *   fetch-tbill-rate (1) → sync-usds-status (1)  ← chained to avoid connection contention
 *
 * Connection budget: 1/6 peak
 */
import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotSafetyGradeHistory } from "../../cron/snapshot-safety-grade-history";
import { fetchTbillRate } from "../../cron/fetch-tbill-rate";
import { snapshotPsiDaily } from "../../cron/snapshot-psi";
import { snapshotPublicDataset } from "../../cron/snapshot-public-dataset";
import { syncUsdsStatus } from "../../cron/sync-usds-status";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

const SLOT_LABEL = "daily 08:00 slot";

function buildSnapshotSupplyGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "snapshot-supply",
      tasks: [
        {
          job: "snapshot-supply",
          run: (signal) => snapshotSupply(runtime.db, signal),
        },
      ],
    },
  ];
}

function buildSafetyPsiPublicGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "safety-psi-public",
      tasks: [
        {
          job: "snapshot-safety-grade-history",
          run: (signal) => snapshotSafetyGradeHistory(runtime.db, signal),
        },
        {
          job: "snapshot-psi",
          run: (signal) => snapshotPsiDaily(runtime.db, signal),
        },
        {
          job: "snapshot-public-dataset",
          run: (signal) => snapshotPublicDataset(runtime.db, signal),
        },
      ],
    },
  ];
}

function buildTbillUsdsGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "tbill-usds",
      tasks: [
        {
          job: "fetch-tbill-rate",
          run: (signal) => fetchTbillRate(runtime.db, signal, runtime.env),
        },
        {
          job: "sync-usds-status",
          run: (signal) =>
            syncUsdsStatus(runtime.db, runtime.env.ETHERSCAN_API_KEY ?? null, signal),
        },
      ],
    },
  ];
}

export async function runDaily0800Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await Promise.all([
    runScheduledSlotGroups(runtime, SLOT_LABEL, buildSnapshotSupplyGroups(runtime)),
    runScheduledSlotGroups(runtime, SLOT_LABEL, buildSafetyPsiPublicGroups(runtime)),
    runScheduledSlotGroups(runtime, SLOT_LABEL, buildTbillUsdsGroups(runtime)),
  ]);
}
