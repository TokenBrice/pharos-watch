import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DepegDirectionSchema,
  DepegEventStoredSnapshotSchema,
  type DepegEventEntry,
} from "@shared/types/market";

export const DEPEG_EVENT_DATA_DIR = join(process.cwd(), "data/depeg-events");
export const DEPEG_EVENT_INDEX_PATH = join(DEPEG_EVENT_DATA_DIR, "index.json");

const DepegEventIndexEntrySchema = z.object({
  slug: z.string().min(1),
  stablecoinId: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  direction: DepegDirectionSchema,
  peakDeviationBps: z.number(),
  startedAt: z.number(),
});
const DepegEventIndexSchema = z.array(DepegEventIndexEntrySchema);
export type DepegEventIndexEntry = z.infer<typeof DepegEventIndexEntrySchema>;

function isMissingFile(cause: unknown): boolean {
  return (
    cause instanceof Error
    && "code" in cause
    && (cause as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parseEventArray(raw: string, path: string): DepegEventEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse ${path} as JSON.`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${path} to contain an array of depeg events.`);
  }

  const result = DepegEventStoredSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "<root>";
    const issueMessage = firstIssue?.message ?? "schema validation failed";
    throw new Error(`Invalid depeg feed event data at ${path}:${issuePath}: ${issueMessage}`);
  }
  return result.data;
}

function readDepegEventShard(path: string): DepegEventEntry[] {
  // The caller restricts this path to a discovered YYYY.json shard below the
  // repository's depeg-event data directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return parseEventArray(readFileSync(path, "utf8"), path);
}

export function readDepegEventIndex({ missing }: { missing: "empty" | "throw" }): DepegEventIndexEntry[] {
  let raw: string;
  try {
    raw = readFileSync(DEPEG_EVENT_INDEX_PATH, "utf8");
  } catch (cause) {
    if (missing === "empty" && isMissingFile(cause)) return [];
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse ${DEPEG_EVENT_INDEX_PATH} as JSON.`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${DEPEG_EVENT_INDEX_PATH} to contain an array of depeg event index entries.`);
  }

  const result = DepegEventIndexSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "<root>";
    const issueMessage = firstIssue?.message ?? "schema validation failed";
    throw new Error(`Invalid depeg event index data at ${DEPEG_EVENT_INDEX_PATH}:${issuePath}: ${issueMessage}`);
  }
  return result.data;
}

export function readDepegEventSnapshot({ missing }: { missing: "empty" | "throw" }): DepegEventEntry[] {
  let shardNames: string[];
  try {
    shardNames = readdirSync(DEPEG_EVENT_DATA_DIR)
      .filter((name) => /^\d{4}\.json$/.test(name))
      .sort();
  } catch (cause) {
    if (missing === "empty" && isMissingFile(cause)) return [];
    throw cause;
  }

  if (shardNames.length === 0) {
    if (missing === "empty") return [];
    throw new Error(`No yearly depeg event shards found under ${DEPEG_EVENT_DATA_DIR}.`);
  }

  const entries = shardNames.flatMap((name) => readDepegEventShard(join(DEPEG_EVENT_DATA_DIR, name)));
  return entries.sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return b.id - a.id;
  });
}

export function readDepegEventPageEntries(): DepegEventEntry[] {
  const index = readDepegEventIndex({ missing: "throw" });
  const bySlug = new Map(readDepegEventSnapshot({ missing: "throw" }).map((event) => [event.slug, event] as const));
  return index.map((entry) => {
    const event = bySlug.get(entry.slug);
    if (!event) {
      throw new Error(
        `Depeg event index entry ${entry.slug} has no matching event in the yearly shards under ${DEPEG_EVENT_DATA_DIR}.`,
      );
    }
    return event;
  });
}
