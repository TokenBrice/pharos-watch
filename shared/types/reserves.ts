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
