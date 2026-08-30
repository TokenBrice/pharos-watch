import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
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
});
