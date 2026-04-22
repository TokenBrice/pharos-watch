#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
const {
  getAllEnvBindingKeys,
  renderEnvExample,
  renderOperatorOriginAccessEnvBlock,
  renderWorkerInfrastructureEnvBlock,
} = await import("../shared/lib/env-contract.ts");

const repoRoot = process.cwd();
const envExamplePath = resolve(repoRoot, ".env.example");

const DOC_SCAN_FILES = [
  resolve(repoRoot, "README.md"),
  resolve(repoRoot, "docs/deployment-process.md"),
  resolve(repoRoot, "docs/operator-origin-access.md"),
  resolve(repoRoot, "docs/scripts.md"),
];

const GENERATED_DOC_BLOCKS = [
  {
    filePath: resolve(repoRoot, "docs/operator-origin-access.md"),
    marker: "ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS",
    render: renderOperatorOriginAccessEnvBlock,
  },
  {
    filePath: resolve(repoRoot, "docs/worker-infrastructure.md"),
    marker: "ENV-CONTRACT:WORKER-INFRASTRUCTURE",
    render: renderWorkerInfrastructureEnvBlock,
  },
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
  "ENV_BINDINGS",
]);

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function splitLines(text) {
  return normalizeText(text).split("\n");
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

  return { duplicates, keys };
}

function addRegexMatches(set, source, pattern, captureIndex = 1) {
  for (const match of source.matchAll(pattern)) {
    const key = match[captureIndex];
    if (isEnvKeyCandidate(key)) {
      set.add(key);
    }
  }
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

function findFirstDifferenceLine(expected, actual) {
  const expectedLines = splitLines(expected);
  const actualLines = splitLines(actual);
  const maxLines = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < maxLines; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        actual: actualLines[index] ?? "<missing>",
        expected: expectedLines[index] ?? "<missing>",
        line: index + 1,
      };
    }
  }

  return null;
}

function buildGeneratedBlock(marker, content) {
  return `<!-- ${marker}:BEGIN -->\n${content}\n<!-- ${marker}:END -->`;
}

function assertFileMatchesExpected(filePath, expected, errors) {
  const actual = normalizeText(readFileSync(filePath, "utf8"));
  if (actual === expected) {
    return;
  }

  const diff = findFirstDifferenceLine(expected, actual);
  if (!diff) {
    errors.push(`${relative(repoRoot, filePath)} does not match the manifest-derived output.`);
    return;
  }

  errors.push(
    `${relative(repoRoot, filePath)} drifts from the manifest-derived output at line ${diff.line}: expected ${JSON.stringify(diff.expected)} but found ${JSON.stringify(diff.actual)}`,
  );
}

function assertGeneratedBlockMatches(filePath, marker, expectedContent, errors) {
  const source = normalizeText(readFileSync(filePath, "utf8"));
  const startMarker = `<!-- ${marker}:BEGIN -->`;
  const endMarker = `<!-- ${marker}:END -->`;
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    errors.push(`${relative(repoRoot, filePath)} is missing the generated block markers for ${marker}.`);
    return;
  }

  const actualBlock = source.slice(startIndex, endIndex + endMarker.length);
  const expectedBlock = buildGeneratedBlock(marker, expectedContent);
  if (actualBlock === expectedBlock) {
    return;
  }

  const diff = findFirstDifferenceLine(expectedBlock, actualBlock);
  if (!diff) {
    errors.push(`${relative(repoRoot, filePath)} has a stale generated block for ${marker}.`);
    return;
  }

  errors.push(
    `${relative(repoRoot, filePath)} has a stale generated block for ${marker} at line ${diff.line}: expected ${JSON.stringify(diff.expected)} but found ${JSON.stringify(diff.actual)}`,
  );
}

const envExample = parseEnvExampleKeys(envExamplePath);
const manifestEnvKeys = new Set(getAllEnvBindingKeys());
const sourceEnvKeys = collectSourceEnvKeys(SOURCE_SCAN_ROOTS.flatMap(collectFiles));
const documentedEnvKeys = collectDocumentedEnvKeys(DOC_SCAN_FILES);
const knownEnvKeys = new Set([
  ...manifestEnvKeys,
  ...sourceEnvKeys,
]);

const errors = [];

if (envExample.duplicates.size > 0) {
  errors.push(`.env.example defines duplicate keys: ${[...envExample.duplicates].sort().join(", ")}`);
}

assertFileMatchesExpected(envExamplePath, renderEnvExample(), errors);

for (const block of GENERATED_DOC_BLOCKS) {
  assertGeneratedBlockMatches(block.filePath, block.marker, block.render(), errors);
}

for (const [key, filePaths] of documentedEnvKeys) {
  if (knownEnvKeys.has(key)) continue;
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
  "Environment contract is in sync with the shared manifest, generated docs blocks, and referenced env names.",
);
