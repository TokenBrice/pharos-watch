/**
 * Daily 08:00 UTC trigger (0 8 * * *):
 *   snapshot-supply (0) | snapshot-safety-grade-history (0) | snapshot-psi (0)  ← parallel, DB-only
 *   fetch-tbill-rate (1) → sync-usds-status (1) → sync-treasury-stable-exposure (2)  ← chained to avoid connection contention
 *
 * Connection budget: 2/6 peak (treasury sync does two Sim reads per owner group)
 */
import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotSafetyGradeHistory } from "../../cron/snapshot-safety-grade-history";
import { fetchTbillRate } from "../../cron/fetch-tbill-rate";
import { snapshotPsiDaily } from "../../cron/snapshot-psi";
import { syncUsdsStatus } from "../../cron/sync-usds-status";
import { syncTreasuryStableExposure } from "../../cron/sync-treasury-stable-exposure";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runDaily0800Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await Promise.all([
    runBestEffortScheduledJob(runtime, "daily 08:00 slot", "snapshot-supply", (signal) => snapshotSupply(runtime.db, signal)),
    runBestEffortScheduledJob(
      runtime,
      "daily 08:00 slot",
      "snapshot-safety-grade-history",
      (signal) => snapshotSafetyGradeHistory(runtime.db, signal),
    ),
    runBestEffortScheduledJob(runtime, "daily 08:00 slot", "snapshot-psi", (signal) => snapshotPsiDaily(runtime.db, signal)),
    (async () => {
      const tbillResult = await runBestEffortScheduledJob(runtime, "daily 08:00 slot", "fetch-tbill-rate", (signal) => fetchTbillRate(runtime.db, signal));
      if (tbillResult?.status === "error" || tbillResult == null) {
        console.warn("[cron] fetch-tbill-rate did not complete cleanly — continuing to sync-usds-status");
      }
      await runBestEffortScheduledJob(
        runtime,
        "daily 08:00 slot",
        "sync-usds-status",
        (signal) => syncUsdsStatus(runtime.db, runtime.env.ETHERSCAN_API_KEY ?? null, signal),
      );
      await runBestEffortScheduledJob(
        runtime,
        "daily 08:00 slot",
        "sync-treasury-stable-exposure",
        (signal) => syncTreasuryStableExposure(runtime.db, runtime.env.SIM_API_KEY ?? null, signal),
      );
    })(),
  ]);
}
