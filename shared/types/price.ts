import { z } from "zod";

export const DETAIL_PROVIDER_VALUES = ["defillama", "coingecko", "commodity"] as const;
export type DetailProvider = (typeof DETAIL_PROVIDER_VALUES)[number];
export const DetailProviderSchema = z.enum(DETAIL_PROVIDER_VALUES);

const PRICE_CONFIDENCE_VALUES = ["high", "single-source", "low", "fallback"] as const;
export type PriceConfidence = (typeof PRICE_CONFIDENCE_VALUES)[number];
const PRICE_OBSERVED_AT_MODE_VALUES = ["upstream", "local_fetch", "unknown", "nominal_reference", "unsupported"] as const;
export type PriceObservedAtMode = (typeof PRICE_OBSERVED_AT_MODE_VALUES)[number];
const DEPEG_PRIMARY_TRUST_VALUES = ["authoritative", "confirm_required", "unusable"] as const;
export type DepegPrimaryTrust = (typeof DEPEG_PRIMARY_TRUST_VALUES)[number];

export const PriceConfidenceSchema = z.enum(PRICE_CONFIDENCE_VALUES);
// Preserve forward compatibility without mistaking a future mode for legacy observation evidence.
export const PriceObservedAtModeSchema = z.preprocess(
  (value) => typeof value === "string" && !(PRICE_OBSERVED_AT_MODE_VALUES as readonly string[]).includes(value)
    ? "unsupported"
    : value,
  z.enum(PRICE_OBSERVED_AT_MODE_VALUES),
);
/** FX reference admission vocabulary shared with worker price validation (`PriceReferenceType`). */
export const PRICE_REFERENCE_TYPE_VALUES = ["fresh", "stale", "static", "none"] as const;
export type PriceReferenceType = (typeof PRICE_REFERENCE_TYPE_VALUES)[number];
export const NominalPriceReferenceSchema = z.object({
  price: z.number().finite().positive(),
  source: z.string(),
  mode: z.literal("nominal_reference"),
  /**
   * Non-USD par only: admission type of the FX reference that converted par to USD. Only `fresh` and
   * `static` references can produce par; USD par carries neither FX field.
   */
  fxReferenceType: z.enum(PRICE_REFERENCE_TYPE_VALUES).optional(),
  /** Non-USD par only: the FX reference's own per-peg source time (unix s); null when the reference has none. */
  fxObservedAt: z.number().int().positive().nullable().optional(),
});
export type NominalPriceReference = z.infer<typeof NominalPriceReferenceSchema>;
export const DepegPrimaryTrustSchema = z.enum(DEPEG_PRIMARY_TRUST_VALUES);

const PriceSourceConfidenceProfileObjectSchema = z
  .object({
    activeDexLanes: z.number().int().min(0),
    freshestDexLaneAgeSec: z.number().int().min(0).nullable(),
    aggregateLaneOnly: z.boolean(),
  })
  .strict();
export type PriceSourceConfidenceProfile = z.output<typeof PriceSourceConfidenceProfileObjectSchema>;
export const PriceSourceConfidenceProfileSchema: z.ZodType<PriceSourceConfidenceProfile> =
  PriceSourceConfidenceProfileObjectSchema;

export interface PegAssetBase {
  id: string;
  symbol: string;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  priceObservedAt?: number | null;
  priceObservedAtMode?: PriceObservedAtMode | null;
  nominalPriceReference?: NominalPriceReference;
  priceSyncedAt?: number | null;
  consensusSources?: string[];
  agreeSources?: string[];
  priceSourceConfidenceProfile?: PriceSourceConfidenceProfile | null;
  pegType?: string;
  circulating?: Record<string, number>;
}

/**
 * Attribution for a price derived from a tracked parent quote (e.g. parent price × vault NAV).
 * Descriptive only: `priceSource`/`priceConfidence` remain the trust authority. `navMethod` names a
 * successful live vault read; a cached rate instead names its original `rateObservedAt`.
 */
export const PriceDerivationSchema = z.object({
  inheritedFrom: z.string().min(1),
  parentSource: z.string().nullable(),
  parentConfidence: PriceConfidenceSchema.nullable(),
  parentObservedAt: z.number().finite().nullable(),
  parentObservedAtMode: PriceObservedAtModeSchema.nullable(),
  parentReplaySafe: z.boolean(),
  navMethod: z.enum(["convertToAssets", "previewRedeem"]).optional(),
  cachedVaultRate: z.object({
    rate: z.number().finite().positive(),
    rateObservedAt: z.number().finite().positive(),
  }).optional(),
});
export type PriceDerivation = z.infer<typeof PriceDerivationSchema>;
