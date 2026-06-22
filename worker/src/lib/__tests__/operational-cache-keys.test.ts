import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_RUN_CURSOR_CACHE_KEY, OPERATIONAL_CACHE_KEYS } from "../operational-cache-keys";

const WORKER_SRC_DIR = join(process.cwd(), "worker/src");
const REGISTRY_RELATIVE_PATH = "lib/operational-cache-keys.ts";

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ? [fullPath]
      : [];
  });
}

describe("operational cache key registry", () => {
  it("registers live-reserve cursor ownership metadata while preserving the D1 key", () => {
    const expectedKey = ["live-reserves", "run-cursor"].join(":");
    const definition = OPERATIONAL_CACHE_KEYS.liveReserveRunCursor;

    expect(definition.key).toBe(expectedKey);
    expect(LIVE_RESERVE_RUN_CURSOR_CACHE_KEY).toBe(expectedKey);
    expect(definition.owner).toBe("sync-live-reserves");
    expect(definition.domain).toBe("live-reserves");
    expect(definition.purpose).toContain("Resume cursor");
    expect(definition.valueSchema).toContain("LiveReserveCursorState");
    expect(definition.ttl).toContain("No time-based TTL");
    expect(definition.cleanup).toContain("clearCursorStateIfComplete");
  });

  it("keeps migrated live-reserve cursor key literals out of Worker call sites", () => {
    const offenders = listSourceFiles(WORKER_SRC_DIR)
      .filter((file) => relative(WORKER_SRC_DIR, file) !== REGISTRY_RELATIVE_PATH)
      .filter((file) => readFileSync(file, "utf8").includes(LIVE_RESERVE_RUN_CURSOR_CACHE_KEY))
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});
