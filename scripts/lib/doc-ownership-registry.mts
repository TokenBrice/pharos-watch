/*
 * Routing schema design
 *
 * `docs/doc-ownership.json#mappings` is the only hand-maintained routing model.
 * Each mapping owns identity, risk, source globs, exact docs (optionally with a
 * heading anchor), focused checks, short hard rules, and scoped context.
 * This module validates nothing policy-specific; it normalizes those records,
 * exposes their source globs through one matcher, and derives the family-shaped
 * projection used by the change contract. That keeps matching and output compatibility centralized
 * without reintroducing a second authored family inventory.
 * Optional `testOwnership` declarations bind inspected source globs to invariant
 * tests that Vitest cannot discover through imports. PR selection consumes all
 * declarations independently of focused-check tier precedence.
 * Optional `reading` selectors replace default docs per matching input file;
 * contract refs augment local refs, while `required` refs bypass display caps.
 * Enumerate authored references before display normalization so coverage and
 * generators retain all modes and curated metadata.
 *
 * Document references stay structured through the runtime boundary so text and
 * JSON formatters can render `path#anchor` while still exposing `{path, anchor}`.
 * Optional `runbook` metadata on existing references curates navigation labels
 * and applicability; it is not part of runtime routing or rendered guidance.
 * Exclusions document implementation areas that intentionally inherit a parent
 * contract rather than owning documentation; runtime routing uses mappings only.
 */
import { readFileSync } from "node:fs";
import { dirname, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_OWNERSHIP_PATH = resolve(REPO_ROOT, "docs/doc-ownership.json");

export interface DocReference {
  anchor?: string;
  path: string;
  runbook?: {
    label: string;
    kind: "symptom" | "reference" | "procedure";
  };
}

type RawDocReference = string | DocReference;

export interface DeclaredTestOwnership {
  sources: string[];
  tests: string[];
}

export interface ReadingSelector {
  sources: string[];
  local?: DocReference[];
  contract?: DocReference[];
  required?: DocReference[];
}

interface RawMapping {
  alsoRead?: string[];
  background?: RawDocReference[];
  checks?: string[];
  docs: RawDocReference[];
  reading?: ReadingSelector[];
  required?: DocReference[];
  id: string;
  label: string;
  risk: "low" | "medium" | "high";
  rules?: string[];
  sources: string[];
  tier?: "specific" | "fallback";
  testOwnership?: DeclaredTestOwnership[];
}

export interface DocOwnershipRegistry {
  mappings?: RawMapping[];
}

export interface PathFamily {
  background: DocReference[];
  checks: string[];
  docs: DocReference[];
  reading?: ReadingSelector[];
  required?: DocReference[];
  hardRules: string[];
  id: string;
  label: string;
  risk: "low" | "medium" | "high";
  scopedContext: string[];
  sourceGlobs: string[];
  tier: "specific" | "fallback";
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

/** Enumerate authored references without stripping curated runbook metadata. */
export function enumerateDocReferences(
  mapping: {
    docs: RawDocReference[];
    background?: RawDocReference[];
    reading?: ReadingSelector[];
    required?: DocReference[];
  },
  { includeBackground = true }: { includeBackground?: boolean } = {},
): DocReference[] {
  return [
    ...mapping.docs,
    ...(mapping.required ?? []),
    ...(mapping.reading ?? []).flatMap((selector) => [
      ...(selector.local ?? []), ...(selector.contract ?? []), ...(selector.required ?? []),
    ]),
    ...(includeBackground ? mapping.background ?? [] : []),
  ].map((reference) => typeof reference === "string" ? { path: reference } : reference);
}

export function normalizeDocReference(reference: RawDocReference): DocReference {
  if (typeof reference === "string") return { path: reference };
  if (!reference.runbook) return reference;
  return reference.anchor ? { path: reference.path, anchor: reference.anchor } : { path: reference.path };
}

function normalizeMapping(mapping: RawMapping): PathFamily {
  return {
    background: enumerateDocReferences({ docs: mapping.background ?? [] }),
    checks: mapping.checks ?? [],
    docs: enumerateDocReferences({ docs: mapping.docs }),
    reading: mapping.reading,
    required: mapping.required,
    hardRules: mapping.rules ?? [],
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

export const PATH_FAMILIES: PathFamily[] = (registry.mappings ?? []).map(normalizeMapping);
export const DECLARED_TEST_OWNERSHIP: DeclaredTestOwnership[] = (registry.mappings ?? [])
  .flatMap((mapping) => mapping.testOwnership ?? []);
