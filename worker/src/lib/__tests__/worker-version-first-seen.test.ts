import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  getWorkerVersionFirstSeenAt,
  recordScheduledWorkerVersionFirstSeen,
} from "../worker-version-first-seen";

describe("worker version first-seen persistence", () => {
  it("attempts one write per isolate and preserves the first timestamp", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();

    await recordScheduledWorkerVersionFirstSeen(db, null, 1_800_000_000);
    await recordScheduledWorkerVersionFirstSeen(db, "worker-v2", 1_800_000_010);
    await recordScheduledWorkerVersionFirstSeen(db, "worker-v2", 1_800_000_020);

    expect(await getWorkerVersionFirstSeenAt(db, "worker-v2")).toBe(1_800_000_010);
    expect((sqlite as DatabaseSync).prepare(
      "SELECT key, updated_at FROM cache WHERE key = 'worker-version-first-seen:worker-v2'",
    ).all()).toEqual([{
      key: "worker-version-first-seen:worker-v2",
      updated_at: 1_800_000_010,
    }]);
    sqlite.close();
  });
});
