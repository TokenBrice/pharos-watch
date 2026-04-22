import { getBackingLabelShort, getGovernanceLabelShort } from "@shared/lib/classification";
import { FILTER_TAG_LABELS, type FilterTag } from "@shared/types";

const HOMEPAGE_FILTER_CONTROL_LABEL_OVERRIDES: Partial<Record<FilterTag, string>> = {
  "fiat-non-usd-peg": "Non USD",
  "variant-tracked": "All variants",
  "variant-savings-passthrough": "Savings",
  "variant-strategy-vault": "Strategy",
  "variant-risk-absorption": "Risk-Abs",
  "variant-bond-maturity": "Bond",
  "infrastructure-liquity-v1": "LQTYv1",
  "infrastructure-liquity-v2": "LQTYv2",
  "infrastructure-m0": "M0",
  "grade-a": "A",
  "grade-ge-b": ">=B",
  "grade-ge-c": ">=C",
  "grade-ge-c-plus": ">=C+",
  "grade-ge-c-minus": ">=C-",
  "grade-le-d": "D<=",
};

const HOMEPAGE_ACTIVE_FILTER_LABEL_OVERRIDES: Partial<Record<FilterTag, string>> = {
  "fiat-non-usd-peg": "Non USD",
  "variant-strategy-vault": "Strategy",
  "variant-bond-maturity": "Bond",
  centralized: "CeFi",
  "centralized-dependent": "CeFi-Dep",
  decentralized: "DeFi",
  "grade-a": "A",
  "grade-ge-b": ">=B",
  "grade-ge-c": ">=C",
  "grade-ge-c-plus": ">=C+",
  "grade-ge-c-minus": ">=C-",
  "grade-le-d": "D<=",
};

export function getHomepageFilterControlLabel(tag: FilterTag): string {
  if (tag === "centralized" || tag === "centralized-dependent" || tag === "decentralized") {
    return getGovernanceLabelShort(tag);
  }

  if (tag === "rwa-backed" || tag === "crypto-backed") {
    return getBackingLabelShort(tag);
  }

  return HOMEPAGE_FILTER_CONTROL_LABEL_OVERRIDES[tag] ?? FILTER_TAG_LABELS[tag];
}

export function getHomepageActiveFilterLabel(tag: FilterTag): string {
  return HOMEPAGE_ACTIVE_FILTER_LABEL_OVERRIDES[tag] ?? FILTER_TAG_LABELS[tag];
}
