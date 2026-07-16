import { z } from "zod";

/** DefiLlama /coins/{tokens} price response */
export const DLPriceResponseSchema = z.object({
  coins: z
    .record(
      z.string(),
      z.object({
        price: z.number(),
        symbol: z.string().optional(),
        timestamp: z.number().optional(),
        confidence: z.number().optional(),
      }),
    )
    .optional()
    .default({}),
});

export const CmcCategoryResponseSchema = z.object({
  data: z.object({
    num_tokens: z.number().int().nonnegative(),
    coins: z.array(
      z.object({
        slug: z.string().optional(),
        symbol: z.string(),
        last_updated: z.string().optional(),
        quote: z.object({
          USD: z.object({
            // CMC returns null price for tokens without recent quotes; the
            // downstream loop already skips null/non-positive prices, so accept
            // them here instead of rejecting the whole response.
            price: z.number().nullable().optional(),
            last_updated: z.string().nullable().optional(),
          }),
        }),
      }),
    ),
  }),
  status: z
    .object({
      error_code: z.number().optional(),
      error_message: z.string().nullable().optional(),
      timestamp: z.string().optional(),
    })
    .optional(),
});

const CmcLatestQuoteEntrySchema = z.object({
  id: z.number().int().positive(),
  slug: z.string(),
  symbol: z.string(),
  is_active: z.number().int().optional(),
  platform: z
    .object({
      slug: z.string().nullable().optional(),
      token_address: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  quote: z.union([
    z.object({
      USD: z.object({
        price: z.number().nullable().optional(),
        volume_24h: z.number().nullable().optional(),
        last_updated: z.string().nullable().optional(),
      }),
    }),
    z.array(z.object({
      symbol: z.string(),
      price: z.number().nullable().optional(),
      volume_24h: z.number().nullable().optional(),
      last_updated: z.string().nullable().optional(),
    })),
  ]),
});

export const CmcLatestQuotesResponseSchema = z.object({
  data: z.array(CmcLatestQuoteEntrySchema),
});

const JupiterQuotedPriceEntrySchema = z.object({
  usdPrice: z.number(),
  decimals: z.number().int().nonnegative(),
  blockId: z.number().int().positive(),
  priceChange24h: z.number().nullable().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  liquidity: z.number().nullable().optional(),
});

const JupiterSparsePriceEntrySchema = z.object({
  // Jupiter returns sparse entries for unsupported / no-quote mints. These are
  // healthy provider responses, just not usable prices.
  usdPrice: z.null().optional(),
  decimals: z.number().int().nonnegative(),
  blockId: z.number().int().positive().optional(),
  priceChange24h: z.number().nullable().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  liquidity: z.number().nullable().optional(),
});

export const JupiterPriceResponseSchema = z.record(
  z.string(),
  z.union([JupiterQuotedPriceEntrySchema, JupiterSparsePriceEntrySchema]),
);

export const SolanaSlotResponseSchema = z.object({
  result: z.number().int().positive(),
});

/** Cron metadata JSON stored in cron_runs.metadata */
export const CronMetadataSchema = z.record(z.string(), z.unknown());

/** LLM digest response JSON */
export const DigestResponseSchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1),
  extended: z.string().min(1),
  meta: z
    .object({
      leadSignalId: z.string().optional(),
      lead: z.string().optional(),
      tone: z.string().optional(),
      coins: z.array(z.string()).optional(),
      usedCandidateIds: z.array(z.string()).optional(),
      suppressedCandidateIds: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Dex liquidity cron metadata shape */
export const DexLiquidityCronMetadataSchema = z.object({
  stagedPoolsMerged: z.number().optional(),
  stagedPoolsSkipped: z.number().optional(),
  stagedPoolsSkippedByExactIdentity: z.number().optional(),
  stagedPoolsSkippedByUniqueDerivedIdentity: z.number().optional(),
  stagedPoolsSkippedByOptionalWildcardIdentity: z.number().optional(),
  stagedPoolsSkippedByAuthoritativeProtocol: z.number().optional(),
  failedSources: z.array(z.string()).optional().default([]),
  sourceCoverage: z
    .object({
      currentCoverage: z.number().optional(),
      previousCoverage: z.number().optional(),
      previousCoverageBaselineAvailable: z.boolean().optional(),
      minExpectedCoverage: z.number().optional(),
      dlYieldsAvailable: z.boolean().optional(),
      dlProtocolsAvailable: z.boolean().optional(),
      currentGlobalTvl: z.number().optional(),
      previousGlobalTvl: z.number().nullable().optional(),
      minExpectedGlobalTvl: z.number().nullable().optional(),
      valueBaselineSource: z
        .enum(["dex_liquidity_global", "cron_metadata_source_complete", "none"])
        .optional(),
      valueBaselineGlobalTvl: z.number().nullable().optional(),
      ignoredPersistedGlobalTvl: z.number().nullable().optional(),
      currentTop10CoveredTvl: z.number().optional(),
      previousTop10CoveredTvl: z.number().optional(),
      currentTop10GuardTvl: z.number().optional(),
      previousTop10GuardTvl: z.number().optional(),
      priceObservationCoins: z.number().optional(),
      weakCoverageCoins: z.number().optional(),
      coverageRecoveredCoins: z.number().optional(),
      dsFallbackCoins: z.number().optional(),
      cgTickerFallbackCoins: z.number().optional(),
      directCexOrderbookDepth: z
        .object({
          checkedSymbols: z.number(),
          venueCount: z.number(),
          observations: z.number(),
          maxDepthDown2PctUsdBySymbol: z.record(z.string(), z.number()),
          maxDepthUp2PctUsdBySymbol: z.record(z.string(), z.number()),
        })
        .nullable()
        .optional(),
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
      protocolCapReductions: z
        .object({
          cappedPoolCount: z.number().optional(),
          cappedProtocols: z.number().optional(),
          reducedTvlUsd: z.number().optional(),
          topProtocols: z
            .array(
              z.object({
                protocol: z.string(),
                preCapTvlUsd: z.number(),
                postCapTvlUsd: z.number(),
                reducedTvlUsd: z.number(),
              }),
            )
            .optional(),
          topStablecoins: z
            .array(
              z.object({
                stablecoinId: z.string(),
                reducedTvlUsd: z.number(),
              }),
            )
            .optional(),
        })
        .optional(),
      qualityDriftFlags: z.array(z.string()).optional(),
      qualityDriftSeverity: z.enum(["none", "medium", "high"]).optional(),
      qualityDriftMetrics: z
        .object({
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
        })
        .optional(),
      topAssetCoverageDeltas: z
        .array(
          z.object({
            stablecoinId: z.string(),
            previousPoolCount: z.number(),
            currentPoolCount: z.number(),
            poolCountPctDelta: z.number().nullable(),
            previousCoverageConfidence: z.number().nullable(),
            currentCoverageConfidence: z.number().nullable(),
            previousMeasuredShare: z.number().nullable(),
            currentMeasuredShare: z.number().nullable(),
          }),
        )
        .optional(),
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
  persistence: z
    .object({
      skipped: z.boolean().optional(),
      skippedReason: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
});
