import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import type { MethodologyChangelogDetailBlock, MethodologyChangelogRichText } from "@shared/types/editorial-content";
import {
  METHODOLOGY_CHANGELOG_MARKDOWN_KEYS,
  getMethodologyChangelogEntryByMarkdownKey,
  type MethodologyChangelogMarkdownKey,
} from "@shared/lib/methodology-versions/registry";
import {
  METHODOLOGY_HISTORY_ARCHIVES,
  METHODOLOGY_RECENT_VERSIONS,
  methodologyArchivePath,
  methodologyHistoryAnchor,
  methodologyDetailAnchors,
} from "@shared/lib/methodology-versions/archives";
import { getListedDefinitions } from "../../src/lib/definitions";
import { METHODOLOGY_INDEX_SECTION_CONTENT } from "../../src/lib/methodology-content";
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
  const definitions = getListedDefinitions()
    .map((def) => `- **${def.term}**: ${def.text}`)
    .join("\n");
  return (
    frontMatterBlock({
      title: "Methodology: How Pharos Grades Stablecoins",
      canonical: "https://pharos.watch/methodology/",
      description:
        "Full methodology behind Pharos safety grades, peg scores, liquidity scores, PSI, DEWS, yield intelligence, and dependency propagation.",
    }) +
    `# Methodology\n\n${body}\n\n## Definitions\n\n${definitions}\n`
  );
}

function richTextMarkdown(text: MethodologyChangelogRichText): string {
  return typeof text === "string" ? text : text.map((run) => typeof run === "string" ? run
    : "code" in run ? `\`${run.code}\`` : "emphasis" in run ? `**${run.emphasis}**` : run.numeric).join("");
}

function detailMarkdown(blocks: readonly MethodologyChangelogDetailBlock[]): string {
  return blocks.map((block): string => {
    switch (block.kind) {
      case "paragraph": return richTextMarkdown(block.text);
      case "list": return block.items.map((item) => `- ${richTextMarkdown(item)}`).join("\n");
      case "formula": return `\`\`\`text\n${block.text}\n\`\`\``;
      case "weights": return `Peg | Liquidity | Safety | Resilience | Decentralization | Dep Risk\n--- | --- | --- | --- | --- | ---\n${block.values.join(" | ")}`;
      case "section": return `### ${block.heading}\n\n${detailMarkdown(block.blocks)}`;
      case "table": {
        const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
        return `<a id="${block.tableId}"></a>\n\n${block.columns.map((column) => cell(column.label)).join(" | ")}\n${block.columns.map(() => "---").join(" | ")}\n${block.rows.map((row) => block.columns.map((column) => cell(row.cells[column.id] ?? "")).join(" | ")).join("\n")}`;
      }
    }
  }).join("\n\n");
}

export function buildMethodologyChangelogMarkdown(key: MethodologyChangelogKey, archiveKey?: string): string {
  const config = getMethodologyChangelogEntryByMarkdownKey(key);
  const archive = archiveKey === undefined ? undefined : METHODOLOGY_HISTORY_ARCHIVES.find((item) =>
    item.changelog.key === config.key && item.archive === archiveKey);
  if (archiveKey !== undefined && !archive) throw new Error(`Unknown methodology archive: ${key}/${archiveKey}`);
  const entries = archive?.entries ?? config.entries;
  const sections = entries.map((entry, index) => {
    const heading = `<a id="${methodologyHistoryAnchor(config, entry.version)}"></a>\n\n## ${toMethodologyVersionLabel(entry.version)} - ${entry.title}\n\n**Effective:** ${entry.date}\n\n${entry.summary}`;
    if (!archive && index >= METHODOLOGY_RECENT_VERSIONS) {
      return `${heading}\n\n[Full release evidence](https://pharos.watch${methodologyArchivePath(config, entry.version)}#${methodologyHistoryAnchor(config, entry.version)})\n${methodologyDetailAnchors(entry.detail).map((anchor) => `\n<a id="${anchor.id}"></a>\n[${anchor.label}](https://pharos.watch${methodologyArchivePath(config, entry.version)}#${anchor.id})`).join("\n")}`;
    }
    const impact = entry.impact.map((line) => `- ${line}`).join("\n");
    const commits = entry.commits.length > 0 ? entry.commits.map((sha) => `\`${sha}\``).join(", ") : "Commit provenance not recorded";
    return `${heading}\n\n${impact}${entry.detail ? `\n\n${detailMarkdown(entry.detail)}` : ""}\n\nOrigin: ${entry.reconstructed ? "Reconstructed from git commit history" : "Contemporaneous release record"}\n\nCommits: ${commits}`;
  }).join("\n\n");
  const archiveLinks = archive ? `[All versions](https://pharos.watch${config.publicPath})` : METHODOLOGY_HISTORY_ARCHIVES
    .filter((item) => item.changelog.key === config.key)
    .map((item) => `- [${item.archive} archive](https://pharos.watch${item.path})`).join("\n");
  return frontMatterBlock({
    title: config.markdownTitle,
    canonical: `https://pharos.watch${archive?.path ?? config.publicPath}`,
    description: `${config.markdownTitle} - Pharos methodology version history.`,
  }) + `# ${config.markdownTitle}\n\n${archiveLinks}\n\n${sections}\n`;
}
