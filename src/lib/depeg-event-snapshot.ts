import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DepegEventStoredSnapshotSchema,
  type DepegEventEntry,
} from "@shared/types/market";

export const DEPEG_EVENT_SNAPSHOT_PATH = join(process.cwd(), "data/depeg-events.json");

export function readDepegEventSnapshot({ missing }: { missing: "empty" | "throw" }): DepegEventEntry[] {
  let raw: string;
  try {
    raw = readFileSync(DEPEG_EVENT_SNAPSHOT_PATH, "utf8");
  } catch (cause) {
    if (
      missing === "empty" &&
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) return [];
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse ${DEPEG_EVENT_SNAPSHOT_PATH} as JSON.`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${DEPEG_EVENT_SNAPSHOT_PATH} to contain an array of depeg events.`);
  }

  const result = DepegEventStoredSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "<root>";
    const issueMessage = firstIssue?.message ?? "schema validation failed";
    throw new Error(`Invalid depeg feed event data at ${issuePath}: ${issueMessage}`);
  }
  return result.data;
}
