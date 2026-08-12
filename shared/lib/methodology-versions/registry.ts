import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "./blacklist-tracker";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "./chain-health";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "./depeg-dews";
import {
  DDR_METHODOLOGY_CHANGELOG,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "./depeg-resolver";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "./liquidity-score";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "./mint-burn-flow";
import {
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG,
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
} from "./pricing-pipeline";
import {
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG,
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
} from "./redemption-backstop";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "./safety-score";
import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "./stability-index";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "./yield-methodology";
import type { MethodologyChangelogEntry } from "./base";

export type MethodologyChangelogRegistryKey =
  | "safety-score"
  | "depeg-dews"
  | "depeg-resolver"
  | "liquidity-score"
  | "stability-index"
  | "chain-health"
  | "yield"
  | "blacklist-tracker"
  | "mint-burn-flow"
  | "pricing-pipeline"
  | "redemption-backstop";

export type MethodologyChangelogMarkdownKey =
  | "scoring"
  | "depeg"
  | "depeg-resolver"
  | "liquidity-score"
  | "stability-index"
  | "chain-health"
  | "yield"
  | "blacklist-tracker"
  | "mint-burn-flow"
  | "pricing-pipeline"
  | "redemption-backstop";

export interface MethodologyChangelogRegistryEntry {
  key: MethodologyChangelogRegistryKey;
  markdownKey: MethodologyChangelogMarkdownKey;
  feedKey: string;
  feedLabel: string;
  markdownTitle: string;
  linkTitle: string;
  llmsDescription: string;
  publicPath: string;
  currentLabel: string;
  entries: readonly MethodologyChangelogEntry[];
  citationId: string;
}

export const METHODOLOGY_CHANGELOG_REGISTRY = [
  {
    key: "safety-score",
    markdownKey: "scoring",
    feedKey: "safety-score",
    feedLabel: "Safety Score",
    markdownTitle: "Safety Scores Changelog",
    linkTitle: "Safety Scores Changelog",
    llmsDescription: "Every weight change since v1.0.",
    publicPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    entries: SAFETY_SCORE_METHODOLOGY_CHANGELOG,
    citationId: "safety-score",
  },
  {
    key: "depeg-dews",
    markdownKey: "depeg",
    feedKey: "depeg-dews",
    feedLabel: "Depeg + DEWS",
    markdownTitle: "Depeg Tracker and DEWS Changelog",
    linkTitle: "Depeg + DEWS Changelog",
    llmsDescription: "",
    publicPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    entries: DEPEG_DEWS_METHODOLOGY_CHANGELOG,
    citationId: "dews",
  },
  {
    key: "depeg-resolver",
    markdownKey: "depeg-resolver",
    feedKey: "depeg-resolver",
    feedLabel: "Depeg Duration Resolver",
    markdownTitle: "Depeg Duration Resolver Changelog",
    linkTitle: "Depeg Duration Resolver Changelog",
    llmsDescription: "",
    publicPath: DDR_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: DDR_METHODOLOGY_VERSION_LABEL,
    entries: DDR_METHODOLOGY_CHANGELOG,
    citationId: "depeg-resolver",
  },
  {
    key: "liquidity-score",
    markdownKey: "liquidity-score",
    feedKey: "liquidity-score",
    feedLabel: "Liquidity Score",
    markdownTitle: "Liquidity Score Changelog",
    linkTitle: "Liquidity Score Changelog",
    llmsDescription: "",
    publicPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    entries: LIQUIDITY_METHODOLOGY_CHANGELOG,
    citationId: "liquidity-score",
  },
  {
    key: "redemption-backstop",
    markdownKey: "redemption-backstop",
    feedKey: "redemption-backstop",
    feedLabel: "Redemption Backstop",
    markdownTitle: "Redemption Backstop Changelog",
    linkTitle: "Redemption Backstop Changelog",
    llmsDescription: "Standalone redemption-route scoring history and V9 Exit evidence evolution.",
    publicPath: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
    entries: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG,
    citationId: "redemption-backstop",
  },
  {
    key: "stability-index",
    markdownKey: "stability-index",
    feedKey: "psi",
    feedLabel: "Pharos Stability Index",
    markdownTitle: "Stability Index Changelog",
    linkTitle: "Stability Index Changelog",
    llmsDescription: "",
    publicPath: PSI_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: PSI_METHODOLOGY_VERSION_LABEL,
    entries: PSI_METHODOLOGY_CHANGELOG,
    citationId: "psi",
  },
  {
    key: "chain-health",
    markdownKey: "chain-health",
    feedKey: "chain-health",
    feedLabel: "Chain Health",
    markdownTitle: "Chain Health Changelog",
    linkTitle: "Chain Health Changelog",
    llmsDescription: "",
    publicPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    entries: CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
    citationId: "chain-health",
  },
  {
    key: "yield",
    markdownKey: "yield",
    feedKey: "yield",
    feedLabel: "Yield Intelligence",
    markdownTitle: "Yield Intelligence Changelog",
    linkTitle: "Yield Intelligence Changelog",
    llmsDescription: "",
    publicPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    entries: YIELD_METHODOLOGY_CHANGELOG,
    citationId: "yield",
  },
  {
    key: "blacklist-tracker",
    markdownKey: "blacklist-tracker",
    feedKey: "blacklist-tracker",
    feedLabel: "Blacklist Tracker",
    markdownTitle: "Blacklist Tracker Changelog",
    linkTitle: "Blacklist Tracker Changelog",
    llmsDescription: "",
    publicPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
    entries: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
    citationId: "blacklist-tracker",
  },
  {
    key: "mint-burn-flow",
    markdownKey: "mint-burn-flow",
    feedKey: "mint-burn-flow",
    feedLabel: "Mint/Burn Flow",
    markdownTitle: "Mint/Burn Flow Changelog",
    linkTitle: "Mint/Burn Flow Changelog",
    llmsDescription: "",
    publicPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    entries: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
    citationId: "mint-burn-flow",
  },
  {
    key: "pricing-pipeline",
    markdownKey: "pricing-pipeline",
    feedKey: "pricing-pipeline",
    feedLabel: "Pricing Pipeline",
    markdownTitle: "Pricing Pipeline Changelog",
    linkTitle: "Pricing Pipeline Changelog",
    llmsDescription: "",
    publicPath: PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
    entries: PRICING_PIPELINE_METHODOLOGY_CHANGELOG,
    citationId: "pricing-pipeline",
  },
] as const satisfies readonly MethodologyChangelogRegistryEntry[];

export const METHODOLOGY_CHANGELOG_SITEMAP_PATHS = METHODOLOGY_CHANGELOG_REGISTRY.map(
  (entry) => entry.publicPath,
) as readonly string[];

export const METHODOLOGY_CHANGELOG_MARKDOWN_KEYS = METHODOLOGY_CHANGELOG_REGISTRY.map(
  (entry) => entry.markdownKey,
) as readonly MethodologyChangelogMarkdownKey[];

const REGISTRY_BY_KEY = new Map<MethodologyChangelogRegistryKey, MethodologyChangelogRegistryEntry>(
  METHODOLOGY_CHANGELOG_REGISTRY.map((entry) => [entry.key, entry]),
);

const REGISTRY_BY_MARKDOWN_KEY = new Map<MethodologyChangelogMarkdownKey, MethodologyChangelogRegistryEntry>(
  METHODOLOGY_CHANGELOG_REGISTRY.map((entry) => [entry.markdownKey, entry]),
);

export function getMethodologyChangelogEntry(
  key: MethodologyChangelogRegistryKey,
): MethodologyChangelogRegistryEntry {
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry) {
    throw new Error(`Unknown methodology changelog key: ${key}`);
  }
  return entry;
}

export function getMethodologyChangelogEntryByMarkdownKey(
  key: MethodologyChangelogMarkdownKey,
): MethodologyChangelogRegistryEntry {
  const entry = REGISTRY_BY_MARKDOWN_KEY.get(key);
  if (!entry) {
    throw new Error(`Unknown methodology changelog markdown key: ${key}`);
  }
  return entry;
}
