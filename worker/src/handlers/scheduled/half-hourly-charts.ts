/**
 * Half-hourly charts trigger (16,46 * * * *):
 *   sync-dex-liquidity (0) → cron-sentinel turnover source (0)
 *   → prepare-safety-score-v9-input (3)
 *   sync-stablecoin-charts (1), failure-independent and serial
 * :16 consumes and publishes the hourly source generation; :46 reuses the
 * exact current score generation for V9 preparation. A terminally failed or
 * never-started hourly stage is re-run inline by the :16 consumer (bounded by
 * the stage job's lease and the consumer's own wall-clock budget), and :46
 * publishes the hour's still-unconsumed stage when :16 never completed.
 * The charts writer uses the same lightweight trigger.
 * Scheduled deliveries share one retryable publication bucket per hour.
 */
import {
  consumeDexLiquidityScoringStage,
  reuseCurrentDexLiquidityScoringGeneration,
} from "../../cron/dex-liquidity/orchestrator";
import {
  DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC,
  isDailyDexShadowTargetPublicationSlot,
  isDexLiquidityPublicationSlot,
  isHourlyDexPriceSlot,
} from "@shared/lib/cron-cadences";
import { prepareSafetyScoreV9Input } from "../../cron/prepare-safety-score-v9-input";
import { runCronSentinel } from "../../cron/cron-sentinel";
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { parseObjectMetadata } from "../../lib/json-metadata";
import { loadExactDexPublicationGeneration } from "../../lib/report-cards-snapshot";
import type { CronResult } from "../../lib/cron-logger";
import { tryParseJson } from "../../lib/json-parse";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

const DEX_SCORING_STAGE_READY_WAIT_MS = 90_000;

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

type DexPublicationRecovery =
  | {
      outcome: "reused";
      generationId: string;
      publicationAgeSec: number;
      budgetSec: number;
    }
  | {
      outcome: "outside-freshness-budget";
      publicationAgeSec: number;
      budgetSec: number;
    }
  | {
      outcome: "generation-unavailable";
      code: string;
    };

/**
 * A failed current-slot DEX scoring run does not withdraw the last accepted
 * publication: the published `dex_liquidity` rows are unchanged until a later
 * successful run replaces them. When that accepted generation is still inside
 * the same reviewed evidence budget the V9 capture itself applies
 * (`DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC`, the budget a :46
 * `liquidity-cadence-reuse` slot already consumes it under), preparation can
 * proceed on it exactly like a cadence reuse; beyond the budget — or when no
 * consistent accepted generation can even be read — it fails closed.
 */
async function recoverLastAcceptedDexPublication(
  db: D1Database,
  slotStartedAt: number,
  signal?: AbortSignal,
): Promise<DexPublicationRecovery> {
  try {
    const accepted = await runWithOverloadRetry(
      () => loadExactDexPublicationGeneration(db),
      3,
      signal,
    );
    const publicationAgeSec = slotStartedAt - accepted.updatedAt;
    if (publicationAgeSec > DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC) {
      return {
        outcome: "outside-freshness-budget",
        publicationAgeSec,
        budgetSec: DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC,
      };
    }
    return {
      outcome: "reused",
      generationId: accepted.generationId,
      publicationAgeSec,
      budgetSec: DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      outcome: "generation-unavailable",
      code:
        error instanceof Error && error.name
          ? error.name.slice(0, 160)
          : "Error",
    };
  }
}

export function buildHalfHourlyChartsSlotGroups(runtime: ScheduledRuntimeContext) {
  let dexPublication: DexPublication | null = null;
  return bindScheduledSlotPlan("halfHourlyChartsOffset", {
    mode: "serial",
    label: "dex-scoring-v9-input-and-charts",
    implementations: {
      "sync-dex-liquidity": async (signal, reportProgress) => {
        let result: CronResult;
        try {
          result = !isHourlyDexPriceSlot(runtime.slotStartedAt)
            ? await reuseCurrentDexLiquidityScoringGeneration(
                runtime.db,
                signal,
                reportProgress,
                runtime.slotStartedAt,
                {
                  stageRecovery: {
                    graphApiKey: runtime.env.GRAPH_API_KEY ?? null,
                    coingeckoApiKey: runtime.coingeckoApiKey,
                    chainRpcs: runtime.chainRpcs,
                  },
                },
              )
            : await consumeDexLiquidityScoringStage(
                runtime.db,
                signal,
                reportProgress,
                runtime.slotStartedAt,
                {
                  publishShadowTargets: isDailyDexShadowTargetPublicationSlot(runtime.slotStartedAt),
                  stageReadyDeadlineMs:
                    (runtime.scheduledTimeMs ?? runtime.slotStartedAt * 1_000)
                    + DEX_SCORING_STAGE_READY_WAIT_MS,
                  stageRecovery: {
                    graphApiKey: runtime.env.GRAPH_API_KEY ?? null,
                    coingeckoApiKey: runtime.coingeckoApiKey,
                    chainRpcs: runtime.chainRpcs,
                  },
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
      "cron-sentinel": (signal) => {
        if (!isDexLiquidityPublicationSlot(runtime.slotStartedAt)) {
          return Promise.resolve({
            status: "skipped_neutral" as const,
            itemCount: 0,
            metadata: JSON.stringify({ reason: "not-liquidity-publication-slot" }),
          });
        }
        const publication = dexPublication;
        if (
          publication == null
          || publication.status === "error"
          || publication.status === "skipped_locked"
          || publication.status === "skipped_neutral"
          || publication.skipped
          || publication.generationId === null
        ) {
          return Promise.resolve({
            status: "skipped_neutral" as const,
            itemCount: 0,
            metadata: JSON.stringify({
              reason: "upstream-dex-publication-unavailable",
              upstreamJob: "sync-dex-liquidity",
              upstreamStatus: publication?.status ?? "not-started",
              upstreamSkippedReason: publication?.skippedReason ?? null,
            }),
          });
        }
        return runCronSentinel(runtime.db, { mode: "turnover", signal });
      },
      "prepare-safety-score-v9-input": async (signal) => {
        const publication = dexPublication;
        const isExactCadenceReuse =
          publication?.status === "skipped_neutral"
          && publication.generationId !== null
          && publication.skipped === false
          && publication.skippedReason === "liquidity-cadence-reuse";
        const dexPublicationUnavailable = (
          recovery?: { outcome: string } & Record<string, unknown>,
        ) => ({
          status: "skipped_neutral" as const,
          itemCount: 0,
          metadata: JSON.stringify({
            reason: "upstream-dex-publication-unavailable",
            upstreamJob: "sync-dex-liquidity",
            upstreamStatus: publication?.status ?? "not-started",
            upstreamSkippedReason: publication?.skippedReason ?? null,
            ...(recovery === undefined ? {} : { upstreamRecovery: recovery }),
            childDisposition: "not_started",
          }),
        });
        if (
          publication == null
          || publication.status === "skipped_locked"
          || (publication.status === "skipped_neutral" && !isExactCadenceReuse)
          || publication.skipped
        ) {
          return dexPublicationUnavailable();
        }
        let generationId = publication.generationId;
        let recovery: DexPublicationRecovery | null = null;
        if (publication.status === "error") {
          const recovered = await recoverLastAcceptedDexPublication(
            runtime.db,
            runtime.slotStartedAt,
            signal,
          );
          if (recovered.outcome !== "reused") {
            return dexPublicationUnavailable(recovered);
          }
          generationId = recovered.generationId;
          recovery = recovered;
        }
        if (generationId === null) {
          throw new Error("DEX publication result omitted its exact generation id");
        }
        const result = await prepareSafetyScoreV9Input(
          runtime.db,
          signal,
          generationId,
          runtime.chainRpcs,
        );
        if (recovery === null) {
          return result;
        }
        return {
          ...result,
          metadata: JSON.stringify({
            ...parseObjectMetadata(result.metadata),
            dexPublicationRecovery: {
              upstreamJob: "sync-dex-liquidity",
              upstreamStatus: "error",
              reusedGenerationId: recovery.generationId,
              publicationAgeSec: recovery.publicationAgeSec,
              budgetSec: recovery.budgetSec,
            },
          }),
        };
      },
      "sync-stablecoin-charts": (signal) =>
        syncStablecoinCharts(runtime.db, signal, { scheduledAtSec: runtime.slotStartedAt }),
    },
  });
}

export async function runHalfHourlyChartsSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(
    runtime,
    "half-hour scoring and charts slot",
    buildHalfHourlyChartsSlotGroups(runtime),
  );
}
