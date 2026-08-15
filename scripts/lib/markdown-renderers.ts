import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import aiSummaries from "../../data/ai-summaries.json";
import digestsData from "../../data/digests.json";
import { changelogs } from "../../src/data/changelogs";
import type { ChangelogEntry } from "../../src/data/changelogs/types";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import {
  DOC_GROUPS,
  PUBLIC_DOCS,
  preparePublicDocMarkdown,
  type PublicDoc,
} from "@shared/lib/public-docs";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  DigestContentEntry,
  StablecoinAiSummariesById,
} from "@shared/types";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface MarkdownRoute {
  /** Route path beginning and ending with slash, e.g. `/stablecoin/usdt-tether/`. */
  path: string;
  /** Fully rendered markdown body including YAML front matter. */
  body: string;
}

const summaries = aiSummaries as StablecoinAiSummariesById;

export function frontMatterBlock(attrs: Record<string, string>): string {
  return (
    "---\n" +
    Object.entries(attrs)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n") +
    "\n---\n\n"
  );
}

function cleanMarkdownText(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function renderStablecoinDetail(
  id: string,
  summariesById: StablecoinAiSummariesById = summaries,
): string {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin) throw new Error(`Unknown stablecoin id: ${id}`);

  const summary = summariesById[id];
  const parts: string[] = [
    frontMatterBlock({
      title: `${coin.name} (${coin.symbol}) Stablecoin Analytics`,
      canonical: `https://pharos.watch/stablecoin/${id}/`,
      description: `Build-time stablecoin profile for ${coin.name} (${coin.symbol}). Live price, supply, peg, liquidity, and flow data are served by the Pharos API.`,
      ...(summary?.updatedAt ? { dateModified: summary.updatedAt } : {}),
    }),
    `# ${coin.name} (${coin.symbol})`,
    [
      `**Peg:** ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}`,
      `**Backing:** ${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}`,
      `**Governance:** ${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}`,
      `**Status:** ${coin.status ?? "active"}`,
    ].join("\n\n"),
  ];

  if (summary?.text) {
    parts.push(`## Overview\n\n${summary.text}`);
  }

  const collateral = cleanMarkdownText(coin.collateral);
  if (collateral) parts.push(`## Collateral\n\n${collateral}`);

  const pegMechanism = cleanMarkdownText(coin.pegMechanism);
  if (pegMechanism) parts.push(`## Peg Mechanism\n\n${pegMechanism}`);

  if (coin.jurisdiction) {
    parts.push(
      [
        "## Jurisdiction",
        "",
        "| Country | Regulator | License |",
        "| --- | --- | --- |",
        `| ${coin.jurisdiction.country} | ${coin.jurisdiction.regulator ?? "N/A"} | ${coin.jurisdiction.license ?? "N/A"} |`,
      ].join("\n"),
    );
  }

  if (coin.contracts?.length) {
    parts.push(
      [
        "## Contracts",
        "",
        "| Chain | Address | Decimals |",
        "| --- | --- | --- |",
        ...coin.contracts.map((contract) =>
          `| ${contract.chain} | \`${contract.address}\` | ${contract.decimals} |`
        ),
      ].join("\n"),
    );
  }

  if (coin.status === "pre-launch") {
    parts.push("## Live Data\n\nThis is a pre-launch stablecoin profile. Live API data is not available until launch.");
  } else if (coin.status === "quarantined" || coin.status === "delisted") {
    parts.push(
      `## Listing Status\n\n${coin.listingStatusReview?.reason ?? "This record is outside Pharos's active universe."} Current live monitoring is disabled; the canonical profile remains available for historical reference.`,
    );
  } else {
    parts.push(
      `## Live Data\n\nReal-time price, supply, peg score, liquidity, and flow data live at https://api.pharos.watch/api/stablecoin/${id}.`,
    );
  }

  return `${parts.join("\n\n")}\n`;
}

export function* iterateStablecoinRoutes(): Generator<MarkdownRoute> {
  for (const [id] of TRACKED_META_BY_ID.entries()) {
    yield { path: `/stablecoin/${id}/`, body: renderStablecoinDetail(id) };
  }
}

export function renderChangelogIndex(entries: readonly ChangelogEntry[] = changelogs): string {
  const sections = entries
    .map((entry) => {
      const summary = entry.summary
        .map((item) => `- **${item.label}**: ${item.description}`)
        .join("\n");
      const headline = entry.headline ? `\n\n${entry.headline}` : "";
      return `## ${entry.dateRange.from} to ${entry.dateRange.to}${headline}\n\n${summary}`;
    })
    .join("\n\n");

  return (
    frontMatterBlock({
      title: "Changelog: What's New on Pharos",
      canonical: "https://pharos.watch/changelog/",
      description: "Weekly release notes for Pharos.",
    }) +
    `# Changelog\n\n${sections}\n`
  );
}

export function renderDigestDetail(digest: DigestContentEntry): string {
  const iso = new Date(digest.generatedAt * 1000).toISOString();
  return (
    frontMatterBlock({
      title: digest.title,
      canonical: `https://pharos.watch/digest/${digest.date}/`,
      datePublished: iso,
      description: digest.text.slice(0, 160),
    }) +
    `# ${digest.title}\n\n## Executive Summary\n\n${digest.text}\n\n## Extended\n\n${digest.extended}\n`
  );
}

export function* iterateDigestRoutes(): Generator<MarkdownRoute> {
  for (const digest of digestsData as DigestContentEntry[]) {
    yield { path: `/digest/${digest.date}/`, body: renderDigestDetail(digest) };
  }
}

export function renderDocMarkdown(doc: PublicDoc): string {
  const source = readFileSync(join(REPO_ROOT, "docs", doc.source), "utf-8");
  return (
    frontMatterBlock({
      title: doc.title,
      canonical: `https://pharos.watch/docs/${doc.slug}/`,
      description: doc.summary,
    }) +
    preparePublicDocMarkdown(source, { absoluteLinks: true, source: doc.source })
  );
}

export function renderDocsIndexMarkdown(): string {
  const sections = DOC_GROUPS.map((group) => {
    const docs = PUBLIC_DOCS.filter((doc) => doc.group === group)
      .map((doc) => `- [${doc.title}](https://pharos.watch/docs/${doc.slug}/): ${doc.summary}`)
      .join("\n");
    return `## ${group}\n\n${docs}`;
  }).join("\n\n");

  return (
    frontMatterBlock({
      title: "Documentation",
      canonical: "https://pharos.watch/docs/",
      description: "Architectural, methodology, and design documentation for Pharos.",
    }) +
    `# Documentation\n\n${sections}\n`
  );
}

export function* iterateDocRoutes(): Generator<MarkdownRoute> {
  yield { path: "/docs/", body: renderDocsIndexMarkdown() };
  for (const doc of PUBLIC_DOCS) {
    yield { path: `/docs/${doc.slug}/`, body: renderDocMarkdown(doc) };
  }
}
