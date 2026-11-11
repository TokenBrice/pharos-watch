import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { hasDeployImpact, hasPagesDeployImpact, hasWorkerDeployImpact, normalizeRepoPath } from "./deploy-impact.mts";
import { collectGitPaths } from "./changed-files.mts";
import type { DocReference } from "./doc-ownership-registry.mts";
import type { ReadingSelector } from "./doc-ownership-registry.mts";
import type * as RoutingRegistry from "./doc-ownership-registry.mts";
import type { MarkdownSectionRange, MarkdownSections } from "./doc-markdown.mts";
import type * as DocMarkdown from "./doc-markdown.mts";
import { unique, require, REPO_ROOT, formatDocReference, normalizeChangedFiles } from "./change-contract-common.ts";


type GitExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf8" },
) => string;

interface PathFamilyRule {
  background: DocReference[];
  checks: string[];
  docs: DocReference[];
  reading?: ReadingSelector[];
  required?: DocReference[];
  hardRules: string[];
  id: string;
  label: string;
  risk: string;
  scopedContext: string[];
  sourceGlobs: string[];
  tier: "specific" | "fallback";
}

export interface MatchedMapping {
  id: string;
  label: string;
  matchedFiles: string[];
  risk: string;
  tier: "specific" | "fallback";
}

export interface ChangeContract {
  background: DocReference[];
  changedFiles: string[];
  checks: string[];
  deploy: {
    deployImpact: boolean;
    pagesImpact: boolean;
    workerImpact: boolean;
  };
  docs: DocReference[];
  requiredDocs: DocReference[];
  contextMode: {
    requested: "auto" | "contract";
    effective: "local" | "contract";
    reasons: string[];
  };
  hardRules: string[];
  mappings: MatchedMapping[];
  scopedContext: string[];
  source: ChangeSource;
  unmappedPaths: string[];
  warnings: string[];
}

export type ChangeSource = "explicit files" | "staged index" | "base/head range" | "working tree";


interface ChangedFileOptions {
  baseRef?: string;
  execFile?: GitExec;
  headRef?: string;
  staged?: boolean;
}
const RISK_RANK: ReadonlyMap<string, number> = new Map([
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);
const MAX_SINGLE_PATH_READ_FIRST_DOCS = 6;
const CONTRACT_SENSITIVE_GLOBS = [
  "shared/types/**", "shared/lib/api-endpoints/**", "shared/lib/*contract*.ts",
  "shared/lib/classification.ts", "shared/lib/methodology-versions/**",
  "shared/data/methodology-changelogs/**", "shared/data/stablecoins/**",
  "shared/lib/safety-score-v9/**", "shared/data/safety-score-v9/**",
  "worker/src/cron/compute-safety-score-v9.ts", "worker/src/cron/prepare-safety-score-v9-input.ts",
  "worker/src/lib/safety-score-v9/publication*.ts",
  "worker/migrations/**", "shared/contracts/**",
];

// Decimal bytes, measured across every tracked single-path reading signature
// in auto and contract modes. Ratchet down only; increases require review of
// the mandatory closure. Batches deliberately retain the 160 KB union guard.
export const ROUTE_CONTEXT_CEILINGS = {
  "local-frontend": 24_000,
  "domain-frontend": 68_000,
  "worker-cron": 104_000,
  "worker-api": 76_000,
  scoring: 100_000,
  functions: 100_000,
  "registry-data": 56_000,
  telegram: 72_000,
  migration: 28_000,
  docs: 108_000,
  "other-one-domain": 84_000,
  "multi-domain-batch": 160_000,
} as const;

export type RouteClass = keyof typeof ROUTE_CONTEXT_CEILINGS;

export function classifyRouteContext(
  contract: Pick<ChangeContract, "changedFiles" | "mappings">,
): RouteClass {
  if (contract.changedFiles.length > 1) return "multi-domain-batch";
  const path = contract.changedFiles[0] ?? "";
  const ids = new Set(contract.mappings.map((mapping) => mapping.id));
  if (path.startsWith("docs/")) return "docs";
  if (path.startsWith("functions/")) return "functions";
  if (path.startsWith("worker/migrations/")) return "migration";
  if (ids.has("telegram")) return "telegram";
  if (path.startsWith("worker/src/cron/") || ids.has("worker-cron")) return "worker-cron";
  if (path.startsWith("worker/src/api/") || ids.has("worker-api-auth")) return "worker-api";
  if (ids.has("safety-score-v9")) return "scoring";
  if (ids.has("stablecoin-registry")) return "registry-data";
  if (path.startsWith("src/") && ids.has("frontend-routes")) {
    return ids.size === 1 ? "local-frontend" : "domain-frontend";
  }
  return "other-one-domain";
}

function selectContextMode(files: readonly string[], requested: "auto" | "contract"): ChangeContract["contextMode"] {
  if (requested === "contract") return { requested, effective: "contract", reasons: ["Explicit contract context"] };
  const surfaces = unique(files.filter((file) =>
    !/(?:^|\/)(?:__tests__|__fixtures__|test|tests|fixtures)\//.test(file) &&
    !/\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/.test(file) &&
    /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file),
  ).map((file) => file.split("/")[0]).filter((surface) => ["src", "functions", "worker", "shared"].includes(surface)));
  const reasons: string[] = [];
  if (surfaces.length >= 2) reasons.push(`Implementation inputs span surfaces: ${surfaces.join(", ")}`);
  for (const glob of CONTRACT_SENSITIVE_GLOBS) {
    if (files.some((file) => getRoutingRegistry().matchesOwnershipGlob(file, glob))) reasons.push(`Contract-sensitive input: ${glob}`);
  }
  return { requested, effective: reasons.length > 0 ? "contract" : "local",
    reasons: reasons.length > 0 ? reasons : ["Fewer than two implementation surfaces and no contract-sensitive paths"] };
}

function selectFamilyReading(family: PathFamilyRule, files: readonly string[], mode: "local" | "contract") {
  const docs: DocReference[] = [];
  const required = [...family.required ?? []];
  const selected = new Set<ReadingSelector>();
  let includedDefaults = false;
  for (const file of files) {
    let matchedSelector = false;
    for (const selector of family.reading ?? []) {
      if (!selector.sources.some((glob) => getRoutingRegistry().matchesOwnershipGlob(file, glob))) continue;
      matchedSelector = true;
      if (selected.has(selector)) continue;
      selected.add(selector);
      docs.push(...selector.local ?? []);
      if (mode === "contract") docs.push(...selector.contract ?? []);
      required.push(...selector.required ?? []);
    }
    if (!matchedSelector && !includedDefaults) {
      docs.push(...family.docs);
      includedDefaults = true;
    }
  }
  return { docs, required, hasSelector: selected.size > 0 };
}
let routingRegistry: typeof RoutingRegistry | undefined;
function getRoutingRegistry() {
  return routingRegistry ??= require("./doc-ownership-registry.mts") as typeof RoutingRegistry;
}

export class ExplicitPathError extends Error {}

function uniqueDocs(values: readonly DocReference[]): DocReference[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.path}#${value.anchor ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(getRoutingRegistry().normalizeDocReference);
}

function fileMatchesRule(file: string, rule: PathFamilyRule): boolean {
  return rule.sourceGlobs.some((glob) => getRoutingRegistry().matchesOwnershipGlob(file, glob));
}

function compareFamilyRisk(a: PathFamilyRule, b: PathFamilyRule): number {
  if (a.tier !== b.tier) return a.tier === "specific" ? -1 : 1;
  const rankDelta = (RISK_RANK.get(b.risk) ?? 0) - (RISK_RANK.get(a.risk) ?? 0);
  if (rankDelta !== 0) return rankDelta;
  return a.label.localeCompare(b.label);
}

function discoverScopedContext(files: readonly string[]): string[] {
  const discovered: string[] = [];
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== "." && directory !== "/") {
      const candidate = `${normalizeRepoPath(directory)}/AGENTS.md`;
      if (existsSync(resolve(REPO_ROOT, candidate))) discovered.push(candidate);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return unique(discovered);
}



interface ExplicitPathResolution {
  existencePaths: string[];
  rawPath: string;
  repoPath: string;
}

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

function isWindowsDriveAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE_PATH.test(value);
}

function isAbsoluteRepoPath(value: string): boolean {
  return isAbsolute(value) || isWindowsDriveAbsolutePath(value);
}

function getRelativeRepoPath(absolutePath: string, root: string): string | null {
  const relativePath = normalizeRepoPath(relative(resolve(root), absolutePath));
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsoluteRepoPath(relativePath)
  ) {
    return null;
  }
  return relativePath.replace(/^(?:\.\/)+/, "");
}

function getCurrentWorktreeRoot(execFile: GitExec = execFileSync as GitExec): string {
  try {
    const output = execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    return output ? resolve(normalizeRepoPath(output)) : REPO_ROOT;
  } catch {
    return REPO_ROOT;
  }
}

function validateExistingExplicitPath(
  { existencePaths, rawPath }: ExplicitPathResolution,
  roots: readonly string[],
): void {
  const existingPaths = existencePaths.filter((path) => existsSync(path));
  if (existingPaths.length === 0) return;

  const realRoots = roots.map((root) => realpathSync(root));
  for (const existingPath of existingPaths) {
    let realPath: string;
    try {
      realPath = realpathSync(existingPath);
    } catch {
      throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
    }

    if (!realRoots.some((root) => getRelativeRepoPath(realPath, root) !== null)) {
      throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
    }
  }
}

function resolveExplicitPath(
  value: unknown,
  currentWorktreeRoot: string,
): ExplicitPathResolution | null {
  const rawPath = normalizeRepoPath(String(value ?? "").trim());
  if (!rawPath) return null;

  const withoutFilePrefix = rawPath.startsWith("file://") ? rawPath.slice("file://".length) : rawPath;
  const repoRoot = resolve(REPO_ROOT);
  const currentRoot = resolve(currentWorktreeRoot);

  if (isWindowsDriveAbsolutePath(withoutFilePrefix) && !isAbsolute(withoutFilePrefix)) {
    throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
  }

  if (isAbsoluteRepoPath(withoutFilePrefix)) {
    const absolutePath = resolve(withoutFilePrefix);
    const roots = currentRoot === repoRoot ? [repoRoot] : [currentRoot, repoRoot];
    for (const root of roots) {
      const repoPath = getRelativeRepoPath(absolutePath, root);
      if (repoPath !== null) {
        return {
          existencePaths: unique([absolutePath, resolve(repoRoot, repoPath)]),
          rawPath,
          repoPath,
        };
      }
    }

    throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
  }

  const relativeInput = withoutFilePrefix.replace(/^(?:\.\/)+/, "");
  const absolutePath = resolve(repoRoot, relativeInput);
  const repoPath = getRelativeRepoPath(absolutePath, repoRoot);
  if (repoPath === null) {
    throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
  }

  return {
    existencePaths: unique([
      absolutePath,
      ...(currentRoot === repoRoot ? [] : [resolve(currentRoot, repoPath)]),
    ]),
    rawPath,
    repoPath,
  };
}

export function normalizeExplicitFiles(
  files: readonly string[],
  { allowMissing = false, execFile = execFileSync as GitExec }: { allowMissing?: boolean; execFile?: GitExec } = {},
): string[] {
  const currentWorktreeRoot = getCurrentWorktreeRoot(execFile);
  const missingWarnings = new Set<string>();
  const resolvedFiles = files
    .map((file) => resolveExplicitPath(file, currentWorktreeRoot))
    .filter((file): file is ExplicitPathResolution => file !== null)
    .map((resolution) => {
      validateExistingExplicitPath(resolution, [REPO_ROOT, currentWorktreeRoot]);
      const { existencePaths, repoPath } = resolution;
      if (!allowMissing && !existencePaths.some((path) => existsSync(path)) && !missingWarnings.has(repoPath)) {
        console.error(`warning: ${repoPath} does not exist (routing as a planned new file)`);
        missingWarnings.add(repoPath);
      }
      return repoPath;
    });

  return normalizeChangedFiles(resolvedFiles);
}

export function classifyChangedFiles(files: readonly string[], context: "auto" | "contract" = "auto"): ChangeContract {
  return classifyChangedFilesWithSource(files, "explicit files", context);
}

export function classifyChangedFilesWithSource(files: readonly string[], source: ChangeSource, context: "auto" | "contract" = "auto"): ChangeContract {
  const changedFiles = normalizeChangedFiles(files);
  const contextMode = selectContextMode(changedFiles, context);
  const { PATH_FAMILIES } = getRoutingRegistry();
  const matchedFamilies = PATH_FAMILIES.map((family) => ({
    ...family,
    matchedFiles: changedFiles.filter((file) => fileMatchesRule(file, family)),
  }))
    .filter((family) => family.matchedFiles.length > 0)
    .sort(compareFamilyRisk);

  // Reading relevance is independent of mapping order, which controls checks.
  const readings = matchedFamilies.map((family) => ({
    ...selectFamilyReading(family, family.matchedFiles, contextMode.effective), tier: family.tier,
  })).sort((a, b) =>
    Number(a.tier === "fallback") - Number(b.tier === "fallback") || Number(b.hasSelector) - Number(a.hasSelector));
  const requiredDocs = uniqueDocs(readings.flatMap((reading) => reading.required));
  const requiredKeys = new Set(requiredDocs.map((doc) => `${doc.path}#${doc.anchor ?? ""}`));
  const rankedDocs = uniqueDocs(readings.flatMap((reading) => reading.docs));
  const ordinaryDocs = rankedDocs.filter((doc) => !requiredKeys.has(`${doc.path}#${doc.anchor ?? ""}`));
  const selectedDocs = changedFiles.length === 1 ? ordinaryDocs.slice(0, MAX_SINGLE_PATH_READ_FIRST_DOCS) : ordinaryDocs;
  const docs = uniqueDocs([...selectedDocs, ...requiredDocs]);
  const readFirstDocKeys = new Set(docs.map((doc) => `${doc.path}#${doc.anchor ?? ""}`));
  const background = uniqueDocs([
    ...ordinaryDocs.slice(selectedDocs.length),
    ...matchedFamilies.flatMap((family) => family.background),
  ]).filter((doc) => !readFirstDocKeys.has(`${doc.path}#${doc.anchor ?? ""}`));
  const scopedContext = unique([
    ...discoverScopedContext(changedFiles),
    ...matchedFamilies.flatMap((family) => family.scopedContext),
  ]);
  const checks = unique(matchedFamilies.flatMap((family) => family.checks));
  const hardRules = unique(matchedFamilies.flatMap((family) => family.hardRules));
  const warnings = buildWarnings(changedFiles);
  const ownedFiles = new Set(matchedFamilies.flatMap((family) => family.matchedFiles));
  const unmappedPaths = changedFiles.filter((file) => !ownedFiles.has(file));
  for (const file of unmappedPaths) {
    warnings.push(`Missing documentation owner for ${file}; search docs/ and add the recurring source area to docs/doc-ownership.json before relying on this route.`);
  }

  return {
    background,
    changedFiles,
    checks: unmappedPaths.length > 0 ? [] : checks,
    deploy: {
      deployImpact: hasDeployImpact(changedFiles),
      pagesImpact: hasPagesDeployImpact(changedFiles),
      workerImpact: hasWorkerDeployImpact(changedFiles),
    },
    docs,
    requiredDocs,
    contextMode,
    hardRules,
    mappings: matchedFamilies.map((family) => ({
      id: family.id,
      label: family.label,
      matchedFiles: family.matchedFiles,
      risk: family.risk,
      tier: family.tier,
    })),
    scopedContext,
    source,
    unmappedPaths,
    warnings,
  };
}

interface ContextSize {
  bytes: number;
  characters: number;
  lines: number;
  approximateTokens: number;
}

interface ContextRange extends ContextSize {
  startLine: number;
  endLine: number;
}

interface ContextReference extends DocReference, ContextRange {
  kind: "root" | "scoped" | "primary";
  requiredReason: string;
}

export interface RouteContext {
  class: RouteClass;
  ceiling: number;
  status: "within-budget" | "over-budget";
  remediation?: string;
  scope: string;
  references: ContextReference[];
  files: Array<ContextSize & { path: string; ranges: ContextRange[] }>;
  total: ContextSize;
  background: DocReference[];
  excluded: string[];
}

interface RouteContextDocument {
  content: string;
  document?: MarkdownSections;
}

export type RouteContextDocumentCache = Map<string, RouteContextDocument>;

function contextSize(content: string): ContextSize {
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    characters: content.length,
    lines: content.length === 0 ? 0 : content.split("\n").length - Number(content.endsWith("\n")),
    approximateTokens: Math.ceil(content.length / 4),
  };
}

function sumContextSizes(sizes: readonly ContextSize[]): ContextSize {
  const total = { bytes: 0, characters: 0, lines: 0, approximateTokens: 0 };
  for (const size of sizes) {
    total.bytes += size.bytes;
    total.characters += size.characters;
    total.lines += size.lines;
  }
  total.approximateTokens = Math.ceil(total.characters / 4);
  return total;
}

/**
 * Explicit route-rendering boundary: no document reads in classification,
 * focused check selection, or hooks. By default the document snapshot lasts
 * one invocation. A batch reader may share `documents` while files are
 * unchanged; discard that cache after any edit. Ranges always remain per-route.
 */
export function buildRouteContext(
  contract: Pick<ChangeContract, "docs" | "scopedContext" | "background"> &
    Partial<Pick<ChangeContract, "requiredDocs" | "changedFiles" | "mappings">>,
  { repoRoot = REPO_ROOT, documents = new Map() }: {
    repoRoot?: string;
    documents?: RouteContextDocumentCache;
  } = {},
): RouteContext {
  const { parseMarkdownSections, resolveMarkdownSectionRange, mergeMarkdownSectionRanges } =
    require("./doc-markdown.mts") as typeof DocMarkdown;
  const cache = new Map<string, {
    path: string;
    source: RouteContextDocument;
    ranges: MarkdownSectionRange[];
  }>();
  const references: ContextReference[] = [];
  const seen = new Set<string>();
  const requested: Array<DocReference & Pick<ContextReference, "kind" | "requiredReason">> = [
    { path: "AGENTS.md", kind: "root", requiredReason: "Root repository instructions" },
    ...contract.scopedContext.map((path) => ({
      path, kind: "scoped" as const, requiredReason: "Applicable scoped instructions",
    })),
    ...contract.docs.map((doc) => ({
      ...doc, kind: "primary" as const, requiredReason: contract.requiredDocs?.some((required) =>
        required.path === doc.path && required.anchor === doc.anchor)
        ? "Required ownership reference (not subject to the reading cap)" : "Selected primary ownership reference",
    })),
  ];
  for (const reference of requested) {
    try {
      let absolute = resolve(repoRoot, reference.path);
      // The Claude facade imports the authored root; it is not a second body.
      if (absolute === resolve(repoRoot, "CLAUDE.md") && readFileSync(absolute, "utf8").trim() === "@AGENTS.md") {
        absolute = resolve(repoRoot, "AGENTS.md");
      }
      const canonical = realpathSync(absolute);
      const key = `${canonical}#${reference.anchor ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let file = cache.get(canonical);
      if (!file) {
        let source = documents.get(canonical);
        if (!source) {
          source = { content: readFileSync(canonical, "utf8") };
          documents.set(canonical, source);
        }
        file = { path: normalizeRepoPath(relative(realpathSync(repoRoot), canonical)), source, ranges: [] };
        cache.set(canonical, file);
      }
      let range: MarkdownSectionRange;
      if (reference.anchor !== undefined) {
        file.source.document ??= parseMarkdownSections(file.source.content);
        range = resolveMarkdownSectionRange(file.source.document, reference.anchor);
      } else {
        range = { start: 0, end: file.source.content.length, startLine: 0, endLine: file.source.content.split("\n").length };
      }
      file.ranges.push(range);
      const size = contextSize(file.source.content.slice(range.start, range.end));
      references.push({
        path: file.path,
        ...(reference.anchor === undefined ? {} : { anchor: reference.anchor }),
        kind: reference.kind,
        requiredReason: reference.requiredReason,
        startLine: range.startLine + 1,
        endLine: range.startLine + size.lines,
        ...size,
      });
    } catch (error) {
      throw new Error(`Cannot account for ${formatDocReference(reference)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const files = [...cache.values()].map((file) => {
    const ranges = mergeMarkdownSectionRanges(file.ranges).map((range) => {
      const size = contextSize(file.source.content.slice(range.start, range.end));
      return { startLine: range.startLine + 1, endLine: range.startLine + size.lines, ...size };
    });
    return { path: file.path, ranges, ...sumContextSizes(ranges) };
  });
  const routeClass = classifyRouteContext({
    changedFiles: contract.changedFiles ?? [], mappings: contract.mappings ?? [],
  });
  const ceiling = ROUTE_CONTEXT_CEILINGS[routeClass];
  const total = sumContextSizes(files);
  return {
    class: routeClass,
    ceiling,
    status: total.bytes > ceiling ? "over-budget" : "within-budget",
    ...(total.bytes > ceiling ? {
      remediation: "Use bounded owner sections or a reviewed ceiling change. For batches, route smaller explicit path groups, each retaining its shared obligations; send the full file set to the check planner.",
    } : {}),
    scope: "Initial routed documents only; UTF-8 bytes include retained source newlines",
    references,
    files,
    total,
    background: contract.background,
    excluded: [
      "Conditional background references and additional reads mandated by scoped guides",
      "Source and test bodies, skills, framework guides, and route-envelope text",
    ],
  };
}

function buildWarnings(changedFiles: readonly string[]): string[] {
  const warnings: string[] = [];
  if (changedFiles.some((file) => file.startsWith("src/components/ui/"))) {
    warnings.push("src/components/ui contains shadcn primitives; edit only when explicitly required.");
  }
  if (changedFiles.some((file) => file.startsWith("worker/migrations/"))) {
    warnings.push("D1 migrations are applied before the new Worker is live; keep them backward-compatible.");
  }
  if (changedFiles.some((file) => file.startsWith("shared/data/stablecoins/"))) {
    warnings.push("Stablecoin data changes must not introduce manual supply overrides.");
  }
  return warnings;
}

export function readChangedFiles({
  baseRef,
  execFile = execFileSync as GitExec,
  headRef,
  staged = false,
}: ChangedFileOptions = {}): string[] {
  const mode = staged
    ? { kind: "staged" as const, noRenames: true }
    : baseRef || headRef
      ? { kind: "range" as const, base: baseRef || "origin/main", head: headRef || "HEAD", noRenames: true }
      : { kind: "working" as const, includeUntracked: true, noRenames: true };
  return normalizeChangedFiles(collectGitPaths(mode, { cwd: REPO_ROOT, execFile }));
}
export { normalizeChangedFiles } from "./change-contract-common.ts";
