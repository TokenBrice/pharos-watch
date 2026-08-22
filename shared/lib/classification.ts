import type { BackingType, GovernanceType } from "../types";
import { BACKING_BADGE_STYLES } from "./classification/badges";
import { PEG_HERO_CHIP_LABELS } from "./peg-taxonomy";

export * from "./classification/index";

export const HERO_CHIP_PEG_LABELS = PEG_HERO_CHIP_LABELS;
export { PEG_TAXONOMY } from "./peg-taxonomy";

export const HERO_CHIP_BACKING_LABELS = {
  "rwa-backed": "RWA-Backed",
  "crypto-backed": "Crypto-Backed",
  algorithmic: "Algorithmic",
} as const satisfies Record<BackingType, string>;

export const HERO_CHIP_GOVERNANCE_LABELS = {
  centralized: "Centralized",
  "centralized-dependent": "Centralized-Dependent",
  decentralized: "Decentralized",
} as const satisfies Record<GovernanceType, string>;

/** Solid chart-fill twins of the canonical BACKING_BADGE_STYLES hues. */
export const BACKING_CHART_FILL_CLASSES = {
  "rwa-backed": "bg-blue-500",
  "crypto-backed": "bg-purple-500",
  algorithmic: "bg-orange-500",
  other: "bg-zinc-400",
} as const satisfies Record<keyof typeof BACKING_BADGE_STYLES | "other", string>;
