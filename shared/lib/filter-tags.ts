import type { FilterTag, PegCurrency, StablecoinMeta } from "../types/core";
import {
  PEG_FILTER_TAG_LABELS,
  PEG_METADATA,
  type PegCurrencyFilterTag,
} from "./classification";
import {
  getReportCardGradeRank,
  REPORT_CARD_GRADE_RANK,
} from "./report-card-core";

type PegMetadataEntry = [PegCurrency, (typeof PEG_METADATA)[PegCurrency]];

const PEG_METADATA_ENTRIES = Object.entries(PEG_METADATA) as PegMetadataEntry[];

function pegFilterTagsWhere(matches: (peg: PegCurrency) => boolean): FilterTag[] {
  return PEG_METADATA_ENTRIES
    .filter(([peg]) => matches(peg))
    .map(([, metadata]) => metadata.filterTag);
}

function isCommodityPeg(peg: PegCurrency): boolean {
  return peg === "GOLD" || peg === "SILVER";
}

export const COMMODITY_PEG_TAGS = pegFilterTagsWhere(isCommodityPeg);

export const FIAT_NON_USD_PEG_TAGS = pegFilterTagsWhere(
  (peg) => peg !== "USD" && !isCommodityPeg(peg),
);

export const OTHER_PEG_TAGS = pegFilterTagsWhere(
  (peg) => peg !== "USD" && peg !== "EUR" && peg !== "GOLD",
);

const NON_PEG_FILTER_TAG_LABELS = {
  "fiat-non-usd-peg": "Fiat non-USD",
  "commodity-peg": "Commodities",
  centralized: "Centralized",
  "centralized-dependent": "CeFi-Dependent",
  decentralized: "Decentralized",
  "rwa-backed": "RWA-Backed",
  "crypto-backed": "Crypto-Backed",
  algorithmic: "Algorithmic",
  "infrastructure-liquity-v1": "Liquity v1",
  "infrastructure-liquity-v2": "Liquity v2",
  "infrastructure-m0": "M0",
  "variant-tracked": "All variants",
  "variant-savings-passthrough": "Savings variant",
  "variant-strategy-vault": "Strategy variant",
  "variant-risk-absorption": "Risk absorption variant",
  "variant-bond-maturity": "Bond variant",
  "grade-a": "A",
  "grade-ge-b": "≥B",
  "grade-ge-c": "≥C",
  "grade-ge-c-plus": "≥C+",
  "grade-ge-c-minus": "≥C-",
  "grade-le-d": "≤D",
} satisfies Record<Exclude<FilterTag, PegCurrencyFilterTag>, string>;

export const FILTER_TAG_LABELS: Record<FilterTag, string> = {
  ...PEG_FILTER_TAG_LABELS,
  ...NON_PEG_FILTER_TAG_LABELS,
};

export function pegCurrencyToFilterTag(peg: PegCurrency): FilterTag {
  return PEG_METADATA[peg].filterTag;
}

export function getFilterTags(meta: StablecoinMeta): FilterTag[] {
  const tags: FilterTag[] = [];
  const pegTag = pegCurrencyToFilterTag(meta.flags.pegCurrency);
  tags.push(pegTag);
  if (COMMODITY_PEG_TAGS.includes(pegTag)) {
    tags.push("commodity-peg");
  } else if (pegTag !== "usd-peg") {
    tags.push("fiat-non-usd-peg");
  }
  tags.push(meta.flags.governance);
  tags.push(meta.flags.backing);
  for (const infra of meta.infrastructures ?? []) {
    tags.push(`infrastructure-${infra}` as FilterTag);
  }
  if (meta.variantOf && meta.variantKind) {
    tags.push("variant-tracked");
    if (meta.variantKind === "savings-passthrough") {
      tags.push("variant-savings-passthrough");
    } else if (meta.variantKind === "strategy-vault") {
      tags.push("variant-strategy-vault");
    } else if (meta.variantKind === "risk-absorption") {
      tags.push("variant-risk-absorption");
    } else if (meta.variantKind === "bond-maturity") {
      tags.push("variant-bond-maturity");
    }
  }
  return tags;
}

export const GRADE_FILTER_TAGS: FilterTag[] = [
  "grade-a",
  "grade-ge-b",
  "grade-ge-c",
  "grade-ge-c-plus",
  "grade-ge-c-minus",
  "grade-le-d",
];

export function gradeMatchesFilter(grade: string | undefined, filterTag: FilterTag): boolean {
  if (!grade) return false;
  const gradeValue = getReportCardGradeRank(grade);
  if (gradeValue == null) return false;

  switch (filterTag) {
    case "grade-a":
      return gradeValue >= REPORT_CARD_GRADE_RANK["A-"];
    case "grade-ge-b":
      return gradeValue >= REPORT_CARD_GRADE_RANK.B;
    case "grade-ge-c":
      return gradeValue >= REPORT_CARD_GRADE_RANK.C;
    case "grade-ge-c-plus":
      return gradeValue >= REPORT_CARD_GRADE_RANK["C+"];
    case "grade-ge-c-minus":
      return gradeValue >= REPORT_CARD_GRADE_RANK["C-"];
    case "grade-le-d":
      return gradeValue <= REPORT_CARD_GRADE_RANK.D;
    default:
      return false;
  }
}
