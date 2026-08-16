/* eslint-disable security/detect-non-literal-fs-filename -- reads the fixed checked-in registry, with path injection retained for isolated tests. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_OWNERSHIP_PATH = resolve(REPO_ROOT, "docs/doc-ownership.json");

interface RawTaskFamily {
  checks?: string[];
  docsLikelyRequired?: string[];
  docsToRead?: string[];
  exactPaths?: string[];
  hardRules?: string[];
  id: string;
  label: string;
  prefixes?: string[];
  regexes?: string[];
  risk: string;
}

interface DocOwnershipRegistry {
  baseDocs?: string[];
  coreRules?: string[];
  taskFamilies?: RawTaskFamily[];
}

export interface PathFamily {
  checks: string[];
  docsLikelyRequired: string[];
  docsToRead: string[];
  exactPaths: string[];
  hardRules: string[];
  id: string;
  label: string;
  prefixes: string[];
  regexes: RegExp[];
  risk: string;
}

function readDocOwnership(path: string = DOC_OWNERSHIP_PATH): DocOwnershipRegistry {
  return JSON.parse(readFileSync(path, "utf8")) as DocOwnershipRegistry;
}

function compileRegex(pattern: string, flags = "i"): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- patterns come from the checked-in doc ownership registry.
  return new RegExp(pattern, flags);
}

function normalizeMatchers(family: RawTaskFamily): PathFamily {
  return {
    ...family,
    checks: family.checks ?? [],
    docsLikelyRequired: family.docsLikelyRequired ?? [],
    docsToRead: family.docsToRead ?? [],
    exactPaths: family.exactPaths ?? [],
    hardRules: family.hardRules ?? [],
    prefixes: family.prefixes ?? [],
    regexes: (family.regexes ?? []).map((pattern) => compileRegex(pattern)),
  };
}

const registry = readDocOwnership();

export const DOC_OWNERSHIP_REGISTRY: DocOwnershipRegistry = registry;
export const DEFAULT_BASE_DOCS: string[] = registry.baseDocs ?? [];
export const CORE_RULES: string[] = registry.coreRules ?? [];
export const PATH_FAMILIES: PathFamily[] = (registry.taskFamilies ?? []).map(normalizeMatchers);
