#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { reportViolations } from "../lib/report-violations.mts";
import { collectSourceFilesUnderRoots } from "../lib/source-files.mts";
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
const NODE_FLAGS_WITH_VALUE = [
  "--conditions",
  "--env-file",
  "--eval",
  "--import",
  "--input-type",
  "--loader",
  "--print",
  "--require",
  "-C",
  "-e",
  "-p",
  "-r",
];
// Reverse mode: every runnable script in these directories must be *runnable*
// — referenced from package.json, a CI workflow, or another script. `docs/` is
// deliberately excluded: a documentation row describes a script, it does not
// keep it reachable, and doc mentions were what let a batch of never-executed
// checks survive as orphans.
const REVERSE_ENTRYPOINT_DIRS = ["scripts/maintenance", "scripts/ci", "scripts/build-data", ".github/scripts"];
const REVERSE_ENTRYPOINT_EXTENSIONS = new Set([".mjs", ".js", ".ts"]);
const REVERSE_REFERENCE_ROOTS = ["scripts", "package.json", ".github"];
const REVERSE_REFERENCE_EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".json", ".yml", ".yaml"]);


function isTestPath(path: string): boolean {
  return path.includes("__tests__") || /\.test\.[a-z]+$/.test(path);
}

function normalizeScriptPath(rawPath: string): string {
  return rawPath.replace(/[\\.,;:]+$/, "");
}

function isCommandBoundary(char: string): boolean {
  return char === "" || /\s/.test(char) || char === "`" || char === "'" || char === '"';
}

export function collectScriptEntrypoints(content: string, { allowLineBreaks = false }: { allowLineBreaks?: boolean } = {}): string[] {
  const entrypoints: string[] = [];

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

        let tokenEnd = pathStart;
        while (tokenEnd < content.length && !SCRIPT_PATH_TERMINATORS.has(content[tokenEnd] ?? "")) {
          tokenEnd += 1;
        }
        const token = content.slice(pathStart, tokenEnd);
        if (!/^--?\w/u.test(token)) break;

        pathStart = tokenEnd;
        if (!token.includes("=") && NODE_FLAGS_WITH_VALUE.includes(token)) {
          while (pathStart < content.length && /\s/.test(content[pathStart] ?? "")) pathStart += 1;
          while (pathStart < content.length && !SCRIPT_PATH_TERMINATORS.has(content[pathStart] ?? "")) {
            pathStart += 1;
          }
        }
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

  return [...new Set(entrypoints)];
}

export function collectScriptEntrypointErrors({ root = process.cwd() }: { root?: string } = {}): { errors: string[]; scannedFileCount: number } {
  const files = collectSourceFilesUnderRoots(SCAN_ROOTS, root, {
    extensions: SOURCE_EXTENSIONS,
    excludedDirs: SKIP_DIRS,
  });

  const errors: string[] = [];

  for (const relFile of files) {
    const content = readFileSync(resolve(root, relFile), "utf8");
    const allowLineBreaks = [".yml", ".yaml"].includes(extname(relFile));
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
  const reverseCandidates = collectSourceFilesUnderRoots(REVERSE_ENTRYPOINT_DIRS, root, {
    extensions: REVERSE_ENTRYPOINT_EXTENSIONS,
    excludedDirs: SKIP_DIRS,
  });
  const referenceFiles = collectSourceFilesUnderRoots(REVERSE_REFERENCE_ROOTS, root, {
    extensions: REVERSE_REFERENCE_EXTENSIONS,
    excludedDirs: SKIP_DIRS,
  });
  const referenceContents = referenceFiles
    .filter((file) => !isTestPath(file))
    .map((file) => ({ file, content: readFileSync(resolve(root, file), "utf8") }));

  for (const relPath of reverseCandidates) {
    if (isTestPath(relPath)) continue;
    const bare = relPath.replace(/\.(mjs|js|ts)$/, "");
    const referenced = referenceContents.some(
      ({ file, content }) => file !== relPath && (content.includes(relPath) || content.includes(bare)),
    );
    if (!referenced) {
      errors.push(`${relPath}: unreferenced script — wire it into package.json/CI or delete it`);
    }
  }

  return { errors, scannedFileCount: files.length };
}

export function runScriptEntrypointCheck({
  root = process.cwd(),
  exit = process.exit,
}: { root?: string; exit?: (code?: number) => never } = {}): boolean {
  const { errors, scannedFileCount } = collectScriptEntrypointErrors({ root });
  const status = reportViolations({
    label: "Script entrypoint references",
    heading: "Script entrypoint check failed",
    violations: errors,
    scannedCount: scannedFileCount,
  });
  if (status !== 0) {
    exit(1);
    return false;
  }
  return true;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runScriptEntrypointCheck();
}
