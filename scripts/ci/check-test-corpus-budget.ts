#!/usr/bin/env tsx
/**
 * Anti-creep ratchet for the test corpus (docs/testing.md#test-corpus-budget).
 *
 * H2 keeps a committed ceiling on five volume metrics that need no test run:
 * test files, test bytes, test-support files and bytes, and fixture bytes. Every
 * metric is measured over the Git index — ignored worktrees and generated copies
 * never count — so the check costs one `git ls-files` plus one `stat` per file.
 *
 * The ceilings a PR is held to are committed on the frozen PR base, never on the
 * PR's own tree: they come from `git show <base>:.ci/test-corpus-budget.json`
 * (the head file only when the base predates it), so a PR cannot buy headroom by
 * committing a bigger ceiling. A per-metric raise or a deleted budget file fails
 * unless `--override`. The head file may lower a ceiling freely.
 *
 * The per-metric limit is `max(ceiling, the base tree's own measurement)`, sized
 * from one `git ls-tree -r -l <base>`: a PR that does not grow a metric never
 * fails because main is already over. The nightly `--metrics-only` mode has no
 * PR base and keeps the absolute check against the checked-out file, which is
 * how debt admitted by the label stays visible until the tests are retired.
 *
 * H3 caps the net test files one PR adds — added minus deleted test paths against
 * the same frozen `PR_BASE_SHA` — so a move or a consolidation is not a new
 * file. `--metrics-only` is the nightly mode: a schedule has no PR base, and
 * skipping the cap there must be explicit rather than an empty-diff guess. A
 * missing base without `--metrics-only` is a usage error, never a pass.
 *
 * `test-budget-override` (owner label) admits growth, a ceiling raise and the cap
 * for one run only, and the label is read from the pull request event: apply it
 * before pushing, because GitHub does not re-run checks on `labeled`.
 *
 * The globs below are the single definition for both the metrics and the cap.
 * Test files mirror the executable-test pattern in `critical-ownership.mts`;
 * support modules mirror its `SUPPORT_MODULE_PATH` vocabulary. A path belongs
 * to the first bucket it matches (a test file inside a fixture tree is a test
 * file).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { collectGitPaths, splitNullDelimited } from "../lib/changed-files.mts";
import { CliUsageError, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const TEST_CORPUS_BUDGET_PATH = ".ci/test-corpus-budget.json";
/** One owner-tunable constant (R5): a PR may add at most this many net test files. */
export const MAX_NEW_TEST_FILES = 2;
export const TEST_BUDGET_OVERRIDE_LABEL = "test-budget-override";

/** Executable test files: the same pattern `critical-ownership.mts` selects with. */
export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/**
 * Test-only support modules: the `SUPPORT_MODULE_PATH` vocabulary in
 * `critical-ownership.mts` (shared helpers, frontend helpers, `__mocks__`), plus
 * the dash-named and bare `test-support` modules and `__tests__/helpers/` that
 * the vocabulary does not spell out.
 */
export const TEST_SUPPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|[./-])test-support\.[cm]?[jt]sx?$/u,
  /(?:^|\/)(?:test-helpers|test-utils|__mocks__)\//u,
  /(?:^|\/)__tests__\/helpers\//u,
];
/** Test fixture corpora: every `fixtures`/`__fixtures__` directory. */
export const TEST_FIXTURE_PATTERNS: readonly RegExp[] = [/(?:^|\/)(?:fixtures|__fixtures__)\//u];

const METRIC_KEYS = [
  "testFiles",
  "testBytes",
  "testSupportFiles",
  "testSupportBytes",
  "fixtureBytes",
] as const;
export type TestCorpusMetricKey = (typeof METRIC_KEYS)[number];
export type TestCorpusMetrics = Record<TestCorpusMetricKey, number>;

/**
 * Authoring headroom per metric (R5: defined once). `test-corpus:update` writes
 * `min(existing ceiling, current + slack)`, so the ceiling still only moves down
 * while a fix may add its regression case — `docs/testing.md#extending-tests`
 * allows up to 40 test lines — without needing the owner label. Cumulative
 * growth stays bounded by the slack until someone trims and re-seeds.
 */
export const TEST_CORPUS_SLACK: TestCorpusMetrics = {
  testFiles: 4,
  testBytes: 65_536,
  testSupportFiles: 2,
  testSupportBytes: 65_536,
  fixtureBytes: 65_536,
};

const METRIC_HINTS: Record<TestCorpusMetricKey, string> = {
  testFiles: "add cases to the owning suite instead of a new file; retire tests this change replaces",
  testBytes: "trim or retire tests; move corpus-wide cases to the nightly tier",
  testSupportFiles: "extend the existing `*.test-support.ts` instead of adding a sibling module",
  testSupportBytes: "trim the support module; extend the existing `*.test-support.ts`",
  fixtureBytes: "shrink the fixture corpus and delete fixtures this change replaces",
};

const USAGE = `Usage: npm run check:test-corpus-budget -- [options]

Anti-creep guard for the test corpus (docs/testing.md#test-corpus-budget).

  H2  each metric in ${TEST_CORPUS_BUDGET_PATH} is a ceiling measured over the
      Git index. A PR is held to the frozen base's ceilings and to
      max(ceiling, the base tree's own measurement); a per-metric raise or a
      deleted budget file fails. \`npm run test-corpus:update\` lowers the
      ceilings to min(current + slack, existing) and never raises one.
  H3  a PR may add at most ${MAX_NEW_TEST_FILES} net test files against its frozen base.

Options:
      --base=<ref>      Frozen PR base for H3, the base ceilings and the base sizes (default: PR_BASE_SHA, GITHUB_BASE_SHA)
      --head=<ref>      Head under test (default: PR_HEAD_SHA, GITHUB_HEAD_SHA, HEAD)
      --metrics-only    Check H2 only, against the checked-out file; skip H3 (nightly and main runs, which have no PR base)
      --override        The ${TEST_BUDGET_OVERRIDE_LABEL} owner label is present; admits growth, a ceiling raise and the cap for this run only
      --update          Rewrite the ceilings as min(current + slack, existing); never evaluates H3
  -h, --help            Show this help

Exit codes: 0 within budget, 1 violation, 2 usage error.`;

const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();
export const TestCorpusBudgetSchema = z.strictObject({
  version: z.literal(2),
  note: z.string().min(1),
  metrics: z.strictObject({
    testFiles: NonNegativeIntegerSchema,
    testBytes: NonNegativeIntegerSchema,
    testSupportFiles: NonNegativeIntegerSchema,
    testSupportBytes: NonNegativeIntegerSchema,
    fixtureBytes: NonNegativeIntegerSchema,
  }),
});
export type TestCorpusBudget = z.output<typeof TestCorpusBudgetSchema>;

/**
 * A frozen base may predate this schema version or a metric, so its ceilings are
 * read leniently: only a raise against a ceiling the base actually carries fails.
 */
const FrozenBudgetSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  metrics: z.object({
    testFiles: NonNegativeIntegerSchema.optional(),
    testBytes: NonNegativeIntegerSchema.optional(),
    testSupportFiles: NonNegativeIntegerSchema.optional(),
    testSupportBytes: NonNegativeIntegerSchema.optional(),
    fixtureBytes: NonNegativeIntegerSchema.optional(),
  }),
});
/** Committed ceilings that a frozen base carries; absent keys were never committed. */
export type FrozenBudgetMetrics = Partial<TestCorpusMetrics>;

export interface TestCorpusFinding {
  readonly code: "budget" | "ceiling-raise" | "budget-deleted" | "new-test-files";
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

interface GitTreeSnapshot {
  readonly files: readonly string[];
  /** Blob size from the tree listing; a path missing from the tree throws. */
  readonly sizeOf: SizeOf;
}

/**
 * Paths and blob sizes of the test corpus at one revision. The tree walk asks
 * for names only and the sizes come from one `git cat-file --batch-check` over
 * the corpus's own object ids: `git ls-tree -l` would have to materialize every
 * blob of the revision, and on the PR checkout's `filter: blob:none` clone it
 * answers `BAD` instead of a size. Only the corpus paths are read, so the base
 * measurement stays one tree walk plus one batch read.
 */
function collectGitTree(ref: string, root: string = ROOT): GitTreeSnapshot {
  const listed = execFileSync("git", ["ls-tree", "-r", "-z", ref], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const tracked: string[] = [];
  const corpus: Array<{ path: string; oid: string }> = [];
  for (const record of splitNullDelimited(listed)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(/\s+/);
    // A gitlink (submodule) is not a blob and never a test-corpus path.
    if (type !== "blob" || oid === undefined) continue;
    const path = record.slice(tab + 1);
    tracked.push(path);
    if (classifyTestCorpusPath(path) !== null) corpus.push({ path, oid });
  }

  const sizes = new Map<string, number>();
  if (corpus.length > 0) {
    const output = execFileSync("git", ["cat-file", "--batch-check=%(objectsize)"], {
      cwd: root,
      encoding: "utf8",
      input: `${corpus.map((entry) => entry.oid).join("\n")}\n`,
      maxBuffer: 32 * 1024 * 1024,
    });
    const lines = output.split("\n");
    corpus.forEach((entry, index) => {
      const size = Number((lines[index] ?? "").trim());
      // `missing` or any unreadable object is left out, so `sizeOf` reports the
      // path as unreadable and the gate fails closed instead of shrinking.
      if (Number.isFinite(size)) sizes.set(entry.path, size);
    });
  }

  return {
    files: tracked.sort(),
    sizeOf: (path: string) => {
      // `measureTestCorpus` sizes `resolve(root, file)`; the tree is keyed repo-relative.
      const size = sizes.get(isAbsolute(path) ? relative(root, path).replaceAll("\\", "/") : path);
      if (size === undefined) throw new Error(`no blob size for ${path} at ${ref}`);
      return size;
    },
  };
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
  const metrics: TestCorpusMetrics = {
    testFiles: 0,
    testBytes: 0,
    testSupportFiles: 0,
    testSupportBytes: 0,
    fixtureBytes: 0,
  };
  const unreadable: string[] = [];
  for (const file of files) {
    const bucket = classifyTestCorpusPath(file);
    if (bucket === null) continue;
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
    } else if (bucket === "testSupportFiles") {
      metrics.testSupportFiles += 1;
      metrics.testSupportBytes += bytes;
    } else {
      metrics.fixtureBytes += bytes;
    }
  }
  return { metrics, unreadable };
}

export interface TestFileDelta {
  readonly added: string[];
  readonly removed: string[];
}

/**
 * Test files this range adds and deletes. Rename detection stays off so a move
 * becomes one add and one delete: the cap counts the net, not the move.
 */
export function collectNetNewTestFiles({
  root = ROOT,
  base,
  head = "HEAD",
}: { root?: string; base: string; head?: string }): TestFileDelta {
  const collect = (diffFilter: "A" | "D") =>
    collectGitPaths({ kind: "range", base, head, noRenames: true, diffFilter }, { cwd: root })
      .filter((file) => TEST_FILE_PATTERN.test(file));
  return { added: collect("A"), removed: collect("D") };
}

function formatMetricLine(metrics: TestCorpusMetrics): string {
  return METRIC_KEYS.map((key) => `${key} ${metrics[key]}`).join(", ");
}

export interface TestCorpusEvaluationInput {
  readonly metrics: TestCorpusMetrics;
  /** The ceilings this run is held to: the frozen base's, or the checked-out file's in `--metrics-only`. */
  readonly budget: TestCorpusMetrics;
  /** Null when H3 was not evaluated (`--metrics-only`). */
  readonly addedTestFiles: readonly string[] | null;
  readonly override: boolean;
  /** PR mode: test files this range deletes, so the cap counts net growth. */
  readonly removedTestFiles?: number;
  /** PR mode: the frozen base tree's own measurement. */
  readonly baseMetrics?: TestCorpusMetrics;
  /** PR mode: the ceilings committed on the frozen base; absent keys were never committed. */
  readonly baseBudget?: FrozenBudgetMetrics;
  /** PR mode: the PR deletes the committed budget file. */
  readonly budgetDeleted?: boolean;
}

/** Ceiling raise, growth and cap findings, in that order. An override suppresses all. */
export function evaluateTestCorpusBudget({
  metrics,
  budget,
  addedTestFiles,
  override,
  removedTestFiles = 0,
  baseMetrics,
  baseBudget,
  budgetDeleted = false,
}: TestCorpusEvaluationInput): TestCorpusFinding[] {
  if (override) return [];
  const findings: TestCorpusFinding[] = [];
  if (budgetDeleted) {
    findings.push({
      code: "budget-deleted",
      detail:
        `${TEST_CORPUS_BUDGET_PATH} exists on the frozen base and is deleted here; keep the file and ` +
        "lower the ceilings instead",
    });
  }
  for (const key of METRIC_KEYS) {
    const base = baseBudget?.[key];
    if (base === undefined || budget[key] <= base) continue;
    findings.push({
      code: "ceiling-raise",
      detail:
        `${key}: ceiling raised ${base} → ${budget[key]} (+${budget[key] - base}) against the frozen base. ` +
        "`npm run test-corpus:update` never raises a ceiling; a raise needs the " +
        `\`${TEST_BUDGET_OVERRIDE_LABEL}\` label or an owner-approved base edit.`,
    });
  }
  for (const key of METRIC_KEYS) {
    const current = metrics[key];
    const ceiling = budget[key];
    const base = baseMetrics?.[key];
    // A PR that does not grow a metric never fails because main is already over:
    // the frozen base's own size is the floor of its limit.
    const limit = base === undefined ? ceiling : Math.max(ceiling, base);
    if (current <= limit) continue;
    const compared = base === undefined || limit === ceiling
      ? `budget ${ceiling}`
      : `limit ${limit} (budget ${ceiling}, base ${base})`;
    findings.push({
      code: "budget",
      detail:
        `${key}: ${current} > ${compared} (+${current - limit}). ` +
        `${METRIC_HINTS[key]}; \`npm run test-corpus:update\` only lowers the budget.`,
    });
  }
  if (addedTestFiles !== null) {
    const net = addedTestFiles.length - removedTestFiles;
    if (net > MAX_NEW_TEST_FILES) {
      findings.push({
        code: "new-test-files",
        detail:
          `${net} net new test files > cap ${MAX_NEW_TEST_FILES} ` +
          `(${addedTestFiles.length} added, ${removedTestFiles} deleted): ${addedTestFiles.join(", ")}. ` +
          "Add cases to the owning suite; a new file needs the `test-budget-override` label and a " +
          '"Test justification" section in the PR body.',
      });
    }
  }
  return findings;
}

function readBudgetFile(path: string, label: string): TestCorpusBudget {
  const parsed = TestCorpusBudgetSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new CliUsageError(
      `${label} does not match the budget schema: ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

function budgetPath(root: string): string {
  return resolve(root, TEST_CORPUS_BUDGET_PATH);
}

/** The checked-out ceilings, or null when the file is absent. */
function readCheckedOutBudget(root: string): TestCorpusMetrics | null {
  const path = budgetPath(root);
  return existsSync(path) ? readBudgetFile(path, TEST_CORPUS_BUDGET_PATH).metrics : null;
}

/** The ceilings committed on a frozen base, or null when that revision has no budget file. */
function readFrozenBudget(ref: string, trackedPaths: readonly string[], root: string): FrozenBudgetMetrics | null {
  if (!trackedPaths.includes(TEST_CORPUS_BUDGET_PATH)) return null;
  const label = `${TEST_CORPUS_BUDGET_PATH} at ${ref}`;
  const text = execFileSync("git", ["show", `${ref}:${TEST_CORPUS_BUDGET_PATH}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = FrozenBudgetSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new CliUsageError(
      `${label} does not match the budget schema: ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
    );
  }
  return parsed.data.metrics;
}

/**
 * The ceilings this run is held to. PR mode defers to the frozen base (the
 * checked-out file only when the base predates it); a metric neither file names
 * falls back to the base measurement, so it cannot grow.
 */
function resolveCeilings(
  checkedOut: TestCorpusMetrics | null,
  frozen: FrozenBudgetMetrics | null,
  baseMetrics: TestCorpusMetrics | null,
): TestCorpusMetrics | null {
  const resolved = METRIC_KEYS.map((key) => [key, checkedOut?.[key] ?? frozen?.[key] ?? baseMetrics?.[key]] as const);
  if (resolved.some(([, value]) => value === undefined)) return null;
  return Object.fromEntries(resolved) as TestCorpusMetrics;
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
    const previous = readCheckedOutBudget(root);
    const next = Object.fromEntries(
      METRIC_KEYS.map((key) => [
        key,
        Math.min(previous?.[key] ?? Infinity, snapshot.metrics[key] + TEST_CORPUS_SLACK[key]),
      ]),
    ) as TestCorpusMetrics;
    const budget: TestCorpusBudget = {
      version: 2,
      note:
        "Ceilings for the test corpus (docs/testing.md#test-corpus-budget), measured over the Git index by " +
        "scripts/ci/check-test-corpus-budget.ts. Each is the corpus plus a fixed per-metric slack; " +
        "npm run test-corpus:update writes min(existing, current + slack) and never raises one. " +
        "Raising one needs the test-budget-override label for one run or an owner-approved edit.",
      metrics: next,
    };
    const target = budgetPath(root);
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

  const override = values.override === true;
  const metricsOnly = values["metrics-only"] === true;
  const optionBase = typeof values.base === "string" ? values.base : undefined;
  const optionHead = typeof values.head === "string" ? values.head : undefined;
  const base = optionBase ?? env.PR_BASE_SHA ?? env.GITHUB_BASE_SHA;
  const head = optionHead ?? env.PR_HEAD_SHA ?? env.GITHUB_HEAD_SHA ?? "HEAD";
  if (!metricsOnly && (base === undefined || base.trim() === "")) {
    throw new CliUsageError(
      "H3 and the base ceilings need the frozen PR base: pass --base=<ref>, set PR_BASE_SHA, or use --metrics-only",
    );
  }

  // PR mode measures the frozen base tree and reads the ceilings committed there.
  const baseTree = metricsOnly || base === undefined ? null : collectGitTree(base, root);
  let baseMetrics: TestCorpusMetrics | null = null;
  let frozenBudget: FrozenBudgetMetrics | null = null;
  if (baseTree !== null && base !== undefined) {
    const baseSnapshot = measureTestCorpus(baseTree.files, { root, sizeOf: baseTree.sizeOf });
    if (baseSnapshot.unreadable.length > 0) {
      return reportUnreadable(baseSnapshot.unreadable, stderr, `frozen base ${base} tree`);
    }
    baseMetrics = baseSnapshot.metrics;
    frozenBudget = readFrozenBudget(base, baseTree.files, root);
  }

  const checkedOut = readCheckedOutBudget(root);
  const budget = resolveCeilings(checkedOut, frozenBudget, baseMetrics);
  if (budget === null) {
    throw new CliUsageError(
      `${TEST_CORPUS_BUDGET_PATH} is missing; run \`npm run test-corpus:update\` and commit the seeded budget`,
    );
  }
  const delta = metricsOnly || base === undefined ? null : collectNetNewTestFiles({ root, base, head });
  const removedTestFiles = delta?.removed.length ?? 0;

  stdout.write(`test corpus: ${formatMetricLine(snapshot.metrics)} (budget ${formatMetricLine(budget)})\n`);
  if (baseMetrics !== null) {
    stdout.write(
      `frozen base ${base}: ${formatMetricLine(baseMetrics)} ` +
        `(${frozenBudget === null ? "no committed budget: first introduction" : `budget ${formatMetricLine(budget)}`})\n`,
    );
  }
  stdout.write(
    delta === null
      ? `added test files: not evaluated (--metrics-only; base=${base ?? "none"})\n`
      : `added test files: net ${delta.added.length - removedTestFiles}/${MAX_NEW_TEST_FILES} against ${base} ` +
        `(${delta.added.length} added, ${removedTestFiles} deleted)\n`,
  );
  if (override) {
    stdout.write(
      `${TEST_BUDGET_OVERRIDE_LABEL}: growth, a ceiling raise and the new-file cap admitted for this run only; ` +
        `${TEST_CORPUS_BUDGET_PATH} is unchanged.\n`,
    );
  }

  const findings = evaluateTestCorpusBudget({
    metrics: snapshot.metrics,
    budget,
    addedTestFiles: delta?.added ?? null,
    override,
    removedTestFiles,
    ...(baseMetrics === null ? {} : { baseMetrics }),
    ...(frozenBudget === null ? {} : { baseBudget: frozenBudget }),
    budgetDeleted: checkedOut === null && frozenBudget !== null,
  });
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

function reportUnreadable(paths: readonly string[], stderr: TestCorpusWriter, where = "worktree"): number {
  stderr.write(`Tracked test files are missing from the ${where}, so the corpus cannot be measured:\n`);
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
