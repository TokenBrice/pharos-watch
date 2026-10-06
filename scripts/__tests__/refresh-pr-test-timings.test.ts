import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { deriveTimingDurations, refreshPrTestTimings } from "../maintenance/refresh-pr-test-timings";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const temporary: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function outputPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-refresh-test-"));
  temporary.push(directory);
  return join(directory, "timings.json");
}

describe("CI timing seed refresh", () => {
  it("aggregates medians deterministically and gives zero-duration files a positive cost", () => {
    expect(deriveTimingDurations([{ file: "b", durationMs: 0 }, { file: "a", durationMs: 11 }, { file: "a", durationMs: 3 }]))
      .toEqual({ a: 7, b: 1 });
  });

  it("downloads only retained timing artifacts from successful PR runs and prefers measured coverage", () => {
    const output = outputPath();
    vi.mocked(execFileSync).mockImplementation((_file, rawArgs) => {
      const args = rawArgs as string[];
      if (args[0] === "run" && args[1] === "list") return JSON.stringify([{ databaseId: 123, headSha: "sha", createdAt: "date", url: "https://example.com/run" }]);
      if (args[0] === "api") return JSON.stringify({ artifacts: [
        { id: 1, name: "pr-test-timings-1", expired: false }, { id: 2, name: "pr-coverage-timings-1", expired: false },
        { id: 3, name: "critical-coverage-1", expired: false }, { id: 4, name: "pr-test-timings-2", expired: true },
      ] });
      const directory = args[args.indexOf("--dir") + 1];
      const name = args[args.indexOf("--name") + 1];
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${name}.json`), JSON.stringify({ success: true, files: name.startsWith("pr-coverage")
        ? [{ file: "a.test.ts", durationMs: 100 }]
        : [{ file: "a.test.ts", durationMs: 10 }, { file: "b.test.ts", durationMs: 20 }] }));
      return "";
    });
    refreshPrTestTimings(["--runs=3", `--output=${output}`]);
    const data = JSON.parse(readFileSync(output, "utf8"));
    expect(data.tests).toEqual({ "a.test.ts": 10, "b.test.ts": 20 });
    expect(data.coverage).toEqual({ "a.test.ts": 100, "b.test.ts": 40 });
    expect(data.coverageFallbackMultiplier).toBe(2);
    expect(data.artifacts).toEqual([{ run: 123, artifact: "pr-test-timings-1", id: 1 }, { run: 123, artifact: "pr-coverage-timings-1", id: 2 }]);
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0][1]).toEqual(expect.arrayContaining(["--status", "success", "--limit", "3"]));
    expect(calls.filter(([, args]) => args?.[1] === "download")).toHaveLength(2);
  });

  it("fails closed on bad arguments and missing retained timings", () => {
    for (const arg of ["--runs=0", "--runs=1.5", "--unknown=1", "--output="]) expect(() => refreshPrTestTimings([arg])).toThrow();
    vi.mocked(execFileSync).mockReturnValue("[]");
    expect(() => refreshPrTestTimings([`--output=${outputPath()}`])).toThrow("No retained plain-test timings");
  });
});
