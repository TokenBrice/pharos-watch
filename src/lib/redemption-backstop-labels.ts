import { REDEMPTION_ROUTE_FAMILY_LABELS } from "@shared/lib/redemption-backstop-scoring";
import type {
  RedemptionDocsProvenance,
  RedemptionModelConfidence,
  RedemptionResolutionState,
  RedemptionRouteFamily,
  RedemptionRouteStatus,
} from "@shared/types";

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
