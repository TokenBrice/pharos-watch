/**
 * Half-hourly charts trigger (16,46 * * * *):
 *   sync-dex-liquidity (0) → prepare-safety-score-v9-input (3)
 *   sync-stablecoin-charts (1), failure-independent and serial
 *
 * :16 consumes the hourly source generation (prices hourly, score every two
 * hours); :46 reuses the exact current score generation for V9 preparation.
 * The charts writer uses the same lightweight trigger.
 * Scheduled deliveries share one retryable publication bucket per hour.
 */
import {
  consumeDexLiquidityScoringStage,
  reuseCurrentDexLiquidityScoringGeneration,
} from "../../cron/dex-liquidity/orchestrator";
import {
  isDailyDexShadowTargetPublicationSlot,
  isDexLiquidityPublicationSlot,
  isHourlyDexPriceSlot,
} from "@shared/lib/cron-cadences";
import { prepareSafetyScoreV9Input } from "../../cron/prepare-safety-score-v9-input";
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import type { CronResult } from "../../lib/cron-logger";
import { tryParseJson } from "../../lib/json-parse";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";

interface DexPublication {
  status: NonNullable<CronResult["status"]>;
  generationId: string | null;
  skipped: boolean;
  skippedReason: string | null;
}

function readDexPublication(result: CronResult): DexPublication {
  const metadata = tryParseJson(
    result.metadata ?? "{}",
    "half-hourly charts DEX publication metadata",
  );
  const persistence =
    metadata !== null
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && "persistence" in metadata
    && metadata.persistence !== null
    && typeof metadata.persistence === "object"
    && !Array.isArray(metadata.persistence)
      ? metadata.persistence
      : null;
  const generationId =
    persistence !== null
    && "generationId" in persistence
    && typeof persistence.generationId === "string"
    && persistence.generationId.trim().length > 0
      ? persistence.generationId
      : null;
  const skippedReason =
    persistence !== null
    && "skippedReason" in persistence
    && typeof persistence.skippedReason === "string"
      ? persistence.skippedReason
      : null;
  return {
    status: result.status ?? "ok",
    generationId,
    skipped:
      persistence !== null
      && "skipped" in persistence
      && persistence.skipped === true,
    skippedReason,
  };
}

export async function runHalfHourlyChartsSlot(runtime: ScheduledRuntimeContext) {
  let dexPublication: DexPublication | null = null;
  return runScheduledSlotGroups(runtime, "half-hour scoring and charts slot", [
    {
      mode: "serial",
      label: "dex-scoring-v9-input",
      tasks: [
        {
          job: "sync-dex-liquidity",
          run: async (signal, reportProgress) => {
            let result: CronResult;
            try {
              result = !isHourlyDexPriceSlot(runtime.slotStartedAt)
                ? await reuseCurrentDexLiquidityScoringGeneration(runtime.db, signal)
                : await consumeDexLiquidityScoringStage(
                    runtime.db,
                    signal,
                    reportProgress,
                    runtime.slotStartedAt,
                    {
                      publishLiquidity: isDexLiquidityPublicationSlot(runtime.slotStartedAt),
                      publishShadowTargets: isDailyDexShadowTargetPublicationSlot(runtime.slotStartedAt),
                    },
                  );
            } catch (error) {
              dexPublication = {
                status: "error",
                generationId: null,
                skipped: false,
                skippedReason: null,
              };
              throw error;
            }
            dexPublication = readDexPublication(result);
            return result;
          },
        },
        {
          job: "prepare-safety-score-v9-input",
          run: (signal) => {
            const publication = dexPublication;
            const isExactCadenceReuse =
              publication?.status === "skipped_neutral"
              && publication.generationId !== null
              && publication.skipped === false
              && publication.skippedReason === "liquidity-cadence-reuse";
            if (
              publication == null
              || publication.status === "error"
              || publication.status === "skipped_locked"
              || (publication.status === "skipped_neutral" && !isExactCadenceReuse)
              || publication.skipped
            ) {
              return Promise.resolve({
                status: "skipped_neutral" as const,
                itemCount: 0,
                metadata: JSON.stringify({
                  reason: "upstream-dex-publication-unavailable",
                  upstreamJob: "sync-dex-liquidity",
                  upstreamStatus: publication?.status ?? "not-started",
                  upstreamSkippedReason: publication?.skippedReason ?? null,
                  childDisposition: "not_started",
                }),
              });
            }
            if (publication.generationId === null) {
              throw new Error("DEX publication result omitted its exact generation id");
            }
            return prepareSafetyScoreV9Input(
              runtime.db,
              signal,
              publication.generationId,
              runtime.chainRpcs,
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
