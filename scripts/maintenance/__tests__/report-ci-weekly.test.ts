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
  parseTestTimings,
  parseWeeklyJobs,
  parseWeeklyRuns,
  percentileSeconds,
  rankAddedTestFiles,
  rankSlowTestFiles,
  renderWeeklyReport,
  summarizeCodeBytes,
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
      "prepare", "v9-resource", "static-guards", "tests", "static-compile", "pages-artifact",
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
  });

  it("renders unavailable evidence as a named reason, never as zero", () => {
    const report = buildWeeklyReport({
      since: "2026-10-26T00:00:00Z",
      until: "2026-11-02T00:00:00Z",
      runs,
      jobs,
      timings: null,
      addedTestLog: null,
      addedTestSizes: {},
      codeBytes: null,
      unavailable: [
        { section: "slow-test-files", reason: "test-timings:missing" },
        { section: "added-test-files", reason: "added-test-files:not-supplied" },
        { section: "test-production-bytes", reason: "tracked-files:unavailable" },
      ],
      notes: [],
    });
    const markdown = renderWeeklyReport(report);
    expect(markdown).toContain("| tests | 200 | 240 | 280 | 3 | 2 |");
    expect(markdown).toContain("Over budget at p50: v9-resource (240s vs 220s), static-guards (130s vs 120s), tests (240s vs 200s), pages-artifact (360s vs 250s)");
    expect(markdown).toContain("failure rate 66.7 %");
    expect(markdown).toContain("Unavailable — no nightly test-timings artifact");
    expect(markdown).toContain("Unavailable — the added-file log");
    expect(markdown).toContain("Unavailable — the tracked file list");
    expect(markdown).toContain("`test-timings:missing`");
    expect(markdown).not.toContain("0 file(s) exceed");
  });

  it("renders the measured sections and the ratio", () => {
    const report = buildWeeklyReport({
      since: "2026-10-26T00:00:00Z",
      until: "2026-11-02T00:00:00Z",
      runUrl: "https://example.test/run/1",
      runs,
      jobs,
      timings: { generatedAt: "2026-11-01T00:00:00Z", files: { "scripts/__tests__/slow.test.ts": 25_000 } },
      addedTestLog: addedLog,
      addedTestSizes: { "scripts/__tests__/new.test.ts": 2_048 },
      codeBytes: summarizeCodeBytes([{ path: "src/a.ts", bytes: 1_000 }, { path: "src/a.test.ts", bytes: 910 }]),
      unavailable: [],
      notes: [],
    });
    const markdown = renderWeeklyReport(report);
    expect(markdown).toContain("Source run: https://example.test/run/1");
    expect(markdown).toContain("1 file(s) exceed the 10 s per-file budget");
    expect(markdown).toContain("| `scripts/__tests__/slow.test.ts` | 25.0 s |");
    expect(markdown).toContain("3 test file(s) added.");
    expect(markdown).toContain("2 added file(s) could not be measured");
    // The census caveat travels with the count: it is commit-dated, not merge-dated.
    expect(markdown).toContain("Census is commit-dated:");
    expect(markdown).toContain("ratio 0.91");
  });

  it("states the census provenance with an empty window and omits it when no log was supplied", () => {
    const empty = renderWeeklyReport(buildWeeklyReport({
      since: "2026-10-26T00:00:00Z",
      until: "2026-11-02T00:00:00Z",
      runs,
      jobs,
      timings: null,
      addedTestLog: "",
      addedTestSizes: {},
      codeBytes: null,
      unavailable: [],
      notes: [],
    }));
    expect(empty).toContain("No test file was added in the window.");
    expect(empty).toContain("Census is commit-dated:");

    const missing = renderWeeklyReport(buildWeeklyReport({
      since: "2026-10-26T00:00:00Z",
      until: "2026-11-02T00:00:00Z",
      runs,
      jobs,
      timings: null,
      addedTestLog: null,
      addedTestSizes: {},
      codeBytes: null,
      unavailable: [{ section: "added-test-files", reason: "added-test-files:missing" }],
      notes: [],
    }));
    expect(missing).not.toContain("Census is commit-dated:");
  });

  it("wires the CLI end to end and names every missing input", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-ci-weekly-"));
    try {
      writeFileSync(join(root, "runs.json"), JSON.stringify(runs));
      writeFileSync(join(root, "jobs.json"), JSON.stringify(jobs));
      writeFileSync(join(root, "report.md"), "");
      const status = main([
        "--runs", join(root, "runs.json"),
        "--jobs", join(root, "jobs.json"),
        "--since", "2026-10-26T00:00:00Z",
        "--until", "2026-11-02T00:00:00Z",
        "--repo-root", root,
        "--output", join(root, "report.md"),
      ]);
      expect(status).toBe(0);
      const markdown = readFileSync(join(root, "report.md"), "utf8");
      expect(markdown).toContain("Window: 2026-10-26T00:00:00Z → 2026-11-02T00:00:00Z");
      // The temp directory is not a checkout: the byte ratio is unavailable, not empty.
      expect(markdown).toContain("`test-timings:not-supplied`");
      expect(markdown).toContain("`added-test-files:not-supplied`");
      expect(markdown).toContain("`tracked-files:unavailable:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
