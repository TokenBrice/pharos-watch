/** PSI band colors — single source of truth for hex and Tailwind classes. */

import { PSI_CONDITION_BAND_VALUES, type PsiConditionBand } from "@shared/types/stability";

/** The closed band vocabulary lives in the wire contract; this alias keeps lib call sites terse. */
export type ConditionBand = PsiConditionBand;

/** Hex color for a band value that is not in the closed vocabulary (legacy rows, unvalidated caches). */
export const PSI_UNKNOWN_BAND_HEX = "#8b8fa3";

/** Narrowing guard for band values that arrive unvalidated, e.g. from historical rows. */
export function isConditionBand(value: string): value is ConditionBand {
  return (PSI_CONDITION_BAND_VALUES as readonly string[]).includes(value);
}

/** Hex colors for each PSI condition band. */
export const PSI_HEX_COLORS: Record<ConditionBand, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

/** Static Tailwind text-color classes for each PSI condition band. */
export const PSI_BAND_CLASSES: Record<ConditionBand, string> = {
  BEDROCK: "text-green-700 dark:text-green-400",
  STEADY: "text-teal-700 dark:text-teal-400",
  TREMOR: "text-yellow-700 dark:text-yellow-400",
  FRACTURE: "text-orange-700 dark:text-orange-400",
  CRISIS: "text-red-700 dark:text-red-400",
  MELTDOWN: "text-red-800 dark:text-red-300",
};

/** Pulse animation duration (seconds) per band — faster = more urgent. */
export const PSI_PULSE_DURATION: Record<ConditionBand, number> = {
  BEDROCK: 3,
  STEADY: 3,
  TREMOR: 2,
  FRACTURE: 1.5,
  CRISIS: 1,
  MELTDOWN: 0.7,
};

/** Lighthouse beam sweep duration (seconds per revolution) per PSI band — slower = calmer. */
export const PSI_SWEEP_DURATION: Record<ConditionBand, number> = {
  BEDROCK: 12,
  STEADY: 9,
  TREMOR: 6,
  FRACTURE: 4,
  CRISIS: 2.5,
  MELTDOWN: 1.2,
};
