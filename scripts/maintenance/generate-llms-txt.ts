import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKING_PROSE_LABELS,
  GOVERNANCE_PROSE_LABELS,
  PEG_LABELS_SHORT,
} from "../../shared/lib/classification";
import { CEMETERY_ENTRIES } from "../../shared/lib/cemetery-merged";
import { SITE_ORIGIN } from "../../shared/lib/runtime-origins";
import { ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import { PUBLIC_DOCS } from "../../shared/lib/public-docs";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "../../shared/lib/methodology-versions/registry";
import { MECHANISM_ARCHETYPE_VALUES } from "../../shared/types/core";
import { CASE_STUDY_LIST } from "../../src/app/learn/case-studies/content";
import { GLOSSARY_ENTRIES } from "../../src/app/learn/glossary/content";
import { ARCHETYPE_CONTENT } from "../../src/app/learn/mechanisms/content";
import type { StablecoinMeta } from "../../shared/types";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIGESTS_PATH = join(__dirname, "../../data/digests.json");
const OUTPUT_PATH = join(__dirname, "../../public/llms.txt");
const DIGEST_LIMIT = 20;
const CHECK_MODE = process.argv.includes("--check");

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
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]").replace(/\s+/g, " ").trim();
}

function stablecoinDescription(coin: StablecoinMeta): string {
  const governance = GOVERNANCE_PROSE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backing = BACKING_PROSE_LABELS[coin.flags.backing] ?? coin.flags.backing;
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
  [
    "Safety Scores",
    absolute("/safety-scores/"),
    "Safety Score V9 three-pillar Backing / Exit / Economic Control model with evidence-backed grades from A+ to F.",
  ],
  ["Pharos Stability Index", absolute("/stability-index/"), "Aggregate market-stability gauge with history chart."],
  ["DEWS (Depeg Early Warning System)", absolute("/depeg/"), "Active depegs, watch-list, and historical DEWS bands."],
  ["Liquidity", absolute("/liquidity/"), "DEX liquidity scores, pool counts, TVL depth."],
  ["Yield", absolute("/yield/"), "Yield-bearing stablecoin intelligence."],
  [
    "Non-USD Market Structure",
    absolute("/alt-pegs/"),
    "Historical and current market structure for non-USD stablecoin cohorts.",
  ],
  ["Chains", absolute("/chains/"), "Per-chain stablecoin distribution and health."],
  ["Flows", absolute("/flows/"), "Mint/burn flow dashboards."],
  ["FreezeWatch", absolute("/freezewatch/"), "Issuer freeze events and exposure."],
  ["Dependency Map", absolute("/dependency-map/"), "Inter-stablecoin dependency graph."],
  ["Coverage", absolute("/coverage/"), "What Pharos tracks and what it does not."],
  ["Cemetery", absolute("/cemetery/"), `${CEMETERY_ENTRIES.length} defunct stablecoins and their causes of death.`],
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
  ...METHODOLOGY_CHANGELOG_REGISTRY.map((entry) => [
    entry.linkTitle,
    absolute(entry.publicPath),
    entry.llmsDescription,
  ] as const),
] as const;

const glossaryHighlights = ["psi", "dews", "pegscore", "safety-score", "liquidity-score", "freezewatch"] as const;

const learnLinks = [
  [
    "Stablecoin Glossary",
    absolute("/learn/glossary/"),
    `${GLOSSARY_ENTRIES.length} citation-ready definitions for Pharos stablecoin analytics terminology.`,
  ],
  ...glossaryHighlights.map((id) => {
    const entry = GLOSSARY_ENTRIES.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new Error(`Missing glossary highlight: ${id}`);
    }
    return [
      `Glossary: ${entry.term}`,
      absolute(`/learn/glossary/#${entry.id}`),
      entry.definition,
    ] as const;
  }),
  [
    "Stablecoin Mechanisms",
    absolute("/learn/mechanisms/"),
    `${MECHANISM_ARCHETYPE_VALUES.length} plain-English explainers for the stablecoin mechanism archetypes Pharos tracks.`,
  ],
  ...MECHANISM_ARCHETYPE_VALUES.map((archetype) => {
    const content = ARCHETYPE_CONTENT[archetype];
    return [
      `Mechanism: ${content.headline}`,
      absolute(`/learn/mechanisms/${archetype}/`),
      content.subtitle,
    ] as const;
  }),
  [
    "Stablecoin Case Studies",
    absolute("/learn/case-studies/"),
    `${CASE_STUDY_LIST.length} long-form retrospectives on stablecoin depegs, failures, and recoveries.`,
  ],
  ...CASE_STUDY_LIST.map((study) => [
    `Case study: ${study.title}`,
    absolute(`/learn/case-studies/${study.slug}/`),
    study.subtitle,
  ] as const),
] as const;

const apiLinks = [
  ["API Access", absolute("/api/"), "Email-verified self-serve API key request flow."],
  ["API Reference", absolute("/about/api/"), "Public and ops lanes, auth model, endpoint catalogue."],
  ["OpenAPI spec", absolute("/openapi.json"), "Machine-readable OpenAPI 3.1 endpoint catalogue for the Pharos API."],
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

const feedLinks = [
  ["Digest feed (RSS 2.0)", absolute("/feed/digest.xml"), "Daily and weekly digests."],
  ["Depeg feed (RSS 2.0)", absolute("/feed/depeg.xml"), "Confirmed depeg events."],
  ["Methodology feed (RSS 2.0)", absolute("/feed/methodology.xml"), "Unified methodology changelog across 10 datasets."],
  ["Cemetery feed (RSS 2.0)", absolute("/feed/cemetery.xml"), "Newly archived defunct stablecoins."],
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
    "## Learn",
    "",
    ...renderLinkList(learnLinks),
    "",
    "## API",
    "",
    ...renderLinkList(apiLinks),
    "",
    "## Feeds",
    "",
    ...renderLinkList(feedLinks),
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
    ...digests.map(
      (entry) =>
        `- [${escapeMarkdown(entry.title)}](${absolute(`/digest/${entry.date}/`)}): ${escapeMarkdown(entry.text)}`,
    ),
    "",
    "## Stablecoins Index",
    "",
    ...ACTIVE_STABLECOINS.map(
      (coin) =>
        `- [${escapeMarkdown(`${coin.name} (${coin.symbol})`)}](${absolute(stablecoinPath(coin.id))}): ${stablecoinDescription(coin)}`,
    ),
    "",
  ];

  return lines.join("\n");
}

const output = render();

syncGeneratedArtifacts({
  artifacts: [{ path: OUTPUT_PATH, contents: output }],
  check: CHECK_MODE,
  staleMessage: "public/llms.txt is out of date. Run `npm run prebuild` and commit the generated file.",
  currentMessage: "public/llms.txt is current",
  writtenMessage: `Generated llms.txt for ${ACTIVE_STABLECOINS.length} active stablecoins`,
});
