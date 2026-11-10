/**
 * Nightly test tier: one authority for its file suffix, Vitest tag and the
 * PR-tier pointer every nightly file must name.
 *
 * The PR tier cannot afford registry-wide sweeps, full-corpus replays or long
 * resource probes, so those cases belong to the nightly full suite. Two
 * mechanisms select the tier, and both run the same vocabulary:
 *
 * - File level: `*.nightly.test.ts(x)` is excluded from the static PR planner
 *   universe (`pr-import-graph.mts`) and from the PR selection union
 *   (`pr-test-selection.mts`), while `npm test` and the nightly `full-tests`
 *   shards run the whole execution universe, so the file stays covered there.
 * - Case level: a `nightly`-tagged `test`/`describe` case runs everywhere
 *   except the PR runner (`run-pr-tests.ts`), which appends
 *   `--tagsFilter=!nightly`. Untagged cases pass `!nightly`, so the filter can
 *   only ever remove the tier. The vocabulary is declared in `vitest.config.ts`
 *   with `strictTags`, so a misspelled tag fails collection instead of
 *   silently changing a tier.
 *
 * A tier move removes PR signal, so each nightly file names the PR-tier test
 * or guard that keeps its behavior visible before merge, and
 * `scripts/ci/check-test-tier.ts` rejects a nightly file or case inside the
 * always-run/critical lists that are the PR tier's safety net.
 */
import { collectSourceFilesUnderRoots } from "./source-files.mts";

/** Vitest `test.tags`/`describe` tag, declared in `vitest.config.ts`. */
export const NIGHTLY_TEST_TAG = "nightly";

/**
 * The PR runner's tag filter. `!nightly` keeps every untagged case and drops
 * only the tier, so appending it can never widen a caller's own selection.
 */
export const PR_TIER_TAGS_FILTER = `!${NIGHTLY_TEST_TAG}`;
export const PR_TIER_VITEST_ARGS: readonly string[] = [`--tagsFilter=${PR_TIER_TAGS_FILTER}`];

/** File-level tier: `npm test`/nightly keep the file; PR selection never selects it. */
export const NIGHTLY_TEST_FILE_PATTERN = /\.nightly\.test\.[cm]?[jt]sx?$/;

/**
 * The header line every nightly file carries, naming the PR-tier test or guard
 * that keeps its behavior visible before merge:
 * `// Nightly tier: PR coverage retained by scripts/__tests__/owner.test.ts`.
 */
export const NIGHTLY_TIER_HEADER_PATTERN = /^\/\/ Nightly tier: PR coverage retained by (\S+)\s*$/m;

/** Roots the executable Vitest projects scan for test files. */
const NIGHTLY_TEST_SCAN_ROOTS = ["src", "shared", "worker", "functions", "scripts"] as const;
const TEST_FILE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
// `tags: ["nightly"]`, `tags: "nightly"` and multi-line arrays.
const TAGS_OPTION = /\btags\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/g;
const NIGHTLY_TAG_VALUE = /["'`]nightly["'`]/;

export function isNightlyTestFile(file: string): boolean {
  return NIGHTLY_TEST_FILE_PATTERN.test(file.replaceAll("\\", "/"));
}

/** The PR-tier test or guard a nightly file names; null when the header is absent. */
export function readNightlyTierPointer(source: string): string | null {
  return NIGHTLY_TIER_HEADER_PATTERN.exec(source)?.[1] ?? null;
}

/**
 * Whether a test source tags a case `nightly`. Textual on purpose: the guard
 * runs before Vitest loads a module, and a case-level tier needs no execution.
 * Whole-line and block comments are stripped so an explanatory `// tags: ...`
 * line cannot fail the guard; a trailing `//` is left in place, so a tag hidden
 * after one still fails closed.
 */
export function declaresNightlyTag(source: string): boolean {
  const scanned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
  return [...scanned.matchAll(TAGS_OPTION)].some((match) => NIGHTLY_TAG_VALUE.test(match[1] ?? ""));
}

/** Every nightly-tier file in the checkout (repo-relative, sorted). */
export function collectNightlyTestFiles(cwd = process.cwd()): string[] {
  return collectSourceFilesUnderRoots(NIGHTLY_TEST_SCAN_ROOTS, cwd, {
    extensions: TEST_FILE_EXTENSIONS,
    excludedDirs: ["node_modules", "dist"],
    skipDotEntries: true,
  }).filter((file) => isNightlyTestFile(file));
}

/**
 * Append the PR-tier tag filter. `--tagsFilter` values apply with AND, so a
 * caller that passes its own expression is narrowed further, never widened.
 */
export function withPrTierVitestArgs(args: readonly string[]): string[] {
  return [...args, ...PR_TIER_VITEST_ARGS];
}
