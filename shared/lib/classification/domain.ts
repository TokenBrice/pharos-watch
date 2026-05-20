import type { BackingType, GovernanceType } from "../../types";

// Governance (Type) labels
// ---------------------------------------------------------------------------

/** Full labels used in metadata, descriptions, and structured data. */
export const GOVERNANCE_LABELS: Record<GovernanceType, string> = {
  centralized: "Centralized (CeFi)",
  "centralized-dependent": "CeFi-Dependent",
  decentralized: "Decentralized (DeFi)",
};

/** Short labels used in table badges, stat cards, and filter options. */
export const GOVERNANCE_LABELS_SHORT: Record<GovernanceType, string> = {
  centralized: "CeFi",
  "centralized-dependent": "CeFi-Dep",
  decentralized: "DeFi",
};

// ---------------------------------------------------------------------------
// Filter option tuples — used by heatmap and depeg filter UIs
// ---------------------------------------------------------------------------

export const GOVERNANCE_FILTER_OPTIONS: { value: GovernanceType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "centralized", label: GOVERNANCE_LABELS_SHORT.centralized },
  { value: "centralized-dependent", label: GOVERNANCE_LABELS_SHORT["centralized-dependent"] },
  { value: "decentralized", label: GOVERNANCE_LABELS_SHORT.decentralized },
];

// ---------------------------------------------------------------------------
// Backing labels
// ---------------------------------------------------------------------------

/** Full labels used in metadata and descriptions. */
export const BACKING_LABELS: Record<BackingType, string> = {
  "rwa-backed": "Real-World Asset Backed",
  "crypto-backed": "Crypto-Collateralized",
  algorithmic: "Algorithmic",
};

/** Short labels used in table badge text. */
export const BACKING_LABELS_SHORT: Record<BackingType, string> = {
  "rwa-backed": "RWA",
  "crypto-backed": "Crypto",
  algorithmic: "Algo",
};

export function getBackingLabelShort(value: string): string {
  if (value in BACKING_LABELS_SHORT) {
    return BACKING_LABELS_SHORT[value as BackingType];
  }
  if (value === "fiat" || value === "fiat-backed") return "Fiat";
  if (value === "crypto") return "Crypto";
  if (value === "rwa") return "RWA";
  return value;
}

export function getGovernanceLabelShort(value: string): string {
  if (value in GOVERNANCE_LABELS_SHORT) {
    return GOVERNANCE_LABELS_SHORT[value as GovernanceType];
  }
  return value;
}

// ---------------------------------------------------------------------------
