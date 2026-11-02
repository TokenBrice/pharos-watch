/**
 * Static import-graph planner for the PR test lane.
 *
 * Answers the same question as `vitest list --changed <base> --filesOnly`
 * without booting Vite: a test is selected when a changed file is the test
 * itself or lies in its transitive import closure. Resolution mirrors
 * `vitest.config.ts` aliases (including the `?raw` worker-full catalog entry),
 * `tsconfig.json` paths, `package.json#imports` and workspace exports.
 * Type-only imports and `vi.mock(...)` specifiers are not runtime edges;
 * `export ... from` re-exports are.
 *
 * Fail closed: a changed toolchain input (package manifest, Vitest/TypeScript
 * config or the Vitest setup/globalSetup tree) selects the whole executable
 * test universe, and any local specifier this resolver cannot place reports a
 * fallback reason so the caller can run the authoritative `vitest list`
 * selection instead. Nothing is cached on disk.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";

import { hasOnlyInternalDocsImpact } from "./deploy-impact.mts";
import { EXECUTABLE_TEST_PROJECTS, normalizeOwnershipPath } from "./critical-ownership.mts";
import { compileGlobMatcher } from "./glob-matcher.mts";
import { isNightlyTestFile } from "./nightly-test-tier.mts";
import { resolveLocalPackageImport } from "./package-imports.mts";
import { collectSourceFilesUnderRoots } from "./source-files.mts";
import { VITEST_SETUP_FILES } from "./vitest-setup-files.mts";

export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Vitest's `resolve.extensions` order: the first existing candidate wins. */
const MODULE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"] as const;
const PARSE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const TEST_SCAN_ROOTS = ["src", "shared", "worker", "functions", "scripts"] as const;
const TEST_FILE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

/**
 * `vitest.config.ts` aliases, most specific first, plus the `tsconfig.json`
 * path prefixes. `vitest.config.ts`, `tsconfig*.json` and `package*.json` are
 * force-rerun inputs below, so an alias change at any of those sources cannot
 * silently narrow this table.
 */
const LOCAL_ALIASES: readonly (readonly [string, string])[] = [
  ["@shared/data/stablecoins/coins.worker-full.generated.json", "shared/data/stablecoins/coins.worker-full.generated.json"],
  ["@", "src"],
  ["@shared", "shared"],
  ["@data", "data"],
  ["satori/standalone", "worker/src/__mocks__/satori-stub.ts"],
  ["satori/yoga.wasm", "worker/src/__mocks__/wasm-module-stub.ts"],
  ["@cf-wasm/resvg/workerd", "worker/src/__mocks__/resvg-stub.ts"],
  ["@resvg/resvg-wasm", "worker/src/__mocks__/resvg-stub.ts"],
];

/** Repository-root specifiers some suites use in place of the aliases. */
const ROOT_SPECIFIER_PREFIXES = ["src/", "shared/", "worker/", "functions/", "scripts/", "data/", "public/", ".codex/"] as const;

/**
 * Selection logic itself is a toolchain input: changing the planner must not
 * narrow the planner. `docs/doc-ownership.json` supplies declared ownership.
 */
const PLANNER_SOURCE_FILES = [
  "scripts/lib/pr-import-graph.mts",
  "scripts/lib/pr-test-selection.mts",
  "scripts/lib/pr-test-plan.mts",
  "scripts/lib/glob-matcher.mts",
  "scripts/lib/vitest-setup-files.mts",
  "scripts/maintenance/run-pr-tests.ts",
  "scripts/lib/critical-ownership.mts",
  "scripts/lib/critical-test-files.mts",
  "scripts/lib/doc-ownership-registry.mts",
  // The nightly-tier vocabulary decides what the planner may select.
  "scripts/lib/nightly-test-tier.mts",
  "docs/doc-ownership.json",
] as const;

/**
 * Vitest `setupFiles`/`globalSetup` (one constant consumed by
 * `vitest.config.ts`) and planner sources force a full run.
 */
const FORCE_RERUN_FILES = new Set<string>([...VITEST_SETUP_FILES, ...PLANNER_SOURCE_FILES]);
const FORCE_RERUN_PREFIXES = ["scripts/test/"] as const;
const FORCE_RERUN_PATTERNS = [
  /(^|\/)package(?:-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(?:vitest|vite)\.config\.[cm]?[jt]s$/,
] as const;
/** Config and setup files whose import closure is a toolchain input. */
const TOOLCHAIN_ROOTS = ["vitest.config.ts", ...VITEST_SETUP_FILES] as const;

/** Directories never scanned while expanding import.meta.glob patterns. */
const PATTERN_SCAN_EXCLUDED_DIRS = new Set([
  "node_modules", "dist", ".git", ".next", "out", "coverage", ".cache", "agents", ".worktrees", "worktrees",
]);

/**
 * Stablecoin catalog data routing (C8). A PR that only edits these JSON data
 * files selects the catalog/registry contract owners instead of the JSON's
 * transitive closure; code, docs and other data families keep the closure.
 */
export const STABLECOIN_CATALOG_DATA_PREFIX = "shared/data/stablecoins/";
const CATALOG_DATA_EXTENSIONS = new Set([".json", ".ndjson", ".csv"]);
export const STABLECOIN_CATALOG_ENTRY_MODULES = [
  "shared/lib/stablecoins/registry.ts",
  "shared/lib/stablecoins/full-catalog.ts",
  "scripts/lib/stablecoin-catalog-sources.ts",
] as const;

export interface PrImportGraphFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  statSync(path: string): { isFile(): boolean };
  realpathSync?(path: string): string;
  readdirSync?(path: string, options: { withFileTypes: true }): Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
}

export interface PrImportGraph {
  cwd: string;
  /** Every executable test file in the Vitest universe (repo-relative). */
  testFiles: string[];
  testFileSet: ReadonlySet<string>;
  /** Direct local imports per parsed module. */
  dependencies: ReadonlyMap<string, readonly string[]>;
  /** Direct local importers per module, test files included. */
  importers: ReadonlyMap<string, readonly string[]>;
  /** Toolchain inputs (Vitest config closure, setup files): any change reruns everything. */
  forceRerunFiles: ReadonlySet<string>;
  /** Local specifiers that could not be placed; non-empty means "fall back". */
  unresolved: string[];
}

export interface BuildPrImportGraphOptions {
  cwd?: string;
  fs?: PrImportGraphFs;
  /** Override the executable test universe (fixtures); defaults to the checkout scan. */
  testFiles?: readonly string[];
}

const defaultFs: PrImportGraphFs = { existsSync, readFileSync, readdirSync, realpathSync, statSync };

export function isStablecoinCatalogDataFile(file: string): boolean {
  const normalized = normalizeOwnershipPath(file);
  return normalized.startsWith(STABLECOIN_CATALOG_DATA_PREFIX)
    && CATALOG_DATA_EXTENSIONS.has(extname(normalized).toLowerCase());
}

/** True when every changed file is non-code stablecoin catalog data. */
export function isStablecoinCatalogDataOnly(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(isStablecoinCatalogDataFile);
}

export function isForceRerunInput(file: string): boolean {
  const normalized = normalizeOwnershipPath(file);
  if (FORCE_RERUN_FILES.has(normalized)) return true;
  if (FORCE_RERUN_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return FORCE_RERUN_PATTERNS.some((pattern) => pattern.test(normalized));
}

const EXECUTABLE_TEST_MATCHERS = EXECUTABLE_TEST_PROJECTS.map((project) => ({
  name: project.name,
  include: project.include.map(compileGlobMatcher),
  exclude: project.exclude.map(compileGlobMatcher),
}));

/**
 * Every test-shaped file under the roots the executable projects scan: the
 * candidate set `EXECUTABLE_TEST_PROJECTS` partitions. Exported so the owning
 * test can compare the compiled matchers with `path.matchesGlob` over the real
 * tree instead of the already-filtered universe.
 */
export function collectExecutableTestCandidates(cwd = process.cwd()): string[] {
  return collectSourceFilesUnderRoots(TEST_SCAN_ROOTS, cwd, {
    extensions: TEST_FILE_EXTENSIONS,
    excludedDirs: ["node_modules", "dist"],
    skipDotEntries: true,
  }).filter((file) => TEST_FILE_PATTERN.test(file));
}

/**
 * Enumerate Vitest's executable test universe: the `EXECUTABLE_TEST_PROJECTS`
 * include/exclude sets, restricted to the roots those projects scan. The
 * patterns are compiled once at module load, not per candidate file.
 *
 * Nightly-tier files (`*.nightly.test.ts`, `scripts/lib/nightly-test-tier.mts`)
 * stay in the execution projects, so `npm test` and the nightly shards run
 * them, but they are never part of the universe this planner can select.
 */
export function collectExecutableTestFiles(cwd = process.cwd()): string[] {
  return collectExecutableTestCandidates(cwd)
    .filter((file) => EXECUTABLE_TEST_MATCHERS.some((project) =>
      project.include.some((matcher) => matcher(file))
      && !project.exclude.some((matcher) => matcher(file))))
    .filter((file) => !isNightlyTestFile(file))
    .sort();
}

interface TokenSpecifiers {
  specifiers: string[];
  /** Template-literal imports and `import.meta.glob` patterns, resolved separately. */
  patterns: ModulePattern[];
  /** Set when EOF arrives inside a literal, hiding any later imports. */
  unterminated?: string;
}

export interface ModulePattern {
  kind: "template" | "glob";
  /** Template body (with `${...}` placeholders) or glob pattern text. */
  value: string;
}

const IDENTIFIER_CHAR = new Uint8Array(128);
const IDENTIFIER_START = new Uint8Array(128);
for (let code = 0; code < 128; code++) {
  const character = String.fromCharCode(code);
  IDENTIFIER_CHAR[code] = /[\w$]/.test(character) ? 1 : 0;
  IDENTIFIER_START[code] = /[A-Za-z_$]/.test(character) ? 1 : 0;
}
/** Tokens after which a `/` opens a regular expression rather than division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await", "case", "default", "delete", "do", "else", "in", "instanceof", "new",
  "of", "return", "throw", "typeof", "void", "yield",
]);

function isIdentifierCode(code: number, start = false): boolean {
  if (code >= 128) return false;
  return (start ? IDENTIFIER_START : IDENTIFIER_CHAR)[code] === 1;
}

/** Skip a quoted string at `index` (the opening quote) without crossing an unescaped newline. */
function scanQuotedString(source: string, index: number): number {
  const quote = source.charCodeAt(index);
  index++;
  while (index < source.length) {
    const current = source.charCodeAt(index);
    if (current === quote) return index + 1;
    if (current === 10) return index;
    if (current === 92) index++;
    index++;
  }
  return index;
}

/** Skip a regular-expression literal at `index` (the opening slash). */
function scanRegexLiteral(source: string, index: number): number {
  index++;
  let inCharacterClass = false;
  while (index < source.length) {
    const current = source[index];
    if (current === "\\") { index += 2; continue; }
    if (current === "\n") return index;
    if (current === "[") inCharacterClass = true;
    else if (current === "]") inCharacterClass = false;
    else if (current === "/" && !inCharacterClass) {
      index++;
      while (index < source.length && isIdentifierCode(source.charCodeAt(index))) index++;
      return index;
    }
    index++;
  }
  return index;
}

/**
 * Skip `${ ... }` in a template literal, including nested strings, templates,
 * regular expressions and braces, so a nested template (`` `${sqlString(`…`)}` ``)
 * or a regex quantifier cannot end the outer literal early.
 */
function scanTemplateExpression(source: string, index: number): number {
  let depth = 1;
  let allowRegex = true;
  while (index < source.length) {
    const current = source[index];
    if (current === " " || current === "\t" || current === "\n" || current === "\r") { index++; continue; }
    if (current === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (current === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (current === "/" && allowRegex) {
      index = scanRegexLiteral(source, index);
      allowRegex = false;
      continue;
    }
    if (current === "'" || current === "\"") { index = scanQuotedString(source, index); allowRegex = false; continue; }
    if (current === "`") { index = scanTemplateLiteral(source, index).end; allowRegex = false; continue; }
    if (isIdentifierCode(source.charCodeAt(index), true)) {
      const start = index;
      index++;
      while (index < source.length && isIdentifierCode(source.charCodeAt(index))) index++;
      allowRegex = REGEX_PRECEDING_KEYWORDS.has(source.slice(start, index));
      continue;
    }
    if (current === "{") { depth++; index++; allowRegex = true; continue; }
    if (current === "}") {
      depth--;
      index++;
      if (depth === 0) return index;
      allowRegex = false;
      continue;
    }
    // `!` is a prefix operator only when nothing loadable precedes it; after
    // an identifier it is a non-null assertion, so the next `/` divides.
    allowRegex = current === "!" ? false : /[[({,;:=&|?+\-*%<>~^]/.test(current);
    index++;
  }
  return index;
}

/** Skip a template literal at `index` (the opening backtick). */
function scanTemplateLiteral(source: string, index: number): { end: number; closed: boolean } {
  index++;
  while (index < source.length) {
    const current = source[index];
    if (current === "\\") { index += 2; continue; }
    if (current === "`") return { end: index + 1, closed: true };
    if (current === "$" && source[index + 1] === "{") {
      index = scanTemplateExpression(source, index + 2);
      continue;
    }
    index++;
  }
  return { end: index, closed: false };
}

/**
 * Split source into lexical tokens: comments and regular-expression literals
 * are consumed whole, string literals stop at an unescaped newline (so JSX
 * text such as `Don't` cannot swallow later declarations), and every other
 * non-space character is a token. Dependency-free so planning has no parse
 * cost beyond the source scan.
 */
function tokenizeSource(source: string): { tokens: string[]; unterminated?: string } {
  const tokens: string[] = [];
  const length = source.length;
  let index = 0;
  let allowRegex = true;
  let unterminated: string | undefined;
  while (index < length) {
    const code = source.charCodeAt(index);
    const next = source.charCodeAt(index + 1);
    if (code === 32 || code === 10 || code === 9 || code === 13) {
      index++;
      continue;
    }
    if (code === 47 /* / */ && next === 47) {
      while (index < length && source.charCodeAt(index) !== 10) index++;
      continue;
    }
    if (code === 47 && next === 42 /* * */) {
      index += 2;
      while (index < length && !(source.charCodeAt(index) === 42 && source.charCodeAt(index + 1) === 47)) index++;
      index += 2;
      continue;
    }
    if (code === 47 && allowRegex) {
      index++;
      let inCharacterClass = false;
      let closed = false;
      while (index < length) {
        const current = source.charCodeAt(index);
        if (current === 92 /* \ */) { index += 2; continue; }
        if (current === 10) break;
        if (current === 91 /* [ */) inCharacterClass = true;
        else if (current === 93 /* ] */) inCharacterClass = false;
        else if (current === 47 && !inCharacterClass) { index++; closed = true; break; }
        index++;
      }
      if (!closed && index >= length) unterminated ??= "unterminated regular expression";
      while (index < length && isIdentifierCode(source.charCodeAt(index))) index++;
      tokens.push("/regex/");
      allowRegex = false;
      continue;
    }
    if (code === 34 /* " */ || code === 39 /* ' */) {
      const start = index;
      let closed = false;
      index++;
      while (index < length) {
        const current = source.charCodeAt(index);
        if (current === code) { closed = true; index++; break; }
        // An unescaped newline ends the token so JSX text such as `Don't`
        // cannot swallow later declarations; only EOF is a hidden import risk.
        if (current === 10) break;
        if (current === 92) index++;
        index++;
      }
      if (!closed && index >= length) unterminated ??= "unterminated string literal";
      tokens.push(source.slice(start, index));
      allowRegex = false;
      continue;
    }
    if (code === 96 /* ` */) {
      const start = index;
      const scanned = scanTemplateLiteral(source, index);
      index = scanned.end;
      if (!scanned.closed) unterminated ??= "unterminated template literal";
      tokens.push(source.slice(start, index));
      allowRegex = false;
      continue;
    }
    if (isIdentifierCode(code, true)) {
      const start = index;
      index++;
      while (index < length && isIdentifierCode(source.charCodeAt(index))) index++;
      const word = source.slice(start, index);
      tokens.push(word);
      allowRegex = REGEX_PRECEDING_KEYWORDS.has(word);
      continue;
    }
    tokens.push(source[index]);
    if (code === 33 /* ! */) {
      // A non-null assertion after an operand is not a prefix negation, so a
      // following `/` divides instead of opening a regex that hides imports.
      const previous = tokens[tokens.length - 2] ?? "";
      allowRegex = !(/[\w$)\]]$/.test(previous));
    } else {
      allowRegex = !(code === 41 /* ) */ || code === 93 /* ] */ || code === 125 /* } */ || isIdentifierCode(code));
    }
    index++;
  }
  return { tokens, ...(unterminated ? { unterminated } : {}) };
}

/**
 * Read `import`, literal `import(...)` and `export ... from` declarations.
 * Type-only imports (`import type`, all-`type` bindings) are erased before the
 * runtime module graph exists, so they are not edges; `vi.mock(...)` is not an
 * import declaration and is not an edge either.
 */
export function collectModuleSpecifiers(source: string): TokenSpecifiers {
  const { tokens, unterminated } = tokenizeSource(source);
  const specifiers = new Set<string>();
  const patterns: ModulePattern[] = [];
  const quoted = (token: string | undefined): token is string => token !== undefined && /^["']/.test(token);
  const templated = (token: string | undefined): token is string => token !== undefined && token.startsWith("`") && token.endsWith("`");
  // A few suites escape the leading `@` of a specifier (`"\@shared/..."`); the
  // string value is the unescaped text, so decode the same way.
  const push = (token: string) => { specifiers.add(token.slice(1, -1).replaceAll(/\\(.)/g, "$1")); };
  const templateBody = (token: string) => token.slice(1, -1).replaceAll(/\\(.)/g, "$1");
  const pushTemplate = (token: string) => {
    const body = templateBody(token);
    if (body.includes("${")) patterns.push({ kind: "template", value: body });
    else specifiers.add(body);
  };
  const allTypeBindings = (open: number): boolean => {
    const end = tokens.indexOf("}", open + 1);
    const bindings = tokens.slice(open + 1, end).join(" ").split(",").map((binding) => binding.trim()).filter(Boolean);
    return end >= 0 && bindings.length > 0 && bindings.every((binding) => /^type\s+\w/.test(binding));
  };
  const declarationSource = (start: number): void => {
    for (let cursor = start + 1; cursor < tokens.length && tokens[cursor] !== ";"; cursor++) {
      if (tokens[cursor] === "from" && quoted(tokens[cursor + 1])) {
        push(tokens[cursor + 1]);
        return;
      }
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // eslint-disable-next-line security/detect-possible-timing-attacks -- lexical token comparison, never a secret
    if (token === "import") {
      // `import.meta.glob("…")` / `import.meta.glob(["…"])`: every pattern is
      // an edge to the files it matches, even when no test imports them.
      if (tokens[index + 1] === "." && tokens[index + 2] === "meta" && tokens[index + 3] === "."
        && /^glob(?:Eager)?$/.test(tokens[index + 4] ?? "") && tokens[index + 5] === "(") {
        for (let cursor = index + 6; cursor < tokens.length && tokens[cursor] !== ")"; cursor++) {
          if (quoted(tokens[cursor])) patterns.push({ kind: "glob", value: tokens[cursor].slice(1, -1).replaceAll(/\\(.)/g, "$1") });
          else if (templated(tokens[cursor])) patterns.push({ kind: "glob", value: templateBody(tokens[cursor]) });
        }
        continue;
      }
      if (tokens[index - 1] === ".") continue;
      if (tokens[index + 1] === "type" && tokens[index + 2] !== "from") continue;
      if (tokens[index + 1] === "{" && allTypeBindings(index + 1)) continue;
      if (tokens[index + 1] === "(") {
        if (quoted(tokens[index + 2]) && [")", ","].includes(tokens[index + 3])) push(tokens[index + 2]);
        else if (templated(tokens[index + 2]) && [")", ","].includes(tokens[index + 3])) pushTemplate(tokens[index + 2]);
      } else if (quoted(tokens[index + 1])) push(tokens[index + 1]);
      else if (templated(tokens[index + 1])) pushTemplate(tokens[index + 1]);
      else declarationSource(index);
      continue;
    }
    // eslint-disable-next-line security/detect-possible-timing-attacks -- lexical token comparison, never a secret
    if (token === "export") {
      if (tokens[index + 1] === "type" && tokens[index + 2] !== "{") continue;
      if (tokens[index + 1] === "{") {
        if (allTypeBindings(index + 1)) continue;
        declarationSource(index);
      } else if (tokens[index + 1] === "*") declarationSource(index);
    }
  }
  return { specifiers: [...specifiers], patterns, ...(unterminated ? { unterminated } : {}) };
}

function stripQuery(specifier: string): string {
  const query = specifier.indexOf("?");
  const hash = specifier.indexOf("#");
  const cutoff = [query, hash].filter((index) => index > 0).sort((left, right) => left - right)[0];
  return cutoff === undefined ? specifier : specifier.slice(0, cutoff);
}

type Resolution = { kind: "external" } | { kind: "unresolved"; reason: string } | { kind: "file"; file: string };

const installedPackageCache = new WeakMap<PrImportGraphFs, Map<string, boolean>>();

/**
 * A bare or `@scope/name` specifier is external only when Node can actually
 * load it: an installed manifest must exist from the importer upwards. An
 * unknown alias or a package that is merely expected to exist is unresolved so
 * the caller falls back to `vitest list`.
 */
function isInstalledPackage(specifier: string, importer: string, cwd: string, fs: PrImportGraphFs): boolean {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name) return false;
  let cache = installedPackageCache.get(fs);
  if (!cache) installedPackageCache.set(fs, cache = new Map());
  const key = `${cwd}\0${dirname(importer)}\0${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const root = resolve(cwd);
  let directory = resolve(cwd, dirname(importer));
  let installed = false;
  while (true) {
    if (fs.existsSync(join(directory, "node_modules", name, "package.json"))) {
      installed = true;
      break;
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory || !directory.startsWith(`${root}/`)) break;
    directory = parent;
  }
  cache.set(key, installed);
  return installed;
}

/**
 * Resolve one specifier exactly like the Vitest runtime, or say why it cannot.
 * `#`-prefixed specifiers keep their leading hash (package imports), so only a
 * later `#` is treated as a URL fragment.
 */
export function resolveModuleSpecifier(
  rawSpecifier: string,
  importer: string,
  { cwd = process.cwd(), fs = defaultFs }: { cwd?: string; fs?: PrImportGraphFs } = {},
): Resolution {
  const specifier = stripQuery(rawSpecifier);
  if (!specifier) return { kind: "unresolved", reason: `${importer} imports an empty specifier` };

  let base: string;
  if (specifier.startsWith(".")) {
    base = normalizeOwnershipPath(join(dirname(importer), specifier));
  } else {
    const alias = LOCAL_ALIASES.find(([find]) => specifier === find || specifier.startsWith(`${find}/`));
    if (alias) {
      base = normalizeOwnershipPath(`${alias[1]}${specifier.slice(alias[0].length)}`);
    } else {
      let target: string | null = null;
      if (specifier.startsWith("#") || specifier.startsWith("@") || !specifier.includes(":")) {
        try {
          target = resolveLocalPackageImport(specifier, cwd, fs);
        } catch (error) {
          return { kind: "unresolved", reason: `${importer} imports ${specifier}: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (target) {
        base = normalizeOwnershipPath(relative(cwd, target));
      } else if (specifier.startsWith("#") || ROOT_SPECIFIER_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
        return { kind: "unresolved", reason: `${importer} imports ${specifier}: no package import or repository module` };
      } else if (specifier.includes(":") || isBuiltin(specifier)) {
        // Protocol specifiers and Node builtins are runtime-provided.
        return { kind: "external" };
      } else if (isInstalledPackage(specifier, importer, cwd, fs)) {
        return { kind: "external" };
      } else {
        return { kind: "unresolved", reason: `${importer} imports ${specifier}: no configured alias, workspace export or installed package` };
      }
    }
  }

  if (base === ".." || base.startsWith("../") || isAbsolute(base)) {
    return { kind: "unresolved", reason: `${importer} imports ${rawSpecifier}, which escapes the checkout` };
  }
  const absolute = resolve(cwd, base);
  const candidates = [
    absolute,
    ...MODULE_EXTENSIONS.map((extension) => `${absolute}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => join(absolute, `index${extension}`)),
  ];
  for (const candidate of new Set(candidates)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { kind: "file", file: normalizeOwnershipPath(relative(cwd, candidate)) };
    }
  }
  return { kind: "unresolved", reason: `${importer} imports ${rawSpecifier}, which does not resolve to a file` };
}

/** Map a pattern's static directory (not a file) to a repository-relative path. */
function resolvePatternDirectory(directory: string, importer: string): string | null {
  const normalized = normalizeOwnershipPath(directory);
  if (!normalized) return null;
  let resolved: string;
  if (normalized.startsWith(".")) {
    resolved = normalizeOwnershipPath(join(dirname(importer), normalized));
  } else {
    const alias = LOCAL_ALIASES.find(([find]) => normalized === find || normalized.startsWith(`${find}/`));
    if (alias) resolved = normalizeOwnershipPath(`${alias[1]}${normalized.slice(alias[0].length)}`);
    else if (ROOT_SPECIFIER_PREFIXES.some((prefix) => normalized.startsWith(prefix))) resolved = normalized;
    else return null;
  }
  if (resolved === ".." || resolved.startsWith("../") || isAbsolute(resolved)) return null;
  return resolved;
}

function listFilesUnderPatternDirectory(directory: string, cwd: string, fs: PrImportGraphFs): string[] {
  if (!fs.readdirSync) return [];
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
    try {
      entries = fs.readdirSync!(resolve(cwd, relativeDirectory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!PATTERN_SCAN_EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          visit(entryPath);
        }
        continue;
      }
      // Parity trees symlink ignored generated inputs, and a Dirent for a
      // symlink is neither isFile() nor isDirectory(); follow it.
      if (entry.isFile()) files.push(entryPath);
      else if (fs.existsSync(resolve(cwd, entryPath)) && fs.statSync(resolve(cwd, entryPath)).isFile()) files.push(entryPath);
    }
  };
  visit(directory);
  return files;
}

export interface ModulePatternResolution {
  files: string[];
  unresolved?: string;
}

/**
 * Expand a template-literal import or `import.meta.glob` pattern to the
 * repository files it can load. A pattern without a usable static directory
 * prefix, or one that matches nothing, is unresolved so the caller falls back
 * to Vitest rather than silently dropping the edge.
 */
export function resolveModulePattern(
  pattern: ModulePattern,
  importer: string,
  { cwd = process.cwd(), fs = defaultFs }: { cwd?: string; fs?: PrImportGraphFs } = {},
): ModulePatternResolution {
  if (pattern.kind === "template") {
    const expression = pattern.value.indexOf("${");
    const prefix = pattern.value.slice(0, expression);
    // Find the true end of the last `${...}` expression rather than trusting
    // any literal `}` in the static text; a missed suffix would drop edges.
    let suffixStart = expression;
    while (suffixStart < pattern.value.length) {
      suffixStart = scanTemplateExpression(pattern.value, suffixStart + 2);
      const next = pattern.value.indexOf("${", suffixStart);
      if (next < 0) break;
      suffixStart = next;
    }
    const suffix = pattern.value.slice(suffixStart);
    const slash = prefix.lastIndexOf("/");
    if (slash < 0) {
      return { files: [], unresolved: `${importer} imports template ${pattern.value} without a static directory prefix` };
    }
    const directory = resolvePatternDirectory(prefix.slice(0, slash), importer);
    if (!directory) {
      return { files: [], unresolved: `${importer} imports template ${pattern.value} with an unresolvable static directory` };
    }
    const repositoryPrefix = `${directory}/${prefix.slice(slash + 1)}`;
    const files = listFilesUnderPatternDirectory(directory, cwd, fs)
      .filter((file) => file.startsWith(repositoryPrefix) && file.endsWith(suffix))
      .sort();
    if (files.length === 0) {
      return { files, unresolved: `${importer} imports template ${pattern.value} that matches no repository file` };
    }
    return { files };
  }

  const magic = pattern.value.search(/[*?[{]/);
  const staticPrefix = magic < 0 ? pattern.value : pattern.value.slice(0, magic);
  const slash = staticPrefix.lastIndexOf("/");
  if (slash < 0) {
    return { files: [], unresolved: `${importer} globs ${pattern.value} without a static directory prefix` };
  }
  const directory = resolvePatternDirectory(staticPrefix.slice(0, slash), importer);
  if (!directory) {
    return { files: [], unresolved: `${importer} globs ${pattern.value} with an unresolvable static directory` };
  }
  const repositoryPattern = `${directory}${pattern.value.slice(slash)}`;
  const files = listFilesUnderPatternDirectory(directory, cwd, fs)
    .filter((file) => matchesGlob(file, repositoryPattern))
    .sort();
  if (files.length === 0) {
    return { files, unresolved: `${importer} globs ${pattern.value} that matches no repository file` };
  }
  return { files };
}

function buildReverseIndex(dependencies: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const [file, imported] of dependencies) {
    for (const dependency of imported) {
      const owners = importers.get(dependency) ?? [];
      owners.push(file);
      importers.set(dependency, owners);
    }
  }
  return importers;
}

/** Build the forward import graph reachable from the test universe and the Vitest toolchain. */
export function buildPrImportGraph({
  cwd = process.cwd(),
  fs = defaultFs,
  testFiles = collectExecutableTestFiles(cwd),
}: BuildPrImportGraphOptions = {}): PrImportGraph {
  const dependencies = new Map<string, string[]>();
  const unresolved = new Map<string, string>();
  const stack: string[] = [...testFiles, ...TOOLCHAIN_ROOTS];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (dependencies.has(file)) continue;
    if (!PARSE_EXTENSIONS.has(extname(file))) {
      dependencies.set(file, []);
      continue;
    }
    let source: string;
    try {
      source = fs.readFileSync(resolve(cwd, file), "utf8");
    } catch (error) {
      unresolved.set(file, `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      dependencies.set(file, []);
      continue;
    }
    const collected = collectModuleSpecifiers(source);
    if (collected.unterminated) {
      unresolved.set(`${file}\u0000tokenizer`, `${file} has an ${collected.unterminated}; later imports may be hidden`);
    }
    const direct: string[] = [];
    for (const specifier of collected.specifiers) {
      const resolution = resolveModuleSpecifier(specifier, file, { cwd, fs });
      if (resolution.kind === "external") continue;
      if (resolution.kind === "unresolved") {
        unresolved.set(`${file}\u0000${specifier}`, resolution.reason);
        continue;
      }
      direct.push(resolution.file);
      stack.push(resolution.file);
    }
    for (const pattern of collected.patterns) {
      const expansion = resolveModulePattern(pattern, file, { cwd, fs });
      if (expansion.unresolved) {
        unresolved.set(`${file}\u0000${pattern.value}`, expansion.unresolved);
        continue;
      }
      for (const matched of expansion.files) {
        direct.push(matched);
        stack.push(matched);
      }
    }
    dependencies.set(file, direct);
  }

  const forceRerunFiles = new Set<string>(FORCE_RERUN_FILES);
  // The config/setup import closures are toolchain inputs: changing any module
  // they load changes how Vitest resolves and runs the tests they cover.
  for (const root of TOOLCHAIN_ROOTS) {
    if (!dependencies.has(root)) continue;
    const seen = new Set<string>([root]);
    const pending: string[] = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      forceRerunFiles.add(current);
      for (const dependency of dependencies.get(current) ?? []) {
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        pending.push(dependency);
      }
    }
  }

  return {
    cwd,
    testFiles: [...testFiles],
    testFileSet: new Set(testFiles),
    dependencies,
    importers: buildReverseIndex(dependencies),
    forceRerunFiles,
    unresolved: [...unresolved.values()].sort(),
  };
}

/** Tests whose closure reaches a changed file (the `vitest list --changed` set). */
export function selectImportGraphTests(graph: PrImportGraph, changedFiles: readonly string[]): string[] {
  const selected = new Set<string>();
  const seen = new Set<string>();
  const pending = [...new Set(changedFiles.map(normalizeOwnershipPath))];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (graph.testFileSet.has(current)) selected.add(current);
    for (const importer of graph.importers.get(current) ?? []) {
      if (graph.testFileSet.has(importer)) selected.add(importer);
      else if (!seen.has(importer)) pending.push(importer);
    }
  }
  return [...selected].sort();
}

/**
 * Direct test importers of the cursor modules (no transitive closure): the
 * C8 data-only selection for the changed catalog JSON and its entry modules.
 */
export function selectDirectImporters(graph: PrImportGraph, files: readonly string[]): string[] {
  return selectImportersWithinHops(graph, files, 1);
}

/**
 * Tests within `maxHops` of the changed files. C8's data-only routing uses two
 * hops so a validator that reaches the JSON through one wrapper module is
 * still selected; the full transitive closure remains the non-data path.
 */
export function selectImportersWithinHops(graph: PrImportGraph, files: readonly string[], maxHops: number): string[] {
  const selected = new Set<string>();
  const seen = new Set<string>();
  let frontier = [...new Set(files.map(normalizeOwnershipPath))];
  for (const file of frontier) seen.add(file);
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const importer of graph.importers.get(file) ?? []) {
        if (graph.testFileSet.has(importer)) {
          selected.add(importer);
        } else if (!seen.has(importer)) {
          seen.add(importer);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }
  return [...selected].sort();
}

export type PrTestSelectionMode = "closure" | "data-only";

export interface PrTestSelectionResult {
  /** Affected tests; empty when `fallback` is set. */
  files: string[];
  mode: PrTestSelectionMode;
  /** Non-empty reason to run the authoritative `vitest list --changed` path. */
  fallback?: string;
}

export interface PlanPrTestSelectionOptions {
  cwd?: string;
  fs?: PrImportGraphFs;
  /** Reuse an already-built graph (parity tooling, tests). */
  graph?: PrImportGraph;
}

/**
 * Plan the affected-test portion of the PR selection. Declaration and
 * always-run unions stay in `selectPrTestFiles`; this only replaces the
 * `vitest list --changed` input.
 */
export function planPrTestSelection(
  changedFiles: readonly string[],
  { cwd = process.cwd(), fs = defaultFs, graph }: PlanPrTestSelectionOptions = {},
): PrTestSelectionResult {
  const changed = [...new Set(changedFiles.map(normalizeOwnershipPath))].filter(Boolean);
  const dataOnly = isStablecoinCatalogDataOnly(changed);
  const mode: PrTestSelectionMode = dataOnly ? "data-only" : "closure";
  const built = graph ?? buildPrImportGraph({ cwd, fs });
  if (built.unresolved.length > 0) {
    return {
      files: [],
      mode,
      fallback: `${built.unresolved.length} unresolved local specifier(s): ${built.unresolved.slice(0, 3).join("; ")}`,
    };
  }
  if (changed.some((file) => built.forceRerunFiles.has(file) || isForceRerunInput(file))) {
    return { files: [...built.testFiles].sort(), mode };
  }
  if (dataOnly) {
    // Two hops from the data file catch a validator that reaches the JSON via
    // one wrapper module; entry modules keep their direct importers.
    const files = [
      ...selectImportersWithinHops(built, changed, 2),
      ...selectDirectImporters(built, STABLECOIN_CATALOG_ENTRY_MODULES),
    ];
    return { files: [...new Set(files)].sort(), mode };
  }
  return { files: selectImportGraphTests(built, changed), mode };
}

/** Whether the PR touched internal docs (the static-guards/docs-inline owner runs its suites). */
export function hasDocsChanges(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => hasOnlyInternalDocsImpact([normalizeOwnershipPath(file)]));
}
