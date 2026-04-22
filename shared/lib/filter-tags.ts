import type { FilterTag, PegCurrency, StablecoinMeta } from "../types/core";

export const COMMODITY_PEG_TAGS: FilterTag[] = ["gold-peg", "silver-peg"];

export const FIAT_NON_USD_PEG_TAGS: FilterTag[] = [
  "eur-peg",
  "chf-peg",
  "gbp-peg",
  "brl-peg",
  "rub-peg",
  "jpy-peg",
  "idr-peg",
  "sgd-peg",
  "try-peg",
  "aud-peg",
  "zar-peg",
  "cad-peg",
  "cny-peg",
  "cnh-peg",
  "php-peg",
  "mxn-peg",
  "uah-peg",
  "ars-peg",
  "var-peg",
  "other-peg",
];

export const OTHER_PEG_TAGS: FilterTag[] = [
  "chf-peg",
  "gbp-peg",
  "brl-peg",
  "rub-peg",
  "jpy-peg",
  "idr-peg",
  "sgd-peg",
  "try-peg",
  "aud-peg",
  "zar-peg",
  "cad-peg",
  "cny-peg",
  "cnh-peg",
  "php-peg",
  "mxn-peg",
  "uah-peg",
  "ars-peg",
  "silver-peg",
  "var-peg",
  "other-peg",
];

export const FILTER_TAG_LABELS: Record<FilterTag, string> = {
  "usd-peg": "USD",
  "fiat-non-usd-peg": "Fiat non-USD",
  "commodity-peg": "Commodities",
  "eur-peg": "EUR",
  "gold-peg": "Gold",
  "chf-peg": "CHF",
  "gbp-peg": "GBP",
  "brl-peg": "BRL",
  "rub-peg": "RUB",
  "jpy-peg": "JPY",
  "idr-peg": "IDR",
  "sgd-peg": "SGD",
  "try-peg": "TRY",
  "aud-peg": "AUD",
  "zar-peg": "ZAR",
  "cad-peg": "CAD",
  "cny-peg": "CNY",
  "cnh-peg": "CNH",
  "php-peg": "PHP",
  "mxn-peg": "MXN",
  "uah-peg": "UAH",
  "ars-peg": "ARS",
  "silver-peg": "Silver",
  "var-peg": "CPI",
  "other-peg": "Other",
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
};

export function pegCurrencyToFilterTag(peg: PegCurrency): FilterTag {
  switch (peg) {
    case "USD":
      return "usd-peg";
    case "EUR":
      return "eur-peg";
    case "GOLD":
      return "gold-peg";
    case "CHF":
      return "chf-peg";
    case "GBP":
      return "gbp-peg";
    case "BRL":
      return "brl-peg";
    case "RUB":
      return "rub-peg";
    case "JPY":
      return "jpy-peg";
    case "IDR":
      return "idr-peg";
    case "SGD":
      return "sgd-peg";
    case "TRY":
      return "try-peg";
    case "AUD":
      return "aud-peg";
    case "ZAR":
      return "zar-peg";
    case "CAD":
      return "cad-peg";
    case "CNY":
      return "cny-peg";
    case "CNH":
      return "cnh-peg";
    case "PHP":
      return "php-peg";
    case "MXN":
      return "mxn-peg";
    case "UAH":
      return "uah-peg";
    case "ARS":
      return "ars-peg";
    case "SILVER":
      return "silver-peg";
    case "VAR":
      return "var-peg";
    default:
      return "other-peg";
  }
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

const GRADE_RANK: Record<string, number> = {
  "A+": 12,
  "A": 11,
  "A-": 10,
  "B+": 9,
  "B": 8,
  "B-": 7,
  "C+": 6,
  "C": 5,
  "C-": 4,
  "D+": 3,
  "D": 2,
  "D-": 1,
  "F": 0,
};

export function gradeMatchesFilter(grade: string | undefined, filterTag: FilterTag): boolean {
  if (!grade) return false;
  const gradeValue = GRADE_RANK[grade] ?? -1;

  switch (filterTag) {
    case "grade-a":
      return grade.startsWith("A");
    case "grade-ge-b":
      return gradeValue >= GRADE_RANK["B"];
    case "grade-ge-c":
      return gradeValue >= GRADE_RANK.C;
    case "grade-ge-c-plus":
      return gradeValue >= GRADE_RANK["C+"];
    case "grade-ge-c-minus":
      return gradeValue >= GRADE_RANK["C-"];
    case "grade-le-d":
      return gradeValue <= GRADE_RANK["D"];
    default:
      return false;
  }
}
