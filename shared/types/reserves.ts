import { z } from "zod";
import { DependencyTypeSchema } from "./dependency-types";
import { ReserveBoundedFactSchema } from "./reserve-bounded-facts";

const RESERVE_RISK_VALUES = ["very-low", "low", "medium", "high", "very-high"] as const;
export type ReserveRisk = (typeof RESERVE_RISK_VALUES)[number];
export const ReserveRiskSchema = z.enum(RESERVE_RISK_VALUES);

const RESERVE_BLACKLISTABILITY_EXPOSURE_VALUES = ["yes", "upstream", "possible", "no", "unknown"] as const;
export type ReserveBlacklistabilityExposure = (typeof RESERVE_BLACKLISTABILITY_EXPOSURE_VALUES)[number];
const ReserveBlacklistabilityExposureSchema = z.enum(RESERVE_BLACKLISTABILITY_EXPOSURE_VALUES);

const RESERVE_ASSET_CLASS_VALUES = [
  "cash",
  "bank-deposit",
  "treasury-bill",
  "government-security",
  "repo",
  "money-market-fund",
  "stablecoin",
  "cryptoasset",
  "hedged-crypto",
  "private-credit",
  "public-credit",
  "tokenized-security",
  "fund-share",
  "protocol-position",
  "commodity-allocated",
  "other",
] as const;
export type ReserveAssetClass = (typeof RESERVE_ASSET_CLASS_VALUES)[number];
export const ReserveAssetClassSchema = z.enum(RESERVE_ASSET_CLASS_VALUES);

const RESERVE_RISK_FACTOR_VALUES = [
  "credit",
  "duration",
  "liquidity",
  "custody",
  "counterparty",
  "smart-contract",
  "market",
  "basis",
  "legal",
  "concentration",
  "leverage",
] as const;
export type ReserveRiskFactor = (typeof RESERVE_RISK_FACTOR_VALUES)[number];
export const ReserveRiskFactorSchema = z.enum(RESERVE_RISK_FACTOR_VALUES);

const RESERVE_LIQUIDITY_HORIZON_VALUES = ["immediate", "one-day", "seven-days", "over-seven-days", "unknown"] as const;
export type ReserveLiquidityHorizon = (typeof RESERVE_LIQUIDITY_HORIZON_VALUES)[number];
const ReserveLiquidityHorizonSchema = z.enum(RESERVE_LIQUIDITY_HORIZON_VALUES);

export const ReserveIntermediarySchema = z.object({
  kind: z.enum(["bridge", "wrapper-token", "vault-share"]),
  label: z.string().trim().min(1),
  chain: z.string().trim().min(1).optional(),
  contract: z.string().trim().min(1).optional(),
  verified: z.boolean(),
  sourceUrl: z.string().url().optional(),
}).strict();
export type ReserveIntermediary = z.output<typeof ReserveIntermediarySchema>;

export const ReserveSliceSchema = z.object({
  sourceKey: z.string()
    .trim()
    .min(3)
    .max(160)
    .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._:/-]*$/)
    .optional(),
  name: z.string(),
  pct: z.number().finite().nonnegative().max(100),
  risk: ReserveRiskSchema,
  coinId: z.string().optional(),
  depType: DependencyTypeSchema.optional(),
  intermediary: ReserveIntermediarySchema.optional(),
  blacklistable: z.boolean().optional(),
  blacklistabilityExposure: ReserveBlacklistabilityExposureSchema.optional(),
  assetClass: ReserveAssetClassSchema.optional(),
  issuerOrObligor: z.string().min(1).optional(),
  riskFactors: z.array(ReserveRiskFactorSchema).min(1).optional(),
  liquidityHorizon: ReserveLiquidityHorizonSchema.optional(),
  maturityDaysMax: z.number().finite().int().nonnegative().optional(),
  boundedFacts: z.array(ReserveBoundedFactSchema).optional(),
  /** Producer-declared unknown quantity, not an adverse asset classification. */
  unclassifiedResidual: z.literal(true).optional(),
  residualReason: z.literal("insufficient-evidence").optional(),
}).strict().superRefine((slice, ctx) => {
  if ((slice.unclassifiedResidual && !slice.residualReason) ||
    (slice.residualReason && !slice.unclassifiedResidual)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unclassified residual requires an explicit marker and reason",
      path: ["unclassifiedResidual"],
    });
  }
  if (slice.pct === 0 && !slice.sourceKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "zero-percent reviewed reserve slices require sourceKey",
      path: ["pct"],
    });
  }
  if (slice.intermediary && !slice.coinId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reserve intermediary requires coinId",
      path: ["intermediary"],
    });
  }
  if (
    slice.blacklistable === true &&
    (slice.blacklistabilityExposure === "no" || slice.blacklistabilityExposure === "unknown")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "blacklistable reserve slices cannot declare blacklistabilityExposure=no or unknown",
      path: ["blacklistabilityExposure"],
    });
  }
});
export type ReserveSlice = z.infer<typeof ReserveSliceSchema>;

// Authored evidence must classify every linked identity. Runtime snapshots
// remain readable so derivation can quarantine an untyped link row by row.
export const AuthoredReserveSliceSchema = ReserveSliceSchema.superRefine((slice, ctx) => {
  if (slice.coinId && !slice.depType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "linked reserve slices require depType",
      path: ["depType"],
    });
  }
});

export type ReserveCompositionValidationMode = "full" | "partial-known-exposure";

export const RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT = 0.5;

function getReserveCompositionTotalPct(reserves: readonly Pick<ReserveSlice, "pct">[]): number {
  return reserves.reduce((total, reserve) => total + reserve.pct, 0);
}

export function validateReserveCompositionTotal(
  reserves: readonly Pick<ReserveSlice, "pct">[],
  mode: ReserveCompositionValidationMode,
): boolean {
  const totalPct = getReserveCompositionTotalPct(reserves);
  if (mode === "partial-known-exposure") {
    return totalPct <= 100 + RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT;
  }
  return Math.abs(totalPct - 100) <= RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT;
}

function createReserveCompositionSchema(
  mode: ReserveCompositionValidationMode,
  sliceSchema: z.ZodType<ReserveSlice> = ReserveSliceSchema,
): z.ZodType<ReserveSlice[]> {
  return z.array(sliceSchema).superRefine((reserves, ctx) => {
    if (validateReserveCompositionTotal(reserves, mode)) return;

    const totalPct = getReserveCompositionTotalPct(reserves);
    const expected = mode === "full"
      ? `sum to 100% within ${RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT}%`
      : `not exceed 100% by more than ${RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT}%`;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Reserve composition must ${expected}; got ${totalPct.toFixed(4)}%`,
    });
  });
}

export const FullReserveCompositionSchema = createReserveCompositionSchema("full");
export const FullAuthoredReserveCompositionSchema = createReserveCompositionSchema("full", AuthoredReserveSliceSchema);
export const PartialKnownExposureReserveCompositionSchema =
  createReserveCompositionSchema("partial-known-exposure");
