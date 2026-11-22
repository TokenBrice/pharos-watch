import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { assertFullGitHistory } from "../lib/git-history.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const OUTPUT = join(__dirname, "../../src/generated/docs-metadata.json");
const OUTPUT_TYPES = join(__dirname, "../../src/generated/docs-metadata.json.d.ts");
const CHECK_MODE = process.argv.includes("--check");
const COMMIT_MARKER = "\x1eCOMMIT\x1e";

interface DocMetadata {
  dateModified: string;
  dateCreated: string;
}

function gitLog(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

/** Committer time: `dateModified` is deployment modification time, not author clock time. */
function getLastCommitDate(filePath: string): string {
  const output = gitLog(["log", "--follow", "-1", "--format=%cI", "--", relative(REPO_ROOT, filePath)]).trim();
  if (!output) {
    throw new Error(`[docs-metadata] no git history for ${filePath}`);
  }
  return output;
}

/** Author time: `dateCreated` is the authored-inception date of the document. */
function getFirstGitDate(filePath: string): string {
  const output = gitLog(["log", "--follow", "--reverse", "--format=%aI", "--", relative(REPO_ROOT, filePath)])
    .trim()
    .split(/\r?\n/)
    .find(Boolean);
  if (!output) {
    throw new Error(`[docs-metadata] no git creation history for ${filePath}`);
  }
  return output;
}

/**
 * Single reverse-chronological `git log -M --name-status -z -- docs/` pass.
 * Tracks rename chains inside `docs/` from HEAD back to root; any doc missing
 * or renamed from outside `docs/` falls back to per-file `git log --follow`.
 */
function collectDocsMetadataFromSinglePass(): { found: Map<string, DocMetadata>; needsFallback: Set<string> } {
  const output = gitLog(["log", "-M", `--format=${COMMIT_MARKER}%cI%x09%aI`, "--name-status", "-z", "--", "docs/"]);
  const trackedPaths = new Map<string, Set<string>>();
  for (const doc of PUBLIC_DOCS) {
    const gitPath = `docs/${doc.source}`;
    const slugs = trackedPaths.get(gitPath) ?? new Set<string>();
    slugs.add(doc.slug);
    trackedPaths.set(gitPath, slugs);
  }

  const found = new Map<string, DocMetadata>();
  const needsFallback = new Set<string>();
  const recordTouch = (slug: string, committerDate: string, authorDate: string) => {
    const existing = found.get(slug);
    if (existing) {
      existing.dateCreated = authorDate;
    } else {
      found.set(slug, { dateModified: committerDate, dateCreated: authorDate });
    }
  };

  for (const block of output.split(COMMIT_MARKER)) {
    if (!block) continue;
    const headerEnd = block.indexOf("\0");
    if (headerEnd === -1) continue;
    const header = block.slice(0, headerEnd).trim();
    const tabIdx = header.indexOf("\t");
    if (tabIdx === -1) continue;
    const committerDate = header.slice(0, tabIdx);
    const authorDate = header.slice(tabIdx + 1);

    const tokens = block.slice(headerEnd + 1).split("\0");
    const pendingRenames: Array<{ oldPath: string; newPath: string; slugs: Set<string> }> = [];
    let i = 0;
    while (i < tokens.length) {
      const status = tokens[i].replace(/^\r?\n/, "");
      if (!status) {
        i += 1;
        continue;
      }
      const code = status[0];
      if (code === "R" || code === "C") {
        if (i + 2 >= tokens.length) break;
        const oldPath = tokens[i + 1];
        const newPath = tokens[i + 2];
        i += 3;
        const slugs = trackedPaths.get(newPath);
        if (slugs) {
          for (const slug of slugs) recordTouch(slug, committerDate, authorDate);
          if (code === "R") pendingRenames.push({ oldPath, newPath, slugs: new Set(slugs) });
        }
      } else {
        if (i + 1 >= tokens.length) break;
        const path = tokens[i + 1];
        i += 2;
        const slugs = trackedPaths.get(path);
        if (slugs) {
          for (const slug of slugs) recordTouch(slug, committerDate, authorDate);
        }
      }
    }

    for (const { newPath, slugs } of pendingRenames) {
      const current = trackedPaths.get(newPath);
      if (!current) continue;
      for (const slug of slugs) current.delete(slug);
      if (current.size === 0) trackedPaths.delete(newPath);
    }
    for (const { oldPath, slugs } of pendingRenames) {
      if (!oldPath.startsWith("docs/")) {
        for (const slug of slugs) needsFallback.add(slug);
        continue;
      }
      const target = trackedPaths.get(oldPath) ?? new Set<string>();
      for (const slug of slugs) target.add(slug);
      trackedPaths.set(oldPath, target);
    }
  }

  return { found, needsFallback };
}

const metadata: Record<string, DocMetadata> = {};

assertFullGitHistory("docs-metadata");

const { found, needsFallback } = collectDocsMetadataFromSinglePass();

for (const doc of PUBLIC_DOCS) {
  const filePath = join(__dirname, "..", "..", "docs", doc.source);
  const entry = !needsFallback.has(doc.slug) ? found.get(doc.slug) : undefined;
  metadata[doc.slug] = entry ?? {
    dateModified: getLastCommitDate(filePath),
    dateCreated: getFirstGitDate(filePath),
  };
}

syncGeneratedArtifacts({
  artifacts: [
    { path: OUTPUT, contents: JSON.stringify(metadata, null, 2) + "\n" },
    {
      path: OUTPUT_TYPES,
      contents: `/** Auto-generated by scripts/maintenance/generate-docs-metadata.ts during prebuild. */
declare const docsMetadata: Record<string, { dateModified: string; dateCreated: string }>;
export default docsMetadata;
`,
    },
  ],
  check: CHECK_MODE,
  staleMessage:
    "src/generated/docs-metadata.json is out of date. Run `tsx scripts/maintenance/generate-docs-metadata.ts`.",
  currentMessage: `Docs metadata is current for ${PUBLIC_DOCS.length} public docs`,
  writtenMessage: `Generated docs metadata for ${PUBLIC_DOCS.length} public docs`,
});
