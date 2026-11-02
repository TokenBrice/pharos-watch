#!/usr/bin/env tsx
/**
 * Anti-creep ratchet for the test corpus (docs/testing.md#test-corpus-budget).
 *
 * H2 keeps a committed ceiling on four volume metrics that need no test run:
 * test files, test bytes, test-support files and fixture bytes. Every metric is
 * measured over the Git index — ignored worktrees and generated copies never
 * count — so the check costs one `git ls-files` plus one `stat` per test file.
 * Growth fails; `npm run test-corpus:update` rewrites the file with
 * `Math.min(current, budget)` per metric, so a ceiling only ever moves down.
 *
 * H3 caps the test files one PR may add. It diffs against the same frozen
 * `PR_BASE_SHA` the other PR gates use, and `--metrics-only` is the nightly
 * mode: a schedule has no PR base, and skipping the cap there must be explicit
 * rather than an empty-diff guess. A missing base without `--metrics-only` is a
 * usage error, never a pass.
 *
 * `test-budget-override` (owner label) admits growth and the cap for one run
 * only. It never edits the budget file: an overridden ceiling stays where it
 * was, so the debt is visible to the next run. Raising a ceiling needs a
 * hand-edited, owner-approved commit; `test-corpus:update` cannot do it.
 *
 * The globs below are the single definition for both the metrics and the cap.
 * Test files mirror the executable-test pattern in `critical-ownership.mts`;
 * support modules mirror its `SUPPORT_MODULE_PATH` vocabulary. A path belongs
 * to the first bucket it matches (a test file inside a fixture tree is a test
 * file).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { collectGitPaths, splitNullDelimited } from "../lib/changed-files.mts";
import { CliUsageError, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const TEST_CORPUS_BUDGET_PATH = ".ci/test-corpus-budget.json";
/** One owner-tunable constant (R5): a PR may add at most this many test files. */
export const MAX_NEW_TEST_FILES = 2;
export const TEST_BUDGET_OVERRIDE_LABEL = "test-budget-override";

/** Executable test files: the same pattern `critical-ownership.mts` selects with. */
export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/**
 * Test-only support modules: the `SUPPORT_MODULE_PATH` vocabulary in
 * `critical-ownership.mts` (shared helpers, frontend helpers, `__mocks__`).
 */
export const TEST_SUPPORT_PATTERNS: readonly RegExp[] = [
  /\.test-support\.[cm]?[jt]sx?$/u,
  /(?:^|\/)(?:test-helpers|test-utils|__mocks__)\//u,
];
/** Test fixture corpora: every `fixtures`/`__fixtures__` directory. */
export const TEST_FIXTURE_PATTERNS: readonly RegExp[] = [/(?:^|\/)(?:fixtures|__fixtures__)\//u];

const METRIC_KEYS = ["testFiles", "testBytes", "testSupportFiles", "fixtureBytes"] as const;
export type TestCorpusMetricKey = (typeof METRIC_KEYS)[number];
export type TestCorpusMetrics = Record<TestCorpusMetricKey, number>;

/** What an over-budget metric asks the author to do. */
const METRIC_HINTS: Record<TestCorpusMetricKey, string> = {
  testFiles: "add cases to the owning suite instead of a new file; retire tests this change replaces",
  testBytes: "trim or retire tests; move corpus-wide cases to the nightly tier",
  testSupportFiles: "extend the existing `*.test-support.ts` instead of adding a sibling module",
  fixtureBytes: "shrink the fixture corpus and delete fixtures this change replaces",
};

const USAGE = `Usage: npm run check:test-corpus-budget -- [options]

Anti-creep guard for the test corpus (docs/testing.md#test-corpus-budget).

  H2  each metric in ${TEST_CORPUS_BUDGET_PATH} is a ceiling measured over the
      Git index; growth fails. \`npm run test-corpus:update\` lowers the
      ceilings to the current tree (never raises them).
  H3  a PR may add at most ${MAX_NEW_TEST_FILES} test files against its frozen base.

Options:
      --base=<ref>      Frozen PR base for the H3 diff (default: PR_BASE_SHA, GITHUB_BASE_SHA)
      --head=<ref>      Head under test (default: PR_HEAD_SHA, GITHUB_HEAD_SHA, HEAD)
      --metrics-only    Check H2 only; skip H3 (nightly and main runs, which have no PR base)
      --override        The ${TEST_BUDGET_OVERRIDE_LABEL} owner label is present; admits growth and the cap for this run only
      --update          Lower the committed ceilings to Math.min(current, budget); never evaluates H3
  -h, --help            Show this help

Exit codes: 0 within budget, 1 violation, 2 usage error.`;

const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();
export const TestCorpusBudgetSchema = z.strictObject({
  version: z.literal(1),
  note: z.string().min(1),
  metrics: z.strictObject({
    testFiles: NonNegativeIntegerSchema,
    testBytes: NonNegativeIntegerSchema,
    testSupportFiles: NonNegativeIntegerSchema,
    fixtureBytes: NonNegativeIntegerSchema,
  }),
});
export type TestCorpusBudget = z.output<typeof TestCorpusBudgetSchema>;

export interface TestCorpusFinding {
  readonly code: "budget" | "new-test-files";
  readonly detail: string;
}

type SizeOf = (path: string) => number;

/** Every path in the Git index, sorted. The index owns the corpus; the worktree does not. */
export function collectTrackedFiles(root: string = ROOT): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return [...new Set(splitNullDelimited(output))].sort();
}

/** The metric bucket a tracked path contributes to, or null when it is production/test-neutral. */
export function classifyTestCorpusPath(path: string): TestCorpusMetricKey | null {
  if (TEST_FILE_PATTERN.test(path)) return "testFiles";
  if (TEST_SUPPORT_PATTERNS.some((pattern) => pattern.test(path))) return "testSupportFiles";
  if (TEST_FIXTURE_PATTERNS.some((pattern) => pattern.test(path))) return "fixtureBytes";
  return null;
}

export interface TestCorpusSnapshot {
  readonly metrics: TestCorpusMetrics;
  /** Tracked paths that would enter a metric but could not be sized. */
  readonly unreadable: readonly string[];
}

/**
 * Measure the corpus from the tracked-file list. A tracked path that is absent
 * from the worktree is reported instead of silently shrinking a metric: the
 * gate fails on the unreadable path rather than certifying a smaller corpus.
 */
export function measureTestCorpus(
  files: readonly string[],
  { root = ROOT, sizeOf = (path: string) => statSync(path).size }: { root?: string; sizeOf?: SizeOf } = {},
): TestCorpusSnapshot {
  const metrics: TestCorpusMetrics = { testFiles: 0, testBytes: 0, testSupportFiles: 0, fixtureBytes: 0 };
  const unreadable: string[] = [];
  for (const file of files) {
    const bucket = classifyTestCorpusPath(file);
    if (bucket === null) continue;
    if (bucket === "testSupportFiles") {
      metrics.testSupportFiles += 1;
      continue;
    }
    let bytes: number;
    try {
      bytes = sizeOf(resolve(root, file));
    } catch {
      unreadable.push(file);
      continue;
    }
    if (bucket === "testFiles") {
      metrics.testFiles += 1;
      metrics.testBytes += bytes;
    } else {
      metrics.fixtureBytes += bytes;
    }
  }
  return { metrics, unreadable };
}

/** Test files this range adds. Rename detection stays off so a move counts as an add. */
export function collectAddedTestFiles({
  root = ROOT,
  base,
  head = "HEAD",
}: { root?: string; base: string; head?: string }): string[] {
  return collectGitPaths(
    { kind: "range", base, head, noRenames: true, diffFilter: "A" },
    { cwd: root },
  ).filter((file) => TEST_FILE_PATTERN.test(file));
}

function formatMetricLine(metrics: TestCorpusMetrics): string {
  return METRIC_KEYS.map((key) => `${key} ${metrics[key]}`).join(", ");
}

export interface TestCorpusEvaluationInput {
  readonly metrics: TestCorpusMetrics;
  readonly budget: TestCorpusMetrics;
  /** Null when H3 was not evaluated (`--metrics-only`). */
  readonly addedTestFiles: readonly string[] | null;
  readonly override: boolean;
}

/** Growth and cap findings, in that order. An override suppresses both. */
export function evaluateTestCorpusBudget({
  metrics,
  budget,
  addedTestFiles,
  override,
}: TestCorpusEvaluationInput): TestCorpusFinding[] {
  if (override) return [];
  const findings: TestCorpusFinding[] = [];
  for (const key of METRIC_KEYS) {
    const current = metrics[key];
    const ceiling = budget[key];
    if (current <= ceiling) continue;
    findings.push({
      code: "budget",
      detail:
        `${key}: ${current} > budget ${ceiling} (+${current - ceiling}). ` +
        `${METRIC_HINTS[key]}; \`npm run test-corpus:update\` only lowers the budget.`,
    });
  }
  if (addedTestFiles !== null && addedTestFiles.length > MAX_NEW_TEST_FILES) {
    findings.push({
      code: "new-test-files",
      detail:
        `${addedTestFiles.length} new test files > cap ${MAX_NEW_TEST_FILES}: ${addedTestFiles.join(", ")}. ` +
        "Add cases to the owning suite; a new file needs the `test-budget-override` label and a " +
        '"Test justification" section in the PR body.',
    });
  }
  return findings;
}

function readBudget(root: string): TestCorpusBudget {
  const path = resolve(root, TEST_CORPUS_BUDGET_PATH);
  if (!existsSync(path)) {
    throw new CliUsageError(
      `${TEST_CORPUS_BUDGET_PATH} is missing; run \`npm run test-corpus:update\` and commit the seeded budget`,
    );
  }
  const parsed = TestCorpusBudgetSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new CliUsageError(
      `${TEST_CORPUS_BUDGET_PATH} does not match the budget schema: ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

export interface TestCorpusWriter {
  write(value: string): unknown;
}

export interface TestCorpusCheckOptions {
  argv?: readonly string[];
  root?: string;
  stdout?: TestCorpusWriter;
  stderr?: TestCorpusWriter;
  env?: NodeJS.ProcessEnv;
  sizeOf?: SizeOf;
}

/**
 * CLI entry. Returns the process exit code: 0 within budget, 1 violation,
 * 2 usage error (thrown as `CliUsageError` for the shared wrapper).
 */
export function runTestCorpusBudgetCheck({
  argv = process.argv.slice(2),
  root = ROOT,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  sizeOf,
}: TestCorpusCheckOptions = {}): number {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [
      ["update", "override"],
      ["update", "metrics-only"],
      ["update", "base"],
      ["metrics-only", "base"],
    ],
    options: {
      base: { type: "string" },
      head: { type: "string" },
      update: { type: "boolean" },
      "metrics-only": { type: "boolean" },
      override: { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, stdout)) return 0;

  const files = collectTrackedFiles(root);
  const snapshot = measureTestCorpus(files, sizeOf === undefined ? { root } : { root, sizeOf });
  // An unmeasurable corpus is not a smaller corpus: never certify or ratchet down
  // on a metric that skipped a tracked test file.
  if (snapshot.unreadable.length > 0) return reportUnreadable(snapshot.unreadable, stderr);

  if (values.update === true) {
    const previous = existsSync(resolve(root, TEST_CORPUS_BUDGET_PATH)) ? readBudget(root).metrics : null;
    const next = Object.fromEntries(
      METRIC_KEYS.map((key) => [key, Math.min(snapshot.metrics[key], previous?.[key] ?? Infinity)]),
    ) as TestCorpusMetrics;
    const budget: TestCorpusBudget = {
      version: 1,
      note:
        "Downward-only ceilings for the test corpus (docs/testing.md#test-corpus-budget). Measured over the Git index by " +
        "scripts/ci/check-test-corpus-budget.ts; npm run test-corpus:update only lowers them. " +
        "Raising one needs an owner-approved edit.",
      metrics: next,
    };
    const target = resolve(root, TEST_CORPUS_BUDGET_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(budget, null, 2)}\n`);
    stdout.write(`test corpus: ${formatMetricLine(snapshot.metrics)}\n`);
    for (const key of METRIC_KEYS) {
      const before = previous?.[key];
      const movement = before === undefined ? "seeded" : before === next[key] ? "held" : `lowered from ${before}`;
      stdout.write(`  ${key}: ${next[key]} (${movement})\n`);
    }
    stdout.write(`${TEST_CORPUS_BUDGET_PATH} updated.\n`);
    return 0;
  }

  const budget = readBudget(root).metrics;
  const override = values.override === true;
  const optionBase = typeof values.base === "string" ? values.base : undefined;
  const optionHead = typeof values.head === "string" ? values.head : undefined;
  const base = optionBase ?? env.PR_BASE_SHA ?? env.GITHUB_BASE_SHA;
  const head = optionHead ?? env.PR_HEAD_SHA ?? env.GITHUB_HEAD_SHA ?? "HEAD";
  if (values["metrics-only"] !== true && (base === undefined || base.trim() === "")) {
    throw new CliUsageError(
      "H3 needs the frozen PR base: pass --base=<ref>, set PR_BASE_SHA, or use --metrics-only",
    );
  }
  const addedTestFiles = values["metrics-only"] === true || base === undefined
    ? null
    : collectAddedTestFiles({ root, base, head });

  stdout.write(`test corpus: ${formatMetricLine(snapshot.metrics)} (budget ${formatMetricLine(budget)})\n`);
  stdout.write(
    addedTestFiles === null
      ? `added test files: not evaluated (--metrics-only; base=${base ?? "none"})\n`
      : `added test files: ${addedTestFiles.length}/${MAX_NEW_TEST_FILES} against ${base}\n`,
  );
  if (override) {
    stdout.write(
      `${TEST_BUDGET_OVERRIDE_LABEL}: growth and the new-file cap admitted for this run only; ` +
        `${TEST_CORPUS_BUDGET_PATH} is unchanged.\n`,
    );
  }

  const findings = evaluateTestCorpusBudget({ metrics: snapshot.metrics, budget, addedTestFiles, override });
  if (findings.length === 0) {
    stdout.write("test corpus budget: OK\n");
    return 0;
  }
  stderr.write("Test corpus budget violations:\n\n");
  for (const finding of findings) stderr.write(`  - [${finding.code}] ${finding.detail}\n`);
  stderr.write(`\n${findings.length} violation(s) found.\n`);
  stderr.write(
    "Hint: extend the owning suite or retire tests, then run `npm run test-corpus:update` to lock in the smaller corpus.\n",
  );
  return 1;
}

function reportUnreadable(paths: readonly string[], stderr: TestCorpusWriter): number {
  stderr.write("Tracked test files are missing from the worktree, so the corpus cannot be measured:\n");
  for (const path of paths) stderr.write(`  - ${path}\n`);
  return 1;
}

runDirectCli(
  import.meta.url,
  () => {
    process.exitCode = runTestCorpusBudgetCheck();
  },
  { label: "test-corpus-budget", usage: USAGE },
);
