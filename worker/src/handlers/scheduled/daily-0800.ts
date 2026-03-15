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

export function runDaily0800Slot(runtime: ScheduledRuntimeContext): void {
  // DB-only snapshot jobs (no external fetch) — safe to parallelize
  runtime.ctx.waitUntil(runtime.runLeasedCron("snapshot-supply", (signal) => snapshotSupply(runtime.db, signal)));
  runtime.ctx.waitUntil(runtime.runLeasedCron(
    "snapshot-safety-grade-history",
    (signal) => snapshotSafetyGradeHistory(runtime.db, signal),
  ));
  runtime.ctx.waitUntil(runtime.runLeasedCron("snapshot-psi", (signal) => snapshotPsiDaily(runtime.db, signal)));

  // External-fetch jobs — chained to avoid concurrent connection contention
  runtime.ctx.waitUntil(
    runtime.runLeasedCron("fetch-tbill-rate", (signal) => fetchTbillRate(runtime.db, signal))
      .then(() => runtime.runLeasedCron(
        "sync-usds-status",
        (signal) => syncUsdsStatus(runtime.db, runtime.env.ETHERSCAN_API_KEY ?? null, signal),
      )),
  );
}
