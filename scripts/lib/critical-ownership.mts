import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { collectSourceFilesUnderRoot } from "./source-files.mts";

const TEST_SCAN_ROOTS = [
  "src",
  "shared/lib",
  "worker/src",
  "worker/scripts",
  "functions",
  "scripts/__tests__",
] as const;
const TEST_FILE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const RESOLVABLE_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IMPORT_KEYWORD_PATTERN = /\bimport\b/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/g;
const FROM_SPECIFIER_PATTERN = /from\s+["']([^"']+)["']/;
const SIDE_EFFECT_IMPORT_PATTERN = /^\s*["']([^"']+)["']/;
const VI_MOCK_PATTERN = /\bvi\.mock\s*\(\s*["']([^"']+)["']/g;

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
      excludedDirs: [],
      skipDotEntries: true,
    }),
  );
  return [...new Set(files
    .filter((file) => TEST_FILE_PATTERN.test(file))
    .map((file) => normalizeOwnershipPath(relative(cwd, file))))].sort();
}

/**
 * Resolve the repository module named by a test's static or dynamic import, or
 * vi.mock call. Package imports are intentionally ignored; only paths that
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
  const specifiers = new Set<string>();
  for (const match of source.matchAll(IMPORT_KEYWORD_PATTERN)) {
    const start = (match.index ?? 0) + match[0].length;
    if (source.slice(start).trimStart().startsWith("(")) continue;
    const statement = readImportStatement(source, start);
    const fromMatch = FROM_SPECIFIER_PATTERN.exec(statement);
    const sideEffectMatch = SIDE_EFFECT_IMPORT_PATTERN.exec(statement);
    if (fromMatch) specifiers.add(fromMatch[1]);
    else if (sideEffectMatch) specifiers.add(sideEffectMatch[1]);
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    const start = (match.index ?? 0) + match[0].length;
    const closingParen = source.indexOf(")", start);
    if (closingParen < 0) continue;
    const sideEffectMatch = SIDE_EFFECT_IMPORT_PATTERN.exec(source.slice(start, closingParen));
    if (sideEffectMatch) specifiers.add(sideEffectMatch[1]);
  }
  for (const match of source.matchAll(VI_MOCK_PATTERN)) specifiers.add(match[1]);
  return [...specifiers];
}

function readImportStatement(source: string, start: number): string {
  const semicolon = source.indexOf(";", start);
  const limit = semicolon >= 0 ? semicolon : source.length;
  const segment = source.slice(start, limit);
  const fromMatch = FROM_SPECIFIER_PATTERN.exec(segment);
  if (fromMatch) {
    const fromEnd = start + fromMatch.index + fromMatch[0].length;
    const newline = source.indexOf("\n", fromEnd);
    const end = newline >= 0 && newline < limit ? newline : limit;
    return source.slice(start, end);
  }
  const newline = source.indexOf("\n", start);
  return newline >= 0 && newline < limit ? source.slice(start, newline) : segment;
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

