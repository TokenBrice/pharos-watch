import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PR_TEST_FILE_OVERHEAD_MS,
  PR_TEST_PLAN_MAX_SHARDS,
  createPrTestPlan,
  partitionTestFiles,
  partitionTestFilesByDuration,
  readPrTestPlan,
  readTestTimings,
  shardCountForFileCount,
  takeTestShard,
} from "../lib/pr-test-plan.mts";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function savePlan(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-plan-test-"));
  temporary.push(directory);
  const path = join(directory, "plan.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function saveTimings(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-timings-test-"));
  temporary.push(directory);
  const path = join(directory, "timings.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}
const DAY_MS = 24 * 60 * 60 * 1000;

describe("PR test plans", () => {
  it("partitions every selected file exactly once, independent of input order", () => {
    const files = Array.from({ length: 1203 }, (_, index) => `src/file-${index}.test.ts`);
    for (const count of [4, 8]) {
      const shards = partitionTestFiles([...files, files[0]], count);
      expect(shards).toHaveLength(count);
      expect(shards.flat()).toHaveLength(files.length);
      expect(new Set(shards.flat()).size).toBe(files.length);
      expect(shards.flat().sort()).toEqual([...files].sort());
      expect(shards).toEqual(partitionTestFiles([...files].reverse(), count));
      const sizes = shards.map((shard) => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it("distributes sorted unique paths round-robin and preserves the input", () => {
    const files = ["src/d.test.ts", "src/b.test.ts", "src/a.test.ts", "src/c.test.ts", "src/a.test.ts"];
    expect(partitionTestFiles(files, 3)).toEqual([
      ["src/a.test.ts", "src/d.test.ts"], ["src/b.test.ts"], ["src/c.test.ts"],
    ]);
    expect(files).toEqual(["src/d.test.ts", "src/b.test.ts", "src/a.test.ts", "src/c.test.ts", "src/a.test.ts"]);
    expect(partitionTestFiles([], 4)).toEqual([[], [], [], []]);
    expect(partitionTestFiles(["src/a.test.ts"], 4)).toEqual([["src/a.test.ts"], [], [], []]);
  });

  it("scales one shard per 120 files from one up to the ten-shard cap", () => {
    const files = Array.from({ length: 1300 }, (_, index) => `src/file-${index}.test.ts`);
    expect(shardCountForFileCount(0)).toBe(1);
    for (const [count, expected] of [
      [1, 1], [120, 1], [121, 2], [240, 2], [241, 3], [600, 5], [780, 7], [1200, PR_TEST_PLAN_MAX_SHARDS], [1300, PR_TEST_PLAN_MAX_SHARDS],
    ] as const) {
      expect(shardCountForFileCount(count)).toBe(expected);
      expect(createPrTestPlan("base", files.slice(0, count)).shardCount).toBe(expected);
    }
    const plan = createPrTestPlan("base", files.slice(0, 801));
    expect(plan.shardCount).toBe(7);
    expect(plan.partitionMode).toBe("round-robin");
    expect(readPrTestPlan(savePlan(plan))).toEqual(plan);
  });

  it("partitions by measured duration with per-file overhead and offloads the longest file", () => {
    const files = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts", "src/e.test.ts"];
    const durations = new Map([
      ["src/a.test.ts", 10_000],
      ["src/b.test.ts", 1_000],
      ["src/c.test.ts", 1_000],
      ["src/d.test.ts", 1_000],
      ["src/e.test.ts", 1_000],
    ]);
    const shards = partitionTestFilesByDuration(files, 2, durations);
    expect(shards).toEqual([
      ["src/a.test.ts"],
      ["src/b.test.ts", "src/c.test.ts", "src/d.test.ts", "src/e.test.ts"],
    ]);
    // Input order does not change the partition.
    expect(partitionTestFilesByDuration([...files].reverse(), 2, durations)).toEqual(shards);
    expect(shards.flat().sort()).toEqual(files);
    const load = (shard: readonly string[]) => shard.reduce((sum, file) => sum + (durations.get(file) ?? 0) + PR_TEST_FILE_OVERHEAD_MS, 0);
    expect(Math.max(...shards.map(load)) - Math.min(...shards.map(load))).toBe(1_500);
    // Unknown files inherit the median measurement instead of weight zero.
    const medianWeighted = partitionTestFilesByDuration(["src/a.test.ts", "src/unknown.test.ts"], 2, durations);
    expect(medianWeighted).toEqual([["src/a.test.ts"], ["src/unknown.test.ts"]]);
    expect(partitionTestFilesByDuration([], 3, durations)).toEqual([[], [], []]);
  });

  it("records the duration partition and timing generation in the plan", () => {
    const files = Array.from({ length: 130 }, (_, index) => `src/file-${index}.test.ts`);
    const timings = { generatedAt: "2026-11-01T00:00:00.000Z", files: Object.fromEntries(files.map((file) => [file, 2_000])) };
    const plan = createPrTestPlan("base", files, { timings });
    expect(plan.shardCount).toBe(2);
    expect(plan.partitionMode).toBe("duration");
    expect(plan.timingsGeneratedAt).toBe(timings.generatedAt);
    expect(readPrTestPlan(savePlan(plan))).toEqual(plan);
    const sizes = plan.shards.map((shard) => shard.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("fails closed on missing, malformed, duplicate, count-mismatched and unsafe plans", () => {
    const plan = createPrTestPlan("base", ["src/a.test.ts", "src/b.test.ts"]);
    expect(plan).toMatchObject({ fileCount: 2, shardCount: 1, partitionMode: "round-robin" });
    expect(() => readPrTestPlan("/not-a-real-pr-plan.json")).toThrow();
    for (const mutation of [
      { ...plan, version: 2 },
      { ...plan, base: "" },
      { ...plan, fileCount: 3 },
      { ...plan, shardCount: 2, shards: [["src/a.test.ts"], ["src/b.test.ts"]] },
      { ...plan, shardCount: 1, shards: [["src/a.test.ts"], ["src/a.test.ts"]] },
      { ...plan, shardCount: 1, shards: [["../src/a.test.ts", "src/b.test.ts"]] },
      { ...plan, shardCount: 1, shards: [["--flag.test.ts", "src/b.test.ts"]] },
      { ...plan, shardCount: 1, shards: [["src/source.ts", "src/b.test.ts"]] },
      { ...plan, partitionMode: "duration" },
    ]) expect(() => readPrTestPlan(savePlan(mutation))).toThrow();
  });

  it("accepts timing evidence only when it is recent, versioned and non-empty", () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    const timings = { version: 1, generatedAt: "2026-11-01T12:00:00.000Z", files: { "src/a.test.ts": 1_500 } };
    expect(readTestTimings(saveTimings(timings), { now })).toEqual({ ok: true, timings: { generatedAt: timings.generatedAt, files: timings.files } });
    expect(readTestTimings(saveTimings({ ...timings, generatedAt: new Date(now - 7 * DAY_MS).toISOString() }), { now }).ok).toBe(true);
    expect(readTestTimings(saveTimings({ ...timings, generatedAt: new Date(now - 7 * DAY_MS - 1).toISOString() }), { now }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("older than 7 days") });
    expect(readTestTimings(saveTimings({ ...timings, generatedAt: new Date(now + DAY_MS).toISOString() }), { now }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("future") });
    for (const invalid of [
      "{not json",
      { ...timings, version: 2 },
      { ...timings, files: {} },
      { ...timings, files: { "src/a.test.ts": -1 } },
      { ...timings, generatedAt: "yesterday" },
    ]) expect(readTestTimings(saveTimings(invalid), { now }).ok).toBe(false);
    expect(readTestTimings("/not-a-real-timings.json", { now }).ok).toBe(false);
  });

  it("validates shard coordinates and removes both supported spellings", () => {
    expect(takeTestShard(["--shard=2/8", "--coverage"])).toEqual({ args: ["--coverage"], shard: { shard: 2, shardCount: 8 } });
    expect(takeTestShard(["--shard", "1/4"])).toEqual({ args: [], shard: { shard: 1, shardCount: 4 } });
    for (const arg of ["0/8", "9/8", "1/0", "bad", "1.5/4"]) expect(() => takeTestShard([`--shard=${arg}`])).toThrow();
    expect(() => takeTestShard(["--shard=1/4", "--shard=2/4"])).toThrow("Duplicate");
    for (const count of [0, -1, 1.5, NaN, Infinity]) expect(() => partitionTestFiles([], count)).toThrow();
    for (const count of [0, -1, 1.5, NaN, Infinity]) expect(() => partitionTestFilesByDuration([], count, new Map())).toThrow();
  });
});
