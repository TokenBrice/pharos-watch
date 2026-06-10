#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["scripts", "docs", "package.json"];
const SOURCE_EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "out", "coverage"]);
const ALLOWED_SCRIPT_PREFIXES = [
  "scripts/maintenance/",
  "scripts/ci/",
  "scripts/build-data/",
  "scripts/lib/",
];
const SCRIPT_COMMANDS = ["node", "tsx"];
const SCRIPT_PATH_TERMINATORS = new Set([" ", "\t", "\r", "\n", "`", "'", '"', ")"]);
// Reverse mode: every runnable script in these directories must be referenced
// somewhere (package.json, CI workflows, docs, or another script).
const REVERSE_ENTRYPOINT_DIRS = ["scripts/maintenance", "scripts/ci", "scripts/build-data"];
const REVERSE_ENTRYPOINT_EXTENSIONS = new Set([".mjs", ".js", ".ts"]);
const REVERSE_REFERENCE_ROOTS = ["scripts", "docs", "package.json", ".github"];
const REVERSE_REFERENCE_EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".json", ".yml", ".yaml"]);

function extension(path) {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

function collectFiles(path, acc, extensions = SOURCE_EXTENSIONS) {
  const abs = resolve(ROOT, path);
  if (!existsSync(abs)) return;
  const stats = statSync(abs);
  if (stats.isFile()) {
    if (extensions.has(extension(abs))) acc.push(abs);
    return;
  }
  if (!stats.isDirectory()) return;

  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(abs, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc, extensions);
    } else if (entry.isFile() && extensions.has(extension(entry.name))) {
      acc.push(full);
    }
  }
}

function isTestPath(path) {
  return path.includes("__tests__") || /\.test\.[a-z]+$/.test(path);
}

function normalizeScriptPath(rawPath) {
  return rawPath.replace(/[\\.,;:]+$/, "");
}

function isCommandBoundary(char) {
  return char === "" || char === " " || char === "\t" || char === "`" || char === "'" || char === '"';
}

function collectScriptEntrypoints(line) {
  const entrypoints = [];

  for (const command of SCRIPT_COMMANDS) {
    const marker = `${command} scripts/`;
    let searchStart = 0;

    while (searchStart < line.length) {
      const markerIndex = line.indexOf(marker, searchStart);
      if (markerIndex === -1) break;

      const previousChar = markerIndex > 0 ? line[markerIndex - 1] ?? "" : "";
      if (!isCommandBoundary(previousChar)) {
        searchStart = markerIndex + marker.length;
        continue;
      }

      const pathStart = markerIndex + `${command} `.length;
      let pathEnd = pathStart;
      while (pathEnd < line.length && !SCRIPT_PATH_TERMINATORS.has(line[pathEnd] ?? "")) {
        pathEnd += 1;
      }

      entrypoints.push(line.slice(pathStart, pathEnd));
      searchStart = pathEnd;
    }
  }

  return entrypoints;
}

const files = [];
for (const root of SCAN_ROOTS) {
  collectFiles(root, files);
}

const errors = [];

for (const file of files) {
  const relFile = relative(ROOT, file).replaceAll("\\", "/");
  const content = readFileSync(file, "utf8");
  for (const [lineIndex, line] of content.split("\n").entries()) {
    for (const entrypoint of collectScriptEntrypoints(line)) {
      const scriptPath = normalizeScriptPath(entrypoint);
      if (scriptPath === "scripts/") continue;
      const allowed = ALLOWED_SCRIPT_PREFIXES.some((prefix) => scriptPath.startsWith(prefix));
      const exists = existsSync(resolve(ROOT, scriptPath));
      if (!allowed || !exists) {
        errors.push(`${relFile}:${lineIndex + 1}: stale script entrypoint \`${scriptPath}\``);
      }
    }
  }
}

// Reverse check: flag runnable scripts that nothing references (dead scripts).
const reverseCandidates = [];
for (const dir of REVERSE_ENTRYPOINT_DIRS) {
  collectFiles(dir, reverseCandidates, REVERSE_ENTRYPOINT_EXTENSIONS);
}
const referenceFiles = [];
for (const root of REVERSE_REFERENCE_ROOTS) {
  collectFiles(root, referenceFiles, REVERSE_REFERENCE_EXTENSIONS);
}
const referenceContents = referenceFiles
  .filter((file) => !isTestPath(relative(ROOT, file).replaceAll("\\", "/")))
  .map((file) => ({ file, content: readFileSync(file, "utf8") }));

for (const candidate of reverseCandidates) {
  const relPath = relative(ROOT, candidate).replaceAll("\\", "/");
  if (isTestPath(relPath)) continue;
  const bare = relPath.replace(/\.(mjs|js|ts)$/, "");
  const referenced = referenceContents.some(
    ({ file, content }) => file !== candidate && (content.includes(relPath) || content.includes(bare)),
  );
  if (!referenced) {
    errors.push(
      `${relPath}: unreferenced script — wire it into package.json/CI, document it in docs/scripts.md, or delete it`,
    );
  }
}

if (errors.length > 0) {
  console.error("Script entrypoint check failed:");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log(`Script entrypoint references passed for ${files.length} files.`);
