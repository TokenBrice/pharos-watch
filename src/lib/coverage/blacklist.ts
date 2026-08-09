import type { BlacklistStatus } from "@shared/lib/report-cards";
import type { StablecoinMeta } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createBreakdownCounter,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  statusKindsFromPresets,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const BLACKLIST_SYMBOLS = new Set<string>(BLACKLIST_STABLECOINS);

const BLACKLIST_STATUS_PRESETS = {
  live: {
    kind: "live",
    label: "Live",
    tone: "amber",
    available: true,
    sortRank: 6,
    detail: "Direct freeze controls are confirmed and live blacklist event tracking is published for this issuer.",
    spokenLabel: "Live tracked blacklistable",
  },
  yes: {
    kind: "yes",
    label: "Yes",
    tone: "rose",
    available: true,
    sortRank: 5,
    detail: "Direct token, vault, or issuer controls can freeze, block, seize, or destroy user balances.",
    spokenLabel: "Blacklistable",
  },
  upstream: {
    kind: "upstream",
    label: "Upstream",
    tone: "amber",
    available: true,
    sortRank: 3,
    detail: "No direct control is resolved; exposure comes from freezable upstream collateral or parent assets.",
  },
  possible: {
    kind: "possible",
    label: "Possible",
    tone: "sky",
    available: true,
    sortRank: 2,
    detail:
      "Mutable or pause-capable admin surfaces indicate possible controls, but active address-level freezing is not confirmed.",
  },
  no: {
    kind: "no",
    label: "No",
    tone: "emerald",
    available: true,
    sortRank: 1,
    detail: "No direct, upstream, or possible freeze exposure is resolved in the current model.",
    spokenLabel: "Not blacklistable",
  },
} satisfies Record<string, CoverageStatusPreset>;

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
    return createPresetStatus(BLACKLIST_STATUS_PRESETS.live);
  }

  if (blacklistStatus === true) {
    return createPresetStatus(BLACKLIST_STATUS_PRESETS.yes);
  }

  if (blacklistStatus === "inherited") {
    return createPresetStatus(BLACKLIST_STATUS_PRESETS.upstream);
  }

  if (blacklistStatus === "possible") {
    return createPresetStatus(BLACKLIST_STATUS_PRESETS.possible);
  }

  return createPresetStatus(BLACKLIST_STATUS_PRESETS.no);
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
  statusKinds: [...statusKindsFromPresets(BLACKLIST_STATUS_PRESETS), DATA_UNAVAILABLE_KIND],
  legendItems: BLACKLIST_LEGEND,
  resolve: resolveBlacklist,
  formatBreakdown: formatBlacklist,
});
