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
  failedSources: z.array(z.string()).optional().default([]),
  sourceCoverage: z
    .object({
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
