import { coverageFeature as blacklistFeature } from "@/lib/coverage/blacklist";
import { coverageFeature as dependencyFeature } from "@/lib/coverage/dependency";
import { coverageFeature as dexFeature } from "@/lib/coverage/dex";
import { coverageFeature as flowsFeature } from "@/lib/coverage/flows";
import { coverageFeature as mintAuthorityFeature } from "@/lib/coverage/mint-authority";
import { coverageFeature as priceFeature } from "@/lib/coverage/price";
import { coverageFeature as redemptionFeature } from "@/lib/coverage/redemption";
import { coverageFeature as reservesFeature } from "@/lib/coverage/reserves";
import { coverageFeature as safetyFeature } from "@/lib/coverage/safety";
import type { CoverageLegendItem } from "@/lib/coverage/shared";
import { coverageFeature as yieldFeature } from "@/lib/coverage/yield";
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
    statusKinds: priceFeature.statusKinds,
    formatBreakdown: priceFeature.formatBreakdown,
  },
  {
    key: "safety",
    label: "Safety Score",
    shortLabel: "Safety",
    description: "Overall report-card grade on the Safety Scores surface.",
    href: "/safety-scores/",
    statusKinds: safetyFeature.statusKinds,
    formatBreakdown: safetyFeature.formatBreakdown,
  },
  {
    key: "dex",
    label: "DEX Price",
    shortLabel: "DEX",
    description: "DEX liquidity observation and price verification confidence.",
    href: "/liquidity/",
    statusKinds: dexFeature.statusKinds,
    formatBreakdown: dexFeature.formatBreakdown,
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
    statusKinds: reservesFeature.statusKinds,
    formatBreakdown: reservesFeature.formatBreakdown,
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
    statusKinds: redemptionFeature.statusKinds,
    formatBreakdown: redemptionFeature.formatBreakdown,
  },
  {
    key: "yield",
    label: "Yield",
    shortLabel: "Yield",
    description: "Current presence in the Yield Intelligence rankings.",
    href: "/yield/",
    statusKinds: yieldFeature.statusKinds,
    formatBreakdown: yieldFeature.formatBreakdown,
  },
  {
    key: "flows",
    label: "Flows",
    shortLabel: "Flows",
    description: "Configured issuance-chain mint/burn flow tracking and coverage state.",
    href: "/flows/",
    statusKinds: flowsFeature.statusKinds,
    formatBreakdown: flowsFeature.formatBreakdown,
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
    statusKinds: blacklistFeature.statusKinds,
    formatBreakdown: blacklistFeature.formatBreakdown,
  },
  {
    key: "dependency",
    label: "Dependency Map",
    shortLabel: "Dependency",
    description: "Resolved dependency role from the report-card graph and dependency inputs.",
    href: "/dependency-map/",
    statusKinds: dependencyFeature.statusKinds,
    formatBreakdown: dependencyFeature.formatBreakdown,
  },
  {
    key: "mintAuthority",
    label: "Mint Authority",
    shortLabel: "Mint Auth",
    description:
      "Curated mint-authority review breadth by mint path plus standalone score bands. V9 evaluates the reviewed control facts directly.",
    headlineCountLabel: "Reviewed authority",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with reviewed mint authority`,
    headlineShareLabel: "Reviewed mint-authority market-cap reach",
    statusKinds: mintAuthorityFeature.statusKinds,
    formatBreakdown: mintAuthorityFeature.formatBreakdown,
  },
] as const;

export const COVERAGE_FEATURE_LEGEND_ITEMS: Record<CoverageFeatureKey, readonly CoverageLegendItem[]> = {
  price: priceFeature.legendItems,
  safety: safetyFeature.legendItems,
  dex: dexFeature.legendItems,
  reserves: reservesFeature.legendItems,
  redemption: redemptionFeature.legendItems,
  yield: yieldFeature.legendItems,
  flows: flowsFeature.legendItems,
  blacklist: blacklistFeature.legendItems,
  dependency: dependencyFeature.legendItems,
  mintAuthority: mintAuthorityFeature.legendItems,
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
