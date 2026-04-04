import { z } from "zod";
import { GovernanceTypeSchema } from "./core";
import { ReportCardGradeSchema } from "./report-cards";

export const TreasurySeedExtractionModeSchema = z.enum([
  "static-seeded",
  "custom-reviewed",
  "dynamic-unresolved",
  "missing",
]);

export type TreasurySeedExtractionMode = z.infer<typeof TreasurySeedExtractionModeSchema>;

export const TreasurySeedOwnerSchema = z.object({
  chain: z.string(),
  address: z.string(),
  label: z.string().optional(),
});

export type TreasurySeedOwner = z.infer<typeof TreasurySeedOwnerSchema>;

export const TreasurySeedSchema = z.object({
  protocolId: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  launchEligible: z.boolean(),
  launchPriority: z.number().int().optional(),
  source: z.literal("defillama-github"),
  adapterFile: z.string().nullable(),
  extractionMode: TreasurySeedExtractionModeSchema,
  chains: z.array(z.string()),
  owners: z.array(TreasurySeedOwnerSchema),
  notes: z.array(z.string()).optional(),
});

export interface TreasurySeed extends z.infer<typeof TreasurySeedSchema> {
  owners: TreasurySeedOwner[];
}

export const TreasurySeedRegistrySchema = z.array(TreasurySeedSchema);
export type TreasurySeedRegistry = z.infer<typeof TreasurySeedRegistrySchema>;

export const TreasuryDenominatorStatusSchema = z.enum([
  "direct-only",
  "adjusted-with-defi",
  "partial",
  "invalid",
]);

export type TreasuryDenominatorStatus = z.infer<typeof TreasuryDenominatorStatusSchema>;

export const TreasuryStableExposureHoldingSchema = z.object({
  stablecoinId: z.string(),
  name: z.string(),
  symbol: z.string(),
  governance: GovernanceTypeSchema,
  usdValue: z.number(),
  pctOfTreasury: z.number().nullable(),
  pctOfStableSleeve: z.number().nullable(),
  safetyScore: z.number().nullable(),
  safetyGrade: ReportCardGradeSchema.nullable(),
});

export type TreasuryStableExposureHolding = z.infer<typeof TreasuryStableExposureHoldingSchema>;

export const TreasuryStableExposureCoverageSchema = z.object({
  extractionMode: TreasurySeedExtractionModeSchema,
  ownerCount: z.number().int(),
  ownerChainCount: z.number().int(),
  denominatorStatus: TreasuryDenominatorStatusSchema,
  directWalletUsd: z.number(),
  defiPositionUsd: z.number(),
  consumedDirectBalanceUsd: z.number(),
  trackedStableUsd: z.number(),
  stablecoinSleeveUsd: z.number(),
  untrackedStableUsd: z.number(),
  derivedUntrackedStableUsd: z.number(),
  ratedTrackedStableUsd: z.number(),
  trackedStablePctOfTreasury: z.number().nullable(),
  trackedStablePctOfStableSleeve: z.number().nullable(),
  ratedTrackedStablePct: z.number().nullable(),
  untrackedStableCount: z.number().int(),
  derivedUntrackedStableCount: z.number().int(),
  skippedDerivedPositionCount: z.number().int(),
  notes: z.array(z.string()),
});

export type TreasuryStableExposureCoverage = z.infer<typeof TreasuryStableExposureCoverageSchema>;

export const TreasuryStableExposureGovernanceBucketsSchema = z.object({
  centralizedUsd: z.number(),
  centralizedDependentUsd: z.number(),
  decentralizedUsd: z.number(),
});

export type TreasuryStableExposureGovernanceBuckets = z.infer<typeof TreasuryStableExposureGovernanceBucketsSchema>;

export const TreasuryStableExposureEntitySchema = z.object({
  protocolId: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  source: z.literal("defillama-github"),
  adapterFile: z.string().nullable(),
  chains: z.array(z.string()),
  directWalletUsd: z.number(),
  treasuryUsd: z.number().nullable(),
  stablecoinSleeveUsd: z.number(),
  trackedStableUsd: z.number(),
  decentralizedStableUsd: z.number(),
  decentralizedStablePctOfTreasury: z.number().nullable(),
  decentralizedStablePctOfStableSleeve: z.number().nullable(),
  weightedSafetyScore: z.number().nullable(),
  weightedSafetyGrade: ReportCardGradeSchema.nullable(),
  governanceBuckets: TreasuryStableExposureGovernanceBucketsSchema,
  holdings: z.array(TreasuryStableExposureHoldingSchema),
  coverage: TreasuryStableExposureCoverageSchema,
});

export interface TreasuryStableExposureEntity extends z.infer<typeof TreasuryStableExposureEntitySchema> {
  holdings: TreasuryStableExposureHolding[];
  coverage: TreasuryStableExposureCoverage;
}

export const TreasuryStableExposureResponseSchema = z.object({
  entities: z.array(TreasuryStableExposureEntitySchema),
  updatedAt: z.number(),
  coverage: z.object({
    entityCount: z.number().int(),
    registryCount: z.number().int(),
    launchEligibleCount: z.number().int(),
    ownerChainTuples: z.number().int(),
    launchOwnerChainTuples: z.number().int(),
    comparableEntityCount: z.number().int(),
    partialEntityCount: z.number().int(),
    invalidEntityCount: z.number().int(),
    supplementedEntityCount: z.number().int(),
    evmOnly: z.boolean(),
    extractionModes: z.object({
      staticSeeded: z.number().int(),
      customReviewed: z.number().int(),
      dynamicUnresolved: z.number().int(),
      missing: z.number().int(),
    }),
  }),
});

export interface TreasuryStableExposureResponse extends z.infer<typeof TreasuryStableExposureResponseSchema> {
  entities: TreasuryStableExposureEntity[];
}
