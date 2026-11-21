import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertionDurations, mergeTestTimings } from "../maintenance/build-test-timings.ts";
import FileTimingsReporter from "../test/vitest-file-timings-reporter.mts";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function reports(files: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-test-timings-"));
  temporary.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return directory;
}

function vitestReport(entries: readonly (readonly [string, readonly number[]])[]): unknown {
  return {
    success: true,
    testResults: entries.map(([name, durations]) => ({
      name,
      status: "passed",
      assertionResults: durations.map((duration) => ({ duration, status: "passed", fullName: "case" })),
    })),
  };
}

describe("nightly test timing extraction", () => {
  it("sums assertion durations per file and rounds to 100 ms", () => {
    const directory = reports({
      "shard-1.json": vitestReport([["/repo/src/a.test.ts", [1_234, 566]], ["/repo/worker/b.test.ts", []]]),
      "shard-2.json": vitestReport([["/repo/scripts/c.test.ts", [95]]]),
      "nested/shard-3.json": vitestReport([["/repo/src/d.test.ts", [1_049]]]),
    });
    const { timings, skipped } = mergeTestTimings([join(directory, "shard-1.json"), join(directory, "shard-2.json"), join(directory, "nested/shard-3.json")], { cwd: "/repo" });
    expect(timings.version).toBe(1);
    expect(Number.isFinite(Date.parse(timings.generatedAt))).toBe(true);
    expect(timings.files).toEqual({
      "scripts/c.test.ts": 100,
      "src/a.test.ts": 1_800,
      "src/d.test.ts": 1_000,
      "worker/b.test.ts": 0,
    });
    expect(skipped).toEqual([]);
  });

  it("keeps the slowest duplicate and skips JSON that is not a Vitest report", () => {
    const directory = reports({
      "one.json": vitestReport([["src/a.test.ts", [500]]]),
      "two.json": vitestReport([["src/a.test.ts", [900]], ["src/a.test.ts", [100]]]),
      "other.json": { totals: { files: 2 } },
      "broken.json": "{not json",
    });
    const { timings, skipped } = mergeTestTimings(["one.json", "two.json", "other.json", "broken.json"].map((name) => join(directory, name)));
    expect(timings.files).toEqual({ "src/a.test.ts": 900 });
    expect(skipped.sort()).toEqual([join(directory, "broken.json"), join(directory, "other.json")]);
  });

  it("merges wall-clock reports from the file-timings reporter into wallFiles", () => {
    const directory = reports({});
    const previous = process.env.PHAROS_VITEST_FILE_TIMINGS;
    process.env.PHAROS_VITEST_FILE_TIMINGS = join(directory, "nested", "vitest-file-timings-1.json");
    try {
      const reporter = new FileTimingsReporter();
      const fakeModule = (moduleId: string, durations: Record<string, number>) => ({
        moduleId,
        diagnostic: () => ({ prepareDuration: 0, environmentSetupDuration: 0, setupDuration: 0, collectDuration: 0, duration: 0, ...durations }),
      }) as unknown as Parameters<FileTimingsReporter["onTestModuleEnd"]>[0];
      // Worker prepare/environment, setup files, import and run all count.
      reporter.onTestModuleEnd(fakeModule(join(process.cwd(), "src/a.test.ts"), { prepareDuration: 40, environmentSetupDuration: 10, setupDuration: 50, collectDuration: 2_400, duration: 330 }));
      reporter.onTestModuleEnd(fakeModule(join(process.cwd(), "src/b.test.ts"), { collectDuration: 60 }));
      reporter.onTestRunEnd();
    } finally {
      if (previous === undefined) delete process.env.PHAROS_VITEST_FILE_TIMINGS;
      else process.env.PHAROS_VITEST_FILE_TIMINGS = previous;
    }
    writeFileSync(join(directory, "vitest-file-timings-2.json"), JSON.stringify({
      kind: "pharos-vitest-file-timings",
      files: { "src/a.test.ts": 900, "src/c.test.ts": 1_250, "src/bad.test.ts": -1, "src/nan.test.ts": "slow" },
    }));
    writeFileSync(join(directory, "shard-1.json"), JSON.stringify(vitestReport([["src/a.test.ts", [300]]])));
    const { timings, skipped } = mergeTestTimings(
      ["nested/vitest-file-timings-1.json", "vitest-file-timings-2.json", "shard-1.json"].map((name) => join(directory, name)),
    );
    expect(timings.files).toEqual({ "src/a.test.ts": 300 });
    expect(timings.wallFiles).toEqual({ "src/a.test.ts": 2_800, "src/b.test.ts": 100, "src/c.test.ts": 1_300 });
    expect(skipped).toEqual([]);
    // Assertion-only inputs keep the historical shape.
    expect(mergeTestTimings([join(directory, "shard-1.json")]).timings).not.toHaveProperty("wallFiles");
  });

  it("ignores missing, non-numeric and negative assertion durations", () => {
    expect(assertionDurations({ assertionResults: [
      { duration: 10 }, { duration: "20" }, { duration: -5 }, { duration: Number.NaN }, {}, { duration: 0 },
    ] })).toBe(30);
    expect(assertionDurations({})).toBe(0);
  });
});
