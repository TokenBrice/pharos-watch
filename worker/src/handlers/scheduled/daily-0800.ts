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
import {
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
} from "../../lib/public-dataset-snapshot-budget";
import { syncUsdsStatus } from "../../cron/sync-usds-status";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

const SLOT_LABEL = "daily 08:00 slot";

function buildDaily0800SlotGroups(runtime: ScheduledRuntimeContext) {
  const stablecoinsCacheFreshnessGate = {
    minStablecoinsCacheUpdatedAtSec: runtime.slotStartedAt,
    freshnessGateLabel: "daily0800Utc",
  };
  const publicSnapshotFreshnessGate = {
    ...stablecoinsCacheFreshnessGate,
    stablecoinsCacheRetryAttempts: PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
    stablecoinsCacheRetryDelayMs: PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
  };

  return bindScheduledSlotPlan("daily0800Utc", {
    mode: "parallel-serial",
    label: "daily-0800-chains",
    chainLabels: ["snapshot-supply", "safety-psi-public", "tbill-usds"],
    implementations: {
      "snapshot-supply": (signal) => snapshotSupply(runtime.db, signal, stablecoinsCacheFreshnessGate),
      "snapshot-safety-grade-history": (signal) => snapshotSafetyGradeHistory(runtime.db, signal),
      "snapshot-psi": (signal) => snapshotPsiDaily(runtime.db, signal),
      "snapshot-public-dataset": (signal) => snapshotPublicDataset(runtime.db, signal, publicSnapshotFreshnessGate),
      "fetch-tbill-rate": (signal) => fetchTbillRate(runtime.db, signal, runtime.env),
      "sync-usds-status": (signal) =>
        syncUsdsStatus(runtime.db, runtime.env.ETHERSCAN_API_KEY ?? null, signal),
    },
  });
}

export async function runDaily0800Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, SLOT_LABEL, buildDaily0800SlotGroups(runtime));
}
