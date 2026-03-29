import type { DependencyType } from "./dependency-types";

export type ReserveRisk = "very-low" | "low" | "medium" | "high" | "very-high";

export interface ReserveSlice {
  name: string;
  pct: number;
  risk: ReserveRisk;
  coinId?: string;
  depType?: DependencyType;
}
