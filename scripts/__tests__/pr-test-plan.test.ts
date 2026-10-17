import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrTestPlan, partitionTestFiles, readPrTestPlan, takeTestShard } from "../lib/pr-test-plan.mts";

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

  it("chooses eight only above 800 unique selected files and roundtrips the plan", () => {
    const files = Array.from({ length: 801 }, (_, index) => `src/file-${index}.test.ts`);
    expect(createPrTestPlan("base", files.slice(0, 800)).shardCount).toBe(4);
    expect(createPrTestPlan("base", [...files.slice(0, 800), files[0]]).shardCount).toBe(4);
    const plan = createPrTestPlan("base", files);
    expect(plan.shardCount).toBe(8);
    expect(readPrTestPlan(savePlan(plan))).toEqual(plan);
  });

  it("fails closed on missing, malformed, duplicate, count-mismatched and unsafe plans", () => {
    const plan = createPrTestPlan("base", ["src/a.test.ts", "src/b.test.ts"]);
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
    for (const count of [0, -1, 1.5, NaN, Infinity]) expect(() => partitionTestFiles([], count)).toThrow();
  });
});
