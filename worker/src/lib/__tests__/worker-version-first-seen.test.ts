import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  getActiveWorkerVersionMarker,
  getWorkerVersionActivatedAt,
  getWorkerVersionFirstSeenAt,
  recordScheduledWorkerVersionFirstSeen,
} from "../worker-version-first-seen";

describe("worker version marker persistence", () => {
  it("preserves first-seen evidence and reads the separate activation marker", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();

    await recordScheduledWorkerVersionFirstSeen(db, null, 1_800_000_000);
    await recordScheduledWorkerVersionFirstSeen(db, "worker-v2", 1_800_000_010);
    await recordScheduledWorkerVersionFirstSeen(db, "worker-v2", 1_800_000_020);
    (sqlite as DatabaseSync).prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES ('worker-version-activated:worker-v2', ?, ?)`,
    ).run(JSON.stringify({ workerVersion: "worker-v2", activatedAt: 1_800_000_005 }), 1_800_000_005);

    expect(await getWorkerVersionFirstSeenAt(db, "worker-v2")).toBe(1_800_000_010);
    expect(await getWorkerVersionActivatedAt(db, "worker-v2")).toBe(1_800_000_005);
    expect((sqlite as DatabaseSync).prepare(
      "SELECT key, updated_at FROM cache WHERE key LIKE 'worker-version-%:worker-v2' ORDER BY key",
    ).all()).toEqual([
      { key: "worker-version-activated:worker-v2", updated_at: 1_800_000_005 },
      { key: "worker-version-first-seen:worker-v2", updated_at: 1_800_000_010 },
    ]);
    sqlite.close();
  });
  it("reads verified markers independently for both script roles", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    expect(await getActiveWorkerVersionMarker(db, "public")).toBeNull();
    expect(await getActiveWorkerVersionMarker(db, "heavy")).toBeNull();
    const version = "12345678-1234-1234-1234-123456789abc";
    for (const role of ["public", "heavy"] as const) {
      const scriptName = role === "public" ? "stablecoin-api" : "stablecoin-heavy";
      const marker = { worker: role, scriptName, workerVersion: version, activatedAt: 1_800_000_000 };
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(`worker-active-version:${role}`, JSON.stringify(marker), marker.activatedAt);
      expect(await getActiveWorkerVersionMarker(db, role)).toEqual({
        scriptName, workerVersion: version, activatedAt: marker.activatedAt,
      });
    }
    sqlite.close();
  });

  it.each([
    "{",
    JSON.stringify({ worker: "public", scriptName: "stablecoin-api", workerVersion: "not-a-uuid", activatedAt: 1_800_000_000 }),
    JSON.stringify({ worker: "heavy", scriptName: "stablecoin-api", workerVersion: "12345678-1234-1234-1234-123456789abc", activatedAt: 1_800_000_000 }),
    JSON.stringify({ worker: "heavy", scriptName: "stablecoin-heavy", workerVersion: "12345678-1234-1234-1234-123456789abc", activatedAt: 1_800_000_001 }),
  ])("treats malformed or mismatched evidence as absent", async (value) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("worker-active-version:heavy", value, 1_800_000_000);
    expect(await getActiveWorkerVersionMarker(db, "heavy")).toBeNull();
    sqlite.close();
  });
});
