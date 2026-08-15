import {
  toMethodologyVersionLabel,
} from "@shared/lib/methodology-versions/base";
import {
  METHODOLOGY_CHANGELOG_MARKDOWN_KEYS,
  getMethodologyChangelogEntryByMarkdownKey,
  type MethodologyChangelogMarkdownKey,
} from "@shared/lib/methodology-versions/registry";
import { METHODOLOGY_INDEX_SECTION_CONTENT } from "../../src/app/methodology/sections/methodology-content";
import { frontMatterBlock } from "./markdown-renderers";

export type MethodologyChangelogKey = MethodologyChangelogMarkdownKey;

export const METHODOLOGY_CHANGELOG_KEYS = METHODOLOGY_CHANGELOG_MARKDOWN_KEYS;

export function getMethodologyChangelogPath(key: MethodologyChangelogKey): string {
  return getMethodologyChangelogEntryByMarkdownKey(key).publicPath;
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
  const config = getMethodologyChangelogEntryByMarkdownKey(key);
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
      title: config.markdownTitle,
      canonical: `https://pharos.watch${config.publicPath}`,
      description: `${config.markdownTitle} - Pharos methodology version history.`,
    }) +
    `# ${config.markdownTitle}\n\n${sections}\n`
  );
}
