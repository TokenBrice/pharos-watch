import type { BlacklistStatus } from "@shared/lib/report-cards";
import type { StablecoinMeta } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createBreakdownCounter,
  createStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  type CoverageLegendItem,
} from "./shared";

const BLACKLIST_SYMBOLS = new Set<string>(BLACKLIST_STABLECOINS);

function hasBlacklistTrackerCoverage(coin: Pick<StablecoinMeta, "symbol">, blacklistStatus: BlacklistStatus | null = null): boolean {
  if (blacklistStatus !== null && blacklistStatus !== true) {
    return false;
  }
  return BLACKLIST_SYMBOLS.has(coin.symbol.toUpperCase());
}

function resolveBlacklist(
  coin: Pick<StablecoinMeta, "symbol">,
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
    "No direct, upstream, or possible freeze exposure is resolved in the current model.",
    "Not blacklistable",
  );
}

function formatBlacklist(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  const unavailable = get(DATA_UNAVAILABLE_KIND);
  const items: CoverageBreakdownItem[] = [
    breakdownItem("live", "live", get("live")),
    breakdownItem("yes", "yes", get("yes")),
    breakdownItem("upstream", "upstream", get("upstream")),
    breakdownItem("possible", "possible", get("possible")),
    breakdownItem("no", "no", get("no")),
  ];
  if (unavailable > 0) {
    items.push(breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", unavailable));
  }
  return items;
}

const BLACKLIST_KINDS: readonly string[] = [
  "live",
  "yes",
  "upstream",
  "possible",
  "no",
  DATA_UNAVAILABLE_KIND,
] as const;

const BLACKLIST_LEGEND: readonly CoverageLegendItem[] = [
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
    description: "No direct, upstream, or possible freeze exposure is resolved in the current model.",
    kinds: ["no"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: BLACKLIST_KINDS,
  legendItems: BLACKLIST_LEGEND,
  resolve: resolveBlacklist,
  formatBreakdown: formatBlacklist,
});
