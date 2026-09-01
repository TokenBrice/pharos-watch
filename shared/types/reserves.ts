import { z } from "zod";
import { DependencyTypeSchema, type DependencyType } from "./dependency-types";

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

export interface ReserveSlice {
  sourceKey?: string;
  name: string;
  pct: number;
  risk: ReserveRisk;
  coinId?: string;
  depType?: DependencyType;
  blacklistable?: boolean;
  blacklistabilityExposure?: ReserveBlacklistabilityExposure;
  assetClass?: ReserveAssetClass;
  issuerOrObligor?: string;
  riskFactors?: ReserveRiskFactor[];
  liquidityHorizon?: ReserveLiquidityHorizon;
  maturityDaysMax?: number;
}

export const ReserveSliceSchema: z.ZodType<ReserveSlice> = z.object({
  sourceKey: z.string()
    .trim()
    .min(3)
    .max(160)
    .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._:/-]*$/)
    .optional(),
  name: z.string(),
  pct: z.number().finite().positive().max(100),
  risk: ReserveRiskSchema,
  coinId: z.string().optional(),
  depType: DependencyTypeSchema.optional(),
  blacklistable: z.boolean().optional(),
  blacklistabilityExposure: ReserveBlacklistabilityExposureSchema.optional(),
  assetClass: ReserveAssetClassSchema.optional(),
  issuerOrObligor: z.string().min(1).optional(),
  riskFactors: z.array(ReserveRiskFactorSchema).min(1).optional(),
  liquidityHorizon: ReserveLiquidityHorizonSchema.optional(),
  maturityDaysMax: z.number().finite().int().nonnegative().optional(),
}).strict().superRefine((slice, ctx) => {
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
): z.ZodType<ReserveSlice[]> {
  return z.array(ReserveSliceSchema).superRefine((reserves, ctx) => {
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
export const PartialKnownExposureReserveCompositionSchema =
  createReserveCompositionSchema("partial-known-exposure");
