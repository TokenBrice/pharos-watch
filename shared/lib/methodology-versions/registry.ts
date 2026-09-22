import { BLACKLIST_TRACKER_V1 } from "../../data/methodology-changelogs/blacklist-tracker/v1";
import { BLACKLIST_TRACKER_V2 } from "../../data/methodology-changelogs/blacklist-tracker/v2";
import { BLACKLIST_TRACKER_V3 } from "../../data/methodology-changelogs/blacklist-tracker/v3";
import { BLACKLIST_TRACKER_V4 } from "../../data/methodology-changelogs/blacklist-tracker/v4";
import { CHAIN_HEALTH_V1 } from "../../data/methodology-changelogs/chain-health/v1";
import { DEPEG_DEWS_V1 } from "../../data/methodology-changelogs/depeg-dews/v1";
import { DEPEG_DEWS_V2 } from "../../data/methodology-changelogs/depeg-dews/v2";
import { DEPEG_DEWS_V3 } from "../../data/methodology-changelogs/depeg-dews/v3";
import { DEPEG_DEWS_V4 } from "../../data/methodology-changelogs/depeg-dews/v4";
import { DEPEG_DEWS_V5 } from "../../data/methodology-changelogs/depeg-dews/v5";
import { DEPEG_DEWS_V6 } from "../../data/methodology-changelogs/depeg-dews/v6";
import { LIQUIDITY_SCORE_V1 } from "../../data/methodology-changelogs/liquidity-score/v1";
import { LIQUIDITY_SCORE_V2 } from "../../data/methodology-changelogs/liquidity-score/v2";
import { LIQUIDITY_SCORE_V3 } from "../../data/methodology-changelogs/liquidity-score/v3";
import { LIQUIDITY_SCORE_V4 } from "../../data/methodology-changelogs/liquidity-score/v4";
import { LIQUIDITY_SCORE_V5 } from "../../data/methodology-changelogs/liquidity-score/v5";
import { LIQUIDITY_SCORE_V6 } from "../../data/methodology-changelogs/liquidity-score/v6";
import { MINT_BURN_FLOW_V1 } from "../../data/methodology-changelogs/mint-burn-flow/v1";
import { MINT_BURN_FLOW_V2 } from "../../data/methodology-changelogs/mint-burn-flow/v2";
import { MINT_BURN_FLOW_V3 } from "../../data/methodology-changelogs/mint-burn-flow/v3";
import { MINT_BURN_FLOW_V4 } from "../../data/methodology-changelogs/mint-burn-flow/v4";
import { MINT_BURN_FLOW_V5 } from "../../data/methodology-changelogs/mint-burn-flow/v5";
import { MINT_BURN_FLOW_V6 } from "../../data/methodology-changelogs/mint-burn-flow/v6";
import { PRICING_PIPELINE_V1 } from "../../data/methodology-changelogs/pricing-pipeline/v1";
import { PRICING_PIPELINE_V2 } from "../../data/methodology-changelogs/pricing-pipeline/v2";
import { PRICING_PIPELINE_V3 } from "../../data/methodology-changelogs/pricing-pipeline/v3";
import { PRICING_PIPELINE_V4 } from "../../data/methodology-changelogs/pricing-pipeline/v4";
import { PRICING_PIPELINE_V5 } from "../../data/methodology-changelogs/pricing-pipeline/v5";
import { PRICING_PIPELINE_V6 } from "../../data/methodology-changelogs/pricing-pipeline/v6";
import { REDEMPTION_BACKSTOP_V1 } from "../../data/methodology-changelogs/redemption-backstop/v1";
import { REDEMPTION_BACKSTOP_V2 } from "../../data/methodology-changelogs/redemption-backstop/v2";
import { REDEMPTION_BACKSTOP_V3 } from "../../data/methodology-changelogs/redemption-backstop/v3";
import { REDEMPTION_BACKSTOP_V4 } from "../../data/methodology-changelogs/redemption-backstop/v4";
import { SAFETY_SCORE_V1 } from "../../data/methodology-changelogs/safety-score/v1";
import { SAFETY_SCORE_V2 } from "../../data/methodology-changelogs/safety-score/v2";
import { SAFETY_SCORE_V3 } from "../../data/methodology-changelogs/safety-score/v3";
import { SAFETY_SCORE_V4 } from "../../data/methodology-changelogs/safety-score/v4";
import { SAFETY_SCORE_V5 } from "../../data/methodology-changelogs/safety-score/v5";
import { SAFETY_SCORE_V6 } from "../../data/methodology-changelogs/safety-score/v6";
import { SAFETY_SCORE_V7 } from "../../data/methodology-changelogs/safety-score/v7";
import { SAFETY_SCORE_V8 } from "../../data/methodology-changelogs/safety-score/v8";
import { SAFETY_SCORE_V9 } from "../../data/methodology-changelogs/safety-score/v9-activation";
import { STABILITY_INDEX_V1 } from "../../data/methodology-changelogs/stability-index/v1";
import { STABILITY_INDEX_V2 } from "../../data/methodology-changelogs/stability-index/v2";
import { STABILITY_INDEX_V3 } from "../../data/methodology-changelogs/stability-index/v3";
import { YIELD_METHODOLOGY_V1 } from "../../data/methodology-changelogs/yield-methodology/v1";
import { YIELD_METHODOLOGY_V2 } from "../../data/methodology-changelogs/yield-methodology/v2";
import { YIELD_METHODOLOGY_V3 } from "../../data/methodology-changelogs/yield-methodology/v3";
import { YIELD_METHODOLOGY_V4 } from "../../data/methodology-changelogs/yield-methodology/v4";
import { YIELD_METHODOLOGY_V5 } from "../../data/methodology-changelogs/yield-methodology/v5";
import { YIELD_METHODOLOGY_V6 } from "../../data/methodology-changelogs/yield-methodology/v6";
import { YIELD_METHODOLOGY_V7 } from "../../data/methodology-changelogs/yield-methodology/v7";
import { YIELD_METHODOLOGY_V8 } from "../../data/methodology-changelogs/yield-methodology/v8";
import {
  createMethodologyVersion,
  type MethodologyChangelogEntry,
  type MethodologyVersion,
  type MethodologyVersionConfig,
} from "./base";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  PRICING_PIPELINE_METHODOLOGY_VERSION,
  PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION,
  PSI_METHODOLOGY_VERSION_LABEL,
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "./constants";
import {
  DDR_METHODOLOGY_CHANGELOG,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION_LABEL,
  getDepegResolverMethodologyVersionAt,
} from "./depeg-resolver";

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

type ManagedMethodologyKey = Exclude<MethodologyChangelogRegistryKey, "depeg-resolver">;

interface ManagedMethodologyVersionConfig extends MethodologyVersionConfig {
  key: ManagedMethodologyKey;
}

const METHODOLOGY_VERSION_CONFIGS: readonly ManagedMethodologyVersionConfig[] = [
  {
    key: "safety-score",
    currentVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...SAFETY_SCORE_V9,
      ...SAFETY_SCORE_V8,
      ...SAFETY_SCORE_V7,
      ...SAFETY_SCORE_V6,
      ...SAFETY_SCORE_V5,
      ...SAFETY_SCORE_V4,
      ...SAFETY_SCORE_V3,
      ...SAFETY_SCORE_V2,
      ...SAFETY_SCORE_V1,
    ],
  },
  {
    key: "depeg-dews",
    currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...DEPEG_DEWS_V6,
      ...DEPEG_DEWS_V5,
      ...DEPEG_DEWS_V4,
      ...DEPEG_DEWS_V3,
      ...DEPEG_DEWS_V2,
      ...DEPEG_DEWS_V1,
    ],
  },
  {
    key: "liquidity-score",
    currentVersion: LIQUIDITY_METHODOLOGY_VERSION,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...LIQUIDITY_SCORE_V6,
      ...LIQUIDITY_SCORE_V5,
      ...LIQUIDITY_SCORE_V4,
      ...LIQUIDITY_SCORE_V3,
      ...LIQUIDITY_SCORE_V2,
      ...LIQUIDITY_SCORE_V1,
    ],
  },
  {
    key: "redemption-backstop",
    currentVersion: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
    changelogPath: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...REDEMPTION_BACKSTOP_V4,
      ...REDEMPTION_BACKSTOP_V3,
      ...REDEMPTION_BACKSTOP_V2,
      ...REDEMPTION_BACKSTOP_V1,
    ],
  },
  {
    key: "stability-index",
    currentVersion: PSI_METHODOLOGY_VERSION,
    changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
    changelog: [...STABILITY_INDEX_V3, ...STABILITY_INDEX_V2, ...STABILITY_INDEX_V1],
  },
  {
    key: "chain-health",
    currentVersion: CHAIN_HEALTH_METHODOLOGY_VERSION,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
    changelog: [...CHAIN_HEALTH_V1],
  },
  {
    key: "yield",
    currentVersion: YIELD_METHODOLOGY_VERSION,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...YIELD_METHODOLOGY_V8,
      ...YIELD_METHODOLOGY_V7,
      ...YIELD_METHODOLOGY_V6,
      ...YIELD_METHODOLOGY_V5,
      ...YIELD_METHODOLOGY_V4,
      ...YIELD_METHODOLOGY_V3,
      ...YIELD_METHODOLOGY_V2,
      ...YIELD_METHODOLOGY_V1,
    ],
  },
  {
    key: "blacklist-tracker",
    currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
    changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...BLACKLIST_TRACKER_V4,
      ...BLACKLIST_TRACKER_V3,
      ...BLACKLIST_TRACKER_V2,
      ...BLACKLIST_TRACKER_V1,
    ],
  },
  {
    key: "mint-burn-flow",
    currentVersion: MINT_BURN_FLOW_METHODOLOGY_VERSION,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...MINT_BURN_FLOW_V6,
      ...MINT_BURN_FLOW_V5,
      ...MINT_BURN_FLOW_V4,
      ...MINT_BURN_FLOW_V3,
      ...MINT_BURN_FLOW_V2,
      ...MINT_BURN_FLOW_V1,
    ],
  },
  {
    key: "pricing-pipeline",
    currentVersion: PRICING_PIPELINE_METHODOLOGY_VERSION,
    changelogPath: PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
    changelog: [
      ...PRICING_PIPELINE_V6,
      ...PRICING_PIPELINE_V5,
      ...PRICING_PIPELINE_V4,
      ...PRICING_PIPELINE_V3,
      ...PRICING_PIPELINE_V2,
      ...PRICING_PIPELINE_V1,
    ],
  },
];

const METHODOLOGY_VERSION_BY_KEY = Object.fromEntries(
  METHODOLOGY_VERSION_CONFIGS.map(({ key, ...config }) => [key, createMethodologyVersion(config)]),
) as Record<ManagedMethodologyKey, MethodologyVersion>;

function getManagedMethodologyVersion(key: ManagedMethodologyKey): MethodologyVersion {
  return METHODOLOGY_VERSION_BY_KEY[key];
}

export const SAFETY_SCORE_METHODOLOGY_CHANGELOG = getManagedMethodologyVersion("safety-score").changelog;
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS =
  getManagedMethodologyVersion("safety-score").versionLabels;
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG = getManagedMethodologyVersion("depeg-dews").changelog;
export const LIQUIDITY_METHODOLOGY_CHANGELOG = getManagedMethodologyVersion("liquidity-score").changelog;
export const REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG =
  getManagedMethodologyVersion("redemption-backstop").changelog;
export const PSI_METHODOLOGY_CHANGELOG = getManagedMethodologyVersion("stability-index").changelog;
export const CHAIN_HEALTH_METHODOLOGY_CHANGELOG = getManagedMethodologyVersion("chain-health").changelog;
export const YIELD_METHODOLOGY_CHANGELOG = getManagedMethodologyVersion("yield").changelog;
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG =
  getManagedMethodologyVersion("blacklist-tracker").changelog;
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG = getManagedMethodologyVersion("mint-burn-flow").changelog;
export const PRICING_PIPELINE_METHODOLOGY_CHANGELOG =
  getManagedMethodologyVersion("pricing-pipeline").changelog;

export interface MethodologyChangelogRegistryEntry {
  key: MethodologyChangelogRegistryKey;
  markdownKey: MethodologyChangelogMarkdownKey;
  feedKey: string;
  feedLabel: string;
  markdownTitle: string;
  linkTitle?: string;
  llmsDescription: string;
  publicPath: string;
  currentLabel: string;
  entries: readonly MethodologyChangelogEntry[];
  citationId: string;
}

export const METHODOLOGY_CHANGELOG_REGISTRY: readonly MethodologyChangelogRegistryEntry[] = [
  {
    key: "safety-score",
    markdownKey: "scoring",
    feedKey: "safety-score",
    feedLabel: "Safety Score",
    markdownTitle: "Safety Scores Changelog",
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
    llmsDescription: "Peg-deviation detection and early-warning stress methodology history.",
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
    llmsDescription: "Forecasting, resolution, and review methodology history for confirmed depeg incidents.",
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
    llmsDescription: "DEX market-depth, confidence, and coverage methodology history.",
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
    llmsDescription: "System-wide stablecoin stability index methodology history.",
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
    llmsDescription: "Chain Health factor, evidence, and rating methodology history.",
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
    llmsDescription: "Yield sourcing, risk, scoring, and publication methodology history.",
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
    llmsDescription: "Address monitoring, event normalization, and coverage methodology history.",
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
    llmsDescription: "Issuance-flow detection, scoring, and publication methodology history.",
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
    llmsDescription: "Price-source selection, consensus, validation, and fallback methodology history.",
    publicPath: PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
    currentLabel: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
    entries: PRICING_PIPELINE_METHODOLOGY_CHANGELOG,
    citationId: "pricing-pipeline",
  },
];

export const METHODOLOGY_CHANGELOG_SITEMAP_PATHS = METHODOLOGY_CHANGELOG_REGISTRY.map(
  (entry) => entry.publicPath,
) as readonly string[];

export const METHODOLOGY_CHANGELOG_MARKDOWN_KEYS = METHODOLOGY_CHANGELOG_REGISTRY.map(
  (entry) => entry.markdownKey,
) as readonly MethodologyChangelogMarkdownKey[];

const REGISTRY_BY_KEY = Object.fromEntries(
  METHODOLOGY_CHANGELOG_REGISTRY.map((entry) => [entry.key, entry]),
) as Record<MethodologyChangelogRegistryKey, MethodologyChangelogRegistryEntry>;

const REGISTRY_BY_MARKDOWN_KEY = Object.fromEntries(
  METHODOLOGY_CHANGELOG_REGISTRY.map((entry) => [entry.markdownKey, entry]),
) as Record<MethodologyChangelogMarkdownKey, MethodologyChangelogRegistryEntry>;

export function getMethodologyVersionAt(key: MethodologyChangelogRegistryKey, unixSeconds: number): string {
  return key === "depeg-resolver"
    ? getDepegResolverMethodologyVersionAt(unixSeconds)
    : getManagedMethodologyVersion(key).getVersionAt(unixSeconds);
}

export function getMethodologyChangelogEntry(
  key: MethodologyChangelogRegistryKey,
): MethodologyChangelogRegistryEntry {
  const entry = REGISTRY_BY_KEY[key];
  if (!entry) {
    throw new Error(`Unknown methodology changelog key: ${key}`);
  }
  return entry;
}

export function getMethodologyChangelogEntryByMarkdownKey(
  key: MethodologyChangelogMarkdownKey,
): MethodologyChangelogRegistryEntry {
  const entry = REGISTRY_BY_MARKDOWN_KEY[key];
  if (!entry) {
    throw new Error(`Unknown methodology changelog markdown key: ${key}`);
  }
  return entry;
}
