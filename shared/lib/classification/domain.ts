import type { BackingType, GovernanceType } from "../../types";
import { BACKING_DESCRIPTORS, GOVERNANCE_DESCRIPTORS, projectDescriptors } from "./descriptors";

// Governance (Type) labels
// ---------------------------------------------------------------------------

/** Full labels used in metadata, descriptions, and structured data. */
export const GOVERNANCE_LABELS = projectDescriptors(GOVERNANCE_DESCRIPTORS, (descriptor) => descriptor.label);

/** Short labels used in table badges, stat cards, and filter options. */
export const GOVERNANCE_LABELS_SHORT = projectDescriptors(
  GOVERNANCE_DESCRIPTORS,
  (descriptor) => descriptor.shortLabel,
);

/** Lowercase prose phrases used inline in metadata descriptions and sentences. */
export const GOVERNANCE_PROSE_LABELS = projectDescriptors(
  GOVERNANCE_DESCRIPTORS,
  (descriptor) => descriptor.proseLabel,
);

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
export const BACKING_LABELS = projectDescriptors(BACKING_DESCRIPTORS, (descriptor) => descriptor.label);

/** Short labels used in table badge text. */
export const BACKING_LABELS_SHORT = projectDescriptors(BACKING_DESCRIPTORS, (descriptor) => descriptor.shortLabel);

/** Sentence-case labels used in inline classification prose. */
export const BACKING_SENTENCE_LABELS = projectDescriptors(
  BACKING_DESCRIPTORS,
  (descriptor) => descriptor.sentenceLabel,
);

/** Prose phrases used inline in metadata descriptions. */
export const BACKING_PROSE_LABELS = projectDescriptors(BACKING_DESCRIPTORS, (descriptor) => descriptor.proseLabel);

export function getBackingLabelShort(value: string): string {
  if (value in BACKING_LABELS_SHORT) {
    return BACKING_LABELS_SHORT[value as BackingType];
  }
  return value;
}

export function getGovernanceLabelShort(value: string): string {
  if (value in GOVERNANCE_LABELS_SHORT) {
    return GOVERNANCE_LABELS_SHORT[value as GovernanceType];
  }
  return value;
}

// ---------------------------------------------------------------------------
