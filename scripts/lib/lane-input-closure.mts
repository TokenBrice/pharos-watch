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
 * specifier the resolver cannot place, or a change outside every area a lane is
 * known not to read selects the lane. Root-level files are not lane inputs
 * unless listed, because the entry points are repository modules and declared
 * data, never ambient checkout files.
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
  /** Areas that cannot reach the lane; an unlisted change there is not an input. */
  ignoredPrefixes: readonly string[];
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

/**
 * Whether a changed-file set reaches a lane's inputs. Malformed paths, an
 * unbuildable closure and any area the lane is not known to read miss fail
 * closed: only a path under a declared non-input area skips the lane.
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
    if (spec.exactPaths?.includes(file)) return true;
    if (spec.prefixes?.some((prefix) => file.startsWith(prefix))) return true;
    if (spec.patterns?.some((pattern) => pattern.test(file))) return true;
    if (spec.matches?.(file)) return true;
    // Ambient checkout files (root manifests are listed) are not modules or data.
    if (!file.includes("/")) return false;
    return !spec.ignoredPrefixes.some((prefix) => file.startsWith(prefix));
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
  "tsconfig.json",
] as const;
/** Read by the generators and the export instead of being imported. */
const PAGES_ARTIFACT_PREFIXES = ["data/", "public/", "shared/data/stablecoins/"] as const;
const PAGES_ARTIFACT_PATTERNS = [
  /^(?:next|postcss|tailwind)\.config\.[cm]?[jt]s$/,
  /(^|\/)(?:\.nvmrc|\.npmrc|\.node-version|\.tool-versions|mise\.toml|\.mise\.toml)$/,
] as const;
const PAGES_ARTIFACT_NON_INPUT_PREFIXES = [
  ".ci/", ".github/", "agents/", "docs/", "functions/", "scripts/", "shared/", "src/", "tests/", "worker/",
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
 * export's import closure or one of its declared inputs. Test-only edits and
 * changes outside the build (Worker source, unrelated CI tooling, internal
 * docs) still validate but do not rebuild the artifact, and a push deploy
 * keeps the broader publish predicate.
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
    ignoredPrefixes: PAGES_ARTIFACT_NON_INPUT_PREFIXES,
  }, { cwd, fs });
}
