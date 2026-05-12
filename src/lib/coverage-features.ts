import {
  BLACKLIST_LEGEND_ITEMS,
  BLACKLIST_STATUS_KINDS,
  formatBlacklistBreakdown,
} from "@/lib/coverage/blacklist";
import {
  DEPENDENCY_LEGEND_ITEMS,
  DEPENDENCY_STATUS_KINDS,
  formatDependencyBreakdown,
} from "@/lib/coverage/dependency";
import { DEX_LEGEND_ITEMS, DEX_STATUS_KINDS, formatDexBreakdown } from "@/lib/coverage/dex";
import { FLOWS_LEGEND_ITEMS, FLOWS_STATUS_KINDS, formatFlowsBreakdown } from "@/lib/coverage/flows";
import { formatPriceBreakdown, PRICE_LEGEND_ITEMS, PRICE_STATUS_KINDS } from "@/lib/coverage/price";
import {
  formatRedemptionBreakdown,
  REDEMPTION_LEGEND_ITEMS,
  REDEMPTION_STATUS_KINDS,
} from "@/lib/coverage/redemption";
import {
  formatReservesBreakdown,
  RESERVES_LEGEND_ITEMS,
  RESERVES_STATUS_KINDS,
} from "@/lib/coverage/reserves";
import { formatSafetyBreakdown, SAFETY_LEGEND_ITEMS, SAFETY_STATUS_KINDS } from "@/lib/coverage/safety";
import type { CoverageLegendItem } from "@/lib/coverage/shared";
import { formatYieldBreakdown, YIELD_LEGEND_ITEMS, YIELD_STATUS_KINDS } from "@/lib/coverage/yield";
import type { CoverageFeatureDefinition, CoverageFeatureKey } from "@/lib/coverage-types";

export const COVERAGE_FEATURES: readonly CoverageFeatureDefinition[] = [
  {
    key: "price",
    label: "Price & Depeg",
    shortLabel: "Price",
    description: "Live price monitoring, peg summary coverage, and depeg event detection.",
    headlineCountLabel: "≥3 sources",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with ≥3 price sources`,
    headlineFilter: (row) => (row.statuses.price.sourceCount ?? 0) >= 3,
    href: "/depeg/",
    statusKinds: PRICE_STATUS_KINDS,
    formatBreakdown: formatPriceBreakdown,
  },
  {
    key: "safety",
    label: "Safety Score",
    shortLabel: "Safety",
    description: "Overall report-card grade on the Safety Scores surface.",
    href: "/safety-scores/",
    statusKinds: SAFETY_STATUS_KINDS,
    formatBreakdown: formatSafetyBreakdown,
  },
  {
    key: "dex",
    label: "DEX Price",
    shortLabel: "DEX",
    description: "DEX liquidity observation and price verification confidence.",
    href: "/liquidity/",
    statusKinds: DEX_STATUS_KINDS,
    formatBreakdown: formatDexBreakdown,
  },
  {
    key: "reserves",
    label: "Reserve View",
    shortLabel: "Reserves",
    description:
      "Detail-page reserve views are separated from score-grade live reserve inputs. The headline counts assets whose current report-card snapshot used fresh independent live reserve data.",
    headlineKinds: ["live"],
    headlineCountLabel: "Score-grade live",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with score-grade live reserves`,
    headlineShareLabel: "Score-grade live reserve market-cap reach",
    statusKinds: RESERVES_STATUS_KINDS,
    formatBreakdown: formatReservesBreakdown,
  },
  {
    key: "redemption",
    label: "Redemption Backstop",
    shortLabel: "Backstop",
    description:
      "Modeled issuer or protocol exit routes beyond secondary-market DEX liquidity. Heuristic supply-based routes are broken out separately below.",
    headlineCountLabel: "Strong coverage",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with strong redemption coverage`,
    headlineShareLabel: "Strong redemption market-cap reach",
    href: "/methodology/#safety-scores-methodology",
    statusKinds: REDEMPTION_STATUS_KINDS,
    formatBreakdown: formatRedemptionBreakdown,
  },
  {
    key: "yield",
    label: "Yield",
    shortLabel: "Yield",
    description: "Current presence in the Yield Intelligence rankings.",
    href: "/yield/",
    statusKinds: YIELD_STATUS_KINDS,
    formatBreakdown: formatYieldBreakdown,
  },
  {
    key: "flows",
    label: "Flows",
    shortLabel: "Flows",
    description: "Configured issuance-chain mint/burn flow tracking and coverage state.",
    href: "/flows/",
    statusKinds: FLOWS_STATUS_KINDS,
    formatBreakdown: formatFlowsBreakdown,
  },
  {
    key: "blacklist",
    label: "Freezable Status",
    shortLabel: "Freezable",
    description:
      "Resolved freeze / blacklist status across every tracked stablecoin. Coins covered by the live FreezeWatch event tracker are called out separately.",
    headlineCountLabel: "Statuses resolved",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with resolved freezable status`,
    headlineShareLabel: "Resolved status market-cap reach",
    href: "/freezewatch/",
    statusKinds: BLACKLIST_STATUS_KINDS,
    formatBreakdown: formatBlacklistBreakdown,
  },
  {
    key: "dependency",
    label: "Dependency Map",
    shortLabel: "Dependency",
    description: "Reserve or mechanism dependency edges in the report-card graph.",
    href: "/dependency-map/",
    statusKinds: DEPENDENCY_STATUS_KINDS,
    formatBreakdown: formatDependencyBreakdown,
  },
] as const;

export const COVERAGE_FEATURE_LEGEND_ITEMS: Record<CoverageFeatureKey, readonly CoverageLegendItem[]> = {
  price: PRICE_LEGEND_ITEMS,
  safety: SAFETY_LEGEND_ITEMS,
  dex: DEX_LEGEND_ITEMS,
  reserves: RESERVES_LEGEND_ITEMS,
  redemption: REDEMPTION_LEGEND_ITEMS,
  yield: YIELD_LEGEND_ITEMS,
  flows: FLOWS_LEGEND_ITEMS,
  blacklist: BLACKLIST_LEGEND_ITEMS,
  dependency: DEPENDENCY_LEGEND_ITEMS,
};

/**
 * Cross-cutting status kinds covered by general legend entries (NR / Data n/a / —).
 * Used by the legend-coverage invariant test so per-feature modules can omit
 * legend terms for these shared-display kinds.
 */
export const GENERAL_LEGEND_STATUS_KINDS: readonly string[] = [
  "nr",
  "unobserved",
  "data-unavailable",
  "none",
  "unavailable",
  "unknown",
] as const;
