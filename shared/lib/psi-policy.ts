import type { PsiConditionBand } from "../types/stability";
import { bandFromThresholds } from "./math";

/** Inclusive lower bounds, ordered from the most stable band to the least. */
export const PSI_CONDITION_BANDS: readonly { min: number; band: PsiConditionBand }[] = [
  { min: 90, band: "BEDROCK" },
  { min: 75, band: "STEADY" },
  { min: 60, band: "TREMOR" },
  { min: 40, band: "FRACTURE" },
  { min: 20, band: "CRISIS" },
  { min: 0, band: "MELTDOWN" },
];

/** Penalty ceilings and the absolute trend bound, shared by scoring and display. */
export const PSI_COMPONENT_LIMITS = { severity: 68, breadth: 17, stressBreadth: 5, trend: 5 } as const;

export function getConditionBand(score: number): PsiConditionBand {
  return bandFromThresholds(score, PSI_CONDITION_BANDS, PSI_CONDITION_BANDS[PSI_CONDITION_BANDS.length - 1]).band;
}
