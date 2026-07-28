/**
 * Half-hourly charts trigger (16,46 * * * *):
 *   sync-dex-liquidity (0) → prepare-safety-score-v9-input (0)
 *   → sync-stablecoin-charts (1)
 *
 * DEX scoring consumes the complete generation written six minutes earlier,
 * then the charts writer uses the same lightweight trigger.
 * Scheduled deliveries share one retryable publication bucket per hour.
 */
import { consumeDexLiquidityScoringStage } from "../../cron/dex-liquidity/orchestrator";
import { prepareSafetyScoreV9Input } from "../../cron/prepare-safety-score-v9-input";
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";

export async function runHalfHourlyChartsSlot(runtime: ScheduledRuntimeContext) {
  let publishedDexGenerationId: string | null = null;
  return runScheduledSlotGroups(runtime, "half-hour scoring and charts slot", [
    {
      mode: "serial",
      label: "dex-scoring-v9-input",
      stopOnFailure: true,
      stopOnNonNeutralSkip: true,
      tasks: [
        {
          job: "sync-dex-liquidity",
          run: async (signal, reportProgress) => {
            const result = await consumeDexLiquidityScoringStage(
              runtime.db,
              signal,
              reportProgress,
              runtime.slotStartedAt,
            );
            const metadata = JSON.parse(result.metadata ?? "{}") as {
              persistence?: { generationId?: string };
            };
            publishedDexGenerationId = metadata.persistence?.generationId ?? null;
            return result;
          },
        },
        {
          job: "prepare-safety-score-v9-input",
          run: (signal) => {
            if (publishedDexGenerationId === null) {
              throw new Error("DEX publication result omitted its exact generation id");
            }
            return prepareSafetyScoreV9Input(
              runtime.db,
              signal,
              publishedDexGenerationId,
            );
          },
        },
      ],
    },
    {
      mode: "serial",
      label: "stablecoin-charts",
      tasks: [
        {
          job: "sync-stablecoin-charts",
          run: (signal) =>
            syncStablecoinCharts(runtime.db, signal, { scheduledAtSec: runtime.slotStartedAt }),
        },
      ],
    },
  ]);
}
