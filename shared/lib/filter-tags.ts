import type { FilterTag, PegCurrency, StablecoinMeta } from "../types/core";
import {
  PEG_METADATA,
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

/** The metal pegs Pharos tracks. Single definition; every commodity split reads it. */
export const COMMODITY_PEG_CURRENCIES = ["GOLD", "SILVER"] as const satisfies readonly PegCurrency[];

export function isCommodityPeg(peg: PegCurrency): boolean {
  return peg === "GOLD" || peg === "SILVER";
}

export const COMMODITY_PEG_TAGS = pegFilterTagsWhere(isCommodityPeg);

export const NON_USD_NON_COMMODITY_PEG_TAGS = pegFilterTagsWhere(
  (peg) => peg !== "USD" && !isCommodityPeg(peg),
);

export const OTHER_PEG_TAGS = pegFilterTagsWhere(
  (peg) => peg !== "USD" && peg !== "EUR" && peg !== "GOLD",
);

export function pegCurrencyToFilterTag(peg: PegCurrency): FilterTag {
  return PEG_METADATA[peg].filterTag;
}

export function getFilterTags(
  meta: Pick<StablecoinMeta, "flags" | "infrastructures" | "variantOf" | "variantKind">,
): FilterTag[] {
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
    tags.push(`variant-${meta.variantKind}` as FilterTag);
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
