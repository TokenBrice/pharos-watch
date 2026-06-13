import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/blacklist-tracker-version";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/chain-health-version";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/depeg-dews-version";
import {
  DDR_METHODOLOGY_CHANGELOG,
  DDR_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/depeg-resolver-version";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/liquidity-score-version";
import {
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "../../shared/lib/methodology-version";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/mint-burn-flow-version";
import {
  PRICING_PIPELINE_CHANGELOG,
  PRICING_PIPELINE_CHANGELOG_PATH,
} from "../../shared/lib/pricing-pipeline-version";
import {
  SAFETY_SCORE_CHANGELOG,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/safety-score-version";
import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/stability-index-version";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_CHANGELOG_PATH,
} from "../../shared/lib/yield-methodology-version";
import { METHODOLOGY_INDEX_SECTION_CONTENT } from "../../src/app/methodology/sections/methodology-content";
import { frontMatterBlock } from "./markdown-renderers";

const CHANGELOG_REGISTRY = {
  scoring: {
    title: "Safety Scores Changelog",
    path: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    entries: SAFETY_SCORE_CHANGELOG,
  },
  depeg: {
    title: "Depeg Tracker and DEWS Changelog",
    path: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
    entries: DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  },
  "depeg-resolver": {
    title: "Depeg Duration Resolver Changelog",
    path: DDR_METHODOLOGY_CHANGELOG_PATH,
    entries: DDR_METHODOLOGY_CHANGELOG,
  },
  "blacklist-tracker": {
    title: "Blacklist Tracker Changelog",
    path: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
    entries: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  },
  "liquidity-score": {
    title: "Liquidity Score Changelog",
    path: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
    entries: LIQUIDITY_METHODOLOGY_CHANGELOG,
  },
  "stability-index": {
    title: "Stability Index Changelog",
    path: PSI_METHODOLOGY_CHANGELOG_PATH,
    entries: PSI_METHODOLOGY_CHANGELOG,
  },
  "mint-burn-flow": {
    title: "Mint/Burn Flow Changelog",
    path: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
    entries: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  },
  yield: {
    title: "Yield Intelligence Changelog",
    path: YIELD_METHODOLOGY_CHANGELOG_PATH,
    entries: YIELD_METHODOLOGY_CHANGELOG,
  },
  "pricing-pipeline": {
    title: "Pricing Pipeline Changelog",
    path: PRICING_PIPELINE_CHANGELOG_PATH,
    entries: PRICING_PIPELINE_CHANGELOG,
  },
  "chain-health": {
    title: "Chain Health Changelog",
    path: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
    entries: CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  },
} as const satisfies Record<string, {
  title: string;
  path: string;
  entries: readonly MethodologyChangelogEntry[];
}>;

export type MethodologyChangelogKey = keyof typeof CHANGELOG_REGISTRY;

export const METHODOLOGY_CHANGELOG_KEYS = Object.keys(CHANGELOG_REGISTRY) as MethodologyChangelogKey[];

export function getMethodologyChangelogPath(key: MethodologyChangelogKey): string {
  return CHANGELOG_REGISTRY[key].path;
}

export function buildMethodologyIndexMarkdown(): string {
  const body = METHODOLOGY_INDEX_SECTION_CONTENT.map((section) => section.markdown)
    .join("\n\n")
    .replace(/\n+$/, "");
  return (
    frontMatterBlock({
      title: "Methodology: How Pharos Grades Stablecoins",
      canonical: "https://pharos.watch/methodology/",
      description:
        "Full methodology behind Pharos safety grades, peg scores, liquidity scores, PSI, DEWS, yield intelligence, and contagion tests.",
    }) +
    `# Methodology\n\n${body}\n`
  );
}

export function buildMethodologyChangelogMarkdown(key: MethodologyChangelogKey): string {
  const config = CHANGELOG_REGISTRY[key];
  const sections = config.entries
    .map((entry) => {
      const impact = entry.impact.map((line) => `- ${line}`).join("\n");
      const commitLine = entry.commits.length > 0
        ? `\n\nCommits: ${entry.commits.map((sha) => `\`${sha}\``).join(", ")}`
        : "";
      return `## ${toMethodologyVersionLabel(entry.version)} - ${entry.title}\n\n**Effective:** ${entry.date}\n\n${entry.summary}\n\n${impact}${commitLine}`;
    })
    .join("\n\n");

  return (
    frontMatterBlock({
      title: config.title,
      canonical: `https://pharos.watch${config.path}`,
      description: `${config.title} - Pharos methodology version history.`,
    }) +
    `# ${config.title}\n\n${sections}\n`
  );
}
