import type { ScheduledRuntimeContext } from "./context";
import { runYieldCoverageAudit } from "../../cron/yield-coverage-audit";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildMonthlyYieldAuditSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "yield-coverage-audit",
      tasks: [
        {
          job: "yield-coverage-audit",
          errorMessage: "[cron] yield-coverage-audit failed in monthly slot:",
          run: (signal) => runYieldCoverageAudit(runtime.db, signal, runtime.chainRpcs),
        },
      ],
    },
  ];
}

export async function runMonthlyYieldAuditSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runScheduledSlotGroups(
    runtime,
    "monthly yield audit slot",
    buildMonthlyYieldAuditSlotGroups(runtime),
  );
}
