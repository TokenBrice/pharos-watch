import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRITICAL_TEST_FILES } from "../lib/critical-test-files.mts";
import { rawShardReportPath } from "../lib/shard-timings.mts";
import { runCriticalCoverageShard } from "../maintenance/run-critical-coverage-shard";
import type { SpawnCommand } from "../lib/command-runner.mts";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("critical coverage shard runner", () => {
  it.each([
    {},
    { PR_BASE_SHA: "frozen-base" },
    { PR_HEAD_SHA: "frozen-head" },
  ])("rejects missing frozen CI refs before executing coverage: %j", async (refs) => {
    const runCommand = vi.fn((_command: SpawnCommand) => 0);
    await expect(runCriticalCoverageShard({
      env: { NODE_ENV: "test", GITHUB_ACTIONS: "true", CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/lib/auth.ts", ...refs },
      argv: ["--shard=1/4"],
      runCommand,
    })).rejects.toThrow("requires frozen base and head refs");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("uses unique blob filenames after explicit partitioning and publishes timings even for a failed shard", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-coverage-timing-test-"));
    temporary.push(directory);
    const timings = join(directory, "coverage.json");
    const summaryPath = join(directory, "summary.md");
    const runCommand = vi.fn((command: SpawnCommand) => {
      expect(command.args).toContain("--reporter=blob");
      expect(command.args).toContain("--reporter=default");
      expect(command.args).toContain("--reporter=./scripts/lib/shard-timing-reporter.mts");
      expect(command.args).toContain("--outputFile.blob=.vitest-reports/blob-3-8.json");
      expect(command.args.some((arg) => arg.startsWith("--shard"))).toBe(false);
      expect(command.args.filter((arg) => arg.startsWith("--coverage.include="))).toEqual(["--coverage.include=worker/src/lib/auth.ts"]);
      writeFileSync(rawShardReportPath(timings), JSON.stringify({ success: false, testResults: [{
        name: join(process.cwd(), "worker/src/example.test.ts"), startTime: 0, endTime: 2300, testCount: 2,
      }] }));
      return 1;
    });
    expect(await runCriticalCoverageShard({ argv: ["--shard=3/8"], env: {
      NODE_ENV: "test",
      GITHUB_STEP_SUMMARY: summaryPath,
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/lib/auth.ts", PR_SHARD_TIMINGS_FILE: timings,
    }, runCommand })).toBe(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(timings, "utf8"))).toMatchObject({
      shard: 3, shardCount: 8, success: false, summedFileMs: 2300,
      files: [{ file: "worker/src/example.test.ts", durationMs: 2300, tests: 2 }],
    });
    expect(readFileSync(summaryPath, "utf8")).toContain("### PR critical coverage shard 3/8");
  });

  it("honors caller blob destinations and retains the whole owner suite in unsharded local mode", async () => {
    const runCommand = vi.fn((_command: SpawnCommand) => 0);
    await runCriticalCoverageShard({ argv: ["--shard=1/8", "--outputFile.blob=custom.json"], env: { NODE_ENV: "test" }, runCommand });
    const args = runCommand.mock.calls[0][0].args;
    expect(args).toContain("--outputFile.blob=custom.json");
    expect(args.filter((arg) => arg.startsWith("--outputFile.blob="))).toHaveLength(1);
    const localCommand = vi.fn((_command: SpawnCommand) => 0);
    await runCriticalCoverageShard({ env: { NODE_ENV: "test" }, argv: [], runCommand: localCommand });
    expect(localCommand.mock.calls[0][0].args.filter((arg) => CRITICAL_TEST_FILES.includes(arg))).toEqual(CRITICAL_TEST_FILES);
    expect(localCommand.mock.calls[0][0].args.some((arg) => arg.includes("shard-timing-reporter"))).toBe(false);
  });
});
