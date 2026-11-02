/**
 * Lane input closures.
 *
 * A lane's inputs are the modules reachable from the entry points it executes
 * plus the data and configuration it reads at runtime — not every file under a
 * broad directory prefix. `shared/**` and `worker/src/lib/**` selected the
 * Pages artifact and V9 resource lanes for edits neither lane can observe, so
 * both predicates now walk a forward import closure from their real entries
 * with the planner's resolver ([`pr-import-graph.mts`](./pr-import-graph.mts)),
 * which places aliases, package imports and globs exactly as the build and the
 * test plan do.
 *
 * Fail closed: an empty or malformed diff, an unreadable module, a local
 * specifier the resolver cannot place, a path the checkout no longer contains,
 * or a change outside every area a lane is known not to read selects the lane.
 * Root-level files are not lane inputs unless listed, because the entry points
 * are repository modules and declared data, never ambient checkout files.
 *
 * The import closure only narrows where it can: the Pages artifact lane takes
 * every non-test path under `src/` by prefix because Next compiles more than
 * module specifiers reach (CSS `@import` chains, `next/font/local` path strings,
 * `fs`-read blog posts, app file conventions such as `favicon.ico`), and
 * `shared/` and `scripts/` stay closure-narrowed.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

import { GENERATED_ARTIFACT_REGISTRY, DEPLOY_IMPACT_REGISTRY } from "./automation-registry.mjs";
import { normalizeRepoPath } from "./deploy-impact.mts";
import {
  collectModuleSpecifiers,
  resolveModulePattern,
  resolveModuleSpecifier,
  TEST_FILE_PATTERN,
  type PrImportGraphFs,
} from "./pr-import-graph.mts";
import { collectSourceFilesUnderRoots } from "./source-files.mts";

export interface ForwardImportClosure {
  /** Repository-relative modules and data files reached from the roots. */
  files: ReadonlySet<string>;
  /** Local specifiers the resolver could not place; non-empty means "select the lane". */
  unresolved: readonly string[];
}

export interface LaneInputSpec {
  /** Cache key; one closure per process per spec id and checkout. */
  id: string;
  /** Entry modules whose forward import closure belongs to the lane. */
  roots: readonly string[];
  /** Literal inputs the lane reads without importing (data, policy, workflow). */
  exactPaths?: readonly string[];
  /** Directory prefixes read at runtime rather than imported. */
  prefixes?: readonly string[];
  /** Configuration and toolchain names that always rebuild or remeasure. */
  patterns?: readonly RegExp[];
  /** Inputs whose decision lives in another authority (e.g. a sub-predicate). */
  matches?: (file: string) => boolean;
  /** Test-only paths that cannot reach the lane however the change is classified. */
  nonInputPatterns?: readonly RegExp[];
  /** Areas that cannot reach the lane; an unlisted change there is not an input. */
  ignoredPrefixes: readonly string[];
  /**
   * Areas whose deletion cannot reach the lane. Every other path the checkout no
   * longer contains selects it, because the closure below describes the
   * post-change tree only.
   */
  deletionNonInputPrefixes: readonly string[];
}

const PARSE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const SOURCE_EXTENSIONS = [...PARSE_EXTENSIONS, ".json"];
const defaultFs: PrImportGraphFs = { existsSync, readFileSync, readdirSync, realpathSync, statSync };
const closureCache = new WeakMap<PrImportGraphFs, Map<string, ForwardImportClosure>>();

/** Follow every local import, re-export, template import and glob from `roots`. */
function buildForwardImportClosure(
  roots: readonly string[],
  { cwd, fs }: { cwd: string; fs: PrImportGraphFs },
): ForwardImportClosure {
  const files = new Set<string>();
  const unresolved = new Map<string, string>();
  const pending: string[] = [];
  for (const root of roots) {
    // A missing entry module means the lane's real graph is unknown.
    if (!fs.existsSync(resolve(cwd, root))) unresolved.set(root, `${root} is not present in this checkout`);
    else pending.push(root);
  }
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!PARSE_EXTENSIONS.has(extname(file))) continue;
    let source: string;
    try {
      source = fs.readFileSync(resolve(cwd, file), "utf8");
    } catch (error) {
      unresolved.set(file, `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const collected = collectModuleSpecifiers(source);
    if (collected.unterminated) unresolved.set(`${file}\u0000tokenizer`, `${file} has an ${collected.unterminated}; later imports may be hidden`);
    for (const specifier of collected.specifiers) {
      const resolution = resolveModuleSpecifier(specifier, file, { cwd, fs });
      if (resolution.kind === "external") continue;
      if (resolution.kind === "unresolved") {
        unresolved.set(`${file}\u0000${specifier}`, resolution.reason);
        continue;
      }
      pending.push(resolution.file);
    }
    for (const pattern of collected.patterns) {
      const expansion = resolveModulePattern(pattern, file, { cwd, fs });
      if (expansion.unresolved) {
        unresolved.set(`${file}\u0000${pattern.value}`, expansion.unresolved);
        continue;
      }
      pending.push(...expansion.files);
    }
  }
  return { files, unresolved: [...unresolved.values()].sort() };
}

function laneClosure(spec: LaneInputSpec, { cwd, fs }: { cwd: string; fs: PrImportGraphFs }): ForwardImportClosure {
  let cache = closureCache.get(fs);
  if (!cache) closureCache.set(fs, cache = new Map());
  const key = `${spec.id}\u0000${cwd}\u0000${spec.roots.join("\u0000")}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const built = buildForwardImportClosure([...new Set(spec.roots)], { cwd, fs });
  cache.set(key, built);
  return built;
}

function isUnderPrefix(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => file.startsWith(prefix));
}

/**
 * The modules and data files a lane's closure reaches in this checkout. Callers
 * that must derive further inputs (a generated artifact whose output the lane
 * bundles) read it instead of restating an import graph.
 */
export function laneInputFiles(
  spec: LaneInputSpec,
  { cwd = process.cwd(), fs = defaultFs }: { cwd?: string; fs?: PrImportGraphFs } = {},
): ReadonlySet<string> {
  return laneClosure(spec, { cwd, fs }).files;
}

/**
 * Whether a changed-file set reaches a lane's inputs. Malformed paths, an
 * unbuildable closure and any area the lane is not known to read miss fail
 * closed: only a path under a declared non-input area skips the lane, and a path
 * absent from the checkout is treated as a deletion rather than as out of scope.
 */
export function hasLaneInputImpact(
  files: readonly string[],
  spec: LaneInputSpec,
  { cwd = process.cwd(), fs = defaultFs }: { cwd?: string; fs?: PrImportGraphFs } = {},
): boolean {
  // An empty diff cannot establish that no input changed.
  if (files.length === 0) return true;
  const closure = laneClosure(spec, { cwd, fs });
  return files.some((rawFile) => {
    const file = normalizeRepoPath(rawFile);
    // Reject absolute, empty-component and traversal paths: a malformed diff
    // cannot establish that inputs are absent.
    if (!file || file.startsWith("/") || file.split("/").some((part) => part === "." || part === ".." || part === "")) return true;
    if (closure.unresolved.length > 0) return true;
    if (closure.files.has(file)) return true;
    // A test-only file compiles into no artifact and runs in no lane, whether
    // the change adds, edits or deletes it.
    if (spec.nonInputPatterns?.some((pattern) => pattern.test(file))) return false;
    if (spec.exactPaths?.includes(file)) return true;
    if (isUnderPrefix(file, spec.prefixes ?? [])) return true;
    if (spec.patterns?.some((pattern) => pattern.test(file))) return true;
    if (spec.matches?.(file)) return true;
    // The closure describes the post-change tree, so a path the checkout does
    // not contain either left that tree (a deletion) or never existed. Base∪head
    // semantics make it an input unless its area cannot reach the lane at all.
    if (!fs.existsSync(resolve(cwd, file))) return !isUnderPrefix(file, spec.deletionNonInputPrefixes);
    // Ambient checkout files (root manifests are listed) are not modules or data.
    if (!file.includes("/")) return false;
    return !isUnderPrefix(file, spec.ignoredPrefixes);
  });
}

/**
 * The modules the Pages artifact lane executes. Keep in step with the npm
 * scripts the lane and its gates spawn (`check:pages-artifact`,
 * `generated:compile-input`, `generated:post-refresh`, `postbuild`,
 * `check:pages-release` and the gate scripts it runs); the owning suite reads
 * `package.json` and fails when one of them stops naming a listed file.
 */
const PAGES_ARTIFACT_LANE_SCRIPTS = [
  "scripts/ci/run-pages-artifact-lane.ts",
  "scripts/maintenance/run-generated-artifacts.ts",
  "scripts/build-data/build-stablecoin-detail-snapshots.ts",
  "scripts/maintenance/run-pages-release-checks.ts",
  "scripts/ci/check-feature-flag-inlining.ts",
  "scripts/maintenance/report-build-size.mjs",
  "scripts/ci/check-phishing-signatures.ts",
  "scripts/ci/check-seo-static.mjs",
  "scripts/maintenance/generate-markdown-exports.ts",
  "scripts/maintenance/inline-homepage-critical-css.ts",
  // Loaded as a `new Worker(new URL(...))` module, so not an import edge.
  "scripts/maintenance/critical-css-worker.mjs",
] as const;
/**
 * Workflow and registry edits that redefine what the lane builds or runs. The
 * deploy registry's Pages exact paths join them: that is the declared list of
 * build inputs the generator lifecycle cannot derive (public doc sources the
 * export reads from disk, `tsconfig.json`, the non-maintenance generator
 * scripts), and the PR lane must not rebuild less than a deploy does.
 */
const PAGES_ARTIFACT_EXACT_PATHS = [
  ".github/workflows/pages-prepare.yml",
  ".github/workflows/pages-release.yml",
  ".github/workflows/pull-request-checks.yml",
  ".github/workflows/rebuild-pages.yml",
  "package.json",
  "package-lock.json",
  "scripts/lib/automation-registry.mjs",
  // The selector is its own input: a change here redefines what the lane builds.
  "scripts/lib/lane-input-closure.mts",
  "tsconfig.json",
] as const;
/**
 * Read by the generators and the export instead of being imported. `src/` is a
 * prefix rather than a closure because Next compiles more than module specifiers
 * reach: CSS `@import` chains, `next/font/local` path strings, blog posts read
 * with `fs` and the app file conventions (`favicon.ico`, icons, manifest,
 * robots, opengraph images). Test-only files under it are excluded below.
 */
const PAGES_ARTIFACT_PREFIXES = ["data/", "public/", "shared/data/stablecoins/", "src/"] as const;
const PAGES_ARTIFACT_PATTERNS = [
  /^(?:next|postcss|tailwind)\.config\.[cm]?[jt]s$/,
  // Any workspace manifest can add a package import the export resolves.
  /(^|\/)package\.json$/,
  /(^|\/)(?:\.nvmrc|\.npmrc|\.node-version|\.tool-versions|mise\.toml|\.mise\.toml)$/,
] as const;
/** The export compiles no test module and runs no support file. */
/** Test-only paths: they compile into no artifact and run in neither lane's measurement. */
export const LANE_TEST_FILE_PATTERNS = [
  /(^|\/)__tests__\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)[^/]*test-support\.[cm]?[jt]sx?$/,
] as const;
const PAGES_ARTIFACT_NON_INPUT_PREFIXES = [
  ".agents/", ".ci/", ".claude/", ".codex/", ".github/", ".impeccable/", ".omp/", "agents/", "docs/", "functions/",
  "scripts/", "shared/", "tests/", "worker/",
] as const;
/**
 * Areas a deletion cannot reach in either lane: agent skills and scratch,
 * internal docs, CI-local policy and the end-to-end suite. Every other deleted
 * path selects both lanes, because neither closure can see what it removed.
 */
export const LANE_DELETION_NON_INPUT_PREFIXES = [
  ".agents/", ".ci/", ".claude/", ".codex/", ".github/", ".impeccable/", ".omp/", "agents/", "docs/", "tests/",
] as const;

const pagesArtifactRootCache = new Map<string, string[]>();

/**
 * Build entries: every module Next compiles from the app directory plus the
 * generators, detail-snapshot bootstrap and gates the lane runs.
 */
function pagesArtifactRoots(cwd: string): string[] {
  const cached = pagesArtifactRootCache.get(cwd);
  if (cached) return cached;
  const appFiles = collectSourceFilesUnderRoots(["src/app"], cwd, {
    extensions: SOURCE_EXTENSIONS,
    excludedDirs: ["node_modules", "dist"],
    skipDotEntries: true,
  }).filter((file) => !TEST_FILE_PATTERN.test(file));
  const artifactScripts = (GENERATED_ARTIFACT_REGISTRY as { buildLifecycle: string; script: string }[])
    .filter((artifact) => artifact.buildLifecycle !== "maintenance-only")
    .map((artifact) => artifact.script);
  const roots = [...new Set([...appFiles, ...artifactScripts, ...PAGES_ARTIFACT_LANE_SCRIPTS])].sort();
  pagesArtifactRootCache.set(cwd, roots);
  return roots;
}

/**
 * Whether the PR Pages-artifact lane must build: the change reaches the static
 * export's import closure, one of its declared inputs, or any non-test path
 * under `src/` (Next compiles more than module edges). Test-only edits and
 * changes outside the build (Worker source, unrelated CI tooling, internal
 * docs) still validate but do not rebuild the artifact, and a push deploy
 * keeps the broader publish predicate. A deleted path selects the lane: the
 * closure is built from the post-change tree and cannot place it.
 */
export function hasPagesArtifactImpact(
  files: readonly string[],
  { cwd = process.cwd(), fs = defaultFs }: { cwd?: string; fs?: PrImportGraphFs } = {},
): boolean {
  if (files.length === 0) return true;
  return hasLaneInputImpact(files, {
    id: "pages-artifact",
    roots: pagesArtifactRoots(cwd),
    exactPaths: [...PAGES_ARTIFACT_EXACT_PATHS, ...DEPLOY_IMPACT_REGISTRY.pages.exactPaths],
    prefixes: PAGES_ARTIFACT_PREFIXES,
    patterns: PAGES_ARTIFACT_PATTERNS,
    nonInputPatterns: LANE_TEST_FILE_PATTERNS,
    ignoredPrefixes: PAGES_ARTIFACT_NON_INPUT_PREFIXES,
    // Worker and Pages Functions code never compiles into the static export
    // (ADR-2); deleting a module an export input imported also edits that importer.
    deletionNonInputPrefixes: [...LANE_DELETION_NON_INPUT_PREFIXES, "functions/", "worker/"],
  }, { cwd, fs });
}
