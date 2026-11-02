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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";

import { hasOnlyInternalDocsImpact } from "./deploy-impact.mts";
import { EXECUTABLE_TEST_PROJECTS, normalizeOwnershipPath } from "./critical-ownership.mts";
import { resolveLocalPackageImport } from "./package-imports.mts";
import { collectSourceFilesUnderRoots } from "./source-files.mts";

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

/** Vitest `setupFiles`/`globalSetup` and config dependencies force a full run. */
const FORCE_RERUN_FILES = new Set(["src/test/setup.ts"]);
const FORCE_RERUN_PREFIXES = ["scripts/test/"] as const;
const FORCE_RERUN_PATTERNS = [
  /(^|\/)package(?:-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(?:vitest|vite)\.config\.[cm]?[jt]s$/,
] as const;
/** Config files whose import closure is a toolchain input. */
const CONFIG_ROOTS = ["vitest.config.ts"] as const;

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

const defaultFs: PrImportGraphFs = { existsSync, readFileSync, realpathSync, statSync };

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

/**
 * Enumerate Vitest's executable test universe: the `EXECUTABLE_TEST_PROJECTS`
 * include/exclude sets, restricted to the roots those projects scan.
 */
export function collectExecutableTestFiles(cwd = process.cwd()): string[] {
  return collectSourceFilesUnderRoots(TEST_SCAN_ROOTS, cwd, {
    extensions: TEST_FILE_EXTENSIONS,
    excludedDirs: ["node_modules", "dist"],
    skipDotEntries: true,
  })
    .filter((file) => TEST_FILE_PATTERN.test(file))
    .filter((file) => EXECUTABLE_TEST_PROJECTS.some((project) =>
      project.include.some((pattern) => matchesGlob(file, pattern))
      && !project.exclude.some((pattern) => matchesGlob(file, pattern))))
    .sort();
}

interface TokenSpecifiers {
  specifiers: string[];
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

/**
 * Split source into lexical tokens: comments and regular-expression literals
 * are consumed whole, string literals stop at an unescaped newline (so JSX
 * text such as `Don't` cannot swallow later declarations), and every other
 * non-space character is a token. Dependency-free so planning has no parse
 * cost beyond the source scan.
 */
function tokenizeSource(source: string): string[] {
  const tokens: string[] = [];
  const length = source.length;
  let index = 0;
  let allowRegex = true;
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
      while (index < length) {
        const current = source.charCodeAt(index);
        if (current === 92 /* \ */) { index += 2; continue; }
        if (current === 10) break;
        if (current === 91 /* [ */) inCharacterClass = true;
        else if (current === 93 /* ] */) inCharacterClass = false;
        else if (current === 47 && !inCharacterClass) { index++; break; }
        index++;
      }
      while (index < length && isIdentifierCode(source.charCodeAt(index))) index++;
      tokens.push("/regex/");
      allowRegex = false;
      continue;
    }
    if (code === 34 /* " */ || code === 39 /* ' */) {
      const start = index;
      index++;
      while (index < length && source.charCodeAt(index) !== code && source.charCodeAt(index) !== 10) {
        if (source.charCodeAt(index) === 92) index++;
        index++;
      }
      index++;
      tokens.push(source.slice(start, index));
      allowRegex = false;
      continue;
    }
    if (code === 96 /* ` */) {
      const start = index;
      index++;
      while (index < length && source.charCodeAt(index) !== 96) {
        if (source.charCodeAt(index) === 92) index++;
        index++;
      }
      index++;
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
    allowRegex = !(code === 41 /* ) */ || code === 93 /* ] */ || code === 125 /* } */ || isIdentifierCode(code));
    index++;
  }
  return tokens;
}

/**
 * Read `import`, literal `import(...)` and `export ... from` declarations.
 * Type-only imports (`import type`, all-`type` bindings) are erased before the
 * runtime module graph exists, so they are not edges; `vi.mock(...)` is not an
 * import declaration and is not an edge either.
 */
export function collectModuleSpecifiers(source: string): TokenSpecifiers {
  const tokens = tokenizeSource(source);
  const specifiers = new Set<string>();
  const quoted = (token: string | undefined): token is string => token !== undefined && /^["']/.test(token);
  // A few suites escape the leading `@` of a specifier (`"\@shared/..."`); the
  // string value is the unescaped text, so decode the same way.
  const push = (token: string) => { specifiers.add(token.slice(1, -1).replaceAll(/\\(.)/g, "$1")); };
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
      if (tokens[index - 1] === ".") continue;
      if (tokens[index + 1] === "type" && tokens[index + 2] !== "from") continue;
      if (tokens[index + 1] === "{" && allTypeBindings(index + 1)) continue;
      if (tokens[index + 1] === "(") {
        if (quoted(tokens[index + 2]) && [")", ","].includes(tokens[index + 3])) push(tokens[index + 2]);
      } else if (quoted(tokens[index + 1])) push(tokens[index + 1]);
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
  return { specifiers: [...specifiers] };
}

function stripQuery(specifier: string): string {
  const query = specifier.indexOf("?");
  const hash = specifier.indexOf("#");
  const cutoff = [query, hash].filter((index) => index > 0).sort((left, right) => left - right)[0];
  return cutoff === undefined ? specifier : specifier.slice(0, cutoff);
}

type Resolution = { kind: "external" } | { kind: "unresolved"; reason: string } | { kind: "file"; file: string };

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
      } else {
        return { kind: "external" };
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

/** Build the forward import graph reachable from the test universe and the Vitest config. */
export function buildPrImportGraph({
  cwd = process.cwd(),
  fs = defaultFs,
  testFiles = collectExecutableTestFiles(cwd),
}: BuildPrImportGraphOptions = {}): PrImportGraph {
  const dependencies = new Map<string, string[]>();
  const unresolved = new Map<string, string>();
  const stack: string[] = [...testFiles, ...CONFIG_ROOTS];

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
    const direct: string[] = [];
    for (const specifier of collectModuleSpecifiers(source).specifiers) {
      const resolution = resolveModuleSpecifier(specifier, file, { cwd, fs });
      if (resolution.kind === "external") continue;
      if (resolution.kind === "unresolved") {
        unresolved.set(`${file}\u0000${specifier}`, resolution.reason);
        continue;
      }
      direct.push(resolution.file);
      stack.push(resolution.file);
    }
    dependencies.set(file, direct);
  }

  const forceRerunFiles = new Set<string>(FORCE_RERUN_FILES);
  // The config's own import closure is a toolchain input: changing any module it
  // loads changes how Vitest resolves and runs every test.
  for (const root of CONFIG_ROOTS) {
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
  const selected = new Set<string>();
  for (const file of files) {
    for (const importer of graph.importers.get(normalizeOwnershipPath(file)) ?? []) {
      if (graph.testFileSet.has(importer)) selected.add(importer);
    }
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
    const cursors = [...new Set([...changed, ...STABLECOIN_CATALOG_ENTRY_MODULES])];
    return { files: selectDirectImporters(built, cursors), mode };
  }
  return { files: selectImportGraphTests(built, changed), mode };
}

/** Whether the PR touched internal docs (the static-guards/docs-inline owner runs its suites). */
export function hasDocsChanges(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => hasOnlyInternalDocsImpact([normalizeOwnershipPath(file)]));
}
