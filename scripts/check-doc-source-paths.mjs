#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const docsRoot = resolve(repoRoot, "docs");
const verifiedDocFiles = [
  resolve(repoRoot, "README.md"),
  ...collectMarkdownFiles(docsRoot),
];

const ROOT_PATH_PREFIXES = [
  ".github/",
  "data/",
  "docs/",
  "functions/",
  "public/",
  "scripts/",
  "shared/",
  "src/",
  "worker/",
];

const ROOT_FILE_NAMES = new Set([
  ".env.example",
  ".gitleaksignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "tsconfig.typecheck.json",
  "vitest.config.ts",
]);

function collectMarkdownFiles(rootDir) {
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

function splitLines(text) {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function* iterInlineCodeSpans(content) {
  let inFence = false;

  for (const [lineIndex, line] of splitLines(content).entries()) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const regex = /`([^`\n]+)`/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      yield {
        line: lineIndex + 1,
        value: match[1],
      };
    }
  }
}

function trimToken(token) {
  return stripLineColumnSuffix(token
    .trim()
    .replace(/^[("'[{]+/, "")
    .replace(/[)"'\]},.;]+$/, ""));
}

function isUnsignedInteger(value) {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

function stripLineColumnSuffix(value) {
  const parts = value.split(":");
  if (parts.length <= 1 || !isUnsignedInteger(parts.at(-1) ?? "")) {
    return value;
  }
  parts.pop();
  if (parts.length > 1 && isUnsignedInteger(parts.at(-1) ?? "")) {
    parts.pop();
  }
  return parts.join(":");
}

function shouldSkipCandidate(candidate) {
  return (
    candidate.length === 0 ||
    candidate.endsWith("/") ||
    candidate.includes("*") ||
    candidate.includes("<") ||
    candidate.includes(">") ||
    candidate.includes("{") ||
    candidate.includes("}") ||
    candidate.includes("...") ||
    candidate.includes("$") ||
    candidate.includes("\\")
  );
}

function isRepoPathCandidate(candidate) {
  if (ROOT_FILE_NAMES.has(candidate)) return true;
  return ROOT_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

function normalizeCandidate(token) {
  const stripped = trimToken(token).split("#", 1)[0];
  if (!isRepoPathCandidate(stripped) || shouldSkipCandidate(stripped)) {
    return null;
  }
  return stripped;
}

const errors = [];

for (const filePath of verifiedDocFiles) {
  const content = readFileSync(filePath, "utf8");
  for (const span of iterInlineCodeSpans(content)) {
    for (const rawToken of span.value.split(/\s+/)) {
      const candidate = normalizeCandidate(rawToken);
      if (!candidate) continue;

      const resolved = resolve(repoRoot, candidate);
      if (!resolved.startsWith(repoRoot)) {
        errors.push(`${relative(repoRoot, filePath)}:${span.line}: ${candidate} resolves outside the repo`);
        continue;
      }
      if (!existsSync(resolved) || (!statSync(resolved).isFile() && !statSync(resolved).isDirectory())) {
        errors.push(`${relative(repoRoot, filePath)}:${span.line}: ${candidate} does not exist`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Documentation source-path check failed:");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log(`Documentation source-path references passed for ${verifiedDocFiles.length} files.`);
