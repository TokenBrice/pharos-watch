import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { getActiveWorkerVersionMarker } from "../worker-version-first-seen";

describe("worker version marker persistence", () => {
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
