import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotSafetyGradeHistory } from "../../cron/snapshot-safety-grade-history";
import { fetchTbillRate } from "../../cron/fetch-tbill-rate";
import { snapshotPsiDaily } from "../../cron/snapshot-psi";
import { syncUsdsStatus } from "../../cron/sync-usds-status";
import type { ScheduledRuntimeContext } from "./context";

export function runDaily0800Slot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(runtime.runLeasedCron("snapshot-supply", (signal) => snapshotSupply(runtime.db, signal)));
  runtime.ctx.waitUntil(runtime.runLeasedCron(
    "snapshot-safety-grade-history",
    (signal) => snapshotSafetyGradeHistory(runtime.db, signal),
  ));
  runtime.ctx.waitUntil(runtime.runLeasedCron("fetch-tbill-rate", (signal) => fetchTbillRate(runtime.db, signal)));
  runtime.ctx.waitUntil(runtime.runLeasedCron("snapshot-psi", (signal) => snapshotPsiDaily(runtime.db, signal)));
  runtime.ctx.waitUntil(runtime.runLeasedCron(
    "sync-usds-status",
    (signal) => syncUsdsStatus(runtime.db, runtime.env.ETHERSCAN_API_KEY ?? null, signal),
  ));
}
