import { z } from "zod";
import { LIVE_RESERVE_FRESHNESS_MODE_VALUES } from "./live-reserve-core";

export const LIVE_RESERVE_ADMISSION_REJECTION_CODE_VALUES = [
  "unconfigured", "suspended", "missing-snapshot", "inconsistent-snapshot", "config-mismatch",
  "non-independent", "stale", "invalid-freshness", "degraded-snapshot", "insufficient-slices",
  "refresh-loss-unproved", "live-scope-invalidated",
] as const;
export const LiveReserveAdmissionRejectionCodeSchema = z.enum(LIVE_RESERVE_ADMISSION_REJECTION_CODE_VALUES);
export type LiveReserveAdmissionRejectionCode = z.output<typeof LiveReserveAdmissionRejectionCodeSchema>;

/** Reserve clocks and budgets are independent of the redemption run clock. */
export const ReserveFreshnessViewSchema = z.object({
  stale: z.boolean(),
  staleReasons: z.array(z.enum(["fetch-age", "source-age", "invalid-fetch-clock"])),
  assessedAt: z.number().finite(), fetchedAt: z.number().finite().nullable(), attemptId: z.string().nullable(),
  fetchAgeSec: z.number().finite().nullable(), fetchBudgetSec: z.number().finite().nonnegative(),
  freshnessMode: z.enum(LIVE_RESERVE_FRESHNESS_MODE_VALUES).nullable(),
  sourceFreshnessInvalid: z.boolean(),
  sourceTimestamp: z.number().finite().nullable(), sourceAgeSec: z.number().finite().nullable(),
  sourceAgeBudgetSec: z.number().finite().nonnegative().nullable(), sourceAgeBudgetCap: z.enum(["scoring", "adapter", "fetch-budget"]).nullable(),
}).strict();
export type ReserveFreshnessView = z.output<typeof ReserveFreshnessViewSchema>;

export const ConsumedReserveInputSchema = z.object({
  generationId: z.string().min(1), contentSha256: z.string().regex(/^[a-f0-9]{64}$/), stablecoinId: z.string().min(1),
  attemptId: z.string().nullable(), configFingerprint: z.string().regex(/^[a-f0-9]{64}$/), freshness: ReserveFreshnessViewSchema,
}).strict();
export type ConsumedReserveInput = z.output<typeof ConsumedReserveInputSchema>;
export const RedemptionReserveRunMetadataSchema = z.object({
  reserveViewSchemaVersion: z.literal(2), reserveGenerationId: z.string().min(1), reserveContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runClockSec: z.number().int().positive(), consumedReserveInputs: z.record(z.string(), ConsumedReserveInputSchema),
  stablecoinsInput: z.object({
    updatedAt: z.number().int().positive(),
    assessedAt: z.number().int().positive(),
    maxAgeSec: z.number().int().positive(),
  }).strict().refine((input) => input.updatedAt <= input.assessedAt && input.assessedAt - input.updatedAt <= input.maxAgeSec,
    { message: "Stablecoins input clock is outside its freshness budget" }).optional(),
}).passthrough();
export type RedemptionReserveRunMetadata = z.output<typeof RedemptionReserveRunMetadataSchema>;
