import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import aiSummaries from "../../data/ai-summaries.json";
import digestsData from "../../data/digests.json";
import { CHANGELOG_MONTH_ARCHIVES, RECENT_CHANGELOGS } from "../../src/lib/changelog-history";
import type { ChangelogEntry } from "@shared/types/editorial-content";
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
import { buildStablecoinUrl } from "@shared/lib/urls";
import {
  AI_SUMMARY_UNAVAILABLE_NOTICE,
  hasAvailableAiSummaryClaims,
  resolveAiSummaryClaims,
} from "@shared/lib/ai-summary-claims";
import { stripTermMarkup } from "../../src/lib/term-markup";
import { formatSnapshotSafetyScoreLabel } from "../../src/lib/safety-grade-snapshot";
import { buildStablecoinFaqItems } from "../../src/components/stablecoin-detail/static-seo-content";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import type {
  DigestContentEntry,
  StablecoinAiSummariesById,
} from "@shared/types";
import { DigestStoredSnapshotSchema } from "@shared/types/digest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface MarkdownRoute {
  /** Route path beginning and ending with slash, e.g. `/stablecoin/usdt-tether/`. */
  path: string;
  /** Fully rendered markdown body including YAML front matter. */
  body: string;
}

const summaries = aiSummaries as StablecoinAiSummariesById;
const digests = DigestStoredSnapshotSchema.parse(digestsData);

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
      canonical: `https://pharos.watch${buildStablecoinUrl(id)}`,
      description: `Build-time stablecoin profile for ${coin.name} (${coin.symbol}).${
        coin.status === "pre-launch" || coin.status === "quarantined" || coin.status === "delisted"
          ? ""
          : " Live price, supply, peg, liquidity, and flow data are served by the Pharos API."
      }`,
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

  // Lead with the dated release grade (the same source as the profile FAQ).
  // Markdown never hydrates, so do not publish summary claims without live inputs.
  const scoreLabel = isActiveStablecoinMeta(coin) ? formatSnapshotSafetyScoreLabel(id) : null;
  const gradeSentence = scoreLabel ? `${coin.symbol} held ${scoreLabel} in Pharos's scores-latest release dataset.` : null;
  const resolvedSummary = summary?.text && hasAvailableAiSummaryClaims(summary.text, summary.claimTokens)
    ? stripTermMarkup(resolveAiSummaryClaims(summary.text, summary.claimTokens).text)
    : null;
  if (gradeSentence || summary?.text) {
    const overview = [gradeSentence, resolvedSummary ?? AI_SUMMARY_UNAVAILABLE_NOTICE].filter(Boolean).join(" ");
    parts.push(`## Overview\n\n${overview}`);
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
          `| ${contract.chain} | \`${contract.address}\` | ${contract.amountEncoding?.kind === "xrpl-issued-currency" ? "XRPL issued-currency decimal string" : contract.decimals} |`
        ),
      ].join("\n"),
    );
  }

  if (coin.status !== "pre-launch") {
    parts.push(
      [
        "## Quick answers",
        ...buildStablecoinFaqItems(coin).map((item) => `### ${item.question}\n\n${item.answer}`),
      ].join("\n\n"),
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
    yield { path: buildStablecoinUrl(id), body: renderStablecoinDetail(id) };
  }
}

export function renderChangelogIndex(entries: readonly ChangelogEntry[] = RECENT_CHANGELOGS, path = "/changelog/"): string {
  const sections = entries
    .map((entry) => {
      const summary = entry.summary
        .map((item) => `- **${item.label}**: ${item.description}`)
        .join("\n");
      const headline = entry.headline ? `\n\n${entry.headline}` : "";
      return `<a id="week-${entry.dateRange.to}"></a>\n<a id="${entry.dateRange.to}"></a>\n\n## ${entry.dateRange.from} to ${entry.dateRange.to}${headline}\n\n${summary}`;
    })
    .join("\n\n");

  return (
    frontMatterBlock({
      title: "Changelog: What's New on Pharos",
      canonical: `https://pharos.watch${path}`,
      description: "Weekly release notes for Pharos.",
    }) +
    `# Changelog\n\n${sections}\n` +
    (path === "/changelog/" ? `\n## Monthly archives\n\n${CHANGELOG_MONTH_ARCHIVES.map((archive) =>
      `- [${archive.label}](https://pharos.watch${archive.path})\n${archive.entries.map((entry) => `  - [${entry.dateRange.to}: ${entry.headline ?? "Weekly release notes"}](https://pharos.watch${archive.path}#week-${entry.dateRange.to})`).join("\n")}`).join("\n")}\n` : "\n[Latest releases and all archives](https://pharos.watch/changelog/)\n")
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
  for (const digest of digests) {
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
    preparePublicDocMarkdown(source, { absoluteLinks: true })
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
