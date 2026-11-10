import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { collectSourceFilesUnderRoot, collectSourceFilesUnderRoots } from "./source-files.mts";
import { cachedGlobMatcher } from "./glob-matcher.mts";
import { resolveLocalPackageImport } from "./package-imports.mts";

const TEST_SCAN_ROOTS = [
  "src",
  "shared",
  "worker",
  "functions",
  "scripts",
] as const;
const TEST_FILE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const RESOLVABLE_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

// Declared before the worker-shared classification below, which reads support
// modules through this filesystem while the module graph initializes.
const ownershipFs: CriticalOwnershipFs = { existsSync, readFileSync, realpathSync, statSync };

export const ISOLATED_NODE_TESTS = [
  // The route's cached import must not retain this suite's evidence-free
  // recomputer mock when canonical snapshot integration tests run afterward.
  "functions/__tests__/selector-snapshot.test.ts",
  "scripts/__tests__/remote-d1.test.ts",
  // Its vi.mock of collectChangedFiles only applies when this file loads the
  // runner first; under isolate:false a sibling suite that already imported
  // run-pr-checks leaves the real git-backed implementation cached.
  "scripts/__tests__/run-pr-checks-execution.test.ts",
  // Its vi.mock("node:fs") read patch must reach the router's fs binding, which
  // only happens when this file loads the router first in its own module cache.
  "scripts/__tests__/pharos-change-contract.test.ts",
  "scripts/__tests__/serve-static-export.test.ts",
  "shared/lib/__tests__/psi-eligible.test.ts",
  "shared/lib/__tests__/stablecoin-id-registry.test.ts",
  // vi.mock("vitest") only intercepts mock-d1's onTestFinished import when
  // this file owns the module cache; under isolate:false another node-project
  // file that imports mock-d1 first leaves the real binding in place.
  "shared/test-utils/__tests__/mock-d1.test.ts",
];
export const THREADED_WORKER_TESTS = [
  "worker/src/lib/__tests__/safety-score-v9-native-input-pipeline.test.ts",
];

// Phased non-isolated worker project: `worker/src/{cron,lib}` suites that own
// no per-file module state run in the shared `worker-shared` project (the
// reserve-adapter pilot directory was the first tranche). Everything else stays
// in the isolated `worker` project, so the classifier is deliberately
// fail-closed: an unknown input (unreadable file, new mock or global-stub
// pattern) runs isolated.
const WORKER_SHARED_TEST_ROOTS = ["worker/src/cron", "worker/src/lib"] as const;
// Every `process.env` write form: plain/compound assignment on the object or a
// key, increment/decrement, `delete`, and an in-place `Object.assign`.
const PROCESS_ENV_WRITE_PATTERNS = [
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded single-line match over repo-controlled test sources
  /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])?\s*(?:\*\*|&&|\|\||\?\?|[-+*/%])?=(?!=)/,
  /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:\+\+|--)/,
  /delete\s+process\.env\b/,
  /Object\.assign\s*\(\s*process\.env\b/,
] as const;
const WORKER_SHARED_INELIGIBLE_PATTERNS = [
  /vi\.mock\s*\(/,
  /vi\.doMock\s*\(/,
  /vi\.resetModules\s*\(/,
  /vi\.hoisted\s*\(/,
  ...PROCESS_ENV_WRITE_PATTERNS,
] as const;

// Module-scope mutable state that one shared module cache would carry into the
// next test file. Matching stays textual because `vitest.config.ts` imports
// this module before install, so no TypeScript parser is available.
const MODULE_SCOPE_LET =
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded single-line match over repo-controlled support modules
  /^(?:export\s+)?(?:let|var)\s+[A-Za-z_$][\w$]*/m;
const MODULE_SCOPE_COLLECTION =
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded single-line match over repo-controlled support modules
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*[^=\n]*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\s*[<(]/m;
const MODULE_SCOPE_LITERAL =
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded single-line match over repo-controlled support modules
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*[[{]/gm;

function moduleScopeLiteralIsWritten(source: string, name: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-regexp -- interpolates a captured identifier name, not caller input
  return new RegExp(
    `(?<!const\\s)(?<!let\\s)(?<!var\\s)\\b${name}\\b\\s*(?:\\[[^\\]]*\\]|\\.\\w+)?\\s*(?:[-+*/%]?=(?!=)|\\+\\+|--|\\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)\\s*\\()`,
  ).test(source);
}

// eslint-disable-next-line security/detect-non-literal-regexp -- the hook name comes from the reviewed WORKER_SHARED_RESET_HOOKS map
const RESET_HOOK_EXPORT = (hook: string) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${hook}\\b`);
// eslint-disable-next-line security/detect-non-literal-regexp -- the hook name comes from the reviewed WORKER_SHARED_RESET_HOOKS map
const RESET_HOOK_CALL = (hook: string) => new RegExp(`\\b${hook}\\s*\\(`);

/** True when a module keeps mutable state a shared module cache would carry
 * into the next test file. */
export function hasModuleScopeMutableState(source: string): boolean {
  if (MODULE_SCOPE_LET.test(source) || MODULE_SCOPE_COLLECTION.test(source)) return true;
  for (const match of source.matchAll(MODULE_SCOPE_LITERAL)) {
    if (match[1] && moduleScopeLiteralIsWritten(source, match[1])) return true;
  }
  return false;
}

// Local helper/support modules own part of a test file's state.
const SUPPORT_MODULE_PATH = /(?:^|\/)(?:test-helpers|test-utils|__mocks__)\/|\.test-support\.[cm]?[jt]sx?$/;
// A support module's state is safe only when it exports the reset hook the
// shared-isolation setup runs after every test.
const WORKER_SHARED_RESET_HOOKS: Readonly<Record<string, string>> = {
  "worker/src/cron/reserve-adapters/__tests__/erc4626-single-asset.test-support.ts": "resetErc4626NetworkForTests",
};
const WORKER_SHARED_ISOLATION_SETUP_PATH = "worker/src/test-helpers/setup-shared-isolation.ts";

/** True when a `worker/src/{cron,lib}` test source can share one module cache. */
export function isWorkerSharedTestEligible(source: string): boolean {
  if (WORKER_SHARED_INELIGIBLE_PATTERNS.some((pattern) => pattern.test(source))) return false;
  if (/vi\.stubGlobal\s*\(/.test(source) && !/vi\.unstubAllGlobals\s*\(/.test(source)) return false;
  if (/vi\.stubEnv\s*\(/.test(source) && !/vi\.unstubAllEnvs\s*\(/.test(source)) return false;
  return true;
}

// Files that pass the source scan but failed a shuffled shared-process run.
// Each keeps per-file isolation (the value names the observed failure); remove
// the entry only after the cause is fixed and the stability protocol passes
// again.
export const WORKER_SHARED_ISOLATED_OVERRIDES: Readonly<Record<string, string>> = {
  "worker/src/cron/reserve-adapters/__tests__/frax.test.ts":
    "Asserts the complete request URL set immediately after a rejection; a stray in-flight retry from an earlier shared file can append a URL.",
  "worker/src/cron/reserve-adapters/__tests__/request.test.ts":
    "Asserts exact fetch call counts; a preceding shared file's pending retry can consume its scripted mock.",
  "worker/src/cron/reserve-adapters/__tests__/usdd-data-platform.test.ts":
    "Asserts a real 5 s abort wait completes within 9 s; CPU contention under default shared-process parallelism made that timing assertion flaky.",
  "worker/src/lib/__tests__/safety-score-v9-extension-reserves.test.ts":
    "Its executed cases leave module-singleton state that suppresses the route-compilation spy in safety-score-v9-fact-set-exit-coverage.test.ts > \"resolves one policy per fixed input without leaking another capture's clock\"; an import-only run of this file leaves that suite green.",
  "worker/src/lib/__tests__/safety-score-v9-fact-set-exit-coverage.test.ts":
    "Asserts exact route-compiler spy call counts; once any earlier shared file has compiled a route the compiler's module-level caches are warm, so the spy records no call. Passes as the only file in its fork.",
};

/** Classify the current `worker/src/{cron,lib}` candidate files once per process. */
export function collectWorkerSharedTestFiles(cwd = process.cwd()): string[] {
  return collectSourceFilesUnderRoots(WORKER_SHARED_TEST_ROOTS, cwd, {
    extensions: TEST_FILE_EXTENSIONS,
    excludedDirs: ["node_modules", "dist"],
    skipDotEntries: true,
  })
    .filter((file) => file.split("/").includes("__tests__") && TEST_FILE_PATTERN.test(file))
    .filter((file) => !THREADED_WORKER_TESTS.includes(file))
    .filter((file) => !Object.hasOwn(WORKER_SHARED_ISOLATED_OVERRIDES, file))
    .filter((file) => {
      try {
        const source = readFileSync(resolve(cwd, file), "utf8");
        return isWorkerSharedTestEligible(source)
          && findUnresetMutableSupportImports(file, source, cwd).length === 0;
      } catch {
        return false;
      }
    })
    .sort();
}

export const WORKER_SHARED_TEST_FILES = collectWorkerSharedTestFiles();

export const EXECUTABLE_TEST_PROJECTS = [
  { name: "node", include: ["{functions,scripts,shared}/**/*.{test,spec}.?(c|m)[jt]s?(x)"], exclude: ISOLATED_NODE_TESTS },
  { name: "node-isolated", include: ISOLATED_NODE_TESTS, exclude: [] },
  { name: "worker", include: ["worker/**/*.{test,spec}.?(c|m)[jt]s?(x)"], exclude: [...THREADED_WORKER_TESTS, ...WORKER_SHARED_TEST_FILES] },
  ...(WORKER_SHARED_TEST_FILES.length > 0
    ? [{ name: "worker-shared", include: WORKER_SHARED_TEST_FILES, exclude: [] }]
    : []),
  { name: "worker-threads", include: THREADED_WORKER_TESTS, exclude: [] },
  { name: "src", include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"], exclude: [] },
];

interface CompiledTestProject {
  include: ((file: string) => boolean)[];
  exclude: ((file: string) => boolean)[];
}

/** Compile the constant project patterns once: `matchesGlob` parses per call, not per pattern. */
function compileTestProjects(
  projects: readonly { include: readonly string[]; exclude: readonly string[] }[],
): CompiledTestProject[] {
  return projects.map((project) => ({
    include: project.include.map(cachedGlobMatcher),
    exclude: project.exclude.map(cachedGlobMatcher),
  }));
}

const EXECUTABLE_TEST_MATCHERS = compileTestProjects(EXECUTABLE_TEST_PROJECTS);

export function assertExecutableTestFiles(
  files: readonly string[],
  { cwd = process.cwd(), exists = (path: string) => existsSync(path) && statSync(path).isFile(), projects = EXECUTABLE_TEST_PROJECTS } = {},
): void {
  if (files.length === 0) throw new Error("Empty executable test selection");
  const matchers = projects === EXECUTABLE_TEST_PROJECTS ? EXECUTABLE_TEST_MATCHERS : compileTestProjects(projects);
  for (const input of files) {
    const file = normalizeOwnershipPath(isAbsolute(input) ? relative(cwd, input) : input);
    const owners = matchers.filter((project) =>
      project.include.some((matcher) => matcher(file))
      && !project.exclude.some((matcher) => matcher(file)));
    if (!TEST_FILE_PATTERN.test(file) || owners.length !== 1 || !exists(resolve(cwd, file))) {
      throw new Error(`Invalid executable test ${file}: expected an existing file owned by exactly one project (found ${owners.length})`);
    }
  }
}

export type CriticalOwnership = ReadonlyMap<string, readonly string[]>;

export interface CriticalOwnershipFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  statSync?(path: string): { isFile(): boolean };
  realpathSync?(path: string): string;
}

export interface CriticalOwnershipOptions {
  cwd?: string;
  testFiles?: readonly string[];
  sourceFiles?: Iterable<string>;
  fsImpl?: CriticalOwnershipFs;
}

// These candidate sources were already critical at the 2026-09-03 cutover but
// have no static importing test. Keep the gap visible without turning the
// generated ownership set into a false claim of coverage. A new unowned
// candidate is still a completeness failure.
export interface CriticalOwnershipWaiver {
  reason: string;
  reviewAfter: string;
}

export const CRITICAL_OWNERSHIP_WAIVERS: Readonly<Record<string, CriticalOwnershipWaiver>> = {
};

export function normalizeOwnershipPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function collectCriticalOwnershipTestFiles(cwd = process.cwd()): string[] {
  const files = TEST_SCAN_ROOTS.flatMap((root) =>
    collectSourceFilesUnderRoot(root, cwd, {
      extensions: TEST_FILE_EXTENSIONS,
      excludedDirs: ["node_modules", "dist"],
      skipDotEntries: true,
    }),
  );
  return [...new Set(files
    .filter((file) => TEST_FILE_PATTERN.test(file))
    .map((file) => normalizeOwnershipPath(relative(cwd, file))))].sort();
}

/**
 * Resolve the repository module named by a test's runtime import.
 * External packages are ignored; exact local package-private/workspace imports
 * and paths inside this checkout can own a critical source.
 */
export function resolveCriticalImport(
  specifier: string,
  importer: string,
  cwd = process.cwd(),
  fsImpl: CriticalOwnershipFs = ownershipFs,
): string | null {
  let modulePath: string;
  const target = resolveLocalPackageImport(specifier, cwd, fsImpl);
  if (target) modulePath = target;
  else if (specifier.startsWith("#")) return null;
  else if (specifier.startsWith("@shared/")) modulePath = specifier.slice("@shared/".length) ? `shared/${specifier.slice("@shared/".length)}` : "shared";
  else if (specifier.startsWith("@data/")) modulePath = `data/${specifier.slice("@data/".length)}`;
  else if (specifier.startsWith("@/")) modulePath = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith("./") || specifier.startsWith("../")) modulePath = join(dirname(importer), specifier);
  else if (specifier.startsWith("worker/") || specifier.startsWith("shared/") || specifier.startsWith("functions/") || specifier.startsWith("src/")) modulePath = specifier;
  else return null;

  const absoluteBase = resolve(cwd, modulePath);
  const relativeBase = normalizeOwnershipPath(relative(cwd, absoluteBase));
  if (!relativeBase || relativeBase === ".." || relativeBase.startsWith("../")) return null;

  const candidates = [absoluteBase];
  const explicitExtension = extname(absoluteBase);
  if (explicitExtension && RESOLVABLE_SOURCE_EXTENSIONS.includes(explicitExtension as (typeof RESOLVABLE_SOURCE_EXTENSIONS)[number])) {
    const withoutExtension = absoluteBase.slice(0, -explicitExtension.length);
    candidates.push(...RESOLVABLE_SOURCE_EXTENSIONS.map((extension) => `${withoutExtension}${extension}`));
  } else {
    candidates.push(...RESOLVABLE_SOURCE_EXTENSIONS.map((extension) => `${absoluteBase}${extension}`));
  }
  candidates.push(...RESOLVABLE_SOURCE_EXTENSIONS.map((extension) => join(absoluteBase, `index${extension}`)));

  for (const candidate of [...new Set(candidates)]) {
    if (!fsImpl.existsSync(candidate)) continue;
    if (fsImpl.statSync && !fsImpl.statSync(candidate).isFile()) continue;
    return normalizeOwnershipPath(relative(cwd, candidate));
  }
  return null;
}

function collectImportSpecifiers(source: string): string[] {
  // Lex strings/comments atomically so their text cannot manufacture imports.
  // This remains dependency-free for pre-install PR preflight (including TSX).
  const tokens = [...source.matchAll(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g,
  )].map(([token]) => token).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const specifiers = new Set<string>();
  const quoted = (token: string | undefined): token is string => token !== undefined && /^["']/.test(token);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "import" || tokens[index - 1] === ".") continue;
    if (tokens[index + 1] === "type" && tokens[index + 2] !== "from") continue;
    if (tokens[index + 1] === "{") {
      const end = tokens.indexOf("}", index + 2);
      const bindings = tokens.slice(index + 2, end).join(" ").split(",").map((binding) => binding.trim()).filter(Boolean);
      if (end >= 0 && bindings.length > 0 && bindings.every((binding) => /^type\s+\w/.test(binding))) continue;
    }
    let specifier: string | undefined;
    if (tokens[index + 1] === "(") {
      if (quoted(tokens[index + 2]) && [")", ","].includes(tokens[index + 3])) specifier = tokens[index + 2];
    } else if (quoted(tokens[index + 1])) {
      specifier = tokens[index + 1];
    } else {
      for (let cursor = index + 1; cursor < tokens.length && tokens[cursor] !== ";"; cursor++) {
        if (tokens[cursor] === "from" && quoted(tokens[cursor + 1])) {
          specifier = tokens[cursor + 1];
          break;
        }
      }
    }
    if (specifier) specifiers.add(specifier.slice(1, -1));
  }
  return [...specifiers];
}

/** Support modules the test imports (one level) that keep module-scope state no
 * reset hook restores. An unreadable or unresolvable local import is treated as
 * stateful so the caller keeps per-file isolation. */
export function findUnresetMutableSupportImports(
  testFile: string,
  source: string,
  cwd = process.cwd(),
  fsImpl: CriticalOwnershipFs = ownershipFs,
): string[] {
  const unreset = new Set<string>();
  let isolationSetup: string | null | undefined;
  for (const specifier of collectImportSpecifiers(source)) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    const resolved = resolveCriticalImport(specifier, testFile, cwd, fsImpl);
    if (!resolved) {
      unreset.add(specifier);
      continue;
    }
    if (!SUPPORT_MODULE_PATH.test(resolved)) continue;
    let moduleSource: string;
    try {
      moduleSource = fsImpl.readFileSync(resolve(cwd, resolved), "utf8");
    } catch {
      unreset.add(resolved);
      continue;
    }
    // A support module that registers mocks or writes process.env at module
    // scope keeps that registration in the shared module cache for every later
    // file in the process, so its importers stay isolated.
    if (WORKER_SHARED_INELIGIBLE_PATTERNS.some((pattern) => pattern.test(moduleSource))) {
      unreset.add(resolved);
      continue;
    }
    if (!hasModuleScopeMutableState(moduleSource)) continue;
    const hook = WORKER_SHARED_RESET_HOOKS[resolved];
    if (!hook || !RESET_HOOK_EXPORT(hook).test(moduleSource)) {
      unreset.add(resolved);
      continue;
    }
    if (isolationSetup === undefined) {
      try {
        isolationSetup = fsImpl.readFileSync(resolve(cwd, WORKER_SHARED_ISOLATION_SETUP_PATH), "utf8");
      } catch {
        isolationSetup = null;
      }
    }
    if (isolationSetup === null || !RESET_HOOK_CALL(hook).test(isolationSetup)) unreset.add(resolved);
  }
  return [...unreset];
}

/** Derive source → importing test files from each test's static or dynamic imports. */
export function deriveCriticalOwnership({
  cwd = process.cwd(),
  testFiles = collectCriticalOwnershipTestFiles(cwd),
  sourceFiles,
  fsImpl = ownershipFs,
}: CriticalOwnershipOptions = {}): Map<string, string[]> {
  const sourceFilter = sourceFiles
    ? new Set([...sourceFiles].map((file) => normalizeOwnershipPath(isAbsolute(file) ? relative(cwd, file) : file)))
    : null;
  const ownership = new Map<string, Set<string>>();
  if (testFiles.length > 0) assertExecutableTestFiles(testFiles, { cwd, exists: fsImpl.existsSync });
  for (const inputTestFile of testFiles) {
    const testFile = normalizeOwnershipPath(isAbsolute(inputTestFile) ? relative(cwd, inputTestFile) : inputTestFile);
    const source = fsImpl.readFileSync(resolve(cwd, testFile), "utf8");
    for (const specifier of collectImportSpecifiers(source)) {
      const resolved = resolveCriticalImport(specifier, testFile, cwd, fsImpl);
      if (!resolved || (sourceFilter && !sourceFilter.has(resolved))) continue;
      const owners = ownership.get(resolved) ?? new Set<string>();
      owners.add(testFile);
      ownership.set(resolved, owners);
    }
  }
  return new Map([...ownership.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, tests]) => [source, [...tests].sort()]));
}

export function findCriticalOwnershipGaps(
  enrolledSources: Iterable<string>,
  ownership: CriticalOwnership,
  waivers: Readonly<Record<string, unknown>> = CRITICAL_OWNERSHIP_WAIVERS,
): string[] {
  const waived = new Set(Object.keys(waivers));
  return [...new Set([...enrolledSources].map(normalizeOwnershipPath))]
    .filter((source) => (ownership.get(source)?.length ?? 0) === 0 && !waived.has(source))
    .sort();
}

export function collectOwningTests(
  sourceFiles: Iterable<string>,
  ownership: CriticalOwnership,
): string[] {
  const tests = new Set<string>();
  for (const source of sourceFiles) {
    for (const test of ownership.get(normalizeOwnershipPath(source)) ?? []) tests.add(test);
  }
  return [...tests].sort();
}


export type BaseBlobExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8" | null; input?: string; maxBuffer?: number },
) => string | Buffer;

// `git cat-file --batch` buffers every requested blob in one response; the
// default 1 MiB `execFileSync` buffer overflows on a large test-file diff.
const BASE_BLOB_BATCH_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Read a set of base-revision blobs in a single `git cat-file --batch -Z`
 * invocation. Headers are NUL-terminated; bodies use the declared byte length
 * so embedded NULs cannot shift subsequent records. One subprocess replaces the former
 * per-file `git show` fan-out on a blob:none partial clone.
 */
function readBaseBlobs(
  ref: string,
  paths: readonly string[],
  execFile: BaseBlobExec,
): Map<string, string> {
  const specs = paths.map((path) => `${ref}:${normalizeOwnershipPath(path)}`);
  const output = execFile("git", ["cat-file", "--batch", "-Z"], {
    encoding: null,
    input: specs.map((spec) => `${spec}\0`).join(""),
    maxBuffer: BASE_BLOB_BATCH_MAX_BUFFER,
  });
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const contents = new Map<string, string>();
  let offset = 0;
  for (let index = 0; index < specs.length; index++) {
    const headerEnd = bytes.indexOf(0, offset);
    if (headerEnd < 0) throw new Error("Truncated base blob header");
    const header = bytes.toString("utf8", offset, headerEnd);
    offset = headerEnd + 1;
    if (header.endsWith(" missing")) continue;
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    const size = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size >= bytes.length || bytes[offset + size] !== 0) {
      throw new Error("Invalid base blob size or terminator");
    }
    contents.set(normalizeOwnershipPath(paths[index]), bytes.toString("utf8", offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

export function deriveBaseCriticalOwnership(
  ref: string,
  changedFiles: readonly string[],
  execFile: BaseBlobExec = execFileSync as BaseBlobExec,
): CriticalOwnership {
  const tests = changedFiles
    .map(normalizeOwnershipPath)
    .filter((file) => TEST_FILE_PATTERN.test(file) && TEST_SCAN_ROOTS.some((root) => file.startsWith(`${root}/`)));
  if (tests.length === 0) return new Map();
  const cwd = process.cwd();
  const inventory = new Set(execFile("git", ["ls-tree", "-r", "--name-only", "-z", ref], { encoding: "utf8" }).toString().split("\0").filter(Boolean));
  const existingTests = tests.filter((file) => inventory.has(file));
  if (existingTests.length === 0) return new Map();
  // Manifest data must come from the same revision as the importing tests,
  // never from current node_modules links or the working checkout.
  const manifests = [...inventory].filter((file) => file === "package.json" || file.endsWith("/package.json"));
  const contents = readBaseBlobs(ref, [...existingTests, ...manifests], execFile);
  return deriveCriticalOwnership({
    testFiles: existingTests,
    fsImpl: {
      existsSync: (file) => inventory.has(normalizeOwnershipPath(relative(cwd, file))),
      readFileSync: (file) => {
        const key = normalizeOwnershipPath(relative(cwd, file));
        const content = contents.get(key);
        if (content === undefined) throw new Error(`Base blob unavailable for ${key}`);
        return content;
      },
    },
  });
}
