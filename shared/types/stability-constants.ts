/**
 * Closed producer-owned PSI band vocabulary. Chrome and executable schemas
 * share this list without pulling Zod or unrelated market contracts into UI.
 */
export const PSI_CONDITION_BAND_VALUES = [
  "BEDROCK",
  "STEADY",
  "TREMOR",
  "FRACTURE",
  "CRISIS",
  "MELTDOWN",
] as const;

export type PsiConditionBand = (typeof PSI_CONDITION_BAND_VALUES)[number];
