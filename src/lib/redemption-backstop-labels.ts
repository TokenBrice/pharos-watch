import type {
  RedemptionAccessModel,
  RedemptionOutputAssetType,
  RedemptionSettlementModel,
  RedemptionDocsProvenance,
  RedemptionModelConfidence,
  RedemptionResolutionState,
  RedemptionRouteFamily,
  RedemptionRouteStatus,
} from "@shared/types";

const REDEMPTION_ROUTE_FAMILY_LABELS: Record<RedemptionRouteFamily, string> = {
  "stablecoin-redeem": "Stablecoin redeem",
  "basket-redeem": "Basket redeem",
  "collateral-redeem": "Collateral redeem",
  "psm-swap": "PSM / swap floor",
  "queue-redeem": "Queue redeem",
  "offchain-issuer": "Offchain issuer",
};

export const REDEMPTION_ACCESS_LABELS: Record<RedemptionAccessModel, string> = {
  "permissionless-onchain": "Permissionless onchain",
  "whitelisted-onchain": "Whitelisted onchain",
  "issuer-api": "Issuer / institutional",
  manual: "Manual / discretionary",
};

/**
 * Authored-short projection of the access labels, for the fixed-width slots
 * that cannot take the full string: the hero passport strip's one-line budget
 * and the redemption route rail's ACCESS node. Prose surfaces keep the full
 * `REDEMPTION_ACCESS_LABELS` vocabulary.
 */
export const REDEMPTION_ACCESS_PASSPORT_LABELS: Record<RedemptionAccessModel, string> = {
  "permissionless-onchain": "Permissionless",
  "whitelisted-onchain": "Whitelisted",
  "issuer-api": "Institutional",
  manual: "Manual",
};

export const REDEMPTION_SETTLEMENT_LABELS: Record<RedemptionSettlementModel, string> = {
  atomic: "Atomic",
  immediate: "Immediate",
  "same-day": "Same day",
  days: "Multi-day",
  queued: "Queued",
};

export const REDEMPTION_OUTPUT_ASSET_LABELS: Record<RedemptionOutputAssetType, string> = {
  "stable-single": "Stable output",
  "stable-basket": "Stable basket",
  "bluechip-collateral": "Blue-chip collateral",
  "physical-commodity-delivery": "Physical commodity delivery",
  "mixed-collateral": "Mixed collateral",
  nav: "NAV / non-cash",
};

type CoverageTone = "emerald" | "sky" | "amber" | "violet" | "rose" | "slate";
type RedemptionRouteFamilyDisplay = {
  label: string;
  coverageLabel: string;
  coverageBreakdownLabel: string;
  coverageTone: CoverageTone;
  coverageSortRank: number;
  coverageDetail: string;
  coverageSpokenLabel?: string;
};

export const REDEMPTION_ROUTE_FAMILY_DISPLAY: Record<RedemptionRouteFamily, RedemptionRouteFamilyDisplay> = {
  "offchain-issuer": {
    label: REDEMPTION_ROUTE_FAMILY_LABELS["offchain-issuer"],
    coverageLabel: "Issuer",
    coverageBreakdownLabel: "issuer",
    coverageTone: "amber",
    coverageSortRank: 2,
    coverageDetail: "Issuer or institutional redemption path is modeled.",
  },
  "psm-swap": {
    label: REDEMPTION_ROUTE_FAMILY_LABELS["psm-swap"],
    coverageLabel: "PSM",
    coverageBreakdownLabel: "psm",
    coverageTone: "sky",
    coverageSortRank: 3,
    coverageDetail: "Protocol swap or PSM-style redemption floor is modeled.",
  },
  "queue-redeem": {
    label: REDEMPTION_ROUTE_FAMILY_LABELS["queue-redeem"],
    coverageLabel: "Queue",
    coverageBreakdownLabel: "queue",
    coverageTone: "violet",
    coverageSortRank: 1,
    coverageDetail: "Queued protocol redemption path is modeled.",
  },
  "collateral-redeem": {
    label: REDEMPTION_ROUTE_FAMILY_LABELS["collateral-redeem"],
    coverageLabel: "Collat.",
    coverageBreakdownLabel: "collateral",
    coverageTone: "sky",
    coverageSortRank: 3,
    coverageDetail: "Direct collateral redemption path is modeled.",
    coverageSpokenLabel: "Collateral redeem",
  },
  "stablecoin-redeem": {
    label: REDEMPTION_ROUTE_FAMILY_LABELS["stablecoin-redeem"],
    coverageLabel: "Stable",
    coverageBreakdownLabel: "stable",
    coverageTone: "emerald",
    coverageSortRank: 3,
    coverageDetail: "Direct stablecoin redemption path is modeled.",
    coverageSpokenLabel: "Stablecoin redeem",
  },
  "basket-redeem": {
    label: REDEMPTION_ROUTE_FAMILY_LABELS["basket-redeem"],
    coverageLabel: "Basket",
    coverageBreakdownLabel: "basket",
    coverageTone: "sky",
    coverageSortRank: 2,
    coverageDetail: "Basket redemption path is modeled.",
  },
};

export const REDEMPTION_MODELED_ROUTE_DISPLAY = {
  coverageLabel: "Modeled",
  coverageTone: "rose",
  coverageSortRank: 1,
  coverageDetail: "Redemption-backstop route is modeled.",
} as const;

const REDEMPTION_RESOLUTION_STATE_LABELS = {
  resolved: "resolved",
  "missing-cache": "missing cache",
  "missing-capacity": "missing capacity",
  failed: "failed",
  impaired: "impaired",
} as const satisfies Record<RedemptionResolutionState, string>;

const REDEMPTION_ROUTE_STATUS_LABELS = {
  open: "open",
  degraded: "degraded",
  paused: "paused",
  suspended: "suspended",
  "cohort-limited": "cohort limited",
  unknown: "status unknown",
} as const satisfies Record<RedemptionRouteStatus, string>;

const REDEMPTION_MODEL_CONFIDENCE_LABELS = {
  high: "Confidence: high",
  medium: "Confidence: medium",
  low: "Confidence: low",
} as const satisfies Record<RedemptionModelConfidence, string>;

const REDEMPTION_DOCS_PROVENANCE_LABELS = {
  "config-reviewed": "Reviewed route source",
  "live-reserve-display": "Fallback live reserve source",
  "proof-of-reserves": "Fallback proof-of-reserves source",
  "preferred-link": "Fallback project link",
} as const satisfies Record<RedemptionDocsProvenance, string>;

export function formatRedemptionRouteFamily(value: RedemptionRouteFamily): string {
  return REDEMPTION_ROUTE_FAMILY_DISPLAY[value].label;
}

export function formatRedemptionResolutionState(value: RedemptionResolutionState): string {
  return REDEMPTION_RESOLUTION_STATE_LABELS[value];
}

export function formatRedemptionRouteStatus(value: RedemptionRouteStatus): string {
  return REDEMPTION_ROUTE_STATUS_LABELS[value];
}

export function formatRedemptionModelConfidence(value: RedemptionModelConfidence): string {
  return REDEMPTION_MODEL_CONFIDENCE_LABELS[value];
}

export function formatRedemptionDocsProvenance(value: RedemptionDocsProvenance): string {
  return REDEMPTION_DOCS_PROVENANCE_LABELS[value];
}
