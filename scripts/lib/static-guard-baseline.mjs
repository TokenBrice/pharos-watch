import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const STATIC_GUARD_BASELINE_PATH = ".ci/static-guard-baselines.json";
export const STATIC_GUARD_IDS = [
  "g1-fail-open-reads",
  "g2-freshness-clock-hygiene",
  "g3-sql-d1-safety",
];

const ZERO_SHA_PATTERN = /^0+$/;
const cacheByPath = new Map();

function isJsonMap(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function emptyBaselineDocument() {
  return {
    schemaVersion: 1,
    guards: Object.fromEntries(STATIC_GUARD_IDS.map((id) => [id, {}])),
  };
}

export function normalizeBaselineFilePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function getStaticGuardBaselineDigest(cwd = process.cwd()) {
  const absolutePath = resolve(cwd, STATIC_GUARD_BASELINE_PATH);
  if (!existsSync(absolutePath)) return "missing";
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex").slice(0, 16);
}

export function hasStaticGuardBaselineEntry(filePath, cwd = process.cwd()) {
  const normalized = normalizeBaselineFilePath(filePath);
  const doc = loadStaticGuardBaselines(cwd, { required: false });
  return STATIC_GUARD_IDS.some((guardId) => Object.prototype.hasOwnProperty.call(doc.guards[guardId], normalized));
}

export function validateStaticGuardBaselineDocument(raw, label = STATIC_GUARD_BASELINE_PATH) {
  if (!isJsonMap(raw)) {
    throw new Error(`${label}: expected a JSON object`);
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`${label}: expected schemaVersion === 1`);
  }
  if (!isJsonMap(raw.guards)) {
    throw new Error(`${label}: expected guards object`);
  }
  const guardKeys = Object.keys(raw.guards);
  for (const key of guardKeys) {
    if (!STATIC_GUARD_IDS.includes(key)) {
      throw new Error(`${label}: unknown guard key "${key}"`);
    }
  }
  const guards = {};
  for (const guardId of STATIC_GUARD_IDS) {
    const guardEntries = raw.guards[guardId];
    if (!isJsonMap(guardEntries)) {
      throw new Error(`${label}: missing or invalid guards["${guardId}"] object`);
    }
    const normalizedGuard = {};
    for (const [rawFile, rules] of Object.entries(guardEntries)) {
      const file = normalizeBaselineFilePath(rawFile);
      if (!file || file.startsWith("/") || file.includes("..")) {
        throw new Error(`${label}: invalid repo-relative path "${rawFile}" under "${guardId}"`);
      }
      if (!isJsonMap(rules) || Object.keys(rules).length === 0) {
        throw new Error(`${label}: "${guardId}" -> "${file}" must map at least one rule to a positive integer`);
      }
      const normalizedRules = {};
      for (const [ruleId, count] of Object.entries(rules)) {
        if (!Number.isInteger(count) || count <= 0) {
          throw new Error(`${label}: "${guardId}" -> "${file}" -> "${ruleId}" must be a positive integer`);
        }
        normalizedRules[ruleId] = count;
      }
      normalizedGuard[file] = normalizedRules;
    }
    guards[guardId] = normalizedGuard;
  }
  return { schemaVersion: 1, guards };
}

export function loadStaticGuardBaselines(cwd = process.cwd(), { required = false } = {}) {
  const absolutePath = resolve(cwd, STATIC_GUARD_BASELINE_PATH);
  if (!existsSync(absolutePath)) {
    if (required) {
      throw new Error(`Missing required static guard baseline: ${STATIC_GUARD_BASELINE_PATH}`);
    }
    return emptyBaselineDocument();
  }
  const stats = statSync(absolutePath);
  const cached = cacheByPath.get(absolutePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.doc;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse ${STATIC_GUARD_BASELINE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const doc = validateStaticGuardBaselineDocument(parsed, STATIC_GUARD_BASELINE_PATH);
  cacheByPath.set(absolutePath, { mtimeMs: stats.mtimeMs, size: stats.size, doc });
  return doc;
}

export function getFileBaselineRules(guardId, relPath, cwd = process.cwd(), { required = false } = {}) {
  const doc = loadStaticGuardBaselines(cwd, { required });
  return doc.guards[guardId]?.[normalizeBaselineFilePath(relPath)] ?? {};
}

function isFileUnderRoots(file, normalizedRoots) {
  if (!normalizedRoots) return true;
  return normalizedRoots.some((root) => file === root || file.startsWith(`${root}/`));
}

export function applyGuardBaselineToViolations(
  guardId,
  violations,
  { cwd = process.cwd(), baseline, coveredRoots, checkStale = true, required = false } = {},
) {
  const baselineMap = baseline ?? loadStaticGuardBaselines(cwd, { required }).guards[guardId] ?? {};
  const grouped = new Map();
  for (const violation of violations) {
    const file = normalizeBaselineFilePath(violation.file);
    let byRule = grouped.get(file);
    if (!byRule) {
      byRule = new Map();
      grouped.set(file, byRule);
    }
    let list = byRule.get(violation.rule);
    if (!list) {
      list = [];
      byRule.set(violation.rule, list);
    }
    list.push(violation);
  }

  const remaining = [];
  for (const [file, byRule] of grouped) {
    const allowedByRule = baselineMap[file] ?? {};
    for (const [rule, list] of byRule) {
      const allowed = allowedByRule[rule] ?? 0;
      if (list.length > allowed) {
        remaining.push(...list.slice(allowed));
      }
    }
  }

  const stale = [];
  if (checkStale) {
    const normalizedRoots = coveredRoots
      ? coveredRoots.map((root) => normalizeBaselineFilePath(root).replace(/\/+$/, ""))
      : null;
    for (const [file, rules] of Object.entries(baselineMap)) {
      if (!isFileUnderRoots(file, normalizedRoots)) continue;
      const byRule = grouped.get(file);
      for (const [rule, allowed] of Object.entries(rules)) {
        const actual = byRule?.get(rule)?.length ?? 0;
        if (actual < allowed) {
          stale.push({
            file,
            line: 1,
            rule: "stale-baseline",
            text: `baseline allows ${allowed} ${rule} site(s) but ${actual} remain; shrink ${STATIC_GUARD_BASELINE_PATH} to ${actual}${actual === 0 ? " (or delete entry)" : ""}`,
          });
        }
      }
    }
  }

  return { violations: remaining, stale };
}

function defaultExecGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function compareBaselineRatchet(baseDoc, currentDoc) {
  const errors = [];
  for (const guardId of STATIC_GUARD_IDS) {
    const baseGuard = baseDoc.guards[guardId] ?? {};
    const currentGuard = currentDoc.guards[guardId] ?? {};
    for (const [file, rules] of Object.entries(currentGuard)) {
      const baseRules = baseGuard[file] ?? {};
      for (const [ruleId, count] of Object.entries(rules)) {
        const baseCount = baseRules[ruleId] ?? 0;
        if (count > baseCount) {
          errors.push(
            `${STATIC_GUARD_BASELINE_PATH}: [${guardId}] ${file} (${ruleId}) increased from ${baseCount} to ${count} — baseline is shrink-only; fix the site or add an inline // pharos-allow-*: <reason> comment instead of raising the baseline.`,
          );
        }
      }
    }
  }
  return errors;
}

export function verifyStaticGuardBaselineRatchet({
  cwd = process.cwd(),
  baseRef = process.env.PR_BASE_SHA,
  required = true,
  execGit = defaultExecGit,
} = {}) {
  const absolutePath = resolve(cwd, STATIC_GUARD_BASELINE_PATH);
  if (!existsSync(absolutePath)) {
    return required ? [`Missing required static guard baseline: ${STATIC_GUARD_BASELINE_PATH}`] : [];
  }
  let currentDoc;
  try {
    currentDoc = loadStaticGuardBaselines(cwd, { required: true });
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const errors = [];
  for (const guardId of STATIC_GUARD_IDS) {
    for (const file of Object.keys(currentDoc.guards[guardId])) {
      if (!existsSync(resolve(cwd, file))) {
        errors.push(
          `${STATIC_GUARD_BASELINE_PATH}: [${guardId}] references deleted or missing file "${file}"; remove its baseline entry.`,
        );
      }
    }
  }

  const trimmedBase = typeof baseRef === "string" ? baseRef.trim() : "";
  if (trimmedBase && !ZERO_SHA_PATTERN.test(trimmedBase)) {
    let baseHasFile = false;
    try {
      execGit(["cat-file", "-e", `${trimmedBase}:${STATIC_GUARD_BASELINE_PATH}`], cwd);
      baseHasFile = true;
    } catch {
      baseHasFile = false;
    }
    if (baseHasFile) {
      try {
        const rawBase = execGit(["show", `${trimmedBase}:${STATIC_GUARD_BASELINE_PATH}`], cwd);
        const baseDoc = validateStaticGuardBaselineDocument(
          JSON.parse(rawBase),
          `${trimmedBase}:${STATIC_GUARD_BASELINE_PATH}`,
        );
        errors.push(...compareBaselineRatchet(baseDoc, currentDoc));
      } catch (error) {
        errors.push(
          `Failed to validate base static guard baseline at ${trimmedBase}:${STATIC_GUARD_BASELINE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return errors;
}
