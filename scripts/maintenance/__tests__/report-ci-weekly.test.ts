import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PR_PREPARE_BUDGET_SECONDS, PR_LANES } from "../../lib/pr-lanes.mts";
import {
  SLOW_TEST_FILE_SECONDS,
  budgetSecondsForLane,
  buildFailureCensus,
  buildLaneBudgets,
  buildWeeklyReport,
  isTestCorpusPath,
  jobDurationSeconds,
  laneOfJobName,
  main,
  parseAddedTestFiles,
  parseIssueHygiene,
  parseTestTimings,
  parseWeeklyJobs,
  parseWeeklyRuns,
  percentileSeconds,
  rankAddedTestFiles,
  rankSlowTestFiles,
  renderWeeklyReport,
  summarizeCodeBytes,
  summarizeIssueHygiene,
  type IssueHygieneInput,
  type WeeklyJob,
  type WeeklyRun,
} from "../report-ci-weekly.ts";

const job = (
  runId: number,
  name: string,
  startedAt: string | null,
  completedAt: string | null,
  conclusion: string | null = "success",
): WeeklyJob => ({ runId, name, startedAt, completedAt, conclusion });

const runs: WeeklyRun[] = [
  { id: 1, createdAt: "2026-10-27T00:00:00Z", conclusion: "success" },
  { id: 2, createdAt: "2026-10-28T00:00:00Z", conclusion: "failure" },
  { id: 3, createdAt: "2026-10-29T00:00:00Z", conclusion: "cancelled" },
  { id: 4, createdAt: "2026-10-30T00:00:00Z", conclusion: "timed_out" },
];

const jobs: WeeklyJob[] = [
  job(1, "secrets", "2026-10-27T00:00:00Z", "2026-10-27T00:00:15Z"),
  job(1, "prepare", "2026-10-27T00:00:10Z", "2026-10-27T00:01:40Z"),
  job(1, "tests (1/2)", "2026-10-27T00:03:20Z", "2026-10-27T00:07:20Z"),
  job(1, "tests (2/2)", "2026-10-27T00:03:20Z", "2026-10-27T00:06:40Z"),
  job(1, "Pages artifact", "2026-10-27T00:03:20Z", "2026-10-27T00:09:20Z"),
  job(1, "PR gate", "2026-10-27T00:10:00Z", "2026-10-27T00:10:10Z"),
  job(2, "prepare", "2026-10-28T00:00:10Z", "2026-10-28T00:01:40Z"),
  job(2, "tests (1/2)", "2026-10-28T00:03:20Z", "2026-10-28T00:08:00Z", "failure"),
  job(2, "static-guards", "2026-10-28T00:03:20Z", "2026-10-28T00:05:30Z", "failure"),
  job(3, "prepare", "2026-10-29T00:00:10Z", "2026-10-29T00:01:00Z", "cancelled"),
  job(4, "prepare", "2026-10-30T00:00:10Z", null, "cancelled"),
  job(4, "v9-resource", "2026-10-30T00:03:20Z", "2026-10-30T00:07:20Z", "timed_out"),
];

const addedLog = [
  "COMMIT aaa",
  "scripts/__tests__/new.test.ts",
  "src/components/Button.tsx",
  "worker/src/__tests__/cron.test-support.ts",
  "",
  "COMMIT bbb",
  "scripts/__tests__/new.test.ts",
  "worker/src/cron/__tests__/late.test.ts",
  "",
].join("\n");

const baseReport = {
  since: "2026-10-26T00:00:00Z", until: "2026-11-02T00:00:00Z", runs, jobs,
  timings: null, addedTestLog: null, addedTestSizes: {}, codeBytes: null, unavailable: [], notes: [],
};

const sampleIssues: IssueHygieneInput = {
  version: 1,
  openedInWindow: [
    { number: 101, createdAt: "2026-10-27T12:00:00Z", labels: ["bug"] },
    { number: 101, createdAt: "2026-10-27T12:00:00Z", labels: ["bug"] },
    { number: 102, createdAt: "2026-10-25T23:59:59Z", labels: ["ops:followup"] },
    { number: 103, createdAt: "2026-11-02T00:00:00Z", labels: ["ops:decision"] },
  ],
  closedInWindow: [
    { number: 90, closedAt: "2026-10-28T00:00:00Z", labels: ["bug"] },
    { number: 90, closedAt: "2026-10-28T00:00:00Z", labels: ["bug"] },
    { number: 91, closedAt: "2026-10-29T00:00:00Z", labels: ["ops:followup"] },
    { number: 92, closedAt: "2026-11-02T00:00:01Z", labels: [] },
    { number: 93, closedAt: "2026-10-26T00:00:00Z", labels: [] },
  ],
  openNow: [
    { number: 1, title: "Weekly CI report", labels: ["ci:weekly-report"] },
    { number: 2, title: "Nightly validation is red", labels: ["ci:nightly-red", "ops:calendar"] },
    { number: 3, title: "Safety Score curation expiry sweep", labels: [] },
    { number: 4, title: "Agent maintenance candidates", labels: [] },
    { number: 5, title: "Worker capacity headroom", labels: [] },
    { number: 6, title: "Scheduled delivery incident", labels: [] },
    { number: 7, title: "Q1 calendar renewal", labels: ["ops:calendar", "ops:upstream-wait"] },
    { number: 7, title: "Q1 calendar renewal", labels: ["ops:calendar", "ops:upstream-wait"] },
    { number: 8, title: "Wait on upstream API", labels: ["ops:upstream-wait"] },
    { number: 9, title: "Fix parser bug", labels: ["bug", "ops:followup", "bug"] },
    { number: 10, title: "Owner policy call", labels: ["ops:decision"] },
  ],
};

describe("weekly CI report", () => {
  it("maps matrix job names to the lane and budget registry", () => {
    expect(laneOfJobName("tests (1/4)")).toBe("tests");
    expect(laneOfJobName("Pages artifact")).toBe("pages-artifact");
    expect(laneOfJobName("PR gate")).toBe("pr-gate");
    expect(laneOfJobName("v9-resource")).toBe("v9-resource");
    expect(budgetSecondsForLane("prepare")).toBe(PR_PREPARE_BUDGET_SECONDS);
    expect(budgetSecondsForLane("tests")).toBe(200);
    // Every manifest budget is the registry's, never a second copy in the report.
    for (const lane of PR_LANES) expect(budgetSecondsForLane(lane.id)).toBe(lane.budgetSeconds ?? null);
    expect(budgetSecondsForLane("secrets")).toBeNull();
  });

  it("computes nearest-rank percentiles over per-job samples", () => {
    expect(percentileSeconds([], 50)).toBeNull();
    expect(percentileSeconds([7], 90)).toBe(7);
    expect(percentileSeconds([1, 2, 3, 4], 50)).toBe(2);
    expect(percentileSeconds([1, 2, 3, 4], 90)).toBe(4);
    expect(jobDurationSeconds(job(1, "prepare", "2026-10-27T00:00:10Z", "2026-10-27T00:01:40Z"))).toBe(90);
    // An inverted or incomplete interval is not a sample.
    expect(jobDurationSeconds(job(1, "prepare", "2026-10-27T00:01:40Z", "2026-10-27T00:00:10Z"))).toBeNull();
    expect(jobDurationSeconds(job(1, "prepare", null, null))).toBeNull();
  });

  it("reports p50/p90 against the budget and drops non-concluded samples", () => {
    const { rows, excludedLaneJobs } = buildLaneBudgets(runs, jobs);
    const byLane = Object.fromEntries(rows.map((row) => [row.lane, row]));
    expect(rows.map((row) => row.lane)).toEqual([
      "prepare", "v9-resource", "static-guards", "og-render-check", "tests", "static-compile", "pages-artifact",
    ]);
    expect(byLane.prepare).toEqual({ lane: "prepare", budgetSeconds: 90, samples: 2, p50Seconds: 90, p90Seconds: 90, overBudget: 0 });
    expect(byLane.tests).toEqual({ lane: "tests", budgetSeconds: 200, samples: 3, p50Seconds: 240, p90Seconds: 280, overBudget: 2 });
    expect(byLane["pages-artifact"].overBudget).toBe(1);
    expect(byLane["static-guards"].overBudget).toBe(1);
    expect(byLane["v9-resource"].p50Seconds).toBe(240);
    expect(byLane["static-compile"].p50Seconds).toBeNull();
    // The cancelled run and the run without a completion time are not latencies.
    expect(excludedLaneJobs).toBe(2);
  });

  it("attributes failures per lane once per run and excludes cancelled runs", () => {
    const census = buildFailureCensus(runs, jobs);
    expect(census).toMatchObject({ total: 4, green: 1, failed: 2, cancelled: 1 });
    expect(census.failureRate).toBeCloseTo(2 / 3);
    expect(census.byLane).toEqual([
      { lane: "static-guards", runs: 1 },
      { lane: "tests", runs: 1 },
      { lane: "v9-resource", runs: 1 },
    ]);
    expect(buildFailureCensus([{ id: 9, createdAt: "2026-10-30T00:00:00Z", conclusion: "cancelled" }], []).failureRate)
      .toBeNull();
  });

  it("flags and ranks the slow files above the per-file budget", () => {
    const { slowest, overBudget } = rankSlowTestFiles({
      "scripts/__tests__/a.test.ts": 12_000,
      "scripts/__tests__/b.test.ts": 9_400,
      "worker/src/__tests__/c.test.ts": 25_000,
    });
    expect(SLOW_TEST_FILE_SECONDS).toBe(10);
    expect(slowest.map((entry) => entry.file)).toEqual([
      "worker/src/__tests__/c.test.ts", "scripts/__tests__/a.test.ts", "scripts/__tests__/b.test.ts",
    ]);
    expect(overBudget).toBe(2);
  });

  it("parses the added-file log, filters the test corpus and ranks by size", () => {
    expect(isTestCorpusPath("scripts/__tests__/new.test.ts")).toBe(true);
    expect(isTestCorpusPath("worker/src/__tests__/cron.test-support.ts")).toBe(true);
    expect(isTestCorpusPath("src/__fixtures__/page.html")).toBe(true);
    expect(isTestCorpusPath("src/components/Button.tsx")).toBe(false);
    const added = parseAddedTestFiles(addedLog);
    expect(added).toEqual([
      { commit: "aaa", file: "scripts/__tests__/new.test.ts" },
      { commit: "aaa", file: "worker/src/__tests__/cron.test-support.ts" },
      { commit: "bbb", file: "worker/src/cron/__tests__/late.test.ts" },
    ]);
    const ranked = rankAddedTestFiles(added, {
      "scripts/__tests__/new.test.ts": 2_048,
      "worker/src/cron/__tests__/late.test.ts": 4_096,
    });
    expect(ranked.files).toEqual([
      { file: "worker/src/cron/__tests__/late.test.ts", bytes: 4_096 },
      { file: "scripts/__tests__/new.test.ts", bytes: 2_048 },
    ]);
    // A re-added file counted once, and an unmeasured size is not a zero.
    expect(ranked.total).toBe(3);
    expect(ranked.unmeasured).toBe(1);
  });

  it("splits the tracked code bytes into the test corpus and production", () => {
    const summary = summarizeCodeBytes([
      { path: "src/a.ts", bytes: 1_000 },
      { path: "src/a.test.ts", bytes: 500 },
      { path: "scripts/__tests__/x.test.ts", bytes: 100 },
      { path: "src/__fixtures__/page.ts", bytes: 50 },
      { path: "docs/readme.md", bytes: 9_999 },
    ]);
    expect(summary).toEqual({
      testBytes: 650, productionBytes: 1_000, testFiles: 3, productionFiles: 1, ratio: 0.65,
    });
  });

  it("rejects malformed inputs instead of reporting zeros", () => {
    expect(() => parseWeeklyRuns({ runs: [] })).toThrow(/array/);
    expect(() => parseWeeklyRuns([{ id: "1" }])).toThrow(/runs\[0\]/);
    expect(() => parseWeeklyJobs([{ runId: 1 }])).toThrow(/jobs\[0\]/);
    expect(() => parseTestTimings({ version: 2, files: {} })).toThrow(/version 1/);
    expect(() => parseTestTimings({ version: 1, files: { "a.test.ts": "slow" } })).toThrow(/duration/);
    expect(parseTestTimings({ version: 1, generatedAt: "2026-11-01T00:00:00Z", files: { "a.test.ts": 4_200 } }))
      .toEqual({ generatedAt: "2026-11-01T00:00:00Z", files: { "a.test.ts": 4_200 } });
    const empty = { version: 1, openedInWindow: [], closedInWindow: [], openNow: [] };
    for (const [bad, pattern] of [
      [[], /object/], [{ ...empty, version: 2 }, /version 1/], [{ ...empty, openedInWindow: "bad" }, /openedInWindow/],
      [{ ...empty, openedInWindow: [{ number: 0, createdAt: "2026-10-27T00:00:00Z", labels: [] }] }, /positive integer/],
      [{ ...empty, closedInWindow: [{ number: 1, closedAt: "nope", labels: [] }] }, /ISO timestamp/],
      [{ ...empty, openNow: [{ number: 1, title: 42, labels: [] }] }, /title/],
      [{ ...empty, openNow: [{ number: 1, title: "ok", labels: [1] }] }, /labels/],
    ] as const) expect(() => parseIssueHygiene(bad)).toThrow(pattern);
    expect(parseIssueHygiene(sampleIssues)).toEqual(sampleIssues);
  });

  it("deduplicates and classifies 7-day issue hygiene without double-counting queues", () => {
    expect(summarizeIssueHygiene(sampleIssues, "2026-10-26T00:00:00Z", "2026-11-02T00:00:00Z")).toEqual({
      opened: 2, closed: 3, net: -1, openTotal: 10, standingTrackers: 6, calendarOpen: 1, upstreamWaitOpen: 1, actionableOpen: 2,
      byLabel: { "ops:followup": 1, "ops:calendar": 2, "ops:upstream-wait": 2, "ops:decision": 1, bug: 1 },
    });
  });

  it("renders unavailable evidence as a named reason, never as zero", () => {
    const markdown = renderWeeklyReport(buildWeeklyReport({
      ...baseReport,
      unavailable: [
        { section: "slow-test-files", reason: "test-timings:missing" },
        { section: "added-test-files", reason: "added-test-files:not-supplied" },
        { section: "test-production-bytes", reason: "tracked-files:unavailable" },
        { section: "issue-hygiene", reason: "issues:not-supplied" },
      ],
    }));
    expect(markdown).toContain("| tests | 200 | 240 | 280 | 3 | 2 |");
    expect(markdown).toContain("Over budget at p50: v9-resource (240s vs 220s), static-guards (130s vs 120s), tests (240s vs 200s), pages-artifact (360s vs 250s)");
    expect(markdown).toContain("failure rate 66.7 %");
    expect(markdown).toContain("Unavailable — no nightly test-timings artifact");
    expect(markdown).toContain("Unavailable — the added-file log");
    expect(markdown).toContain("Unavailable — the tracked file list");
    expect(markdown).toContain("Unavailable — no GitHub issue hygiene snapshot");
    expect(markdown).toContain("`test-timings:missing`");
    expect(markdown).toContain("`issues:not-supplied`");
    expect(markdown).not.toContain("0 file(s) exceed");
    expect(markdown).not.toContain("Opened 0, closed 0");
  });

  it("renders the measured sections and the ratio", () => {
    const markdown = renderWeeklyReport(buildWeeklyReport({
      ...baseReport,
      runUrl: "https://example.test/run/1",
      timings: { generatedAt: "2026-11-01T00:00:00Z", files: { "scripts/__tests__/slow.test.ts": 25_000 } },
      addedTestLog: addedLog,
      addedTestSizes: { "scripts/__tests__/new.test.ts": 2_048 },
      codeBytes: summarizeCodeBytes([{ path: "src/a.ts", bytes: 1_000 }, { path: "src/a.test.ts", bytes: 910 }]),
      routeBudgets: [
        { file: "worker/src/api/a.ts", mode: "auto", class: "worker-api", status: "over-budget", bytes: 76_001 },
        { file: "src/components/a.tsx", mode: "contract", class: "local-frontend", status: "over-budget", bytes: 24_200 },
        { file: "worker/src/api/b.ts", mode: "contract", class: "worker-api", status: "within-budget", bytes: 76_000 },
      ],
      issues: sampleIssues,
    }));
    expect(markdown).toContain("Source run: https://example.test/run/1");
    expect(markdown).toContain("1 file(s) exceed the 10 s per-file budget");
    expect(markdown).toContain("| `scripts/__tests__/slow.test.ts` | 25.0 s |");
    expect(markdown).toContain("3 test file(s) added.");
    expect(markdown).toContain("2 added file(s) could not be measured");
    expect(markdown).toContain("Census is commit-dated:");
    expect(markdown).toContain("ratio 0.91");
    expect(markdown).toContain("2 of 3 tracked single-file route signatures");
    expect(markdown).toContain("| worker-api | 76000 | 1 | 2 |");
    expect(markdown).toMatch(/src\/components\/a.tsx[^\n]+200 B over ceiling\.[\s\S]+worker\/src\/api\/a.ts[^\n]+1 B over ceiling\./);
    expect(markdown).toContain("## Issue hygiene (7d)");
    expect(markdown).toContain("Opened 2, closed 3 (net -1) in the window; 10 open total (2 actionable, 6 standing tracker(s), 1 calendar, 1 upstream-wait).");
    expect(markdown).toContain("| `ops:followup` | 1 |");
    expect(markdown).toContain("| `ops:calendar` | 2 |");
    expect(markdown).toContain("| `ops:upstream-wait` | 2 |");
    expect(markdown).toContain("| `ops:decision` | 1 |");
    expect(markdown).toContain("| `bug` | 1 |");
  });

  it("states the census provenance with an empty window and omits it when no log was supplied", () => {
    const empty = renderWeeklyReport(buildWeeklyReport({ ...baseReport, addedTestLog: "" }));
    expect(empty).toContain("No test file was added in the window.");
    expect(empty).toContain("Census is commit-dated:");

    const missing = renderWeeklyReport(buildWeeklyReport({
      ...baseReport,
      unavailable: [{ section: "added-test-files", reason: "added-test-files:missing" }],
    }));
    expect(missing).not.toContain("Census is commit-dated:");
  });

  it("wires the CLI end to end and names every missing input", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-ci-weekly-"));
    try {
      const runsPath = join(root, "runs.json"), jobsPath = join(root, "jobs.json"), outPath = join(root, "report.md");
      writeFileSync(runsPath, JSON.stringify(runs));
      writeFileSync(jobsPath, JSON.stringify(jobs));
      const baseArgs = ["--runs", runsPath, "--jobs", jobsPath, "--since", "2026-10-26T00:00:00Z", "--until", "2026-11-02T00:00:00Z", "--repo-root", root, "--output", outPath];
      expect(main(baseArgs)).toBe(0);
      const missingMd = readFileSync(outPath, "utf8");
      expect(missingMd).toContain("Window: 2026-10-26T00:00:00Z → 2026-11-02T00:00:00Z");
      expect(missingMd).toContain("`test-timings:not-supplied`");
      expect(missingMd).toContain("`added-test-files:not-supplied`");
      expect(missingMd).toContain("`tracked-files:unavailable:");
      expect(missingMd).toContain("`route-context:unavailable:checkout-mismatch`");
      expect(missingMd).toContain("`issues:not-supplied`");

      const issuesPath = join(root, "issues.json");
      writeFileSync(issuesPath, JSON.stringify(sampleIssues));
      expect(main([...baseArgs, "--issues", issuesPath])).toBe(0);
      expect(readFileSync(outPath, "utf8")).toContain("Opened 2, closed 3 (net -1) in the window");

      writeFileSync(issuesPath, JSON.stringify({ version: 9 }));
      expect(main([...baseArgs, "--issues", issuesPath])).toBe(0);
      expect(readFileSync(outPath, "utf8")).toContain("`issues:invalid:issues input must declare version 1`");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("measures the reporting checkout and publishes through parser failures", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-ci-weekly-"));
    const input = join(root, "empty.json");
    const args = ["--experimental-strip-types", "scripts/maintenance/report-ci-weekly.ts",
      "--runs", input, "--jobs", input, "--since", "2026-10-26T00:00:00Z"];
    const run = (extra: Record<string, string> = {}) => execFileSync(process.execPath, args, {
      encoding: "utf8", env: { ...process.env, ROUTE_PARSER_INSTALL_OUTCOME: "", ...extra },
    });
    try {
      writeFileSync(input, "[]");
      const without = (name: string) => `--import=data:text/javascript,${encodeURIComponent(`import { registerHooks } from 'node:module';
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === '${name}') throw Object.assign(new Error('Missing ${name}'), { code: 'ERR_MODULE_NOT_FOUND' });
          return next(specifier, context);
        } });`)}`;
      const withoutYaml = { NODE_OPTIONS: without("yaml") };
      expect(run(withoutYaml)).toMatch(/\d+ of [1-9]\d* tracked single-file route signatures[\s\S]+\| worker-api \| 76000 \| \d+ \| [1-9]\d* \|/);
      expect(run({ ...withoutYaml, ROUTE_PARSER_INSTALL_OUTCOME: "failure" })).toContain("`route-context:unavailable:parser-install-failed`");
      expect(run({ NODE_OPTIONS: without("remark-gfm") }))
        .toContain("`route-context:unavailable:measurement-failed`");
      const stalledMeasurement = `import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        if (process.argv.includes('--measure-route-budgets')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
        const { spawnSync } = childProcess;
        childProcess.spawnSync = (command, args, options) => {
          if (options.timeout !== 60_000 || options.killSignal !== 'SIGKILL') throw new Error('Missing measurement deadline');
          return spawnSync(command, args, { ...options, timeout: 500 });
        };
        syncBuiltinESMExports();`;
      expect(run({ NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(stalledMeasurement)}` }))
        .toContain("`route-context:unavailable:measurement-timeout`");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);
});
