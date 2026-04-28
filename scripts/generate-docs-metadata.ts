import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_DOCS } from "../shared/lib/public-docs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, "../src/generated/docs-metadata.json");
const HISTORY_FALLBACKS: Record<string, string> = {
  "docs/pharosville-page.md": "docs/lighthouse-page.md",
};

interface DocMetadata {
  dateModified: string;
  dateCreated: string;
}

function gitLog(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

function gitLogWithHistoryFallback(filePath: string, args: string[]): string {
  const relPath = relative(process.cwd(), filePath);
  const output = gitLog([...args, "--", relPath]);
  if (output) return output;
  const fallback = HISTORY_FALLBACKS[relPath];
  return fallback ? gitLog([...args, "--", fallback]) : "";
}

function getLastGitDate(filePath: string): string {
  const output = gitLogWithHistoryFallback(filePath, ["log", "--follow", "-1", "--format=%aI"]);
  if (!output) {
    throw new Error(`[docs-metadata] no git history for ${filePath}`);
  }
  return output;
}

function getFirstGitDate(filePath: string): string {
  const output = gitLogWithHistoryFallback(filePath, ["log", "--follow", "--reverse", "--format=%aI"])
    .split(/\r?\n/)
    .find(Boolean);
  if (!output) {
    throw new Error(`[docs-metadata] no git creation history for ${filePath}`);
  }
  return output;
}

const metadata: Record<string, DocMetadata> = {};

for (const doc of PUBLIC_DOCS) {
  const filePath = join(__dirname, "..", "docs", doc.source);
  metadata[doc.slug] = {
    dateModified: getLastGitDate(filePath),
    dateCreated: getFirstGitDate(filePath),
  };
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
console.log(`Generated docs metadata for ${PUBLIC_DOCS.length} public docs`);
