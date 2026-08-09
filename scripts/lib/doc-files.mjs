import { resolve } from "node:path";
import { collectSourceFiles } from "./source-files.mjs";

// Documentation trees have no test/mock directories to skip, so the walker runs
// with an empty exclusion set rather than the source-scanner default.
const NO_EXCLUDED_DIRS = new Set();

export function collectMarkdownFiles(rootDir) {
  return collectSourceFiles(rootDir, { extensions: [".md"], excludedDirs: NO_EXCLUDED_DIRS });
}

export function getVerifiedDocFiles(repoRoot = process.cwd()) {
  const docsRoot = resolve(repoRoot, "docs");
  return [
    resolve(repoRoot, "README.md"),
    ...collectMarkdownFiles(docsRoot),
  ];
}

export function splitLines(text) {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
