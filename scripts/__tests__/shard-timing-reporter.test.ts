import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestModule } from "vitest/node";
import ShardTimingReporter from "../lib/shard-timing-reporter.mts";
import { publishShardTimings, rawShardReportPath } from "../lib/shard-timings.mts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("import-aware shard timing reporter", () => {
  it("publishes the same summary shape for tests and coverage, including import/collect costs", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-reporter-test-"));
    temporary.push(directory);
    const file = join(directory, "coverage-timings.json");
    vi.stubEnv("PR_SHARD_TIMINGS_FILE", file);
    const testModule = {
      moduleId: join(process.cwd(), "worker/src/example.test.ts"),
      diagnostic: () => ({ prepareDuration: 11, environmentSetupDuration: 13, setupDuration: 17,
        collectDuration: 1900, duration: 59, importDurations: { dependency: { totalTime: 1800 } } }),
      children: { *allTests() { yield {}; yield {}; } },
    } as unknown as TestModule;
    new ShardTimingReporter().onTestRunEnd([testModule], [], "passed");
    expect(JSON.parse(readFileSync(rawShardReportPath(file), "utf8")).testResults[0].endTime).toBe(2000);
    publishShardTimings(file, { shard: 2, shardCount: 8 }, 3200, { NODE_ENV: "test" }, "plain-test");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      fileCount: 1, files: [{ file: "worker/src/example.test.ts", durationMs: 2000, tests: 2 }],
      shard: 2, shardCount: 8, success: true, summedFileMs: 2000, testCount: 2, wallMs: 3200,
    });
  });

  it("records collection failure with no assertions and marks an unsuccessful run", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-reporter-test-"));
    temporary.push(directory);
    const file = join(directory, "timings.json");
    vi.stubEnv("PR_SHARD_TIMINGS_FILE", file);
    const testModule = { moduleId: "failed.test.ts", diagnostic: () => ({ prepareDuration: 0, environmentSetupDuration: 0,
      setupDuration: 0, collectDuration: 700, duration: 0 }), children: { *allTests() {} } } as unknown as TestModule;
    new ShardTimingReporter().onTestRunEnd([testModule], [new Error("collection failed")], "failed");
    const report = JSON.parse(readFileSync(rawShardReportPath(file), "utf8"));
    expect(report.success).toBe(false);
    expect(report.testResults[0]).toMatchObject({ testCount: 0, endTime: 700 });
  });
});
