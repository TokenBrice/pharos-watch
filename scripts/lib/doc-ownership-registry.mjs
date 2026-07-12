import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_OWNERSHIP_PATH = resolve(REPO_ROOT, "docs/doc-ownership.json");

function readDocOwnership(path = DOC_OWNERSHIP_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compileRegex(pattern, flags = "i") {
  // eslint-disable-next-line security/detect-non-literal-regexp -- patterns come from the checked-in doc ownership registry.
  return new RegExp(pattern, flags);
}

function normalizeMatchers(family) {
  return {
    ...family,
    exactPaths: family.exactPaths ?? [],
    prefixes: family.prefixes ?? [],
    regexes: (family.regexes ?? []).map((pattern) => compileRegex(pattern)),
  };
}

const registry = readDocOwnership();

export const DOC_OWNERSHIP_REGISTRY = registry;
export const DEFAULT_BASE_DOCS = registry.baseDocs ?? [];
export const CORE_RULES = registry.coreRules ?? [];
export const PATH_FAMILIES = (registry.taskFamilies ?? []).map(normalizeMatchers);
