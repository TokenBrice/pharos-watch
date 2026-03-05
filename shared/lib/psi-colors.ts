/** PSI band colors — single source of truth for hex and Tailwind classes. */

export type ConditionBand = "BEDROCK" | "STEADY" | "TREMOR" | "FRACTURE" | "CRISIS" | "MELTDOWN";

const CONDITION_BANDS = new Set<string>(["BEDROCK", "STEADY", "TREMOR", "FRACTURE", "CRISIS", "MELTDOWN"]);

/** Type guard for ConditionBand — returns true when the string is a valid band. */
export function isConditionBand(s: string): s is ConditionBand {
  return CONDITION_BANDS.has(s);
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
  BEDROCK: "text-green-500",
  STEADY: "text-teal-500",
  TREMOR: "text-yellow-500",
  FRACTURE: "text-orange-500",
  CRISIS: "text-red-500",
  MELTDOWN: "text-red-800",
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

/** Pulse animation duration (seconds) per band — faster = more urgent. */
export const PSI_PULSE_DURATION: Record<ConditionBand, number> = {
  BEDROCK: 3,
  STEADY: 3,
  TREMOR: 2,
  FRACTURE: 1.5,
  CRISIS: 1,
  MELTDOWN: 0.7,
};
