import type { HealthBand } from "../../types/chains";
import { projectDescriptors } from "./descriptors";

/**
 * Chain Health band presentation: the only authority for band colours, consumed by the frontend
 * (`src/lib/chain-ui.ts`, the Harbor scene) and the Worker OG cards. `hex` is the SVG/PNG fill;
 * `pennants` repeats the band ordinally on the Harbor signal flag (robust = plain flag).
 */
const CHAIN_HEALTH_BAND_DESCRIPTORS = {
  robust: {
    label: "Robust",
    hex: "#059669",
    pennants: 0,
    badgeClassName: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    textClassName: "text-emerald-600 dark:text-emerald-400",
    fillClassName: "bg-emerald-500",
  },
  healthy: {
    label: "Healthy",
    hex: "#22c55e",
    pennants: 1,
    badgeClassName: "bg-green-500/15 text-green-700 dark:text-green-400",
    textClassName: "text-green-600 dark:text-green-400",
    fillClassName: "bg-green-500",
  },
  mixed: {
    label: "Mixed",
    hex: "#d97706",
    pennants: 2,
    badgeClassName: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    textClassName: "text-amber-600 dark:text-amber-400",
    fillClassName: "bg-amber-500",
  },
  fragile: {
    label: "Fragile",
    hex: "#ea580c",
    pennants: 3,
    badgeClassName: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
    textClassName: "text-orange-600 dark:text-orange-400",
    fillClassName: "bg-orange-500",
  },
  concentrated: {
    label: "Concentrated",
    hex: "#dc2626",
    pennants: 4,
    badgeClassName: "bg-red-500/15 text-red-700 dark:text-red-400",
    textClassName: "text-red-600 dark:text-red-400",
    fillClassName: "bg-red-500",
  },
} as const satisfies Record<HealthBand, {
  label: string;
  hex: string;
  pennants: number;
  badgeClassName: string;
  textClassName: string;
  fillClassName: string;
}>;

/** Best → worst; the leaderboard legend and Harbor flag key follow this order. */
export const CHAIN_HEALTH_BAND_ORDER = [
  "robust",
  "healthy",
  "mixed",
  "fragile",
  "concentrated",
] as const satisfies readonly HealthBand[];

export const CHAIN_HEALTH_LABELS = projectDescriptors(CHAIN_HEALTH_BAND_DESCRIPTORS, (d) => d.label);
export const CHAIN_HEALTH_HEX = projectDescriptors(CHAIN_HEALTH_BAND_DESCRIPTORS, (d) => d.hex);
export const CHAIN_HEALTH_PENNANTS = projectDescriptors(CHAIN_HEALTH_BAND_DESCRIPTORS, (d) => d.pennants);
export const CHAIN_HEALTH_BADGE_CLASSES = projectDescriptors(CHAIN_HEALTH_BAND_DESCRIPTORS, (d) => d.badgeClassName);
export const CHAIN_HEALTH_TEXT_CLASSES = projectDescriptors(CHAIN_HEALTH_BAND_DESCRIPTORS, (d) => d.textClassName);
export const CHAIN_HEALTH_FILL_CLASSES = projectDescriptors(CHAIN_HEALTH_BAND_DESCRIPTORS, (d) => d.fillClassName);
/** Neutral fill for an unrated (`healthBand: null`) chain: unavailable is not healthy. */
export const CHAIN_HEALTH_UNRATED_HEX = "#8b8fa3";
