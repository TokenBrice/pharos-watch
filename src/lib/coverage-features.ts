import { COVERAGE_FEATURE_MODULES as modules } from "@/lib/coverage-feature-modules";
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
    statusKinds: modules.price.statusKinds,
    legendItems: modules.price.legendItems,
    formatBreakdown: modules.price.formatBreakdown,
  },
  {
    key: "safety",
    label: "Safety Score",
    shortLabel: "Safety",
    description: "Overall report-card grade on the Safety Scores surface.",
    href: "/safety-scores/",
    statusKinds: modules.safety.statusKinds,
    legendItems: modules.safety.legendItems,
    formatBreakdown: modules.safety.formatBreakdown,
  },
  {
    key: "dex",
    label: "DEX Price",
    shortLabel: "DEX",
    description: "DEX liquidity observation and price verification confidence.",
    href: "/liquidity/",
    legendLabel: "DEX Liquidity",
    statusKinds: modules.dex.statusKinds,
    legendItems: modules.dex.legendItems,
    formatBreakdown: modules.dex.formatBreakdown,
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
    legendLabel: "Reserves",
    statusKinds: modules.reserves.statusKinds,
    legendItems: modules.reserves.legendItems,
    formatBreakdown: modules.reserves.formatBreakdown,
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
    legendLabel: "Redemption",
    statusKinds: modules.redemption.statusKinds,
    legendItems: modules.redemption.legendItems,
    formatBreakdown: modules.redemption.formatBreakdown,
  },
  {
    key: "yield",
    label: "Yield",
    shortLabel: "Yield",
    description: "Current presence in the Yield Intelligence rankings.",
    href: "/yield/",
    statusKinds: modules.yield.statusKinds,
    legendItems: modules.yield.legendItems,
    formatBreakdown: modules.yield.formatBreakdown,
  },
  {
    key: "flows",
    label: "Flows",
    shortLabel: "Flows",
    description: "Configured issuance-chain mint/burn flow tracking and coverage state.",
    href: "/flows/",
    statusKinds: modules.flows.statusKinds,
    legendItems: modules.flows.legendItems,
    formatBreakdown: modules.flows.formatBreakdown,
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
    legendLabel: "Blacklist Status",
    statusKinds: modules.blacklist.statusKinds,
    legendItems: modules.blacklist.legendItems,
    formatBreakdown: modules.blacklist.formatBreakdown,
  },
  {
    key: "mica",
    label: "MiCA",
    shortLabel: "MiCA",
    description:
      "Structured EU MiCA assessment status from the compliance tracker. Reviewed out-of-scope and non-compliant findings count as assessed coverage; missing metadata does not.",
    headlineCountLabel: "Assessed assets",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with MiCA assessment`,
    headlineShareLabel: "MiCA-assessed market-cap reach",
    href: "/compliance/?regime=mica",
    statusKinds: modules.mica.statusKinds,
    legendItems: modules.mica.legendItems,
    formatBreakdown: modules.mica.formatBreakdown,
  },
  {
    key: "genius",
    label: "GENIUS",
    shortLabel: "GENIUS",
    description:
      "Structured U.S. GENIUS Act implementation-watch posture from the compliance tracker. Reviewed no-authorization, not-applicable, and unknown findings count as assessed coverage; missing metadata does not.",
    headlineCountLabel: "Assessed assets",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with GENIUS assessment`,
    headlineShareLabel: "GENIUS-assessed market-cap reach",
    href: "/compliance/?regime=genius",
    statusKinds: modules.genius.statusKinds,
    legendItems: modules.genius.legendItems,
    formatBreakdown: modules.genius.formatBreakdown,
  },
  {
    key: "dependency",
    label: "Dependency Map",
    shortLabel: "Dependency",
    description: "Resolved dependency role from the report-card graph and dependency inputs.",
    href: "/dependency-map/",
    statusKinds: modules.dependency.statusKinds,
    legendItems: modules.dependency.legendItems,
    formatBreakdown: modules.dependency.formatBreakdown,
  },
  {
    key: "mintAuthority",
    label: "Mint Authority",
    shortLabel: "Mint Auth",
    description:
      "Curated mint-authority review breadth by mint path plus published V9 mint-component posture bands. V9 is the sole mint score.",
    headlineCountLabel: "Reviewed authority",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with reviewed mint authority`,
    headlineShareLabel: "Reviewed mint-authority market-cap reach",
    statusKinds: modules.mintAuthority.statusKinds,
    legendItems: modules.mintAuthority.legendItems,
    formatBreakdown: modules.mintAuthority.formatBreakdown,
  },
] as const;

export const COVERAGE_FEATURE_LEGEND_ITEMS = Object.fromEntries(
  COVERAGE_FEATURES.map((feature) => [feature.key, feature.legendItems]),
) as Record<CoverageFeatureKey, CoverageFeatureDefinition["legendItems"]>;

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
