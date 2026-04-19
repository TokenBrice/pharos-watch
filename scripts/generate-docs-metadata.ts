import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_DOCS } from "../shared/lib/public-docs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, "../src/generated/docs-metadata.json");

interface DocMetadata {
  dateModified: string;
  dateCreated: string;
}

function gitLog(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

function getLastGitDate(filePath: string): string {
  const output = gitLog(["log", "-1", "--format=%aI", "--", filePath]);
  if (!output) {
    throw new Error(`[docs-metadata] no git history for ${filePath}`);
  }
  return output;
}

function getFirstGitDate(filePath: string): string {
  const output = gitLog(["log", "--reverse", "--format=%aI", "--", filePath])
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
