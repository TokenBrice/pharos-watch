import { afterEach, describe, expect, it } from "vitest";
import { runPruneDetailCache } from "../prune-detail-cache";
import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
const createTestDb = fixtures.open;
afterEach(fixtures.closeAll);

describe("runPruneDetailCache", () => {
  it("deletes orphaned and week-stale active rows, keeps fresh readable rows", async () => {
    const liveId = [...ACTIVE_IDS][0];
    const otherLiveId = [...ACTIVE_IDS][1];
    const nowSec = Math.floor(Date.now() / 1000);
    const { sqlite, db } = createTestDb();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    for (const row of [
      ["detail:146", nowSec - 3600],
      ["detail:retired-coin-id", nowSec - 3600],
      [`detail:${liveId}`, nowSec - 8 * 24 * 3600],
      [`detail:${otherLiveId}`, nowSec - 3600],
    ]) insert.run(row[0], "{}", row[1]);

    const result = await runPruneDetailCache(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      orphansDeleted: number;
      staleDeleted: number;
      scanned: number;
    };

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(3);
    expect(metadata.scanned).toBe(4);
    expect(metadata.orphansDeleted).toBe(2);
    expect(metadata.staleDeleted).toBe(1);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key LIKE 'detail:%' ORDER BY key").all()).toEqual([
      { key: `detail:${otherLiveId}` },
    ]);
  });

  it("keeps week-stale rows for frozen coins because the detail API never refreshes them", async () => {
    const frozenId = [...FROZEN_IDS][0];
    const nowSec = Math.floor(Date.now() / 1000);
    const { sqlite, db } = createTestDb();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(`detail:${frozenId}`, "{}", nowSec - 90 * 24 * 3600);

    const result = await runPruneDetailCache(db);

    expect(result.itemCount).toBe(0);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key LIKE 'detail:%'").all()).toEqual([
      { key: `detail:${frozenId}` },
    ]);
  });

  it("keyset-paginates through every detail-cache page", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 501 }, (_, index) => ({
      key: `detail:orphan-${String(index).padStart(3, "0")}`,
      updated_at: nowSec - 8 * 24 * 3600,
    }));
    const { sqlite, db } = createTestDb();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.key, "{}", row.updated_at);

    const result = await runPruneDetailCache(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as { scanned: number };

    expect(result.itemCount).toBe(501);
    expect(metadata.scanned).toBe(501);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'detail:%'").get()).toEqual({ count: 0 });
  });
});
