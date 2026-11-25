import {
  ACTIVE_STABLECOIN_COUNT,
  ACTIVE_TOKENIZED_FUND_COUNT,
  ACTIVE_VARIANT_STABLECOIN_COUNT,
  CORE_AGGREGATE_STABLECOIN_COUNT,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";
import { PSI_HISTORICAL_ASSETS } from "@shared/lib/psi-historical-assets";

/**
 * One vocabulary for the asset sets ("universes") a headline figure is computed
 * over. Pages name the universe under each hero KPI with `UniverseChip` so a
 * reader can tell why counts differ across routes (core vs active vs tokenized funds, …).
 *
 * Catalog universes carry their build-time count; runtime universes (scored,
 * peg catalog, yield rows) are counted by the page from the response it read.
 * Add an entry only for a set some code actually computes.
 */
export const UNIVERSES = {
  tracked: {
    label: "Tracked",
    definition: "Every asset in the Pharos registry, including tokenized funds, pre-launch, and retired entries.",
    count: TRACKED_STABLECOIN_COUNT,
  },
  active: {
    label: "Active",
    definition:
      "Every live stablecoin Pharos monitors: core stablecoins, tracked variants, and review-hold coins. Tokenized funds are tracked separately and excluded.",
    count: ACTIVE_STABLECOIN_COUNT - ACTIVE_TOKENIZED_FUND_COUNT,
  },
  core: {
    label: "Core",
    definition:
      "Active core stablecoins counted in market aggregates. Variants, tokenized funds, and review-hold listings are excluded.",
    count: CORE_AGGREGATE_STABLECOIN_COUNT,
  },
  variants: {
    label: "Variants",
    definition:
      "Active wrapped, bridged, or yield-bearing children of a parent stablecoin. Monitored, but excluded from aggregate totals.",
    count: ACTIVE_VARIANT_STABLECOIN_COUNT,
  },
  tokenizedFunds: {
    label: "Tokenized funds",
    definition:
      "Active tokenized money-market, Treasury, and credit fund shares tracked because they back stablecoins Pharos follows. Excluded from stablecoin totals and Safety grades.",
    count: ACTIVE_TOKENIZED_FUND_COUNT,
  },
  psi: {
    label: "PSI universe",
    definition:
      "Core stablecoins plus historical collapsed assets (such as UST) kept for PSI continuity. Variants, tokenized funds, and review-hold listings are excluded.",
    // CORE_PSI_ELIGIBLE_IDS: historical assets are off-catalog, so the union is a plain sum.
    count: CORE_AGGREGATE_STABLECOIN_COUNT + PSI_HISTORICAL_ASSETS.length,
  },
  preLaunch: {
    label: "Pre-launch",
    definition:
      "Announced stablecoins that are not live yet, from announcement through launch. They join the active set when they go live.",
    // Counted by the page: the build-time pre-launch total also holds launched
    // rows awaiting data, which are live and so outside this definition.
    count: null,
  },
  scored: {
    label: "Scored",
    definition:
      "Active stablecoins with a published numeric Safety Score. Not Rated and Pipeline gap cards carry no score.",
    count: null,
  },
  pegCatalog: {
    label: "Peg catalog",
    definition:
      "Coins in the live peg summary. NAV-priced tokens are listed but excluded from the active-depeg count.",
    count: null,
  },
  yieldRows: {
    label: "Yield rows",
    definition:
      "Yield sources, not coins: one coin can appear once per venue or wrapper. Counts follow the current filters.",
    count: null,
  },
} as const satisfies Record<string, { label: string; definition: string; count: number | null }>;

export type UniverseKey = keyof typeof UNIVERSES;

/**
 * The one public headline coin count: home title and description, the site
 * WebSite/Organization description, `llms.txt`, the About KPI strip and docs all
 * say "{N} active stablecoins" over the active stablecoin universe (core +
 * variants + review-hold, excluding tokenized funds). A larger figure must name
 * its universe, e.g. "{tracked} tracked, including tokenized funds, pre-launch
 * and frozen entries".
 */
export const HEADLINE_STABLECOIN_COUNT = UNIVERSES.active.count;
export const HEADLINE_STABLECOIN_LABEL = "active stablecoins";
