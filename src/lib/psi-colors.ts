/** PSI band colors — single source of truth for hex and Tailwind classes. */

export type ConditionBand = "BEDROCK" | "STEADY" | "TREMOR" | "FRACTURE" | "CRISIS" | "MELTDOWN";

/** Hex colors for each PSI condition band. */
export const PSI_HEX_COLORS: Record<string, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

/** Static Tailwind text-color classes for each PSI condition band. */
export const PSI_BAND_CLASSES: Record<string, string> = {
  BEDROCK: "text-green-500",
  STEADY: "text-teal-500",
  TREMOR: "text-yellow-500",
  FRACTURE: "text-orange-500",
  CRISIS: "text-red-500",
  MELTDOWN: "text-red-800",
};

/** Pulse animation duration (seconds) per band — faster = more urgent. */
export const PSI_PULSE_DURATION: Record<string, number> = {
  BEDROCK: 3,
  STEADY: 3,
  TREMOR: 2,
  FRACTURE: 1.5,
  CRISIS: 1,
  MELTDOWN: 0.7,
};
