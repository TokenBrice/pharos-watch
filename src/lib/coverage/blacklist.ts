import type { BlacklistStatus } from "@shared/lib/report-cards";
import type { StablecoinMeta } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createStatus,
  DATA_UNAVAILABLE_KIND,
  type CoverageLegendItem,
} from "./shared";

const BLACKLIST_SYMBOLS = new Set<string>(BLACKLIST_STABLECOINS);

function hasBlacklistTrackerCoverage(coin: StablecoinMeta, blacklistStatus: BlacklistStatus | null = null): boolean {
  if (blacklistStatus !== null && blacklistStatus !== true) {
    return false;
  }
  return BLACKLIST_SYMBOLS.has(coin.symbol.toUpperCase());
}

export function resolveBlacklistCoverage(
  coin: StablecoinMeta,
  blacklistStatus: BlacklistStatus | null = null,
): CoverageStatus {
  if (blacklistStatus === null) {
    return createDataUnavailableStatus("Blacklist status");
  }

  if (hasBlacklistTrackerCoverage(coin, blacklistStatus)) {
    return createStatus(
      "live",
      "Live",
      "amber",
      true,
      6,
      "Direct freeze controls are confirmed and live blacklist event tracking is published for this issuer.",
      "Live tracked blacklistable",
    );
  }

  if (blacklistStatus === true) {
    return createStatus(
      "yes",
      "Yes",
      "rose",
      true,
      5,
      "Direct token, vault, or issuer controls can freeze, block, seize, or destroy user balances.",
      "Blacklistable",
    );
  }

  if (blacklistStatus === "dilutable") {
    return createStatus(
      "dilutable",
      "Dilutable",
      "violet",
      true,
      4,
      "No direct address freeze is resolved, but an admin can mint without bound and dilute holders.",
    );
  }

  if (blacklistStatus === "inherited") {
    return createStatus(
      "upstream",
      "Upstream",
      "amber",
      true,
      3,
      "No direct control is resolved; exposure comes from freezable upstream collateral or parent assets.",
    );
  }

  if (blacklistStatus === "possible") {
    return createStatus(
      "possible",
      "Possible",
      "sky",
      true,
      2,
      "Mutable or pause-capable admin surfaces indicate possible controls, but active address-level freezing is not confirmed.",
    );
  }

  return createStatus(
    "no",
    "No",
    "emerald",
    true,
    1,
    "No direct, upstream, possible, or dilutable freeze exposure is resolved in the current model.",
    "Not blacklistable",
  );
}

export function formatBlacklistBreakdown(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = (kind: string) => breakdownMap.get(kind) ?? 0;
  const unavailable = get(DATA_UNAVAILABLE_KIND);
  const items: CoverageBreakdownItem[] = [
    breakdownItem("live", "live", get("live")),
    breakdownItem("yes", "yes", get("yes")),
    breakdownItem("dilutable", "dilutable", get("dilutable")),
    breakdownItem("upstream", "upstream", get("upstream")),
    breakdownItem("possible", "possible", get("possible")),
    breakdownItem("no", "no", get("no")),
  ];
  if (unavailable > 0) {
    items.push(breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", unavailable));
  }
  return items;
}

export const BLACKLIST_STATUS_KINDS: readonly string[] = [
  "live",
  "yes",
  "dilutable",
  "upstream",
  "possible",
  "no",
  DATA_UNAVAILABLE_KIND,
] as const;

export const BLACKLIST_LEGEND_ITEMS: readonly CoverageLegendItem[] = [
  {
    term: "Live",
    description: "Direct freeze controls are confirmed and live blacklist event tracking is published for this issuer.",
    kinds: ["live"],
  },
  {
    term: "Yes",
    description: "Direct token, vault, or issuer controls can freeze, block, seize, or destroy user balances.",
    kinds: ["yes"],
  },
  {
    term: "Dilutable",
    description: "No direct address freeze is resolved, but an admin can mint without bound and dilute holders.",
    kinds: ["dilutable"],
  },
  {
    term: "Upstream",
    description: "No direct control is resolved; exposure comes from freezable upstream collateral or parent assets.",
    kinds: ["upstream"],
  },
  {
    term: "Possible",
    description:
      "Mutable or pause-capable admin surfaces indicate possible controls, but active address-level freezing is not confirmed.",
    kinds: ["possible"],
  },
  {
    term: "No",
    description: "No direct, upstream, possible, or dilutable freeze exposure is resolved in the current model.",
    kinds: ["no"],
  },
] as const;
