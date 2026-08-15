import type { BackingType, GovernanceType } from "../types";
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
