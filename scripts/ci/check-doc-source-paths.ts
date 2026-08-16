#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { getVerifiedDocFiles, splitLines } from "../lib/doc-files.mts";
import { reportViolations } from "../lib/report-violations.mts";

const repoRoot = process.cwd();
const verifiedDocFiles = getVerifiedDocFiles(repoRoot);

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

interface InlineCodeSpan {
  line: number;
  value: string;
}

interface HistoricalCandidate {
  revision: string;
  path: string;
}

function* iterInlineCodeSpans(content: string): Generator<InlineCodeSpan> {
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

function trimToken(token: string): string {
  return stripLineColumnSuffix(token
    .trim()
    .replace(/^[("'[{]+/, "")
    .replace(/[)"'\]},.;]+$/, ""));
}

function isUnsignedInteger(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

function stripLineColumnSuffix(value: string): string {
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

function shouldSkipCandidate(candidate: string): boolean {
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

function isRepoPathCandidate(candidate: string): boolean {
  if (ROOT_FILE_NAMES.has(candidate)) return true;
  return ROOT_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

function normalizeCandidate(token: string): string | null {
  const stripped = trimToken(token).split("#", 1)[0];
  if (!isRepoPathCandidate(stripped) || shouldSkipCandidate(stripped)) {
    return null;
  }
  return stripped;
}

function parseHistoricalCandidate(token: string): HistoricalCandidate | null {
  const stripped = trimToken(token);
  const match = stripped.match(/^git:([0-9a-f]{7,40}):(.+)$/i);
  if (!match) return null;
  const [, revision = "", path = ""] = match;
  if (!isRepoPathCandidate(path) || shouldSkipCandidate(path)) return null;
  return { revision, path };
}

const errors: string[] = [];

for (const filePath of verifiedDocFiles) {
  const content = readFileSync(filePath, "utf8");
  for (const span of iterInlineCodeSpans(content)) {
    for (const rawToken of span.value.split(/\s+/)) {
      const historical = parseHistoricalCandidate(rawToken);
      if (historical) {
        const result = spawnSync("git", ["cat-file", "-e", `${historical.revision}:${historical.path}`], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        if (result.status !== 0) {
          errors.push(
            `${relative(repoRoot, filePath)}:${span.line}: ${historical.revision}:${historical.path} does not exist`,
          );
        }
        continue;
      }
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

process.exit(
  reportViolations({
    label: "Documentation source-path references",
    heading: "Documentation source-path check failed",
    violations: errors,
    scannedCount: verifiedDocFiles.length,
  }),
);
