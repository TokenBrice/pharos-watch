#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const envExamplePath = resolve(repoRoot, ".env.example");
const workerEnvPath = resolve(repoRoot, "worker/src/lib/env.ts");
const pagesOpsEnvPath = resolve(repoRoot, "functions/lib/ops-env.ts");
const pagesSiteDataEnvPath = resolve(repoRoot, "functions/lib/site-api-env.ts");

const DOC_SCAN_FILES = [
  resolve(repoRoot, "README.md"),
  resolve(repoRoot, "docs/deployment-process.md"),
  resolve(repoRoot, "docs/operator-origin-access.md"),
  resolve(repoRoot, "docs/scripts.md"),
];

const SOURCE_SCAN_ROOTS = [
  resolve(repoRoot, ".github/workflows"),
  resolve(repoRoot, "functions"),
  resolve(repoRoot, "scripts"),
  resolve(repoRoot, "src"),
  resolve(repoRoot, "worker"),
];

const SOURCE_SCAN_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
  ".sh",
]);

const EXTERNALLY_DECLARED_ENV_KEYS = new Set(["DB"]);
const DOC_NON_ENV_TOKENS = new Set([
  "WORKER_REQUIRED_ENV_KEYS",
  "WORKER_OPTIONAL_ENV_KEYS",
  "WORKER_RESERVED_ENV_KEYS",
  "WORKER_ACTIVE_ENV_KEYS",
  "PAGES_FUNCTIONS_REQUIRED_ENV_KEYS",
  "PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS",
  "PAGES_FUNCTIONS_RESERVED_ENV_KEYS",
  "PAGES_FUNCTIONS_ACTIVE_ENV_KEYS",
  "SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS",
  "SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS",
  "SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS",
]);

function splitLines(text) {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function collectFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
      continue;
    }
    if (entry.isFile() && SOURCE_SCAN_EXTENSIONS.has(extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function parseEnvExampleKeys(filePath) {
  const keys = new Set();
  const duplicates = new Set();

  for (const rawLine of splitLines(readFileSync(filePath, "utf8"))) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    if (!isEnvKeyCandidate(key)) continue;

    if (keys.has(key)) duplicates.add(key);
    keys.add(key);
  }

  return { keys, duplicates };
}

function parseTsStringArray(filePath, constName) {
  const source = readFileSync(filePath, "utf8");
  const marker = `export const ${constName} = [`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Could not locate ${constName} in ${filePath}`);
  }

  const arrayStart = start + marker.length;
  const arrayEnd = source.indexOf("] as const;", arrayStart);
  if (arrayEnd < 0) {
    throw new Error(`Could not find array terminator for ${constName} in ${filePath}`);
  }

  return extractDoubleQuotedStrings(source.slice(arrayStart, arrayEnd));
}

function extractDoubleQuotedStrings(source) {
  const values = [];
  let index = 0;

  while (index < source.length) {
    if (source[index] !== "\"") {
      index += 1;
      continue;
    }

    let value = "";
    let cursor = index + 1;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        if (cursor + 1 < source.length) {
          value += source[cursor + 1];
          cursor += 2;
          continue;
        }
        break;
      }
      if (char === "\"") {
        values.push(value);
        index = cursor + 1;
        value = "";
        break;
      }
      value += char;
      cursor += 1;
    }

    if (cursor >= source.length) {
      break;
    }
  }

  return values;
}

function addRegexMatches(set, source, pattern, captureIndex = 1) {
  for (const match of source.matchAll(pattern)) {
    const key = match[captureIndex];
    if (isEnvKeyCandidate(key)) {
      set.add(key);
    }
  }
}

function collectSourceEnvKeys(filePaths) {
  const keys = new Set();

  for (const filePath of filePaths) {
    const source = readFileSync(filePath, "utf8");
    addRegexMatches(keys, source, /process\.env\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /(?:^|[^A-Za-z0-9_])env\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /\b(?:secrets|vars)\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /\bread[A-Za-z0-9]*Env\(\s*"([A-Z][A-Z0-9_]+)"/g);

    if (extname(filePath) === ".sh") {
      for (const key of collectShellEnvKeys(source)) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function collectShellEnvKeys(source) {
  const keys = new Set();

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$") continue;

    let cursor = index + 1;
    if (source[cursor] === "{") {
      cursor += 1;
    }

    let key = "";
    while (cursor < source.length) {
      const char = source[cursor];
      const isUpper = char >= "A" && char <= "Z";
      const isDigit = char >= "0" && char <= "9";
      if (!isUpper && !isDigit && char !== "_") {
        break;
      }
      key += char;
      cursor += 1;
    }

    if (isEnvKeyCandidate(key)) {
      keys.add(key);
    }
  }

  return keys;
}

function extractInlineCodeTokens(line) {
  const tokens = [];
  let index = 0;

  while (index < line.length) {
    const start = line.indexOf("`", index);
    if (start < 0) break;
    const end = line.indexOf("`", start + 1);
    if (end < 0) break;

    const token = line.slice(start + 1, end).trim();
    if (token.length > 0) {
      tokens.push(token);
    }
    index = end + 1;
  }

  return tokens;
}

function isEnvKeyCandidate(token) {
  if (token !== "DB" && !token.includes("_")) return false;
  if (!/[A-Z]/.test(token[0])) return false;

  for (const char of token) {
    const isUpper = char >= "A" && char <= "Z";
    const isDigit = char >= "0" && char <= "9";
    if (!isUpper && !isDigit && char !== "_") {
      return false;
    }
  }

  return true;
}

function collectDocumentedEnvKeys(filePaths) {
  const seen = new Map();

  for (const filePath of filePaths) {
    let inFence = false;

    for (const line of splitLines(readFileSync(filePath, "utf8"))) {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      for (const token of extractInlineCodeTokens(line)) {
        if (!isEnvKeyCandidate(token) || DOC_NON_ENV_TOKENS.has(token)) {
          continue;
        }

        const files = seen.get(token) ?? new Set();
        files.add(filePath);
        seen.set(token, files);
      }
    }
  }

  return seen;
}

function formatFileList(filePaths) {
  return [...filePaths].map((filePath) => relative(repoRoot, filePath)).sort().join(", ");
}

const envExample = parseEnvExampleKeys(envExamplePath);
const runtimeContractKeys = new Set([
  ...parseTsStringArray(workerEnvPath, "WORKER_REQUIRED_ENV_KEYS"),
  ...parseTsStringArray(workerEnvPath, "WORKER_OPTIONAL_ENV_KEYS"),
  ...parseTsStringArray(workerEnvPath, "WORKER_RESERVED_ENV_KEYS"),
  ...parseTsStringArray(pagesOpsEnvPath, "PAGES_FUNCTIONS_REQUIRED_ENV_KEYS"),
  ...parseTsStringArray(pagesOpsEnvPath, "PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS"),
  ...parseTsStringArray(pagesOpsEnvPath, "PAGES_FUNCTIONS_RESERVED_ENV_KEYS"),
  ...parseTsStringArray(pagesSiteDataEnvPath, "SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS"),
  ...parseTsStringArray(pagesSiteDataEnvPath, "SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS"),
]);
const sourceEnvKeys = collectSourceEnvKeys(SOURCE_SCAN_ROOTS.flatMap(collectFiles));
const documentedEnvKeys = collectDocumentedEnvKeys(DOC_SCAN_FILES);
const knownEnvKeys = new Set([
  ...envExample.keys,
  ...runtimeContractKeys,
  ...sourceEnvKeys,
]);

const errors = [];

if (envExample.duplicates.size > 0) {
  errors.push(`.env.example defines duplicate keys: ${[...envExample.duplicates].sort().join(", ")}`);
}

for (const key of [...runtimeContractKeys].sort()) {
  if (EXTERNALLY_DECLARED_ENV_KEYS.has(key) || envExample.keys.has(key)) continue;
  errors.push(`.env.example is missing runtime contract key ${key}`);
}

for (const [key, filePaths] of documentedEnvKeys) {
  if (EXTERNALLY_DECLARED_ENV_KEYS.has(key) || knownEnvKeys.has(key)) continue;
  errors.push(`Verified env docs reference unknown env key ${key} in ${formatFileList(filePaths)}`);
}

if (errors.length > 0) {
  console.error("Environment contract check failed:");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log(
  `Environment contract passed (${envExample.keys.size} .env.example keys, ${runtimeContractKeys.size} runtime contract keys, ${sourceEnvKeys.size} source-tracked keys).`,
);
