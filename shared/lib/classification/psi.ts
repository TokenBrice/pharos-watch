import { PSI_CONDITION_BAND_VALUES } from "../../types/stability-constants";
import type { PsiConditionBand } from "../../types/stability-constants";
import { projectDescriptors } from "./descriptors";

export type ConditionBand = PsiConditionBand;

/** Legacy/unvalidated bands keep their neutral chart treatment. */
export const PSI_UNKNOWN_BAND_HEX = "#8b8fa3";

export function isConditionBand(value: string): value is ConditionBand {
  return (PSI_CONDITION_BAND_VALUES as readonly string[]).includes(value);
}

const PSI_BAND_DESCRIPTORS = {
  BEDROCK: { min: 90, hex: "#22c55e", textClassName: "text-green-700 dark:text-green-400", sweep: 12 },
  STEADY: { min: 75, hex: "#14b8a6", textClassName: "text-teal-700 dark:text-teal-400", sweep: 9 },
  TREMOR: { min: 60, hex: "#eab308", textClassName: "text-yellow-700 dark:text-yellow-400", sweep: 6 },
  FRACTURE: { min: 40, hex: "#f97316", textClassName: "text-orange-700 dark:text-orange-400", sweep: 4 },
  CRISIS: { min: 20, hex: "#ef4444", textClassName: "text-red-700 dark:text-red-400", sweep: 2.5 },
  MELTDOWN: { min: 0, hex: "#991b1b", textClassName: "text-red-800 dark:text-red-300", sweep: 1.2 },
} satisfies Record<ConditionBand, { min: number; hex: string; textClassName: string; sweep: number }>;

/** Inclusive lower bounds, ordered from the most stable band to the least. */
export const PSI_CONDITION_BANDS: readonly { min: number; band: PsiConditionBand }[] =
  PSI_CONDITION_BAND_VALUES.map((band) => ({ min: PSI_BAND_DESCRIPTORS[band].min, band }));

export const PSI_HEX_COLORS = projectDescriptors(PSI_BAND_DESCRIPTORS, (descriptor) => descriptor.hex);
export const PSI_BAND_CLASSES = projectDescriptors(PSI_BAND_DESCRIPTORS, (descriptor) => descriptor.textClassName);

/** PSI beam-dimmer lane fills: support reads positive, stress lanes escalate by severity. */
export const PSI_LANE_TONE_CLASSES = {
  support: { bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
  stressBreadth: { bar: "bg-amber-500" },
  breadth: { bar: "bg-orange-500" },
  pressure: { bar: "bg-red-500" },
} as const satisfies Record<"support" | "stressBreadth" | "breadth" | "pressure", { bar: string; text?: string }>;
