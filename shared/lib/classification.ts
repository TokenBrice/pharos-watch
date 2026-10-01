import type { CustodyModel, DependencyType, GovernanceType, MechanismArchetype, PegCurrency, ResearchReviewConfidence } from "../types";
import type { V9DependencyEconomicRole } from "../types/dependency-types";
import type { V9FailureDomainRef } from "../types/safety-score-v9-fact-primitives";
import type { ContagionShock } from "../types/contagion";
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
export * from "./classification/resolve-mechanism-archetype";
export * from "./classification/resolve-implementation-launch-date";
export type { BadgeStyle } from "./classification/common";

export const HERO_CHIP_PEG_LABELS = PEG_HERO_CHIP_LABELS;

const MECHANISM_ARCHETYPE_DESCRIPTORS = {
  "fiat-cash": { label: "Custodial Cash and Cash-Equivalents", shortLabel: "Custodial Cash", ctaNoun: "fiat-backed",
    oneLiner: "Centralized issuers custody dollars in bank accounts and short-term Treasuries; tokens are minted and redeemed on demand.",
  },
  tbill: { label: "Tokenized Treasury", shortLabel: "Tokenized Treasury", ctaNoun: "tokenized Treasury",
    oneLiner: "Regulated funds hold short-duration Treasuries; the token is a fund share that accretes NAV instead of trading exactly at $1.",
  },
  cdp: { label: "Crypto-Collateralized (CDP)", shortLabel: "Crypto CDP", ctaNoun: "CDP",
    oneLiner: "Overcollateralized vaults issue stablecoin debt; positions liquidate when collateral falls below a safety ratio.",
  },
  "synthetic-delta-neutral": { label: "Hedged Synthetic Dollar", shortLabel: "Hedged Synthetic", ctaNoun: "delta-neutral",
    oneLiner: "Offsetting economic exposures target a stable net value; implementations range from spot-plus-perp hedges to on-chain lending with matched borrow-and-stake legs.",
  },
  algorithmic: { label: "Reflexive / Unbacked", shortLabel: "Reflexive / Unbacked", ctaNoun: "algorithmic",
    oneLiner: "The peg is held by protocol-level mint/burn rules and arbitrage incentives rather than by 1:1 reserves.",
  },
  "rwa-credit-fund": { label: "Tokenized Credit Fund", shortLabel: "Credit Fund", ctaNoun: "credit-fund",
    oneLiner: "Regulated funds hold private credit, CLO tranches, or other non-Treasury debt; the token is a fund share whose NAV reflects credit losses and quarterly redemption gates.",
  },
  "commodity-claim": { label: "Allocated Commodity Claim", shortLabel: "Commodity Claim", ctaNoun: "commodity-backed",
    oneLiner: "The token is a title claim on specific vaulted metal rather than on dollars; it tracks the commodity price and can usually be redeemed for physical delivery in whole-bar lots.",
  },
  "ucits-trs-fund": { label: "UCITS Physical Securities and TRS Fund", shortLabel: "UCITS / TRS Fund", ctaNoun: "UCITS / TRS fund",
    oneLiner: "The token represents a proportional fund interest; physical securities and total-return swaps target the share class's return, with separate NAV, counterparty and recovery risks.",
  },
  "shared-reserve": { label: "Shared Reserve Liability", shortLabel: "Shared Reserve", ctaNoun: "shared-reserve",
    oneLiner: "Several protocol-issued liabilities draw on one reserve pool; exchange rights do not establish exclusive allocation, legal priority or complete liability coverage.",
  },
  "protocol-position": { label: "Protocol Position Liability", shortLabel: "Protocol Position", ctaNoun: "protocol-position",
    oneLiner: "Protocol-issued tokens rely on bridge, vault or module positions; the local claim and position continuity remain distinct from the underlying assets' backing.",
  },
};

export const MECHANISM_ARCHETYPE_LABELS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.label);

/** Chip-length names for dense surfaces; values must fit pills without truncation. */
export const MECHANISM_ARCHETYPE_SHORT_LABELS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.shortLabel);

const MECHANISM_ARCHETYPE_CTA_NOUNS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.ctaNoun);

export const MECHANISM_ARCHETYPE_ONE_LINERS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.oneLiner);

export function getMechanismArchetypeLabel(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_LABELS[value];
}

export function getMechanismArchetypeCtaNoun(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_CTA_NOUNS[value];
}

export function getMechanismArchetypeOneLiner(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_ONE_LINERS[value];
}

export function getMechanismExplainerPath(value: MechanismArchetype): string {
  return `/learn/mechanisms/${value}/`;
}

export const CUSTODY_MODEL_LABELS: Readonly<Record<CustodyModel, string>> = {
  onchain: "On-chain",
  "institutional-top": "Top-tier institution",
  "institutional-regulated": "Regulated institution",
  "institutional-unregulated": "Unregulated institution",
  "institutional-sanctioned": "Sanctioned institution",
  cex: "Exchange",
  mixed: "Mixed custody",
  unknown: "Unknown custody",
};

export const RESEARCH_REVIEW_CONFIDENCE_LABELS: Readonly<Record<ResearchReviewConfidence, string>> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

export const DEPENDENCY_RELATIONSHIP_LABELS = {
  wrapper: "Wrapper",
  mechanism: "Mechanism",
  collateral: "Collateral",
  "serial-claim": "Serial claim",
} as const satisfies Readonly<Record<DependencyType | "serial-claim", string>>;

export const DEPENDENCY_ROLE_LABELS = {
  "serial-claim": "Serial claim",
  "basket-exposure": "Basket exposure",
  "exit-dependency": "Exit dependency",
  "control-operator": "Control operator",
  "oracle-nav": "Oracle / NAV",
} as const satisfies Readonly<Record<V9DependencyEconomicRole, string>>;

export const EXPOSURE_BAND_LABELS = {
  material: "Material",
  minor: "Minor",
  trace: "Trace",
  unknown: "Unknown",
} as const satisfies Readonly<Record<"material" | "minor" | "trace" | "unknown", string>>;

export const FAILURE_DOMAIN_KIND_LABELS = {
  "reserve-issuer": "Reserve issuer",
  "reserve-custodian": "Reserve custodian",
  "mint-control": "Mint control",
  "upgrade-control": "Upgrade control",
  "oracle-feed": "Oracle feed",
  "bridge-route": "Bridge route",
  "redemption-rail": "Redemption rail",
  "output-asset": "Output asset",
  chain: "Chain",
  "dex-protocol": "DEX protocol",
} as const satisfies Readonly<Record<V9FailureDomainRef["kind"], string>>;

export const DEPENDENCY_SCENARIO_KIND_LABELS = {
  "score-limit": "Score limit",
  depeg: "Depeg",
  "mint-control-compromise": "Mint-control compromise",
} as const satisfies Readonly<Record<ContagionShock["kind"], string>>;

export const DEPENDENCY_SCENARIO_DIMENSION_LABELS = {
  final: "final",
  backing: "backing",
} as const satisfies Readonly<Record<Extract<ContagionShock, { kind: "score-limit" }>["dimension"], string>>;

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
