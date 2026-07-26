#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { collectSourceFiles } from "../lib/source-files.mjs";
import { splitLines } from "../lib/doc-files.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
const {
  getAllEnvBindingKeys,
  renderEnvExample,
  renderOperatorOriginAccessEnvBlock,
  renderWorkerInfrastructureEnvBlock,
} = await import("../../shared/lib/env-contract.ts");

const repoRoot = process.cwd();
const envExamplePath = resolve(repoRoot, ".env.example");
const workerEnvPath = resolve(repoRoot, "worker/src/lib/env.ts");
const wranglerConfigPath = resolve(repoRoot, "worker/wrangler.toml");

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

const WRANGLER_BINDING_SECTIONS = new Map([
  ["d1_databases", { property: "binding", type: "D1Database" }],
  ["r2_buckets", { property: "binding", type: "R2Bucket" }],
  ["version_metadata", { property: "binding", type: "WorkerVersionMetadata" }],
]);

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function collectFiles(rootDir) {
  // Explicit empty excludedDirs: this scan intentionally recurses into __tests__
  // (the shared default excludes it, which would change behavior here).
  return collectSourceFiles(rootDir, {
    extensions: SOURCE_SCAN_EXTENSIONS,
    excludedDirs: new Set(),
  });
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

export function extractExportedEnvInterfaceBody(source) {
  const match = /\bexport\s+interface\s+Env\s*\{/u.exec(source);
  if (!match) {
    return null;
  }

  let depth = 1;
  let cursor = match.index + match[0].length;
  const bodyStart = cursor;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart, cursor);
      }
    }
    cursor += 1;
  }

  return null;
}

export function parseWorkerEnvInterfaceKeys(filePath) {
  return new Set(parseWorkerEnvInterfaceBindings(filePath).keys());
}

export function parseWorkerEnvInterfaceBindings(filePath) {
  const source = readFileSync(filePath, "utf8");
  const body = extractExportedEnvInterfaceBody(source);
  if (!body) {
    throw new Error(`${relative(repoRoot, filePath)} is missing export interface Env`);
  }

  const bindings = new Map();
  let typeLiteralDepth = 0;
  for (const rawLine of splitLines(body)) {
    const line = rawLine.replace(/\/\/.*$/u, "").trim();
    const match = typeLiteralDepth === 0 ? /^([A-Z][A-Z0-9_]*|DB)(\?)?\s*:\s*([^;]+);?/u.exec(line) : null;
    if (match) {
      bindings.set(match[1], {
        optional: match[2] === "?",
        type: match[3].trim().replace(/\s+/gu, " "),
      });
    }
    for (const char of line) {
      if (char === "{") {
        typeLiteralDepth += 1;
      } else if (char === "}") {
        typeLiteralDepth = Math.max(0, typeLiteralDepth - 1);
      }
    }
  }

  return bindings;
}

function parseTomlSectionHeader(line) {
  const content = line.trim().split("#", 1)[0].trim();
  const isArraySection = content.startsWith("[[") && content.endsWith("]]");
  const isTableSection = !isArraySection && content.startsWith("[") && content.endsWith("]");
  if (!isArraySection && !isTableSection) {
    return null;
  }

  const name = isArraySection ? content.slice(2, -2) : content.slice(1, -1);
  if (!isTomlSectionName(name)) {
    return null;
  }
  return {
    label: isArraySection ? `[[${name}]]` : `[${name}]`,
    name,
  };
}

function isTomlSectionName(name) {
  if (name.length === 0) {
    return false;
  }
  for (const char of name) {
    const isLower = char >= "a" && char <= "z";
    const isUpper = char >= "A" && char <= "Z";
    const isDigit = char >= "0" && char <= "9";
    if (!isLower && !isUpper && !isDigit && char !== "_" && char !== "." && char !== "-") {
      return false;
    }
  }
  return true;
}

function parseTomlKey(line) {
  let cursor = 0;
  while (cursor < line.length && /\s/u.test(line[cursor])) {
    cursor += 1;
  }

  let key = "";
  while (cursor < line.length) {
    const char = line[cursor];
    const isLower = char >= "a" && char <= "z";
    const isUpper = char >= "A" && char <= "Z";
    const isDigit = char >= "0" && char <= "9";
    if (!isLower && !isUpper && !isDigit && char !== "_") {
      break;
    }
    key += char;
    cursor += 1;
  }
  if (key.length === 0) {
    return null;
  }

  while (cursor < line.length && /\s/u.test(line[cursor])) {
    cursor += 1;
  }
  return line[cursor] === "=" ? key : null;
}

function parseTomlStringValue(line, key) {
  if (parseTomlKey(line) !== key) {
    return null;
  }

  const equalsIndex = line.indexOf("=");
  if (equalsIndex < 0) {
    return null;
  }
  const value = line.slice(equalsIndex + 1).trimStart();
  const quote = value[0];
  if (quote !== "'" && quote !== "\"") {
    return null;
  }

  let parsed = "";
  for (let cursor = 1; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (char === quote) {
      return parsed;
    }
    if (quote === "\"" && char === "\\" && cursor + 1 < value.length) {
      cursor += 1;
      parsed += value[cursor];
      continue;
    }
    parsed += char;
  }
  return null;
}

function addWranglerBinding(bindings, duplicates, key, binding) {
  if (bindings.has(key)) {
    duplicates.add(key);
  }
  bindings.set(key, binding);
}

export function parseWranglerWorkerConfigBindings(source) {
  const bindings = new Map();
  const duplicates = new Set();
  const unsupported = [];
  let section = null;

  for (const rawLine of splitLines(source)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const nextSection = parseTomlSectionHeader(rawLine);
    if (nextSection) {
      section = nextSection;
      continue;
    }

    if (!section) {
      continue;
    }

    if (section.name === "vars") {
      const key = parseTomlKey(rawLine);
      if (key && isEnvKeyCandidate(key)) {
        addWranglerBinding(bindings, duplicates, key, {
          source: section.label,
          type: "string",
        });
      }
      continue;
    }

    const bindingSpec = WRANGLER_BINDING_SECTIONS.get(section.name);
    if (!bindingSpec) {
      continue;
    }

    const key = parseTomlStringValue(rawLine, bindingSpec.property);
    if (!key) {
      continue;
    }
    if (!isEnvKeyCandidate(key)) {
      unsupported.push({ key, source: section.label });
      continue;
    }
    addWranglerBinding(bindings, duplicates, key, {
      source: section.label,
      type: bindingSpec.type,
    });
  }

  return { bindings, duplicates, unsupported };
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

export function collectSourceEnvKeys(filePaths) {
  const keys = new Set();

  for (const filePath of filePaths) {
    const source = readFileSync(filePath, "utf8");
    addRegexMatches(keys, source, /process\.env\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /(?:^|[^A-Za-z0-9_])env\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /\b(?:secrets|vars)\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /\bread[A-Za-z0-9]*Env\(\s*"([A-Z][A-Z0-9_]+)"/g);
    addRegexMatches(keys, source, /\brequireEnv\(\s*"([A-Z][A-Z0-9_]+)"/g);
    addRegexMatches(keys, source, /\breadEnvFirst\(\s*"([A-Z][A-Z0-9_]+)"/g);
    for (const match of source.matchAll(/\breadEnvFirst\(\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    for (const match of source.matchAll(/\benvNames\s*:\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    for (const match of source.matchAll(/\bapiFetchHeaders\(\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    for (const match of source.matchAll(/\b[A-Z][A-Z0-9_]*_ENV_NAMES\s*=\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    addRegexMatches(keys, source, /\bapiKeyEnv\s*:\s*"([A-Z][A-Z0-9_]+)"/g);

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

export function runEnvContractCheck({ consoleImpl = console, exit = process.exit } = {}) {
  const envExample = parseEnvExampleKeys(envExamplePath);
  const manifestEnvKeys = new Set(getAllEnvBindingKeys());
  const workerEnvInterfaceBindings = parseWorkerEnvInterfaceBindings(workerEnvPath);
  const workerEnvInterfaceKeys = new Set(workerEnvInterfaceBindings.keys());
  const wranglerConfigBindings = parseWranglerWorkerConfigBindings(readFileSync(wranglerConfigPath, "utf8"));
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

  const workerEnvKeysMissingFromManifest = [...workerEnvInterfaceKeys]
    .filter((key) => !manifestEnvKeys.has(key))
    .sort();
  if (workerEnvKeysMissingFromManifest.length > 0) {
    errors.push(
      `worker/src/lib/env.ts Env declares keys missing from the shared env manifest: ${workerEnvKeysMissingFromManifest.join(", ")}`,
    );
  }

  if (wranglerConfigBindings.duplicates.size > 0) {
    errors.push(
      `worker/wrangler.toml declares duplicate Worker binding keys: ${[...wranglerConfigBindings.duplicates].sort().join(", ")}`,
    );
  }

  if (wranglerConfigBindings.unsupported.length > 0) {
    errors.push(
      `worker/wrangler.toml declares unsupported Worker binding keys: ${
        wranglerConfigBindings.unsupported
          .map((binding) => `${binding.key} (${binding.source})`)
          .sort()
          .join(", ")
      }`,
    );
  }

  const wranglerBindingsMissingFromEnv = [...wranglerConfigBindings.bindings]
    .filter(([key]) => !workerEnvInterfaceKeys.has(key))
    .map(([key, binding]) => `${key} (${binding.source})`)
    .sort();
  if (wranglerBindingsMissingFromEnv.length > 0) {
    errors.push(
      `worker/wrangler.toml declares bindings missing from worker/src/lib/env.ts Env: ${wranglerBindingsMissingFromEnv.join(", ")}`,
    );
  }

  const wranglerBindingTypeMismatches = [...wranglerConfigBindings.bindings]
    .filter(([key, binding]) => {
      const envBinding = workerEnvInterfaceBindings.get(key);
      return envBinding && envBinding.type !== binding.type;
    })
    .map(([key, binding]) => {
      const envBinding = workerEnvInterfaceBindings.get(key);
      return `${key} (${binding.source}) is ${binding.type}, Env declares ${envBinding.type}`;
    })
    .sort();
  if (wranglerBindingTypeMismatches.length > 0) {
    errors.push(
      `worker/wrangler.toml binding types drift from worker/src/lib/env.ts Env: ${wranglerBindingTypeMismatches.join("; ")}`,
    );
  }

  for (const [key, filePaths] of documentedEnvKeys) {
    if (knownEnvKeys.has(key)) continue;
    errors.push(`Verified env docs reference unknown env key ${key} in ${formatFileList(filePaths)}`);
  }

  if (errors.length > 0) {
    consoleImpl.error("Environment contract check failed:");
    for (const error of errors) {
      consoleImpl.error(`  ${error}`);
    }
    exit(1);
    return false;
  }

  consoleImpl.log(
    "Environment contract is in sync with Wrangler bindings, the shared manifest, generated docs blocks, and referenced env names.",
  );
  return true;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runEnvContractCheck();
}
