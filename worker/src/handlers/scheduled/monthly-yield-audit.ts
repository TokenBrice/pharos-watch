import type { ScheduledRuntimeContext } from "./context";
import { runYieldCoverageAudit } from "../../cron/yield-coverage-audit";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runMonthlyYieldAuditSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "monthly yield audit slot", "yield-coverage-audit", (signal) =>
    runYieldCoverageAudit(runtime.db, signal),
    { errorMessage: "[cron] yield-coverage-audit failed in monthly slot:" },
  );
}
