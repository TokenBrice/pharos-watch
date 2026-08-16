import { z } from "zod";
import { Sha256Schema } from "@shared/types/safety-schema-primitives";
import { PegSummaryCoinSchema } from "@shared/types/market";
import { RedemptionBackstopMapSchema } from "@shared/types/redemption";
import { ReserveSliceSchema } from "@shared/types/reserves";
import { getCirculatingRaw } from "@shared/lib/supply";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { ReportCardEvidenceJournalByIdV1Schema } from "@shared/lib/report-card-evidence-journal";
import { SupplyAttributionJournalByIdV1Schema } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import {
  projectSafetyScoreV9PegScoreResult,
  projectSafetyScoreV9PegSummary,
  SafetyScoreV9PegProvenanceSummarySchema,
} from "./safety-score-v9-peg-provenance";
import {
  normalizeReviewedDeploymentAttribution,
  reviewedDeploymentAttributionValidationError,
} from "./safety-score-v9-supply-attribution-contract";
import {
  normalizeXautRepresentationGroupAttribution,
  XAUT_ASSET_ID,
  XautRepresentationGroupSupplyAttributionV2Schema,
  xautRepresentationGroupAttributionValidationError,
} from "./safety-score-v9-xaut-supply-attribution-contract";

const FreshnessEntrySchema = z.object({
  updatedAt: z.number().finite().nonnegative().nullable(),
  ageSeconds: z.number().finite().nonnegative().nullable(),
  stale: z.boolean(),
});

const NavPriceObservationSchema = z.strictObject({
  priceUsd: z.number().finite().positive(),
  sourceId: z.string().min(1),
  observedAtSec: z.number().int().nonnegative(),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
});

const CanonicalLockMintSupplyAttributionSchema = z.strictObject({
  model: z.literal("canonical-lock-mint-partition-v1"),
  observedAtSec: z.number().int().nonnegative(),
  currentSupplyUsdByChain: z
    .record(z.string().trim().min(1), z.number().finite().positive())
    .refine((rows) => Object.keys(rows).length >= 2, {
      message: "V9 lock/mint attribution requires canonical and pooled supply rows",
    }),
});

const ReviewedDeploymentSupplyRowSchema = z.strictObject({
  routeId: z.string().trim().min(1),
  chainId: z.string().trim().min(1),
  contractAddress: z.string().trim().min(1),
  decimals: z.number().int().min(0).max(36),
  rawSupply: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockNumberOrSlot: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockTimeSec: z.number().int().nonnegative(),
  blockHash: z.string().trim().min(1),
  runtimeCodeSha256: Sha256Schema.optional(),
  implementationAddress: z.string().trim().min(1).optional(),
  implementationCodeSha256: Sha256Schema.optional(),
  underlyingTokenAddress: z.string().trim().min(1).optional(),
  controllerAddress: z.string().trim().min(1).optional(),
  controllerProgramOwner: z.string().trim().min(1).optional(),
  programOwner: z.string().trim().min(1).optional(),
  mintAuthority: z.string().trim().min(1).optional(),
  currentSupplyUsd: z.number().finite().nonnegative(),
});

const ReviewedDeploymentUnitPartitionSchema = z.strictObject({
  model: z.literal("reviewed-deployment-unit-partition-v1"),
  assetId: z.string().trim().min(1),
  observedAtSec: z.number().int().nonnegative(),
  captureStartedAtSec: z.number().int().nonnegative(),
  captureEndedAtSec: z.number().int().nonnegative(),
  registryFingerprint: Sha256Schema,
  routeInventoryDigest: Sha256Schema,
  deployments: z.array(ReviewedDeploymentSupplyRowSchema).min(2),
});

export const SafetyScoreV9SupplyAttributionSchema = z.discriminatedUnion("model", [
  CanonicalLockMintSupplyAttributionSchema,
  XautRepresentationGroupSupplyAttributionV2Schema,
  ReviewedDeploymentUnitPartitionSchema,
]);

export type SafetyScoreV9SupplyAttribution = z.infer<typeof SafetyScoreV9SupplyAttributionSchema>;

/** Per-asset DEX pool coverage of circulating supply. */
const DexDeploymentSupplyCoverageSchema = z.strictObject({
  totalSupplyUsd: z.number().finite().positive(),
  observedSupplyUsd: z.number().finite().nonnegative(),
  verifiedNoPoolsSupplyUsd: z.number().finite().nonnegative(),
  providerInaccessibleSupplyUsd: z.number().finite().nonnegative(),
  unknownSupplyUsd: z.number().finite().nonnegative(),
  observedSupplyRatio: z.number().finite().min(0).max(1),
  verifiedNoPoolsSupplyRatio: z.number().finite().min(0).max(1),
  providerInaccessibleSupplyRatio: z.number().finite().min(0).max(1),
  unknownSupplyRatio: z.number().finite().min(0).max(1),
  unknownChains: z.array(z.string().min(1)),
});

export type DexDeploymentSupplyCoverage = z.infer<typeof DexDeploymentSupplyCoverageSchema>;

export function createFixedInputPayloadFields<
  TPublicationHealth extends z.ZodType,
  TChainCirculating extends z.ZodType,
  TAfterRedemption extends z.ZodRawShape,
  TBeforeLiveFallback extends z.ZodRawShape,
>(options: {
  publicationHealthSchema: TPublicationHealth;
  chainCirculatingByIdSchema: TChainCirculating;
  afterRedemptionBackstopMap: TAfterRedemption;
  beforeLiveToFallbackCoins: TBeforeLiveFallback;
}) {
  return {
    capturedAt: z.string().datetime(),
    sourceGeneration: z.string().min(1),
    registryRevision: z.string().min(1),
    methodologyVersion: z.string().min(1),
    clockSec: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    liquidityStale: z.boolean(),
    redemptionStale: z.boolean(),
    inputFreshness: z.object({
      dexLiquidity: FreshnessEntrySchema,
      redemptionBackstops: FreshnessEntrySchema,
    }),
    v9PublicationInputHealth: options.publicationHealthSchema,
    pegDataById: z.record(z.string(), PegSummaryCoinSchema),
    navPriceById: z.record(z.string(), NavPriceObservationSchema).optional(),
    activeDepegPeakBpsById: z.record(z.string(), z.number().finite().nonnegative()),
    redemptionBackstopMap: RedemptionBackstopMapSchema,
    ...options.afterRedemptionBackstopMap,
    liveReserveMap: z.record(z.string(), z.array(ReserveSliceSchema)),
    liveReserveProvenanceMap: z.record(
      z.string(),
      z.object({ source: z.string().min(1), fetchedAt: z.number().int().nonnegative() }),
    ),
    chainCirculatingById: options.chainCirculatingByIdSchema,
    // DefiLlama list buckets are already USD-denominated. Consumers must use
    // getCirculatingRaw() and must never multiply these values by price.
    aggregateCirculatingById: z
      .record(
        z.string(),
        z.object({
          circulating: z.record(z.string(), z.number().finite().nonnegative()),
          observedAtSec: z.number().int().nonnegative().nullable(),
        }),
      )
      .default({}),
    safetyScoreV9SupplyAttributionById: z
      .record(z.string(), SafetyScoreV9SupplyAttributionSchema)
      .default({}),
    // Both journals are diagnostic-only and excluded from base-input identity.
    evidenceJournalById: ReportCardEvidenceJournalByIdV1Schema.default({}),
    supplyAttributionJournalById: SupplyAttributionJournalByIdV1Schema.default({}),
    pegProvenanceById: z
      .record(z.string(), SafetyScoreV9PegProvenanceSummarySchema)
      .default({}),
    dexDeploymentSupplyCoverageById: z.record(z.string(), DexDeploymentSupplyCoverageSchema).default({}),
    ...options.beforeLiveToFallbackCoins,
    liveToFallbackCoins: z.array(z.string()).default([]),
  };
}

export function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export function assertSameIds(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    const expectedSet = new Set(expectedSorted);
    const actualSet = new Set(actualSorted);
    throw new Error(
      `${label} mismatch: missing=${expectedSorted.filter((id) => !actualSet.has(id)).join(",") || "none"}; ` +
        `unexpected=${actualSorted.filter((id) => !expectedSet.has(id)).join(",") || "none"}`,
    );
  }
}

interface CommonFixedInput {
  activeAssetIds: string[];
  navPriceById?: Record<string, unknown>;
  clockSec: number;
  registryFingerprint: string;
  liquidityStale: boolean;
  redemptionStale: boolean;
  dexGenerationId: string;
  redemptionGenerationId: string;
  dexLiqMap: Record<string, { updatedAt: number }>;
  redemptionBackstopMap: Record<string, { updatedAt: number }>;
  inputFreshness: Record<string, z.infer<typeof FreshnessEntrySchema>> & {
    dexLiquidity: z.infer<typeof FreshnessEntrySchema>;
    redemptionBackstops: z.infer<typeof FreshnessEntrySchema>;
  };
  aggregateCirculatingById: Record<string, { circulating: Record<string, number> }>;
  safetyScoreV9SupplyAttributionById: Record<string, SafetyScoreV9SupplyAttribution>;
  evidenceJournalById: Record<string, Array<{ completedAtSec: number }>>;
  supplyAttributionJournalById: Record<string, Array<{ completedAtSec: number }>>;
  pegProvenanceById: Record<string, z.infer<typeof SafetyScoreV9PegProvenanceSummarySchema>>;
  pegDataById: Record<string, z.infer<typeof PegSummaryCoinSchema>>;
}

interface CommonConsistencyOptions {
  phase: "identity" | "evidence" | "freshness";
  laneLabel: "Fixed input" | "Native V9 input";
  exactLabel: "Exact fixed input" | "Native V9 input";
  requireProducerBindings: boolean;
  validateNavPriceIds: boolean;
  dexActiveRowsLabel?: string;
}

export function assertCommonFixedInputConsistency(
  input: CommonFixedInput,
  options: CommonConsistencyOptions,
): void {
  if (options.phase === "identity") {
    if (new Set(input.activeAssetIds).size !== input.activeAssetIds.length) {
      throw new Error(`${options.laneLabel} active asset identities contain duplicates`);
    }
    if (options.validateNavPriceIds) {
      const invalidNavPriceIds = Object.keys(input.navPriceById ?? {}).filter(
        (id) => ACTIVE_STABLECOINS.find((coin) => coin.id === id)?.flags.navToken !== true,
      );
      if (invalidNavPriceIds.length > 0) {
        throw new Error(`${options.laneLabel} NAV price rows target non-NAV assets: ${invalidNavPriceIds.join(",")}`);
      }
    }
    if (options.dexActiveRowsLabel) {
      assertSameIds(Object.keys(input.dexLiqMap), input.activeAssetIds, options.dexActiveRowsLabel);
    }
    return;
  }

  if (options.phase === "evidence") {
    for (const [assetId, attribution] of Object.entries(input.safetyScoreV9SupplyAttributionById)) {
      if (!input.activeAssetIds.includes(assetId)) {
        throw new Error(`V9 supply attribution targets inactive asset ${assetId}`);
      }
      if (attribution.model !== "reviewed-deployment-unit-partition-v1" && attribution.observedAtSec > input.clockSec) {
        throw new Error(`V9 supply attribution for ${assetId} is later than the scoring clock`);
      }
      if (assetId === XAUT_ASSET_ID && attribution.model === "canonical-lock-mint-partition-v1") {
        throw new Error("Legacy XAUT lock/mint attribution is no longer admissible; a reconciled V2 packet is required");
      }
      const aggregateSupplyUsd = getCirculatingRaw(input.aggregateCirculatingById[assetId] ?? {});
      const attributedSupplyUsd =
        attribution.model === "canonical-lock-mint-partition-v1"
          ? Object.values(attribution.currentSupplyUsdByChain).reduce((sum, value) => sum + value, 0)
          : attribution.model === "canonical-lock-mint-group-partition-v2"
            ? attribution.canonical.currentSupplyUsd + attribution.representationGroup.currentSupplyUsd
            : attribution.deployments.reduce((sum, deployment) => sum + deployment.currentSupplyUsd, 0);
      const toleranceUsd = Math.max(0.000001, aggregateSupplyUsd * 1e-12);
      if (aggregateSupplyUsd <= 0 || Math.abs(attributedSupplyUsd - aggregateSupplyUsd) > toleranceUsd) {
        throw new Error(`V9 supply attribution for ${assetId} does not conserve aggregate circulating USD`);
      }
      if (attribution.model === "reviewed-deployment-unit-partition-v1") {
        const validationError = reviewedDeploymentAttributionValidationError({
          assetId,
          attribution,
          aggregateSupplyUsd,
          registryFingerprint: input.registryFingerprint,
          clockSec: input.clockSec,
        });
        if (validationError) throw new Error(validationError);
      } else if (attribution.model === "canonical-lock-mint-group-partition-v2") {
        if (attribution.assetId !== assetId) {
          throw new Error(`V9 supply attribution key ${assetId} does not match packet asset ${attribution.assetId}`);
        }
        const validationError = xautRepresentationGroupAttributionValidationError({
          attribution,
          aggregateSupplyUsd,
          registryFingerprint: input.registryFingerprint,
          clockSec: input.clockSec,
        });
        if (validationError) throw new Error(validationError);
      }
    }
    for (const [assetId, records] of Object.entries(input.evidenceJournalById)) {
      if (!input.activeAssetIds.includes(assetId)) throw new Error(`Evidence journal targets inactive asset ${assetId}`);
      for (const record of records) {
        if (record.completedAtSec > input.clockSec) {
          throw new Error(`Evidence journal for ${assetId} is later than the scoring clock`);
        }
      }
    }
    for (const [assetId, records] of Object.entries(input.supplyAttributionJournalById)) {
      if (!input.activeAssetIds.includes(assetId)) {
        throw new Error(`Supply attribution journal targets inactive asset ${assetId}`);
      }
      for (const record of records) {
        if (record.completedAtSec > input.clockSec) {
          throw new Error(`Supply attribution journal for ${assetId} is later than the scoring clock`);
        }
      }
    }
    const pegProvenanceIds = Object.keys(input.pegProvenanceById);
    if (pegProvenanceIds.length > 0) {
      assertSameIds(pegProvenanceIds, Object.keys(input.pegDataById), "V9 peg provenance rows");
    }
    for (const [assetId, summary] of Object.entries(input.pegProvenanceById)) {
      const pegSummary = input.pegDataById[assetId];
      if (!pegSummary || summary.assetId !== assetId) {
        throw new Error(`V9 peg provenance does not match peg row ${assetId}`);
      }
      if (summary.clockSec !== input.clockSec || summary.trackingStartSec !== (pegSummary.historyCoverage?.startedAt ?? null)) {
        throw new Error(`V9 peg provenance clock/coverage does not match peg row ${assetId}`);
      }
      if (
        stableJsonStringifyV1(projectSafetyScoreV9PegScoreResult(summary.legacyInclusive.result)) !==
        stableJsonStringifyV1(projectSafetyScoreV9PegSummary(pegSummary))
      ) {
        throw new Error(`V9 peg provenance score does not match peg row ${assetId}`);
      }
    }
    return;
  }

  const dexFreshness = input.inputFreshness.dexLiquidity;
  if (options.requireProducerBindings) {
    const dexTimestamps = [...new Set(Object.values(input.dexLiqMap).map((row) => String(row.updatedAt)))].sort();
    if (dexTimestamps.length !== 1 || Number(dexTimestamps[0]) !== dexFreshness.updatedAt) {
      throw new Error(`${options.exactLabel} DEX rows do not match the DEX freshness generation`);
    }
    const expectedDexGeneration = `dex-liquidity-${dexFreshness.updatedAt}`;
    if (input.dexGenerationId !== expectedDexGeneration) {
      throw new Error(
        `${options.exactLabel} DEX generation ${input.dexGenerationId} does not match active-row generation ${expectedDexGeneration}`,
      );
    }
    const redemptionFreshness = input.inputFreshness.redemptionBackstops;
    const hasRedemptionRows = Object.keys(input.redemptionBackstopMap).length > 0;
    if (hasRedemptionRows) {
      const timestamps = [...new Set(Object.values(input.redemptionBackstopMap).map((row) => String(row.updatedAt)))].sort();
      if (timestamps.length !== 1 || Number(timestamps[0]) !== redemptionFreshness.updatedAt) {
        throw new Error(`${options.exactLabel} redemption rows do not match the redemption freshness generation`);
      }
    } else if (!redemptionFreshness.stale) {
      throw new Error(`${options.exactLabel} has no redemption rows but marks redemption freshness as current`);
    }
    if (
      (hasRedemptionRows && !input.redemptionGenerationId.startsWith("redemption:")) ||
      (!hasRedemptionRows && input.redemptionGenerationId !== "redemption-backstops-unavailable")
    ) {
      throw new Error(`${options.exactLabel} redemption generation ${input.redemptionGenerationId} is not producer-bound`);
    }
    if (input.liquidityStale !== dexFreshness.stale || input.redemptionStale !== redemptionFreshness.stale) {
      throw new Error(`${options.exactLabel} top-level freshness flags do not match lane freshness`);
    }
  }
  for (const [lane, freshness] of Object.entries(input.inputFreshness)) {
    if (freshness.updatedAt != null && freshness.updatedAt > input.clockSec) {
      throw new Error(
        `${options.laneLabel} ${lane} producer timestamp ${freshness.updatedAt} is later than scoring clock ${input.clockSec}`,
      );
    }
    if (freshness.updatedAt == null || freshness.ageSeconds == null) {
      if (!freshness.stale) throw new Error(`${options.laneLabel} ${lane} freshness is incomplete but not stale`);
      continue;
    }
    const expectedAge = input.clockSec - freshness.updatedAt;
    if (freshness.ageSeconds !== expectedAge) {
      throw new Error(`${options.laneLabel} ${lane} age ${freshness.ageSeconds} does not match clock-derived age ${expectedAge}`);
    }
  }
}

interface CommonNormalizationInput {
  pegDataById: Record<string, unknown>;
  navPriceById?: Record<string, unknown>;
  activeDepegPeakBpsById: Record<string, unknown>;
  bluechipMap?: Record<string, unknown>;
  resolvedBlacklistStatuses?: Record<string, unknown>;
  liveReserveMap: Record<string, unknown>;
  liveReserveProvenanceMap: Record<string, unknown>;
  chainCirculatingById: Record<string, unknown>;
  aggregateCirculatingById: Record<string, unknown>;
  safetyScoreV9SupplyAttributionById: Record<string, SafetyScoreV9SupplyAttribution>;
  evidenceJournalById: Record<string, unknown>;
  supplyAttributionJournalById: Record<string, unknown>;
  pegProvenanceById: Record<string, unknown>;
  dexDeploymentSupplyCoverageById: Record<string, unknown>;
  liveToFallbackCoins: string[];
}

export function normalizeCommonFixedInputRecords(input: CommonNormalizationInput) {
  return {
    pegDataById: sortedRecord(input.pegDataById),
    ...(input.navPriceById ? { navPriceById: sortedRecord(input.navPriceById) } : {}),
    activeDepegPeakBpsById: sortedRecord(input.activeDepegPeakBpsById),
    ...(input.bluechipMap ? { bluechipMap: sortedRecord(input.bluechipMap) } : {}),
    ...(input.resolvedBlacklistStatuses
      ? { resolvedBlacklistStatuses: sortedRecord(input.resolvedBlacklistStatuses) }
      : {}),
    liveReserveMap: sortedRecord(input.liveReserveMap),
    liveReserveProvenanceMap: sortedRecord(input.liveReserveProvenanceMap),
    chainCirculatingById: sortedRecord(input.chainCirculatingById),
    aggregateCirculatingById: sortedRecord(input.aggregateCirculatingById),
    safetyScoreV9SupplyAttributionById: sortedRecord(
      Object.fromEntries(
        Object.entries(input.safetyScoreV9SupplyAttributionById).map(([assetId, attribution]) => [
          assetId,
          attribution.model === "canonical-lock-mint-partition-v1"
            ? { ...attribution, currentSupplyUsdByChain: sortedRecord(attribution.currentSupplyUsdByChain) }
            : attribution.model === "canonical-lock-mint-group-partition-v2"
              ? normalizeXautRepresentationGroupAttribution(attribution)
              : normalizeReviewedDeploymentAttribution(attribution),
        ]),
      ),
    ),
    evidenceJournalById: input.evidenceJournalById,
    supplyAttributionJournalById: input.supplyAttributionJournalById,
    pegProvenanceById: sortedRecord(input.pegProvenanceById),
    dexDeploymentSupplyCoverageById: sortedRecord(input.dexDeploymentSupplyCoverageById),
    liveToFallbackCoins: [...input.liveToFallbackCoins].sort(),
  };
}
