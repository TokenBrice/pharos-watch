import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { hasUnverifiedDepegPeak } from "./depeg-event-config";
import {
  DepegDirectionSchema,
  DepegEventStoredSnapshotSchema,
  type DepegEventEntry,
} from "@shared/types/peg";

export const DEPEG_EVENT_DATA_DIR = join(process.cwd(), "data/depeg-events");
const RESOLVED_DEPEG_EVENT_DATA_DIR = resolve(DEPEG_EVENT_DATA_DIR);

let defaultSnapshotCache: { signature: string; entries: readonly DepegEventEntry[] } | null = null;
let defaultPageEntriesCache: {
  indexSignature: string;
  snapshotSignature: string;
  entries: readonly DepegEventEntry[];
} | null = null;

function tryFileStatSignature(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

function buildShardsSignature(dataDir: string, shardNames: readonly string[]): string | null {
  const parts: string[] = [];
  for (const name of shardNames) {
    const sig = tryFileStatSignature(join(dataDir, name));
    if (sig === null) return null;
    parts.push(`${name}:${sig}`);
  }
  return parts.join("|");
}

const DepegEventIndexEntrySchema = z.object({
  slug: z.string().min(1),
  stablecoinId: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  direction: DepegDirectionSchema,
  peakDeviationBps: z.number(),
  startedAt: z.number(),
  retainedPage: DepegEventStoredSnapshotSchema.element.optional(),
}).refine(({ retainedPage, slug }) => !retainedPage || retainedPage.slug === slug, "retained page slug mismatch");
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
  return parseEventArray(readFileSync(path, "utf8"), path);
}

export function readDepegEventIndex({ missing }: { missing: "empty" | "throw" }, path: string): DepegEventIndexEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if (missing === "empty" && isMissingFile(cause)) return [];
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse ${path} as JSON.`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${path} to contain an array of depeg event index entries.`);
  }

  const result = DepegEventIndexSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "<root>";
    const issueMessage = firstIssue?.message ?? "schema validation failed";
    throw new Error(`Invalid depeg event index data at ${path}:${issuePath}: ${issueMessage}`);
  }
  return result.data;
}

export function readDepegEventSnapshot({ missing }: { missing: "empty" | "throw" }, dataDir = DEPEG_EVENT_DATA_DIR): DepegEventEntry[] {
  let shardNames: string[];
  try {
    shardNames = readdirSync(dataDir)
      .filter((name) => /^\d{4}\.json$/.test(name))
      .sort();
  } catch (cause) {
    if (missing === "empty" && isMissingFile(cause)) return [];
    throw cause;
  }

  if (shardNames.length === 0) {
    if (missing === "empty") return [];
    throw new Error(`No yearly depeg event shards found under ${dataDir}.`);
  }

  // Only memoize the production data directory (keyed by shard inode/size/mtime)
  // so temp-dir test fixtures mutated in-place within a single clock tick never read stale data.
  const isDefaultDir = resolve(dataDir) === RESOLVED_DEPEG_EVENT_DATA_DIR;
  const signature = isDefaultDir ? buildShardsSignature(dataDir, shardNames) : null;
  if (signature !== null && defaultSnapshotCache?.signature === signature) {
    return defaultSnapshotCache.entries.slice();
  }

  const entries = shardNames.flatMap((name) => readDepegEventShard(join(dataDir, name)));
  entries.sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return b.id - a.id;
  });
  if (signature !== null) {
    defaultSnapshotCache = { signature, entries };
  }
  return entries.slice();
}

export function hasReviewedDepegEvent(event: DepegEventEntry): boolean {
  const verdict = event.provenance?.auditVerdict;
  return verdict != null && verdict !== "no_data";
}

export function resolveRetainedDepegEventPage(retained: DepegEventEntry, current: DepegEventEntry | undefined): DepegEventEntry {
  if (current && current.id === retained.id && hasReviewedDepegEvent(current)) return current;
  return retained;
}

/** Resolve the permanent route index against the current ledger, newest first. */
export function readDepegEventPageEntries(dataDir = DEPEG_EVENT_DATA_DIR): DepegEventEntry[] {
  const indexPath = join(dataDir, "index.json");
  const isDefaultDir = resolve(dataDir) === RESOLVED_DEPEG_EVENT_DATA_DIR;
  const indexSignature = isDefaultDir ? tryFileStatSignature(indexPath) : null;
  const snapshot = readDepegEventSnapshot({ missing: "throw" }, dataDir);
  const snapshotSignature = isDefaultDir ? (defaultSnapshotCache?.signature ?? null) : null;
  if (
    indexSignature !== null
    && snapshotSignature !== null
    && defaultPageEntriesCache?.indexSignature === indexSignature
    && defaultPageEntriesCache.snapshotSignature === snapshotSignature
  ) {
    return defaultPageEntriesCache.entries.slice();
  }

  const index = readDepegEventIndex({ missing: "throw" }, indexPath);
  const bySlug = new Map(snapshot.map((event) => [event.slug, event] as const));
  const pages = index.map(({ slug, retainedPage }) => {
    const current = bySlug.get(slug);
    const event = retainedPage ? resolveRetainedDepegEventPage(retainedPage, current) : current;
    if (!event) {
      throw new Error(
        `Depeg event index entry ${slug} has no matching event in the yearly shards under ${dataDir}.`,
      );
    }
    return event;
  });
  const indexedSlugs = new Set(index.map(({ slug }) => slug));
  for (const event of bySlug.values()) {
    if (hasUnverifiedDepegPeak(event) && !indexedSlugs.has(event.slug)) pages.push(event);
  }
  pages.sort((a, b) => b.startedAt - a.startedAt || a.slug.localeCompare(b.slug));
  if (indexSignature !== null && snapshotSignature !== null) {
    defaultPageEntriesCache = { indexSignature, snapshotSignature, entries: pages };
  }
  return pages.slice();
}
