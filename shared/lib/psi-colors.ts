/** PSI band colors — single source of truth for hex and Tailwind classes. */

export type ConditionBand = "BEDROCK" | "STEADY" | "TREMOR" | "FRACTURE" | "CRISIS" | "MELTDOWN";

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

/** Static Tailwind border-l color classes for each PSI condition band. */
export const PSI_BORDER_CLASSES: Record<ConditionBand, string> = {
  BEDROCK: "border-l-green-500",
  STEADY: "border-l-teal-500",
  TREMOR: "border-l-yellow-500",
  FRACTURE: "border-l-orange-500",
  CRISIS: "border-l-red-500",
  MELTDOWN: "border-l-red-800",
};

/** Static Tailwind background overlay classes for each PSI condition band (low opacity for nav accent). */
export const PSI_BG_OVERLAY_CLASSES: Record<ConditionBand, string> = {
  BEDROCK: "bg-green-500/15",
  STEADY: "bg-teal-500/15",
  TREMOR: "bg-yellow-500/15",
  FRACTURE: "bg-orange-500/15",
  CRISIS: "bg-red-500/15",
  MELTDOWN: "bg-red-800/20",
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

export function psiSweepDuration(band: string): number {
  return PSI_SWEEP_DURATION[band as ConditionBand] ?? PSI_SWEEP_DURATION.BEDROCK;
}
