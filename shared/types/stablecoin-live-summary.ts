import { z } from "zod";
import { NominalPriceReferenceSchema, PriceConfidenceSchema, PriceObservedAtModeSchema } from "./core";

const StablecoinDetailPegBucketsSchema = z.record(z.string(), z.number());

/** Native token-count checkpoints from one history series; unavailable is never zero. */
const NativeSupplyCheckpointsSchema = z.object({
  current: z.number().nullable(),
  prevWeek: z.number().nullable(),
  prevMonth: z.number().nullable(),
});
export type NativeSupplyCheckpoints = z.infer<typeof NativeSupplyCheckpointsSchema>;

export const StablecoinLiveSummarySchema = z.object({
  price: z.number().nullable(),
  priceSource: z.string().nullable(),
  priceConfidence: PriceConfidenceSchema.nullable(),
  priceUpdatedAt: z.number().nullable(),
  priceObservedAt: z.number().nullable(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable().optional(),
  priceSyncedAt: z.number().nullable().optional(),
  nominalPriceReference: NominalPriceReferenceSchema.optional(),
  consensusSources: z.array(z.string()).optional(),
  agreeSources: z.array(z.string()).optional(),
  supplyObservedAt: z.number().nullable(),
  supplyRestored: z.boolean().optional(),
  circulating: StablecoinDetailPegBucketsSchema,
  circulatingPrevDay: StablecoinDetailPegBucketsSchema,
  circulatingPrevWeek: StablecoinDetailPegBucketsSchema,
  circulatingPrevMonth: StablecoinDetailPegBucketsSchema,
  nativeSupply: NativeSupplyCheckpointsSchema,
});
export type StablecoinLiveSummary = z.infer<typeof StablecoinLiveSummarySchema>;
