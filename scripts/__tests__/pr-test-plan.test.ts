import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrTestPlan, partitionTestFiles, readPrTestPlan, readPrTestTimings, takeTestShard } from "../lib/pr-test-plan.mts";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function savePlan(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-plan-test-"));
  temporary.push(directory);
  const path = join(directory, "plan.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("PR test plans", () => {
  it("uses duration-weighted LPT with path ties and stable shard ties", () => {
    const durations = { "src/a.test.ts": 9, "src/b.test.ts": 7, "src/c.test.ts": 3, "src/d.test.ts": 1 };
    const files = Object.keys(durations);
    expect(partitionTestFiles(files, 2, durations)).toEqual([[files[0], files[3]], [files[1], files[2]]]);
    expect(partitionTestFiles([...files].reverse(), 2, durations)).toEqual(partitionTestFiles(files, 2, durations));
    expect(partitionTestFiles(["b.test.ts", "a.test.ts"], 2, {})).toEqual([["a.test.ts"], ["b.test.ts"]]);
  });

  it("gives unknown files the median measured duration, including even-sized medians", () => {
    const durations = { a: 10, b: 2, c: 6, d: 4 };
    expect(partitionTestFiles(["a", "b", "unknown", "c", "d"], 2, durations)).toEqual([["a", "d"], ["c", "unknown", "b"]]);
    expect(partitionTestFiles(["a", "unknown", "b"], 2, { a: 9, b: 1, other: 5 })).toEqual([["a"], ["unknown", "b"]]);
  });

  it("partitions every selected file exactly once, independent of input order", () => {
    const files = Array.from({ length: 1203 }, (_, index) => `src/file-${index}.test.ts`);
    const durations = Object.fromEntries(files.filter((_, index) => index % 3 === 0).map((file, index) => [file, index + 1]));
    for (const count of [4, 8]) {
      const shards = partitionTestFiles([...files, files[0]], count, durations);
      expect(shards).toHaveLength(count);
      expect(shards.flat()).toHaveLength(files.length);
      expect(new Set(shards.flat()).size).toBe(files.length);
      expect(shards.flat().sort()).toEqual([...files].sort());
      expect(shards).toEqual(partitionTestFiles([...files].reverse(), count, durations));
    }
  });

  it("chooses eight only above 800 unique selected files and roundtrips the plan", () => {
    const files = Array.from({ length: 801 }, (_, index) => `src/file-${index}.test.ts`);
    expect(createPrTestPlan("base", files.slice(0, 800), {}).shardCount).toBe(4);
    expect(createPrTestPlan("base", [...files.slice(0, 800), files[0]], {}).shardCount).toBe(4);
    const plan = createPrTestPlan("base", files, {});
    expect(plan.shardCount).toBe(8);
    expect(readPrTestPlan(savePlan(plan))).toEqual(plan);
  });

  it("fails closed on missing, malformed, duplicate, count-mismatched and unsafe plans", () => {
    const plan = createPrTestPlan("base", ["src/a.test.ts", "src/b.test.ts"], {});
    expect(() => readPrTestPlan("/not-a-real-pr-plan.json")).toThrow();
    for (const mutation of [
      { ...plan, version: 2 }, { ...plan, base: "" }, { ...plan, fileCount: 3 }, { ...plan, shardCount: 8 },
      { ...plan, shards: [["src/a.test.ts"], ["src/a.test.ts"], [], []] },
      { ...plan, shards: [["../src/a.test.ts"], ["src/b.test.ts"], [], []] },
      { ...plan, shards: [["--flag.test.ts"], ["src/b.test.ts"], [], []] },
      { ...plan, shards: [["src/source.ts"], ["src/b.test.ts"], [], []] },
    ]) expect(() => readPrTestPlan(savePlan(mutation))).toThrow();
  });

  it("validates shard coordinates and removes both supported spellings", () => {
    expect(takeTestShard(["--shard=2/8", "--coverage"])).toEqual({ args: ["--coverage"], shard: { shard: 2, shardCount: 8 } });
    expect(takeTestShard(["--shard", "1/4"])).toEqual({ args: [], shard: { shard: 1, shardCount: 4 } });
    for (const arg of ["0/8", "9/8", "1/0", "bad", "1.5/4"]) expect(() => takeTestShard([`--shard=${arg}`])).toThrow();
    expect(() => takeTestShard(["--shard=1/4", "--shard=2/4"])).toThrow("Duplicate");
    expect(() => partitionTestFiles([], 0, {})).toThrow();
  });

  it("loads distinct real plain and coverage duration seeds", () => {
    const timings = readPrTestTimings();
    expect(Object.keys(timings.tests).length).toBeGreaterThan(800);
    expect(Object.keys(timings.coverage).length).toBeGreaterThan(8);
    const file = "worker/src/lib/__tests__/safety-score-v9-native-input-pipeline.test.ts";
    expect(timings.coverage[file]).toBeGreaterThan(timings.tests[file]);
  });
});
