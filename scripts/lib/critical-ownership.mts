import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";

import { collectSourceFilesUnderRoot } from "./source-files.mts";

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

export const ISOLATED_NODE_TESTS = [
  "scripts/__tests__/remote-d1.test.ts",
  "scripts/__tests__/serve-static-export.test.ts",
  "shared/lib/__tests__/psi-eligible.test.ts",
  "shared/lib/__tests__/stablecoin-id-registry.test.ts",
];
export const THREADED_WORKER_TESTS = [
  "worker/src/lib/__tests__/safety-score-v9-native-input-pipeline.test.ts",
];
export const EXECUTABLE_TEST_PROJECTS = [
  { name: "node", include: ["{functions,scripts,shared}/**/*.{test,spec}.?(c|m)[jt]s?(x)"], exclude: ISOLATED_NODE_TESTS },
  { name: "node-isolated", include: ISOLATED_NODE_TESTS, exclude: [] },
  { name: "worker", include: ["worker/**/*.{test,spec}.?(c|m)[jt]s?(x)"], exclude: THREADED_WORKER_TESTS },
  { name: "worker-threads", include: THREADED_WORKER_TESTS, exclude: [] },
  { name: "src", include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"], exclude: [] },
];

export function assertExecutableTestFiles(
  files: readonly string[],
  { cwd = process.cwd(), exists = (path: string) => existsSync(path) && statSync(path).isFile(), projects = EXECUTABLE_TEST_PROJECTS } = {},
): void {
  if (files.length === 0) throw new Error("Empty executable test selection");
  for (const input of files) {
    const file = normalizeOwnershipPath(isAbsolute(input) ? relative(cwd, input) : input);
    const owners = projects.filter((project) =>
      project.include.some((pattern) => matchesGlob(file, pattern))
      && !project.exclude.some((pattern) => matchesGlob(file, pattern)));
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
export const CRITICAL_OWNERSHIP_WAIVERS: Readonly<Record<string, string>> = {
  "functions/lib/pages-proxy-harness.ts": "no importing test at 2026-09-03 cutover",
  "functions/lib/proxy-paths.ts": "no importing test at 2026-09-03 cutover",
  "shared/lib/liquidity-score-weights.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/cron/depeg-detection/hydration.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/cron/depeg-detection/native-quote-policy.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/cron/depeg-resolver/constants.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/cron/depeg-resolver/options.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/cron/depeg-resolver/persistence.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/cron/sync-live-reserves-finalize.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/cap-cusd.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/idle-cdo-tranche.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/index.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/infinifi-iusd.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/inherited-tracked.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/protocol-par.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/protocol-redeem-provider.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/authoritative-price-sources/rate-cache.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/depeg-resolver-methodology.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/depeg-resolver-store-validators.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/freshness-sentinels.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/geckoterminal-price-probe-stats.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/live-reserves/store-overview.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/live-reserves/store-read.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/live-reserves/store-snapshot-state.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/live-reserves/store-views.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/capture.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/curated-single-route-supply.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/extension-oracle.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/extension-wrapper-allocation.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/fact-set-backing.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/fact-set-boundary.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/fact-set-control.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/fact-set-exit.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/fact-set-operational-resilience.ts": "no importing test at 2026-09-03 cutover",
  "worker/src/lib/safety-score-v9/fact-set-peg-supply.ts": "no importing test at 2026-09-03 cutover",
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
 * Package imports are intentionally ignored; only paths that
 * resolve inside this checkout can own a critical source.
 */
export function resolveCriticalImport(
  specifier: string,
  importer: string,
  cwd = process.cwd(),
  fsImpl: CriticalOwnershipFs = { existsSync, readFileSync, statSync },
): string | null {
  let modulePath: string;
  if (specifier.startsWith("@shared/")) modulePath = specifier.slice("@shared/".length) ? `shared/${specifier.slice("@shared/".length)}` : "shared";
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

/** Derive source → importing test files from each test's static or dynamic imports. */
export function deriveCriticalOwnership({
  cwd = process.cwd(),
  testFiles = collectCriticalOwnershipTestFiles(cwd),
  sourceFiles,
  fsImpl = { existsSync, readFileSync, statSync },
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
  waivers: Readonly<Record<string, string>> = CRITICAL_OWNERSHIP_WAIVERS,
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


type BaseBlobExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; input?: string; maxBuffer?: number },
) => string;

// `git cat-file --batch` buffers every requested blob in one response; the
// default 1 MiB `execFileSync` buffer overflows on a large test-file diff.
const BASE_BLOB_BATCH_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Read a set of base-revision blobs in a single `git cat-file --batch -Z`
 * invocation. NUL-terminated records make each blob's content recoverable
 * without a byte-precise header parse, and one subprocess replaces the former
 * per-file `git show` fan-out on a blob:none partial clone.
 */
function readBaseBlobs(
  ref: string,
  paths: readonly string[],
  execFile: BaseBlobExec,
): Map<string, string> {
  const specs = paths.map((path) => `${ref}:${normalizeOwnershipPath(path)}`);
  const output = execFile("git", ["cat-file", "--batch", "-Z"], {
    encoding: "utf8",
    input: specs.map((spec) => `${spec}\0`).join(""),
    maxBuffer: BASE_BLOB_BATCH_MAX_BUFFER,
  });
  const records = output.split("\0");
  const contents = new Map<string, string>();
  let record = 0;
  for (let index = 0; index < specs.length; index++) {
    const header = records[record++];
    if (header === undefined) break;
    if (header.endsWith(" missing")) continue; // absent at `ref` (new file)
    contents.set(normalizeOwnershipPath(paths[index]), records[record++] ?? "");
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
  const inventory = new Set(execFile("git", ["ls-tree", "-r", "--name-only", "-z", ref], { encoding: "utf8" }).split("\0").filter(Boolean));
  const existingTests = tests.filter((file) => inventory.has(file));
  if (existingTests.length === 0) return new Map();
  const contents = readBaseBlobs(ref, existingTests, execFile);
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
