import type { ScheduledRuntimeContext } from "./context";
import { runYieldCoverageAudit } from "../../cron/yield-coverage-audit";
import { runSingleScheduledJob } from "./slot-groups";

export async function runMonthlyYieldAuditSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "monthly yield audit slot", {
    job: "yield-coverage-audit",
    errorMessage: "[cron] yield-coverage-audit failed in monthly slot:",
    run: (signal, reportProgress) => runYieldCoverageAudit(runtime.db, signal, runtime.chainRpcs, reportProgress),
  });
}
