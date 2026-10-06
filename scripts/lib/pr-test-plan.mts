import { readFileSync } from "node:fs";
import { z } from "zod";

export const PR_TEST_PLAN_PATH = ".tmp/pr-test-plan.json";
export const PR_TEST_PLAN_LARGE_SELECTION = 800;
export const PR_TEST_TIMINGS_PATH = "scripts/data/pr-test-timings.json";

export interface PrTestPlan {
  version: 1;
  base: string;
  fileCount: number;
  shardCount: number;
  shards: string[][];
}

export interface PrTestTimingData {
  version: 1;
  tests: Record<string, number>;
  coverage: Record<string, number>;
}

const TimingDataSchema = z.object({
  version: z.literal(1),
  tests: z.record(z.string(), z.number().finite().positive()),
  coverage: z.record(z.string(), z.number().finite().positive()),
});

const PlanSchema = z.object({
  version: z.literal(1),
  base: z.string().trim().min(1),
  fileCount: z.number().int().positive(),
  shardCount: z.union([z.literal(4), z.literal(8)]),
  shards: z.array(z.array(z.string().min(1).refine((file) =>
    !file.startsWith("/") && !file.startsWith("-") && !file.includes("\\") && !file.split("/").includes("..")
    && /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)))),
}).refine((plan) => {
  const files = plan.shards.flat();
  return plan.shardCount === (plan.fileCount > PR_TEST_PLAN_LARGE_SELECTION ? 8 : 4)
    && plan.shards.length === plan.shardCount && files.length === plan.fileCount && new Set(files).size === files.length;
}, "Invalid PR test plan partition");

export function readPrTestTimings(): PrTestTimingData {
  return TimingDataSchema.parse(JSON.parse(readFileSync(new URL("../data/pr-test-timings.json", import.meta.url), "utf8")));
}

/** Unknown files use the median measured duration, or 1s before any measurements exist. */
export function partitionTestFiles(
  files: readonly string[],
  shardCount: number,
  durations: Readonly<Record<string, number>>,
): string[][] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) throw new Error("Invalid test shard count");
  const known = Object.values(durations).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const middle = Math.floor(known.length / 2);
  const fallback = known.length === 0 ? 1000 : known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2;
  const duration = (file: string): number => durations[file] > 0 && Number.isFinite(durations[file]) ? durations[file] : fallback;
  const ordered = [...new Set(files)].sort((a, b) => duration(b) - duration(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  const loads = Array<number>(shardCount).fill(0);
  for (const file of ordered) {
    let target = 0;
    for (let index = 1; index < shardCount; index++) {
      if (loads[index] < loads[target] || (loads[index] === loads[target] && shards[index].length < shards[target].length)) target = index;
    }
    shards[target].push(file);
    loads[target] += duration(file);
  }
  return shards;
}

export function createPrTestPlan(base: string, files: readonly string[], durations = readPrTestTimings().tests): PrTestPlan {
  const fileCount = new Set(files).size;
  const shardCount = fileCount > PR_TEST_PLAN_LARGE_SELECTION ? 8 : 4;
  return { version: 1, base, fileCount, shardCount, shards: partitionTestFiles(files, shardCount, durations) };
}

export function readPrTestPlan(path: string): PrTestPlan {
  return PlanSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Remove Vitest's own hash partition: the explicit file list is already partitioned. */
export function takeTestShard(args: readonly string[]): { args: string[]; shard?: { shard: number; shardCount: number } } {
  const rest: string[] = [];
  let shard: { shard: number; shardCount: number } | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--shard" || arg.startsWith("--shard=")) {
      if (shard) throw new Error("Duplicate test shard argument");
      const value = arg === "--shard" ? args[++index] : arg.slice("--shard=".length);
      const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
      if (!match) throw new Error(`Invalid test shard: ${value}`);
      const number = Number(match[1]);
      const count = Number(match[2]);
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(count) || number < 1 || number > count) throw new Error(`Invalid test shard: ${value}`);
      shard = { shard: number, shardCount: count };
    } else rest.push(arg);
  }
  return { args: rest, shard };
}
