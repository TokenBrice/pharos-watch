import { readFileSync } from "node:fs";
import { z } from "zod";

export const PR_TEST_PLAN_PATH = ".tmp/pr-test-plan.json";
/** Continuous shard policy: one shard per 120 selected files, floored at 2 and capped at 10. */
export const PR_TEST_PLAN_FILES_PER_SHARD = 120;
export const PR_TEST_PLAN_MIN_SHARDS = 2;
export const PR_TEST_PLAN_MAX_SHARDS = 10;
/** Fixed setup/import/teardown cost attributed to every selected file by the duration scheduler. */
export const PR_TEST_FILE_OVERHEAD_MS = 1_500;
/** Nightly timing evidence older than this is ignored in favour of round-robin. */
export const TEST_TIMINGS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PrTestPartitionMode = "round-robin" | "duration";

/** Merged nightly per-file durations (`test-timings:build`). */
export interface PrTestTimings {
  generatedAt: string;
  files: Record<string, number>;
}

export interface PrTestPlan {
  version: 1;
  base: string;
  fileCount: number;
  shardCount: number;
  partitionMode?: PrTestPartitionMode;
  timingsGeneratedAt?: string;
  shards: string[][];
}

const PlanSchema = z.object({
  version: z.literal(1),
  base: z.string().trim().min(1),
  fileCount: z.number().int().positive(),
  shardCount: z.number().int().min(1).max(PR_TEST_PLAN_MAX_SHARDS),
  partitionMode: z.enum(["round-robin", "duration"]).optional(),
  timingsGeneratedAt: z.string().optional(),
  shards: z.array(z.array(z.string().min(1).refine((file) =>
    !file.startsWith("/") && !file.startsWith("-") && !file.includes("\\") && !file.split("/").includes("..")
    && /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)))),
}).refine((plan) => {
  const files = plan.shards.flat();
  return plan.shardCount === shardCountForFileCount(plan.fileCount)
    && plan.shards.length === plan.shardCount && files.length === plan.fileCount && new Set(files).size === files.length
    && (plan.partitionMode !== "duration" || plan.timingsGeneratedAt !== undefined);
}, "Invalid PR test plan partition");

const TimingsSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "generatedAt must be an ISO timestamp"),
  files: z.record(z.string().min(1), z.number().finite().nonnegative()),
});

/** One shard per 120 files; a selection that fits one shard stays unsharded. */
export function shardCountForFileCount(fileCount: number): number {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) throw new Error("Invalid selected file count");
  if (fileCount <= PR_TEST_PLAN_FILES_PER_SHARD) return 1;
  return Math.min(PR_TEST_PLAN_MAX_SHARDS, Math.max(PR_TEST_PLAN_MIN_SHARDS, Math.ceil(fileCount / PR_TEST_PLAN_FILES_PER_SHARD)));
}

/** Distribute sorted unique paths round-robin, independent of input order. */
export function partitionTestFiles(
  files: readonly string[],
  shardCount: number,
): string[][] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) throw new Error("Invalid test shard count");
  const ordered = [...new Set(files)].sort();
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  for (let index = 0; index < ordered.length; index++) {
    shards[index % shardCount].push(ordered[index]);
  }
  return shards;
}

/**
 * Longest-processing-time partition from nightly per-file durations. Each file
 * weighs its measured duration plus a fixed per-file overhead; files without a
 * measurement use the median measurement. Ties break on path, then shard index,
 * so the partition is deterministic.
 */
export function partitionTestFilesByDuration(
  files: readonly string[],
  shardCount: number,
  durations: ReadonlyMap<string, number>,
): string[][] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) throw new Error("Invalid test shard count");
  const ordered = [...new Set(files)].sort();
  const measured = ordered
    .map((file) => durations.get(file))
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .sort((left, right) => left - right);
  const median = measured.length > 0 ? measured[Math.floor((measured.length - 1) / 2)] : 0;
  const weight = (file: string): number => (durations.get(file) ?? median) + PR_TEST_FILE_OVERHEAD_MS;
  const scheduled = [...ordered].sort((left, right) => weight(right) - weight(left) || left.localeCompare(right));
  const shards = Array.from({ length: shardCount }, () => ({ files: [] as string[], load: 0 }));
  for (const file of scheduled) {
    let target = 0;
    for (let index = 1; index < shards.length; index++) {
      if (shards[index].load < shards[target].load) target = index;
    }
    shards[target].files.push(file);
    shards[target].load += weight(file);
  }
  return shards.map((shard) => shard.files.sort());
}

export function createPrTestPlan(
  base: string,
  files: readonly string[],
  { timings }: { timings?: PrTestTimings } = {},
): PrTestPlan {
  const ordered = [...new Set(files)].sort();
  const shardCount = shardCountForFileCount(ordered.length);
  const durations = timings ? new Map(Object.entries(timings.files)) : undefined;
  return {
    version: 1,
    base,
    fileCount: ordered.length,
    shardCount,
    partitionMode: durations ? "duration" : "round-robin",
    ...(timings ? { timingsGeneratedAt: timings.generatedAt } : {}),
    shards: durations ? partitionTestFilesByDuration(ordered, shardCount, durations) : partitionTestFiles(ordered, shardCount),
  };
}

export function readPrTestPlan(path: string): PrTestPlan {
  return PlanSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export type TestTimingsLoad =
  | { ok: true; timings: PrTestTimings }
  | { ok: false; reason: string };

/**
 * Load nightly timing evidence. Anything missing, malformed, empty or older
 * than seven days is rejected with a reason; callers fall back to round-robin,
 * so timing evidence can only ever improve balance, never the selection.
 */
export function readTestTimings(path: string, { now = Date.now() }: { now?: number } = {}): TestTimingsLoad {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: `unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
  const result = TimingsSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "does not match {version:1, generatedAt, files}" };
  if (Object.keys(result.data.files).length === 0) return { ok: false, reason: "contains no file durations" };
  const generatedAt = Date.parse(result.data.generatedAt);
  const age = now - generatedAt;
  if (age < -5 * 60_000) return { ok: false, reason: `generatedAt ${result.data.generatedAt} is in the future` };
  if (age > TEST_TIMINGS_MAX_AGE_MS) return { ok: false, reason: `generatedAt ${result.data.generatedAt} is older than 7 days` };
  return { ok: true, timings: { generatedAt: result.data.generatedAt, files: result.data.files } };
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
