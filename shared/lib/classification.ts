import type { GovernanceType, PegCurrency, ResearchReviewConfidence } from "../types";
import { BACKING_BADGE_STYLES } from "./classification/badges";
import { BACKING_DESCRIPTORS, projectDescriptors } from "./classification/descriptors";
import { PEG_HERO_CHIP_LABELS } from "./peg-taxonomy";
import { PEG_LABELS_SHORT } from "./classification/pegs";
import { DEPEG_THRESHOLD_BPS } from "./depeg-config";

export * from "./classification/domain";
export * from "./classification/pegs";
export * from "./classification/badges";
export * from "./classification/risk";
export * from "./classification/liquidity-concentration";
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
/**
 * Peg-deviation chart bands share the live USD depeg trigger rather than
 * maintaining a second literal for the outer stress boundary.
 */
export const PEG_BAND_BPS = {
  tight: 25,
  drift: 50,
  stress: DEPEG_THRESHOLD_BPS,
} as const;

export const PEG_BAND_HEX = {
  inBand: "#94a3b8",
  drift: "#eab308",
  stress: "#f97316",
  depeg: "#ef4444",
} as const;

export const PEG_BAND_LABELS = {
  inBand: "in-band",
  drift: "drift",
  stress: "stressed",
  depeg: "depeg",
} as const;

/** One label and badge palette for the screener's V9 evidence states. */
export const SAFETY_EVIDENCE_LABELS = {
  strong: "Strong",
  adequate: "Adequate",
  limited: "Limited",
  nr: "NR",
} as const;

export const SAFETY_EVIDENCE_BADGE_CLASSES = {
  strong: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  adequate: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  limited: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  nr: "border-border/60 bg-muted/30 text-muted-foreground",
} as const;

export const MINT_PRESSURE_BANDS = {
  burnDominated: -35,
  burnTilt: -10,
  mintTilt: 10,
  mintDominated: 35,
} as const;

export type MintPressureBand =
  | "no-activity"
  | "burn-dominated"
  | "burn-tilt"
  | "balanced"
  | "mint-tilt"
  | "mint-dominated";

export const MINT_PRESSURE_LABELS: Record<MintPressureBand, string> = {
  "no-activity": "No activity",
  "burn-dominated": "Burn dominated",
  "burn-tilt": "Burn tilt",
  balanced: "Balanced",
  "mint-tilt": "Mint tilt",
  "mint-dominated": "Mint dominated",
};

export function getMintPressureBand(score: number | null): MintPressureBand {
  if (score == null) return "no-activity";
  if (score >= MINT_PRESSURE_BANDS.mintDominated) return "mint-dominated";
  if (score >= MINT_PRESSURE_BANDS.mintTilt) return "mint-tilt";
  if (score > MINT_PRESSURE_BANDS.burnTilt) return "balanced";
  if (score > MINT_PRESSURE_BANDS.burnDominated) return "burn-tilt";
  return "burn-dominated";
}
