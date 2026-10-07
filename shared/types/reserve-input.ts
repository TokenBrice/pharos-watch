import { z } from "zod";

/** Reserve clocks and budgets are independent of the redemption run clock. */
export const ReserveFreshnessViewSchema = z.object({
  stale: z.boolean(),
  staleReasons: z.array(z.enum(["fetch-age", "source-age"])),
  assessedAt: z.number().finite(), fetchedAt: z.number().finite().nullable(), attemptId: z.string().nullable(),
  fetchAgeSec: z.number().finite().nullable(), fetchBudgetSec: z.number().finite().nonnegative(),
  sourceTimestamp: z.number().finite().nullable(), sourceAgeSec: z.number().finite().nullable(),
  sourceAgeBudgetSec: z.number().finite().nonnegative().nullable(), sourceAgeBudgetCap: z.enum(["scoring", "adapter", "fetch-budget"]).nullable(),
}).strict();
export type ReserveFreshnessView = z.output<typeof ReserveFreshnessViewSchema>;

export const ConsumedReserveInputSchema = z.object({
  generationId: z.string().min(1), contentSha256: z.string().regex(/^[a-f0-9]{64}$/), stablecoinId: z.string().min(1),
  attemptId: z.string().nullable(), configFingerprint: z.string().nullable(), freshness: ReserveFreshnessViewSchema,
}).strict();
export type ConsumedReserveInput = z.output<typeof ConsumedReserveInputSchema>;
export const RedemptionReserveRunMetadataSchema = z.object({
  reserveViewSchemaVersion: z.literal(1), reserveGenerationId: z.string().min(1), reserveContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runClockSec: z.number().int().positive(), consumedReserveInputs: z.record(z.string(), ConsumedReserveInputSchema),
}).passthrough();
export type RedemptionReserveRunMetadata = z.output<typeof RedemptionReserveRunMetadataSchema>;
