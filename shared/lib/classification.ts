import type { GovernanceType, PegCurrency, ResearchReviewConfidence } from "../types";
import { BACKING_BADGE_STYLES } from "./classification/badges";
import { BACKING_DESCRIPTORS, projectDescriptors } from "./classification/descriptors";
import { PEG_HERO_CHIP_LABELS } from "./peg-taxonomy";
import { PEG_LABELS_SHORT } from "./classification/pegs";

export * from "./classification/domain";
export * from "./classification/pegs";
export * from "./classification/badges";
export * from "./classification/risk";
export * from "./classification/control-posture";
export * from "./classification/grades";
export * from "./classification/mechanism-archetypes";
export * from "./classification/resolve-mechanism-archetype";
export * from "./classification/resolve-implementation-launch-date";
export type { BadgeStyle } from "./classification/common";

export const HERO_CHIP_PEG_LABELS = PEG_HERO_CHIP_LABELS;

export const RESEARCH_REVIEW_CONFIDENCE_LABELS: Readonly<Record<ResearchReviewConfidence, string>> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

export { PEG_TAXONOMY } from "./peg-taxonomy";

export function getProfilePegLabel(
  flags: { pegCurrency: PegCurrency; navToken: boolean },
  navReferenceSymbol?: string,
): string {
  const pegLabel = PEG_LABELS_SHORT[flags.pegCurrency] ?? flags.pegCurrency;
  return flags.navToken ? `${navReferenceSymbol ?? pegLabel}-denominated NAV` : pegLabel;
}

export function getHeroPegLabel(
  flags: { pegCurrency: PegCurrency; navToken: boolean },
  navReferenceSymbol?: string,
): string {
  const pegLabel = PEG_HERO_CHIP_LABELS[flags.pegCurrency] ?? flags.pegCurrency;
  return flags.navToken ? `${navReferenceSymbol ?? flags.pegCurrency} NAV` : pegLabel;
}

export const HERO_CHIP_BACKING_LABELS = projectDescriptors(BACKING_DESCRIPTORS, (descriptor) => descriptor.badgeLabel);

/** Hero chips spell out "Centralized-Dependent"; the badge descriptor abbreviates to "CeFi-Dependent". */
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
