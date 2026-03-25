import type { ScheduledRuntimeContext } from "./context";
import { runYieldCoverageAudit } from "../../cron/yield-coverage-audit";

export async function runMonthlyYieldAuditSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("yield-coverage-audit", (signal) =>
      runYieldCoverageAudit(runtime.db, signal),
    );
  } catch (err) {
    console.error("[cron] yield-coverage-audit failed in monthly slot:", err);
  }
}
