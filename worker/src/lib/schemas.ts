import { z } from "zod";

/** DefiLlama /coins/{tokens} price response */
export const DLPriceResponseSchema = z.object({
  coins: z
    .record(
      z.string(),
      z.object({
        price: z.number(),
        timestamp: z.number().optional(),
        confidence: z.number().optional(),
      }),
    )
    .optional()
    .default({}),
});

/** Cron metadata JSON stored in cron_runs.metadata */
export const CronMetadataSchema = z.record(z.string(), z.unknown());

/** LLM digest response JSON */
export const DigestResponseSchema = z.object({
  title: z.string().optional().default(""),
  text: z.string().optional().default(""),
  extended: z.string().optional().default(""),
  meta: z
    .object({
      lead: z.string().optional(),
      tone: z.string().optional(),
      coins: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Dex liquidity cron metadata shape */
export const DexLiquidityCronMetadataSchema = z.object({
  stagedPoolsMerged: z.number().optional(),
  stagedPoolsSkipped: z.number().optional(),
  failedSources: z.array(z.string()).optional().default([]),
  sourceCoverage: z
    .object({
      currentCoverage: z.number().optional(),
      previousCoverage: z.number().optional(),
      previousCoverageBaselineAvailable: z.boolean().optional(),
      minExpectedCoverage: z.number().optional(),
      priceObservationCoins: z.number().optional(),
      weakCoverageCoins: z.number().optional(),
      coverageRecoveredCoins: z.number().optional(),
      dsFallbackCoins: z.number().optional(),
      cgTickerFallbackCoins: z.number().optional(),
      measuredBalanceCoveragePct: z.number().optional(),
      syntheticOnlyCoins: z.number().optional(),
      coinsWithoutMeasuredBalances: z.number().optional(),
      coinsGtOnly: z.number().optional(),
      coinsCrawlerOnly: z.number().optional(),
      coinsPriceOnlyNoMeasuredLiquidity: z.number().optional(),
      retainedPoolCountBySourceFamily: z.record(z.string(), z.number()).optional(),
      measuredBalanceTvlBySourceFamily: z.record(z.string(), z.number()).optional(),
      priceObservationCoinsBySourceFamily: z.record(z.string(), z.number()).optional(),
      sourceDegradedFamilies: z.array(z.string()).optional(),
      protocolCapReductions: z.object({
        cappedPoolCount: z.number().optional(),
        cappedProtocols: z.number().optional(),
        reducedTvlUsd: z.number().optional(),
        topProtocols: z.array(z.object({
          protocol: z.string(),
          preCapTvlUsd: z.number(),
          postCapTvlUsd: z.number(),
          reducedTvlUsd: z.number(),
        })).optional(),
        topStablecoins: z.array(z.object({
          stablecoinId: z.string(),
          reducedTvlUsd: z.number(),
        })).optional(),
      }).optional(),
      qualityDriftFlags: z.array(z.string()).optional(),
      qualityDriftSeverity: z.enum(["none", "medium", "high"]).optional(),
      qualityDriftMetrics: z.object({
        previousPriceObservationCoins: z.number().nullable().optional(),
        currentPriceObservationCoins: z.number().optional(),
        priceObservationPctDelta: z.number().nullable().optional(),
        previousMeasuredBalanceCoveragePct: z.number().nullable().optional(),
        currentMeasuredBalanceCoveragePct: z.number().optional(),
        measuredBalanceCoverageDelta: z.number().nullable().optional(),
        previousStagedPoolsMerged: z.number().nullable().optional(),
        currentStagedPoolsMerged: z.number().optional(),
        stagedPoolsMergedPctDelta: z.number().nullable().optional(),
        previousStagedPoolsSkipped: z.number().nullable().optional(),
        currentStagedPoolsSkipped: z.number().optional(),
        stagedPoolsSkippedPctDelta: z.number().nullable().optional(),
        previousWeakCoverageCoins: z.number().nullable().optional(),
        currentWeakCoverageCoins: z.number().optional(),
        weakCoverageDelta: z.number().nullable().optional(),
      }).optional(),
      topAssetCoverageDeltas: z.array(z.object({
        stablecoinId: z.string(),
        previousPoolCount: z.number(),
        currentPoolCount: z.number(),
        poolCountPctDelta: z.number().nullable(),
        previousCoverageConfidence: z.number().nullable(),
        currentCoverageConfidence: z.number().nullable(),
        previousMeasuredShare: z.number().nullable(),
        currentMeasuredShare: z.number().nullable(),
      })).optional(),
      nearCoverageGuard: z.boolean().optional().default(false),
      nearValueGuard: z.boolean().optional().default(false),
      nearMajorCoverageGuard: z.boolean().optional().default(false),
    })
    .optional()
    .default(() => ({
      nearCoverageGuard: false,
      nearValueGuard: false,
      nearMajorCoverageGuard: false,
    })),
});
