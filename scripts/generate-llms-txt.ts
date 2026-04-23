import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PEG_LABELS_SHORT } from "../shared/lib/classification";
import { DEAD_STABLECOINS } from "../shared/lib/dead-stablecoins";
import { SITE_ORIGIN } from "../shared/lib/runtime-origins";
import { ACTIVE_STABLECOINS } from "../shared/lib/stablecoins";
import { PUBLIC_DOCS } from "../shared/lib/public-docs";
import type { BackingType, GovernanceType, StablecoinMeta } from "../shared/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIGESTS_PATH = join(__dirname, "../data/digests.json");
const OUTPUT_PATH = join(__dirname, "../public/llms.txt");
const DIGEST_LIMIT = 20;
const CHECK_MODE = process.argv.includes("--check");

const GOVERNANCE_METADATA_PHRASES: Record<GovernanceType, string> = {
  centralized: "centralized",
  "centralized-dependent": "CeFi-dependent",
  decentralized: "decentralized",
};

const BACKING_METADATA_PHRASES: Record<BackingType, string> = {
  "rwa-backed": "backed by real-world assets",
  "crypto-backed": "collateralized by crypto assets",
  algorithmic: "algorithmic stablecoin",
};

interface DigestEntry {
  date: string;
  title: string;
  text: string;
  generatedAt?: number;
}

function absolute(path: string): string {
  return `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

function stablecoinPath(id: string): string {
  return `/stablecoin/${encodeURIComponent(id)}/`;
}

function escapeMarkdown(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/\s+/g, " ")
    .trim();
}

function stablecoinDescription(coin: StablecoinMeta): string {
  const governance = GOVERNANCE_METADATA_PHRASES[coin.flags.governance] ?? coin.flags.governance;
  const backing = BACKING_METADATA_PHRASES[coin.flags.backing] ?? coin.flags.backing;
  const peg = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  return `${governance} stablecoin ${backing} pegged to ${peg}.`;
}

function loadDigests(): DigestEntry[] {
  const raw = readFileSync(DIGESTS_PATH, "utf8");
  const parsed = JSON.parse(raw) as DigestEntry[];

  return parsed
    .filter((entry) => entry.date && entry.title && entry.text)
    .sort((left, right) => (right.generatedAt ?? 0) - (left.generatedAt ?? 0))
    .slice(0, DIGEST_LIMIT);
}

const coreDataLinks = [
  ["Dashboard homepage", absolute("/"), "Market overview with KPI bar, peg-score heatmap, and stablecoin list."],
  ["Safety Scores", absolute("/safety-scores/"), "Weighted Liquidity / Resilience / Decentralization / Dependency + peg-stability multiplier, A+ to F."],
  ["Pharos Stability Index", absolute("/stability-index/"), "Aggregate market-stability gauge with history chart."],
  ["DEWS (Depeg Early Warning System)", absolute("/depeg/"), "Active depegs, watch-list, and historical DEWS bands."],
  ["Liquidity", absolute("/liquidity/"), "DEX liquidity scores, pool counts, TVL depth."],
  ["Yield", absolute("/yield/"), "Yield-bearing stablecoin intelligence."],
  ["Non-USD Market Structure", absolute("/alt-pegs/"), "Historical and current market structure for non-USD stablecoin cohorts."],
  ["Chains", absolute("/chains/"), "Per-chain stablecoin distribution and health."],
  ["Flows", absolute("/flows/"), "Mint/burn flow dashboards."],
  ["Blacklist Tracker", absolute("/blacklist/"), "Issuer freeze events and exposure."],
  ["Dependency Map", absolute("/dependency-map/"), "Inter-stablecoin dependency graph."],
  ["Coverage", absolute("/coverage/"), "What Pharos tracks and what it does not."],
  [
    "Cemetery",
    absolute("/cemetery/"),
    `${DEAD_STABLECOINS.length} defunct stablecoins and their causes of death.`,
  ],
  [
    "Stablecoin Cemetery dataset (JSON)",
    absolute("/datasets/stablecoin-cemetery.json"),
    "Citation-ready dataset of failed, discontinued, and abandoned stablecoins.",
  ],
  [
    "Stablecoin Cemetery dataset (CSV)",
    absolute("/datasets/stablecoin-cemetery.csv"),
    "Tabular export of the Stablecoin Cemetery dataset.",
  ],
  ["Upcoming", absolute("/upcoming/"), "Pre-launch stablecoins Pharos is tracking."],
] as const;

const methodologyLinks = [
  ["Methodology Hub", absolute("/methodology/"), "Full scoring model for safety, peg, liquidity, yield, contagion."],
  ["Safety Scores Changelog", absolute("/methodology/scoring-changelog/"), "Every weight change since v1.0."],
  ["Depeg + DEWS Changelog", absolute("/methodology/depeg-changelog/"), ""],
  ["Liquidity Score Changelog", absolute("/methodology/liquidity-score-changelog/"), ""],
  ["Stability Index Changelog", absolute("/methodology/stability-index-changelog/"), ""],
  ["Chain Health Changelog", absolute("/methodology/chain-health-changelog/"), ""],
  ["Yield Intelligence Changelog", absolute("/methodology/yield-changelog/"), ""],
  ["Blacklist Tracker Changelog", absolute("/methodology/blacklist-tracker-changelog/"), ""],
  ["Mint/Burn Flow Changelog", absolute("/methodology/mint-burn-flow-changelog/"), ""],
  ["Pricing Pipeline Changelog", absolute("/methodology/pricing-pipeline-changelog/"), ""],
] as const;

const apiLinks = [
  ["API Reference", absolute("/about/api/"), "Public and ops lanes, auth model, endpoint catalogue."],
  [
    "OpenAPI spec",
    absolute("/openapi.json"),
    "Machine-readable OpenAPI 3.1 endpoint catalogue for the Pharos API.",
  ],
  [
    "Postman collection",
    absolute("/postman/pharos-api.postman_collection.json"),
    "Importable Pharos API collection for external integrations.",
  ],
  [
    "Postman environment",
    absolute("/postman/pharos-api.postman_environment.json"),
    "Production environment template with API key placeholder.",
  ],
  ["Funding", absolute("/funding/"), "Public ledger of Pharos running costs, donations, and sustainability path."],
  ["About", absolute("/about/"), "Project context and data sources."],
] as const;

const changelogLinks = [
  ["Weekly Changelog", absolute("/changelog/"), "Release notes."],
  ["Daily Digest Archive", absolute("/digest/"), "Daily market recaps."],
] as const;

const docsLinks = [
  ["Documentation Archive", absolute("/docs/"), "Architecture, methodology, and design documentation."],
  ...PUBLIC_DOCS.map((doc) => [doc.title, absolute(`/docs/${doc.slug}/`), doc.summary] as const),
] as const;

function renderLinkList(links: readonly (readonly [string, string, string])[]): string[] {
  return links.map(([title, url, description]) => {
    const suffix = description ? `: ${description}` : "";
    return `- [${escapeMarkdown(title)}](${url})${suffix}`;
  });
}

function render(): string {
  const digests = loadDigests();
  const lines: string[] = [
    "# Pharos",
    "",
    `> Pharos tracks ${ACTIVE_STABLECOINS.length} active stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency-risk scoring, and report-card-style risk summaries. Data refreshes multiple times per day from the Pharos Cloudflare Worker API.`,
    "",
    "## Core Data",
    "",
    ...renderLinkList(coreDataLinks),
    "",
    "## Methodology",
    "",
    ...renderLinkList(methodologyLinks),
    "",
    "## API",
    "",
    ...renderLinkList(apiLinks),
    "",
    "## Changelog",
    "",
    ...renderLinkList(changelogLinks),
    "",
    "## Docs",
    "",
    ...renderLinkList(docsLinks),
    "",
    "Docs support `Accept: text/markdown` content negotiation for agent consumption.",
    "",
    "## Digest",
    "",
    ...digests.map((entry) => (
      `- [${escapeMarkdown(entry.title)}](${absolute(`/digest/${entry.date}/`)}): ${escapeMarkdown(entry.text)}`
    )),
    "",
    "## Stablecoins Index",
    "",
    ...ACTIVE_STABLECOINS.map((coin) => (
      `- [${escapeMarkdown(`${coin.name} (${coin.symbol})`)}](${absolute(stablecoinPath(coin.id))}): ${stablecoinDescription(coin)}`
    )),
    "",
  ];

  return lines.join("\n");
}

const output = render();

if (CHECK_MODE) {
  const current = readFileSync(OUTPUT_PATH, "utf8");
  if (current !== output) {
    console.error("public/llms.txt is out of date. Run `npm run prebuild` and commit the generated file.");
    process.exit(1);
  }
  console.log("public/llms.txt is current");
} else {
  writeFileSync(OUTPUT_PATH, output, "utf8");
  console.log(`Generated llms.txt for ${ACTIVE_STABLECOINS.length} active stablecoins`);
}
