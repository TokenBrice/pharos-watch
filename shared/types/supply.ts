import { CORE_STABLECOIN_AGGREGATE_UNIVERSES } from "./aggregate-universe";
import { z } from "zod";
import {
  PriceConfidenceSchema,
  PriceObservedAtModeSchema,
  NominalPriceReferenceSchema,
  PricePublicationReasonSchema,
  PriceSourceConfidenceProfileSchema,
} from "./price";
import { CurrentPegSchema } from "./current-peg";
import { FxReferenceEvidenceMapSchema, SelectedPegReferencesSchema } from "./fx-reference";
import { SfraxStockPerimeterObservationSchema } from "./sfrax-supply";
import { ContractDeploymentSchema } from "./stablecoin-meta-primitives";
import { ListingClassSchema } from "./stablecoin-taxonomy";
import { NonNegativeFiniteSchema, StrictIsoDateSchema, UnixSecondsSchema } from "./safety-schema-primitives";
import { PriceDerivationSchema } from "./price";

/** Canonical producer refusal, not a measured zero or a provider-history fallback. */
export const SupplyUnavailableReasonSchema = z.enum(["supply-chain-dropout", "economic-float-unreconciled"]);
export type SupplyUnavailableReason = z.infer<typeof SupplyUnavailableReasonSchema>;

export const PegBucketsSchema = z.record(z.string(), z.number());

export const SupplyChangeBaselinesSchema = z.partialRecord(z.enum(["day", "week", "month"]), z.object({
  observedAt: UnixSecondsSchema.positive(),
  circulatingUsd: NonNegativeFiniteSchema,
  circulatingNative: NonNegativeFiniteSchema.nullable(),
}).nullable());

const StablecoinDetailTokenSchema = z.object({
  nativeSupplySource: z.literal("onchain-circulating-supply").optional(),
  nativeSupplyObservedAt: UnixSecondsSchema.positive().optional(),
  date: z.number().optional(),
  totalCirculatingUSD: PegBucketsSchema.optional(),
  totalCirculating: PegBucketsSchema.optional(),
  circulating: PegBucketsSchema.optional(),
}).passthrough();

/** Public per-coin detail response; provider-specific fields intentionally pass through. */
export const StablecoinDetailResponseSchema = z.object({
  price: z.number().nullable().optional(),
  priceSource: z.string().nullable().optional(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  pricePublicationReason: PricePublicationReasonSchema.optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  /** Canonical parent derivation of the overlaid publication quote only. */
  priceDerivation: PriceDerivationSchema.optional(),
  currentPeg: CurrentPegSchema.optional(),
  /** Current admitted list USD buckets; distinct from the provider's dated token history. */
  currentCirculatingUSD: PegBucketsSchema.optional(),
  currentCirculatingNative: NonNegativeFiniteSchema.nullish(),
  /** Canonical producer source of the admitted current supply overlay. */
  currentSupplySource: z.string().optional(),
  commodityHistoryObservedAt: UnixSecondsSchema.positive().optional(),
  currentCirculatingPrevDayUSD: PegBucketsSchema.optional(),
  currentCirculatingPrevWeekUSD: PegBucketsSchema.optional(),
  currentCirculatingPrevMonthUSD: PegBucketsSchema.optional(),
  supplyChangeBaselines: SupplyChangeBaselinesSchema.optional(),
  currentSupplyObservedAt: z.number().finite().positive().optional(),
  /** Canonical carry-forward provenance for the admitted current supply overlay. */
  currentSupplyRestored: z.boolean().optional(),
  /** Canonical partial coverage: chain labels excluded (unavailable) from the admitted current supply. */
  currentSupplyExcludedChains: z.array(z.string()).min(1).optional(),
  /** Canonical matched comparison perimeter (Pricing v6.90): chain labels excluded from both ends of a change. */
  currentSupplyComparisonExcludedChains: z.array(z.string()).min(1).optional(),
  /**
   * Canonical producer refusal: consumers must not substitute the provider's
   * dated history for current unavailable supply.
   */
  currentSupplyUnavailableReason: SupplyUnavailableReasonSchema.optional(),
  tokens: z.array(StablecoinDetailTokenSchema).optional(),
}).passthrough();
export type StablecoinDetailResponse = z.infer<typeof StablecoinDetailResponseSchema>;

/**
 * Published aggregate peg buckets: finite nonnegative USD per bucket. `{}` stays absence (read it with
 * the `*OrNull` supply helpers); an explicit `0` is an observed zero (CR-13 / D01-2).
 */
const SupplyBucketsSchema = z.record(z.string(), z.number().finite().nonnegative());

/**
 * Per-chain supply scalars. `null` = the chain row exists but that observation was unavailable (empty or
 * invalid provider bucket); it is never a zero. Canonical storage and public wires carry `null` (Release B).
 */
const ChainSupplyValueSchema = z.number().finite().nonnegative().nullable();

const ChainCirculatingSchema = z.record(
  z.string(),
  z.object({
    chainId: z.string().optional(),
    current: ChainSupplyValueSchema,
    circulatingPrevDay: ChainSupplyValueSchema.optional(),
    circulatingPrevWeek: ChainSupplyValueSchema.optional(),
    circulatingPrevMonth: ChainSupplyValueSchema.optional(),
  }),
);

/**
 * DEC-01 provenance on a row whose aggregate supply was raised by the bounded CoinGecko gap-fill. The
 * canonical DefiLlama total stays visible beside the supplemental CoinGecko value and the admitted ratio.
 */
export const SupplyGapFillProvenanceSchema = z.object({
  method: z.literal("coingecko-single-missing-chain"),
  /** `entered` = admitted inside the entry band; `retained` = kept by the hysteresis band. */
  admission: z.enum(["entered", "retained"]),
  missingChainId: z.string(),
  canonicalSource: z.literal("defillama"),
  canonicalCurrentUsd: z.number().finite().positive(),
  supplementalSource: z.literal("coingecko"),
  supplementalCurrentUsd: z.number().finite().positive(),
  ratio: z.number().finite().positive(),
  maxRatio: z.number().finite().positive(),
  observedAt: z.number().int().nonnegative(),
  /** Consecutive no-decision publications; fresh reconciliation resets this bounded carry. */
  carryForwardRuns: z.number().int().nonnegative().optional(),
  /** Missing-chain history withheld when aggregate or chain history is unobserved or nonconserving. */
  withheldHistoricalBuckets: z.array(z.enum(["day", "week", "month"])).min(1).optional(),
  /** Present iff buckets are withheld; its key set exactly equals `withheldHistoricalBuckets`. */
  withheldHistoricalBucketReasons: z.partialRecord(
    z.enum(["day", "week", "month"]),
    z.enum(["history-unobserved", "nonconserving"]),
  ).optional(),
});
export type SupplyGapFillProvenance = z.infer<typeof SupplyGapFillProvenanceSchema>;

/** On-chain shares apportioned onto a source-owned aggregate; carried shares keep their original read clock. */
export const ChainPartitionProvenanceSchema = z.object({
  basis: z.literal("onchain-share"),
  observedAt: z.number().int().positive(),
  onchainUsd: z.number().finite().positive(),
  ratio: z.number().finite().positive(),
  admission: z.enum(["entered", "retained", "carried"]),
});
export type ChainPartitionProvenance = z.infer<typeof ChainPartitionProvenanceSchema>;

/** Current-chain dropout evidence; historical aggregate buckets are never rewritten by this lane. */
export const SupplyChainGuardProvenanceSchema = z.object({
  reason: z.literal("supply-chain-dropout"),
  status: z.enum(["repaired", "quarantined", "unavailable", "chains-unavailable"]),
  quarantinedSince: z.number().int().nonnegative().optional(),
  /**
   * A bounded minority-share quarantine, reviewed exclusion, or fill-default native remainder publishes
   * `status: "chains-unavailable"`: the aggregate excludes unavailable chains; fill-default uses native reads only.
   */
  partialCoverage: z.literal(true).optional(),
  /**
   * Same-run supply gain on this asset's healthy chains large enough to explain the drop (e.g. a bridge
   * representation reattributed to its source). Attribution is ambiguous, so repairs are withheld and a
   * material drop holds the vetted whole-asset total.
   */
  concurrentGainUsd: z.number().finite().nonnegative().optional(),
  /**
   * Pricing v6.90: windows whose live provider baseline excludes this guard's unavailable chains from both
   * ends (a gap below the 2% materiality bound that the provider reads as zero or omits). Only the row's own
   * comparison stands; stored history across the gap keeps partial comparison coverage.
   */
  matchedComparisonWindows: z.array(z.enum(["day", "week", "month"])).min(1).optional(),
  chains: z.array(z.object({
    chainId: z.string().optional(),
    chainLabel: z.string(),
    listCurrentUsd: z.number().finite().nonnegative().nullable(),
    baselineUsd: z.number().finite().nonnegative(),
    baselineObservedAt: z.number().int().nonnegative(),
    baselineSource: z.enum(["state", "seed", "list-prev-day"]),
    resolution: z.enum(["onchain-total-supply", "defillama-chain-history", "carried-baseline", "unavailable"]),
    reviewedExclusion: z.object({
      reason: z.literal("reviewed-excluded"),
      reviewedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
      quarantinedSince: z.number().int().nonnegative(),
      evidenceUrl: z.string().url(),
    }).optional(),
    repairedCurrentUsd: z.number().finite().nonnegative().optional(),
    observedAt: z.number().int().nonnegative().optional(),
    /** Native probes carry a local-read clock; daily chart points carry their upstream observation time. */
    observedAtKind: z.enum(["upstream", "local-read"]).optional(),
  })).min(1),
});
export type SupplyChainGuardProvenance = z.infer<typeof SupplyChainGuardProvenanceSchema>;

/**
 * Recorded provenance of one admitted supply observation (daily history row / dataset row). A present
 * object attests that the writer inspected the admitted current row; `null`/absent means coverage was not
 * recorded (unknown, never complete). Source and clock stay null when the observation carried none.
 */
export const SupplyObservationProvenanceSchema = z.object({
  supplySource: z.string().nullable(),
  supplyObservedAt: z.number().int().nonnegative().nullable(),
  supplyChainGuard: SupplyChainGuardProvenanceSchema.nullable(),
  nativeQuantityUnavailable: z.literal(true).optional(),
  marketQuote: z.object({
    price: z.number().finite().positive(),
    observedAt: UnixSecondsSchema.positive().nullable(),
  }).optional(),
});
export type SupplyObservationProvenance = z.infer<typeof SupplyObservationProvenanceSchema>;

/**
 * Why a `supplyRestored` row was carried. Only the DefiLlama-outage fallback sets
 * `outage-fallback`; routine chain-dropout and coverage carries stay unmarked so
 * consumers can keep treating them as normal main-path carries.
 */
export const SupplyRestoreModeSchema = z.enum(["outage-fallback"]);
export type SupplyRestoreMode = z.infer<typeof SupplyRestoreModeSchema>;

export type SupplyQuantityBasis = "native-quantity" | "usd-value";

const supplyQuantityFields = {
  circulatingNative: NonNegativeFiniteSchema.nullish(),
  valuationPriceUsd: z.number().finite().positive().nullish(),
  valuationObservedAtSec: UnixSecondsSchema.nullish(),
};

export const CommodityEntitlementSchema = z.object({
  source: z.literal("matrixdock-frs").optional(),
  generation: z.string().min(1).optional(),
  quoteObservedAtSec: UnixSecondsSchema.positive().optional(),
  ozPerToken: z.number().finite().positive(),
  observedAtSec: UnixSecondsSchema.positive(),
});

/** XAGm's cache label withholds the static-ounce comparison on rollback. */
export const XAGM_ENTITLEMENT_PEG_TYPE = "entitlement-priced";

export function decodePublishedPegType(assetId: string, pegType: string): string {
  return assetId === "xagm-matrixdock" && pegType === XAGM_ENTITLEMENT_PEG_TYPE ? "peggedSILVER" : pegType;
}

const StablecoinDataRawSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  geckoId: z.string().nullable().optional(),
  gecko_id: z.string().nullable().optional(),
  pegType: z.string(),
  pegMechanism: z.string(),
  listingClass: ListingClassSchema.nullable().optional(),
  price: z.number().nullable(),
  priceSource: z.string().nullable(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  pricePublicationReason: PricePublicationReasonSchema.optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable().optional(),
  nominalPriceReference: NominalPriceReferenceSchema.optional(),
  priceDerivation: PriceDerivationSchema.optional(),
  currentPeg: CurrentPegSchema.optional(),
  priceSyncedAt: z.number().nullable().optional(),
  consensusSources: z.array(z.string()).optional(),
  agreeSources: z.array(z.string()).optional(),
  priceSourceConfidenceProfile: PriceSourceConfidenceProfileSchema.nullable().optional(),
  supplySource: z.string().optional(),
  supplyObservedAt: z.number().nullable().optional(),
  supplyRestored: z.boolean().optional(),
  supplyRestoreMode: SupplyRestoreModeSchema.optional(),
  supplyUnavailableReason: SupplyUnavailableReasonSchema.optional(),
  supplyPerimeter: SfraxStockPerimeterObservationSchema.optional(),
  supplyGapFill: SupplyGapFillProvenanceSchema.optional(),
  supplyChainGuard: SupplyChainGuardProvenanceSchema.optional(),
  chainPartition: ChainPartitionProvenanceSchema.optional(),
  ...supplyQuantityFields,
  supplyChangeBaselines: SupplyChangeBaselinesSchema.optional(),
  commodityEntitlement: CommodityEntitlementSchema.optional(),
  priceQuoteBasis: z.enum(["bid-ask-midpoint", "last-trade"]).optional(),
  upstreamKeys: z.array(z.string()).optional(),
  pricePoolKeys: z.array(z.string()).optional(),
  parityQuoteUnit: z.enum(["raw-token", "accrued-token"]).optional(),
  circulating: SupplyBucketsSchema,
  circulatingPrevDay: SupplyBucketsSchema.nullish(),
  circulatingPrevWeek: SupplyBucketsSchema.nullish(),
  circulatingPrevMonth: SupplyBucketsSchema.nullish(),
  chainCirculating: ChainCirculatingSchema,
  chains: z.array(z.string()),
  contracts: z.array(ContractDeploymentSchema).optional(),
  frozen: z.boolean().optional(),
  frozenAt: StrictIsoDateSchema.optional(),
});

/** JSON wire shape after legacy aliases and optional observations have been normalized. */
export const StablecoinDataOutputSchema = StablecoinDataRawSchema.omit({ gecko_id: true }).extend({
  geckoId: z.string().nullable(),
  listingClass: ListingClassSchema.nullable(),
  priceConfidence: PriceConfidenceSchema.nullable(),
  priceUpdatedAt: z.number().nullable(),
  priceObservedAt: z.number().nullable(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable(),
  priceSyncedAt: z.number().nullable(),
  consensusSources: z.array(z.string()),
  agreeSources: z.array(z.string()),
  priceSourceConfidenceProfile: PriceSourceConfidenceProfileSchema.optional(),
  supplyObservedAt: z.number().optional(),
  circulatingPrevDay: SupplyBucketsSchema,
  circulatingPrevWeek: SupplyBucketsSchema,
  circulatingPrevMonth: SupplyBucketsSchema,
});

export const StablecoinDataSchema = StablecoinDataRawSchema.transform((asset) => ({
  id: asset.id,
  name: asset.name,
  symbol: asset.symbol,
  geckoId: asset.geckoId ?? asset.gecko_id ?? null,
  pegType: asset.pegType,
  pegMechanism: asset.pegMechanism,
  listingClass: asset.listingClass ?? null,
  price: asset.price,
  priceSource: asset.priceSource,
  priceConfidence: asset.priceConfidence ?? null,
  ...(asset.pricePublicationReason != null ? { pricePublicationReason: asset.pricePublicationReason } : {}),
  priceUpdatedAt: asset.priceUpdatedAt ?? null,
  priceObservedAt: asset.priceObservedAt === undefined ? asset.priceUpdatedAt ?? null : asset.priceObservedAt,
  priceObservedAtMode: asset.priceObservedAtMode ?? null,
  ...(asset.nominalPriceReference != null ? { nominalPriceReference: asset.nominalPriceReference } : {}),
  ...(asset.priceDerivation != null ? { priceDerivation: asset.priceDerivation } : {}),
  ...(asset.currentPeg != null ? { currentPeg: asset.currentPeg } : {}),
  priceSyncedAt: asset.priceSyncedAt ?? null,
  consensusSources: asset.consensusSources ?? [],
  agreeSources: asset.agreeSources ?? [],
  ...(asset.priceSourceConfidenceProfile != null
    ? { priceSourceConfidenceProfile: asset.priceSourceConfidenceProfile }
    : {}),
  supplySource: asset.supplySource,
  ...(asset.supplyObservedAt != null ? { supplyObservedAt: asset.supplyObservedAt } : {}),
  ...(asset.supplyRestored === true ? { supplyRestored: true } : {}),
  ...(asset.supplyRestoreMode != null ? { supplyRestoreMode: asset.supplyRestoreMode } : {}),
  ...(asset.supplyUnavailableReason != null ? { supplyUnavailableReason: asset.supplyUnavailableReason } : {}),
  ...(asset.supplyPerimeter != null ? { supplyPerimeter: asset.supplyPerimeter } : {}),
  ...(asset.supplyGapFill != null ? { supplyGapFill: asset.supplyGapFill } : {}),
  ...(asset.supplyChainGuard != null ? { supplyChainGuard: asset.supplyChainGuard } : {}),
  ...(asset.chainPartition != null ? { chainPartition: asset.chainPartition } : {}),
  ...(asset.supplyChangeBaselines !== undefined ? { supplyChangeBaselines: asset.supplyChangeBaselines } : {}),
  ...(asset.commodityEntitlement !== undefined ? { commodityEntitlement: asset.commodityEntitlement } : {}),
  ...(asset.priceQuoteBasis !== undefined ? { priceQuoteBasis: asset.priceQuoteBasis } : {}),
  ...(asset.pricePoolKeys !== undefined ? { pricePoolKeys: asset.pricePoolKeys } : {}),
  ...(asset.upstreamKeys !== undefined ? { upstreamKeys: asset.upstreamKeys } : {}),
  ...(asset.parityQuoteUnit !== undefined ? { parityQuoteUnit: asset.parityQuoteUnit } : {}),
  ...(asset.circulatingNative !== undefined ? { circulatingNative: asset.circulatingNative } : {}),
  ...(asset.valuationPriceUsd !== undefined ? { valuationPriceUsd: asset.valuationPriceUsd } : {}),
  ...(asset.valuationObservedAtSec !== undefined ? { valuationObservedAtSec: asset.valuationObservedAtSec } : {}),
  circulating: asset.circulating,
  circulatingPrevDay: asset.circulatingPrevDay ?? {},
  circulatingPrevWeek: asset.circulatingPrevWeek ?? {},
  circulatingPrevMonth: asset.circulatingPrevMonth ?? {},
  chainCirculating: asset.chainCirculating,
  chains: asset.chains,
  ...(asset.contracts && asset.contracts.length > 0 ? { contracts: asset.contracts } : {}),
  ...(asset.frozen != null ? { frozen: asset.frozen } : {}),
  ...(asset.frozenAt != null ? { frozenAt: asset.frozenAt } : {}),
}));
export type StablecoinData = z.infer<typeof StablecoinDataSchema>;

export const StablecoinListResponseSchema = z.object({
  peggedAssets: z.array(StablecoinDataSchema),
  fxFallbackRates: z.record(z.string(), z.number()).optional(),
  fxReferenceObservations: FxReferenceEvidenceMapSchema.optional(),
  selectedPegReferences: SelectedPegReferencesSchema.optional(),
  fxAdmissionCoverageGeneration: z.string().uuid().optional(),
});
export type StablecoinListResponse = z.infer<typeof StablecoinListResponseSchema>;

const SupplyHistoryPointSchema = z.object({
  date: z.number(),
  circulatingUsd: z.number(),
  price: z.number().nullable(),
  ...supplyQuantityFields,
  /** Chain-coverage provenance of this daily observation; null/absent = unrecorded (legacy), never complete. */
  supplyProvenance: SupplyObservationProvenanceSchema.nullable().optional(),
});
export type SupplyHistoryPoint = z.infer<typeof SupplyHistoryPointSchema>;
export const SupplyHistoryResponseSchema = z.array(SupplyHistoryPointSchema);

const NonUsdSharePointSchema = z.object({
  date: z.number(),
  // Numeric observed subtotals; historical cohort coverage is disclosed separately.
  commodityShare: z.number(),
  fiatNonUsdShare: z.number(),
  commodity: z.number(),
  fiatNonUsd: z.number(),
  total: z.number(),
  coverage: z.object({
    basis: z.literal("interior-gap-prior-value"),
    total: z.number().min(0).max(1),
    commodity: z.number().min(0).max(1),
    fiatNonUsd: z.number().min(0).max(1),
  }).describe("Observed value divided by observed plus prior-value estimates for interior history gaps; not a deployment census.")
    .nullable().optional(),
});
export type NonUsdSharePoint = z.infer<typeof NonUsdSharePointSchema>;
export const NonUsdShareResponseSchema = z.array(NonUsdSharePointSchema);

export const STABLECOIN_CHART_LEGACY_AGGREGATE_UNIVERSE = "legacy-provider-all-stablecoins-v1" as const;
export const StablecoinChartAggregateUniverseSchema = z.enum([
  STABLECOIN_CHART_LEGACY_AGGREGATE_UNIVERSE,
  ...CORE_STABLECOIN_AGGREGATE_UNIVERSES,
]);

export const StablecoinChartResponseSchema = z.array(
  z.object({
    date: z.number(),
    // Omitted and null buckets are unavailable; only explicit finite nonnegative values are observations.
    totalCirculatingUSD: z.record(z.string(), z.number().finite().nonnegative().nullable()),
    aggregateUniverse: StablecoinChartAggregateUniverseSchema.optional(),
  }),
);
export type StablecoinChartPoint = z.infer<typeof StablecoinChartResponseSchema>[number];
