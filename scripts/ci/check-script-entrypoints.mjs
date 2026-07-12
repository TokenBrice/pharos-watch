#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { collectSourceFiles } from "../lib/source-files.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const SCAN_ROOTS = ["scripts", "docs", "package.json", ".github/workflows", ".github/actions"];
const SOURCE_EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".json", ".yml", ".yaml"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "out", "coverage"]);
const ALLOWED_SCRIPT_PREFIXES = [
  "scripts/maintenance/",
  "scripts/ci/",
  "scripts/build-data/",
  "scripts/lib/",
  ".github/scripts/",
];
const SCRIPT_COMMANDS = ["node", "tsx"];
const SCRIPT_PATH_TERMINATORS = new Set([" ", "\t", "\r", "\n", "`", "'", '"', ")"]);
// Reverse mode: every runnable script in these directories must be referenced
// somewhere (package.json, CI workflows, docs, or another script).
const REVERSE_ENTRYPOINT_DIRS = ["scripts/maintenance", "scripts/ci", "scripts/build-data", ".github/scripts"];
const REVERSE_ENTRYPOINT_EXTENSIONS = new Set([".mjs", ".js", ".ts"]);
const REVERSE_REFERENCE_ROOTS = ["scripts", "docs", "package.json", ".github"];
const REVERSE_REFERENCE_EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".json", ".yml", ".yaml"]);

function collectFiles(root, path, acc, extensions = SOURCE_EXTENSIONS) {
  const abs = resolve(root, path);
  if (!existsSync(abs)) return;
  const stats = statSync(abs);
  if (stats.isFile()) {
    if (extensions.has(extname(abs))) acc.push(abs);
    return;
  }
  if (!stats.isDirectory()) return;

  acc.push(...collectSourceFiles(abs, { extensions, excludedDirs: SKIP_DIRS }));
}

function isTestPath(path) {
  return path.includes("__tests__") || /\.test\.[a-z]+$/.test(path);
}

function normalizeScriptPath(rawPath) {
  return rawPath.replace(/[\\.,;:]+$/, "");
}

function isCommandBoundary(char) {
  return char === "" || /\s/.test(char) || char === "`" || char === "'" || char === '"';
}

export function collectScriptEntrypoints(content, { allowLineBreaks = false } = {}) {
  const entrypoints = [];

  for (const command of SCRIPT_COMMANDS) {
    let searchStart = 0;

    while (searchStart < content.length) {
      const commandIndex = content.indexOf(command, searchStart);
      if (commandIndex === -1) break;

      const previousChar = commandIndex > 0 ? content[commandIndex - 1] ?? "" : "";
      const afterCommand = commandIndex + command.length;
      if (!isCommandBoundary(previousChar) || !/\s/.test(content[afterCommand] ?? "")) {
        searchStart = afterCommand;
        continue;
      }

      let pathStart = afterCommand;
      while (pathStart < content.length) {
        const char = content[pathStart] ?? "";
        if (char === " " || char === "\t") {
          pathStart += 1;
          continue;
        }
        if (char === "\\" && allowLineBreaks && /\r|\n/.test(content[pathStart + 1] ?? "")) {
          pathStart += content[pathStart + 1] === "\r" && content[pathStart + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (allowLineBreaks && (char === "\r" || char === "\n")) {
          pathStart += char === "\r" && content[pathStart + 1] === "\n" ? 2 : 1;
          continue;
        }
        break;
      }

      const hasRepoScriptPrefix = ["scripts/", ".github/scripts/"].some((prefix) =>
        content.startsWith(prefix, pathStart),
      );
      if (!hasRepoScriptPrefix) {
        searchStart = afterCommand;
        continue;
      }

      let pathEnd = pathStart;
      while (pathEnd < content.length && !SCRIPT_PATH_TERMINATORS.has(content[pathEnd] ?? "")) {
        pathEnd += 1;
      }

      entrypoints.push(content.slice(pathStart, pathEnd));
      searchStart = pathEnd;
    }
  }

  return entrypoints;
}

export function collectScriptEntrypointErrors({ root = process.cwd() } = {}) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    collectFiles(root, scanRoot, files);
  }

  const errors = [];

  for (const file of files) {
    const relFile = relative(root, file).replaceAll("\\", "/");
    const content = readFileSync(file, "utf8");
    const allowLineBreaks = [".yml", ".yaml"].includes(extname(file));
    for (const entrypoint of collectScriptEntrypoints(content, { allowLineBreaks })) {
      const scriptPath = normalizeScriptPath(entrypoint);
      if (scriptPath === "scripts/") continue;
      const allowed = ALLOWED_SCRIPT_PREFIXES.some((prefix) => scriptPath.startsWith(prefix));
      const exists = existsSync(resolve(root, scriptPath));
      if (!allowed || !exists) {
        const entrypointIndex = content.indexOf(entrypoint);
        const lineNumber = content.slice(0, entrypointIndex).split("\n").length;
        errors.push(`${relFile}:${lineNumber}: stale script entrypoint \`${scriptPath}\``);
      }
    }
  }

  // Reverse check: flag runnable scripts that nothing references (dead scripts).
  const reverseCandidates = [];
  for (const dir of REVERSE_ENTRYPOINT_DIRS) {
    collectFiles(root, dir, reverseCandidates, REVERSE_ENTRYPOINT_EXTENSIONS);
  }
  const referenceFiles = [];
  for (const referenceRoot of REVERSE_REFERENCE_ROOTS) {
    collectFiles(root, referenceRoot, referenceFiles, REVERSE_REFERENCE_EXTENSIONS);
  }
  const referenceContents = referenceFiles
    .filter((file) => !isTestPath(relative(root, file).replaceAll("\\", "/")))
    .map((file) => ({ file, content: readFileSync(file, "utf8") }));

  for (const candidate of reverseCandidates) {
    const relPath = relative(root, candidate).replaceAll("\\", "/");
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

  return { errors, scannedFileCount: files.length };
}

export function runScriptEntrypointCheck({ root = process.cwd(), consoleImpl = console, exit = process.exit } = {}) {
  const { errors, scannedFileCount } = collectScriptEntrypointErrors({ root });
  if (errors.length > 0) {
    consoleImpl.error("Script entrypoint check failed:");
    for (const error of errors) {
      consoleImpl.error(`  ${error}`);
    }
    exit(1);
    return false;
  }
  consoleImpl.log(`Script entrypoint references passed for ${scannedFileCount} files.`);
  return true;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runScriptEntrypointCheck();
}
