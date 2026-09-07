/*
 * Routing schema design
 *
 * `docs/doc-ownership.json#mappings` is the only hand-maintained routing model.
 * Each mapping owns identity, risk, source globs, exact docs (optionally with a
 * heading anchor), focused checks, short hard rules, scoped context, and hints.
 * This module validates nothing policy-specific; it normalizes those records,
 * exposes their source globs through one matcher, and derives the family-shaped
 * projection used by the change contract. That keeps matching and output compatibility centralized
 * without reintroducing a second authored family inventory.
 *
 * Document references stay structured through the runtime boundary so text and
 * JSON formatters can render `path#anchor` while still exposing `{path, anchor}`.
 * Hints are deliberately separate from document slots. Exclusions are matched by
 * the same glob implementation and exist only for tracked implementation areas
 * that intentionally inherit a parent contract rather than owning documentation.
 */
import { readFileSync } from "node:fs";
import { dirname, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_OWNERSHIP_PATH = resolve(REPO_ROOT, "docs/doc-ownership.json");

export interface DocReference {
  anchor?: string;
  path: string;
}

type RawDocReference = string | DocReference;

interface RawMapping {
  alsoRead?: string[];
  background?: RawDocReference[];
  checks?: string[];
  docs: RawDocReference[];
  hints?: string[];
  id: string;
  label: string;
  risk: "low" | "medium" | "high";
  rules?: string[];
  sources: string[];
  tier?: "specific" | "fallback";
}

interface RawExclusion {
  reason: string;
  sources: string[];
}

export interface DocOwnershipRegistry {
  baseDocs?: string[];
  coreRules?: string[];
  exclusions?: RawExclusion[];
  mappings?: RawMapping[];
}

export interface PathFamily {
  background: DocReference[];
  checks: string[];
  docs: DocReference[];
  hardRules: string[];
  hints: string[];
  id: string;
  label: string;
  risk: "low" | "medium" | "high";
  scopedContext: string[];
  sourceGlobs: string[];
  tier: "specific" | "fallback";
}

export interface PathExclusion {
  reason: string;
  sourceGlobs: string[];
}

type OwnershipGlobMatcher = (file: string) => boolean;

const ownershipGlobMatchers = new Map<string, OwnershipGlobMatcher>();

function escapeRegexCharacter(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compileSimpleOwnershipGlob(pattern: string): RegExp | null {
  if (!/^[\w./*-]+$/.test(pattern) || pattern.includes("**/")) return null;

  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (index === 0 || pattern[index - 1] === "/") source += "(?!\\.)";
      if (pattern[index + 1] === "*") {
        source += "(?!.*\\/\\.)";
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- the source is built from a restricted glob alphabet
  return new RegExp(`${source}$`);
}

export function createOwnershipGlobMatcher(pattern: string): OwnershipGlobMatcher {
  const cached = ownershipGlobMatchers.get(pattern);
  if (cached) return cached;

  const compiled = compileSimpleOwnershipGlob(pattern);
  const matcher = compiled
    ? (file: string) => compiled.test(file)
    : (file: string) => matchesGlob(file, pattern);
  ownershipGlobMatchers.set(pattern, matcher);
  return matcher;
}

function readDocOwnership(path: string = DOC_OWNERSHIP_PATH): DocOwnershipRegistry {
  return JSON.parse(readFileSync(path, "utf8")) as DocOwnershipRegistry;
}

function normalizeDocReference(reference: RawDocReference): DocReference {
  return typeof reference === "string" ? { path: reference } : reference;
}

function normalizeMapping(mapping: RawMapping): PathFamily {
  const docs = mapping.docs.map(normalizeDocReference);
  return {
    background: (mapping.background ?? []).map(normalizeDocReference),
    checks: mapping.checks ?? [],
    docs,
    hardRules: mapping.rules ?? [],
    hints: mapping.hints ?? [],
    id: mapping.id,
    label: mapping.label,
    risk: mapping.risk,
    scopedContext: mapping.alsoRead ?? [],
    sourceGlobs: mapping.sources,
    tier: mapping.tier ?? "specific",
  };
}

export function matchesOwnershipGlob(file: string, pattern: string): boolean {
  return createOwnershipGlobMatcher(pattern)(file);
}

const registry = readDocOwnership();

export const DOC_OWNERSHIP_REGISTRY: DocOwnershipRegistry = registry;
export const DEFAULT_BASE_DOCS: string[] = registry.baseDocs ?? [];
export const CORE_RULES: string[] = registry.coreRules ?? [];
export const PATH_FAMILIES: PathFamily[] = (registry.mappings ?? []).map(normalizeMapping);
export const PATH_EXCLUSIONS: PathExclusion[] = (registry.exclusions ?? []).map((exclusion) => ({
  reason: exclusion.reason,
  sourceGlobs: exclusion.sources,
}));
