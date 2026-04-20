import { readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

export function collectMarkdownFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(entryPath));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(entryPath);
    }
  }
  return files;
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
