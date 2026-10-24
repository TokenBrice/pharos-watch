import {
  ACTIVE_STABLECOIN_COUNT,
  ACTIVE_VARIANT_STABLECOIN_COUNT,
  CORE_AGGREGATE_STABLECOIN_COUNT,
  PRE_LAUNCH_STABLECOIN_COUNT,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";
import { PSI_HISTORICAL_ASSETS } from "@shared/lib/psi-historical-assets";

/**
 * One vocabulary for the coin sets ("universes") a headline figure is computed
 * over. Pages name the universe under each hero KPI with `UniverseChip` so a
 * reader can tell why counts differ across routes (core 267 vs active 396, …).
 *
 * Catalog universes carry their build-time count; runtime universes (scored,
 * peg catalog, yield rows) are counted by the page from the response it read.
 * Add an entry only for a set some code actually computes.
 */
export const UNIVERSES = {
  tracked: {
    label: "Tracked",
    definition: "Every coin in the Pharos registry, including pre-launch and retired coins.",
    count: TRACKED_STABLECOIN_COUNT,
  },
  active: {
    label: "Active",
    definition: "Every live coin Pharos monitors: core stablecoins, variants, and stable-value investments.",
    count: ACTIVE_STABLECOIN_COUNT,
  },
  core: {
    label: "Core",
    definition:
      "Active core stablecoins and cash equivalents counted in market aggregates. Variants and stable-value investments are excluded to avoid double counting.",
    count: CORE_AGGREGATE_STABLECOIN_COUNT,
  },
  variants: {
    label: "Variants",
    definition:
      "Active wrapped, bridged, or yield-bearing children of a parent stablecoin. Monitored, but excluded from aggregate totals.",
    count: ACTIVE_VARIANT_STABLECOIN_COUNT,
  },
  psi: {
    label: "PSI universe",
    definition:
      "Core stablecoins plus historical collapsed assets (such as UST) kept for PSI continuity. Variants and stable-value investments are excluded.",
    // CORE_PSI_ELIGIBLE_IDS: historical assets are off-catalog, so the union is a plain sum.
    count: CORE_AGGREGATE_STABLECOIN_COUNT + PSI_HISTORICAL_ASSETS.length,
  },
  preLaunch: {
    label: "Pre-launch",
    definition:
      "Announced stablecoins that are not live yet, from announcement through launch. They join the active set when they go live.",
    count: PRE_LAUNCH_STABLECOIN_COUNT,
  },
  scored: {
    label: "Scored",
    definition:
      "Active coins with a published numeric Safety Score. Not Rated and Pipeline gap cards carry no score.",
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
 * say "{N} active stablecoins" over the active universe (core + variants +
 * stable-value investments). A larger figure must name its universe, e.g.
 * "{tracked} tracked, including pre-launch and frozen coins".
 */
export const HEADLINE_STABLECOIN_COUNT = UNIVERSES.active.count;
export const HEADLINE_STABLECOIN_LABEL = "active stablecoins";
