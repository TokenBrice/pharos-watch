/**
 * Half-hourly charts trigger (16,46 * * * *):
 *   sync-dex-liquidity (0) → sync-stablecoin-charts (1)
 *
 * DEX scoring consumes the complete generation written six minutes earlier,
 * then the charts writer uses the same lightweight trigger.
 * Scheduled deliveries share one retryable publication bucket per hour.
 */
import { consumeDexLiquidityScoringStage } from "../../cron/dex-liquidity/orchestrator";
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";

export async function runHalfHourlyChartsSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "half-hour scoring and charts slot", [
    {
      mode: "serial",
      label: "dex-scoring-charts",
      tasks: [
        {
          job: "sync-dex-liquidity",
          run: (signal, reportProgress) =>
            consumeDexLiquidityScoringStage(
              runtime.db,
              signal,
              reportProgress,
              runtime.slotStartedAt,
            ),
        },
        {
          job: "sync-stablecoin-charts",
          run: (signal) =>
            syncStablecoinCharts(runtime.db, signal, { scheduledAtSec: runtime.slotStartedAt }),
        },
      ],
    },
  ]);
}
