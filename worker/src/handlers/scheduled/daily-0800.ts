/**
 * Daily 08:00 UTC trigger (0 8 * * *):
 *   snapshot-supply (0) | snapshot-safety-grade-history (0) | snapshot-psi (0)  ← parallel, DB-only
 *   fetch-tbill-rate (1) → sync-usds-status (1)  ← chained to avoid connection contention
 *
 * Connection budget: 1/6 peak (external-fetch jobs are chained)
 */
import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotSafetyGradeHistory } from "../../cron/snapshot-safety-grade-history";
import { fetchTbillRate } from "../../cron/fetch-tbill-rate";
import { snapshotPsiDaily } from "../../cron/snapshot-psi";
import { syncUsdsStatus } from "../../cron/sync-usds-status";
import type { ScheduledRuntimeContext } from "./context";

export async function runDaily0800Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  const runDailyJob = async (
    job: string,
    fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1],
  ) => {
    try {
      return (await runtime.runLeasedCron(job, fn)) ?? null;
    } catch (err) {
      console.error(`[cron] ${job} failed in daily 08:00 slot:`, err);
      return null;
    }
  };

  await Promise.all([
    runDailyJob("snapshot-supply", (signal) => snapshotSupply(runtime.db, signal)),
    runDailyJob(
      "snapshot-safety-grade-history",
      (signal) => snapshotSafetyGradeHistory(runtime.db, signal),
    ),
    runDailyJob("snapshot-psi", (signal) => snapshotPsiDaily(runtime.db, signal)),
    (async () => {
      const tbillResult = await runDailyJob("fetch-tbill-rate", (signal) => fetchTbillRate(runtime.db, signal));
      if (tbillResult?.status === "error" || tbillResult == null) {
        console.warn("[cron] fetch-tbill-rate did not complete cleanly — continuing to sync-usds-status");
      }
      await runDailyJob(
        "sync-usds-status",
        (signal) => syncUsdsStatus(runtime.db, runtime.env.ETHERSCAN_API_KEY ?? null, signal),
      );
    })(),
  ]);
}
