import { describe, expect, it } from "vitest";

import {
  formatShardTimingSummary,
  parseShardCoordinates,
  summarizeShardTimings,
  type VitestJsonReport,
} from "../lib/shard-timings.mts";

const report: VitestJsonReport = {
  numTotalTests: 6,
  success: true,
  testResults: [
    { name: "/repo/b.test.ts", startTime: 1_000, endTime: 3_000, assertionResults: [{ duration: 1 }, { duration: 2 }] },
    { name: "/repo/a.test.ts", startTime: 1_000, endTime: 3_000, assertionResults: [{ duration: 3 }] },
    { name: "/repo/slow.test.ts", startTime: 1_000, endTime: 9_500, assertionResults: [{ duration: 8 }] },
    { name: "/repo/no-span.test.ts", assertionResults: [{ duration: 400 }, { duration: 350 }] },
  ],
};

describe("summarizeShardTimings", () => {
  it("orders files slowest first and breaks equal durations by path", () => {
    const summary = summarizeShardTimings(report, { cwd: "/repo", shard: 2, shardCount: 4, wallMs: 12_000 });
    expect(summary.files.map((file) => file.file)).toEqual([
      "slow.test.ts",
      "a.test.ts",
      "b.test.ts",
      "no-span.test.ts",
    ]);
  });

  it("falls back to summed test durations when the file span is missing", () => {
    const summary = summarizeShardTimings(report, { cwd: "/repo", shard: 2, shardCount: 4, wallMs: 12_000 });
    expect(summary.files.at(-1)).toEqual({ durationMs: 750, file: "no-span.test.ts", tests: 2 });
  });

  it("reports the shard totals a balance review compares", () => {
    const summary = summarizeShardTimings(report, { cwd: "/repo", shard: 2, shardCount: 4, wallMs: 12_000 });
    expect(summary).toMatchObject({ fileCount: 4, shard: 2, shardCount: 4, summedFileMs: 13_250, testCount: 6, wallMs: 12_000 });
  });
});

describe("parseShardCoordinates", () => {
  it("reads inline and separated shard options", () => {
    expect(parseShardCoordinates(["run", "--shard=2/4"])).toEqual({ shard: 2, shardCount: 4 });
    expect(parseShardCoordinates(["run", "--shard", "3/4"])).toEqual({ shard: 3, shardCount: 4 });
  });

  it("treats an unsharded run as the whole shard", () => {
    expect(parseShardCoordinates(["run", "a.test.ts"])).toEqual({ shard: 1, shardCount: 1 });
  });
});

describe("formatShardTimingSummary", () => {
  it("caps the step summary table and points at the full artifact", () => {
    const summary = summarizeShardTimings(report, { cwd: "/repo", shard: 1, shardCount: 4, wallMs: 12_000 });
    const markdown = formatShardTimingSummary(summary, 2);
    expect(markdown).toContain("shard 1/4");
    expect(markdown.match(/^\| `/gm)).toHaveLength(2);
    expect(markdown).toContain("2 further files in the `pr-test-timings-1` run artifact.");
  });
});
