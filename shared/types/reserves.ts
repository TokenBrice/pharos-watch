import { z } from "zod";
import { DependencyTypeSchema, type DependencyType } from "./dependency-types";

export const RESERVE_RISK_VALUES = ["very-low", "low", "medium", "high", "very-high"] as const;
export type ReserveRisk = (typeof RESERVE_RISK_VALUES)[number];
export const ReserveRiskSchema = z.enum(RESERVE_RISK_VALUES);

export interface ReserveSlice {
  name: string;
  pct: number;
  risk: ReserveRisk;
  coinId?: string;
  depType?: DependencyType;
  blacklistable?: boolean;
}

export const ReserveSliceSchema: z.ZodType<ReserveSlice> = z.object({
  name: z.string(),
  pct: z.number().finite().positive().max(100),
  risk: ReserveRiskSchema,
  coinId: z.string().optional(),
  depType: DependencyTypeSchema.optional(),
  blacklistable: z.boolean().optional(),
}).strict();

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
