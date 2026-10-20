import { methodologyChangelogEntryId } from "./base";
import type { MethodologyChangelogDetailBlock } from "../../types/editorial-content";
import { METHODOLOGY_CHANGELOG_REGISTRY, type MethodologyChangelogRegistryEntry } from "./registry";

/** Bound the overview independently of the amount of retained history. */
export const METHODOLOGY_RECENT_VERSIONS = 2;

export function methodologyHistoryAnchor(changelog: MethodologyChangelogRegistryEntry, version: string): string {
  return changelog.key === "safety-score"
    ? `scoring-v${version.replaceAll(".", "-")}`
    : methodologyChangelogEntryId(version);
}

function methodologyArchiveKey(version: string): string {
  return `v${version.replace(/^v/, "").split(".")[0]}`;
}

export function methodologyArchivePath(changelog: MethodologyChangelogRegistryEntry, version: string): string {
  return `${changelog.publicPath}archive/${methodologyArchiveKey(version)}/`;
}

/** Major-version shards keep route growth bounded without losing any release body. */
export const METHODOLOGY_HISTORY_ARCHIVES = METHODOLOGY_CHANGELOG_REGISTRY.flatMap((changelog) =>
  [...new Set(changelog.entries.map((entry) => methodologyArchiveKey(entry.version)))].map((archive) => ({
    changelog,
    archive,
    path: `${changelog.publicPath}archive/${archive}/`,
    slug: changelog.publicPath.split("/")[2],
    entries: changelog.entries.filter((entry) => methodologyArchiveKey(entry.version) === archive),
  })),
);

export function methodologyDetailAnchors(blocks: readonly MethodologyChangelogDetailBlock[] = []): { id: string; label: string }[] {
  return blocks.flatMap((block) => block.kind === "table"
    ? [{ id: block.tableId, label: block.ariaLabel }]
    : block.kind === "section" ? methodologyDetailAnchors(block.blocks) : []);
}

export const METHODOLOGY_ARCHIVE_PATHS = METHODOLOGY_HISTORY_ARCHIVES.map((archive) => archive.path);
