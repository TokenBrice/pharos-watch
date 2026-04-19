import { BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG } from "../../shared/lib/blacklist-tracker-version";
import { CHAIN_HEALTH_METHODOLOGY_CHANGELOG } from "../../shared/lib/chain-health-version";
import { DEPEG_DEWS_METHODOLOGY_CHANGELOG } from "../../shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_CHANGELOG } from "../../shared/lib/liquidity-score-version";
import type { MethodologyChangelogEntry } from "../../shared/lib/methodology-version";
import { MINT_BURN_FLOW_METHODOLOGY_CHANGELOG } from "../../shared/lib/mint-burn-flow-version";
import { PRICING_PIPELINE_CHANGELOG } from "../../shared/lib/pricing-pipeline-version";
import { SAFETY_SCORE_CHANGELOG } from "../../shared/lib/safety-score-version";
import { PSI_METHODOLOGY_CHANGELOG } from "../../shared/lib/stability-index-version";
import { YIELD_METHODOLOGY_CHANGELOG } from "../../shared/lib/yield-methodology-version";
import { CONTENT_MARKDOWN as PRICING_PIPELINE } from "../../src/app/methodology/sections/core-sections-pricing";
import { CONTENT_MARKDOWN as INFRASTRUCTURE } from "../../src/app/methodology/sections/core/infrastructure-section";
import { CONTENT_MARKDOWN as LIQUIDITY } from "../../src/app/methodology/sections/core/liquidity-section";
import { CONTENT_MARKDOWN as MINT_BURN_FLOW } from "../../src/app/methodology/sections/core/mint-burn-flow-section";
import { CONTENT_MARKDOWN as SAFETY_SCORES } from "../../src/app/methodology/sections/core/safety-scores-section";
import { CONTENT_MARKDOWN as STABILITY_INDEX } from "../../src/app/methodology/sections/core/stability-index-section";
import { CONTENT_MARKDOWN as BLACKLIST } from "../../src/app/methodology/sections/monitoring/blacklist-tracker-section";
import { CONTENT_MARKDOWN as CHAIN_HEALTH } from "../../src/app/methodology/sections/monitoring/chain-health-section";
import { CONTENT_MARKDOWN as CONTAGION } from "../../src/app/methodology/sections/monitoring/contagion-stress-test-section";
import { CONTENT_MARKDOWN as PEGSCORE_DEWS } from "../../src/app/methodology/sections/monitoring/pegscore-dews-section";
import { CONTENT_MARKDOWN as YIELD } from "../../src/app/methodology/sections/monitoring/yield-intelligence-section";
import { frontMatterBlock } from "./markdown-renderers";

const SECTIONS = [
  PRICING_PIPELINE,
  STABILITY_INDEX,
  SAFETY_SCORES,
  INFRASTRUCTURE,
  LIQUIDITY,
  MINT_BURN_FLOW,
  YIELD,
  PEGSCORE_DEWS,
  CONTAGION,
  BLACKLIST,
  CHAIN_HEALTH,
];

const CHANGELOG_REGISTRY = {
  scoring: {
    title: "Safety Scores Changelog",
    path: "/methodology/scoring-changelog/",
    entries: SAFETY_SCORE_CHANGELOG,
  },
  depeg: {
    title: "Depeg Tracker and DEWS Changelog",
    path: "/methodology/depeg-changelog/",
    entries: DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  },
  "blacklist-tracker": {
    title: "Blacklist Tracker Changelog",
    path: "/methodology/blacklist-tracker-changelog/",
    entries: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  },
  "liquidity-score": {
    title: "Liquidity Score Changelog",
    path: "/methodology/liquidity-score-changelog/",
    entries: LIQUIDITY_METHODOLOGY_CHANGELOG,
  },
  "stability-index": {
    title: "Stability Index Changelog",
    path: "/methodology/stability-index-changelog/",
    entries: PSI_METHODOLOGY_CHANGELOG,
  },
  "mint-burn-flow": {
    title: "Mint/Burn Flow Changelog",
    path: "/methodology/mint-burn-flow-changelog/",
    entries: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  },
  yield: {
    title: "Yield Intelligence Changelog",
    path: "/methodology/yield-changelog/",
    entries: YIELD_METHODOLOGY_CHANGELOG,
  },
  "pricing-pipeline": {
    title: "Pricing Pipeline Changelog",
    path: "/methodology/pricing-pipeline-changelog/",
    entries: PRICING_PIPELINE_CHANGELOG,
  },
  "chain-health": {
    title: "Chain Health Changelog",
    path: "/methodology/chain-health-changelog/",
    entries: CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  },
} as const satisfies Record<string, {
  title: string;
  path: string;
  entries: readonly MethodologyChangelogEntry[];
}>;

export type MethodologyChangelogKey = keyof typeof CHANGELOG_REGISTRY;

export const METHODOLOGY_CHANGELOG_KEYS = Object.keys(CHANGELOG_REGISTRY) as MethodologyChangelogKey[];

export function buildMethodologyIndexMarkdown(): string {
  return (
    frontMatterBlock({
      title: "Methodology: How Pharos Grades Stablecoins",
      canonical: "https://pharos.watch/methodology/",
      description:
        "Full methodology behind Pharos safety grades, peg scores, liquidity scores, PSI, DEWS, yield intelligence, and contagion tests.",
    }) +
    `# Methodology\n\n${SECTIONS.join("\n\n")}\n`
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
      return `## v${entry.version} - ${entry.title}\n\n**Effective:** ${entry.date}\n\n${entry.summary}\n\n${impact}${commitLine}`;
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
