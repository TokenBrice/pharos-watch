import { afterEach, describe, expect, it, vi } from "vitest";
import { runPruneDetailCache } from "../prune-detail-cache";
import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
const createTestDb = fixtures.open;
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

describe("runPruneDetailCache", () => {
  it("sweeps only expired telemetry and reviewed retired versions, keeping exact TTL boundaries and live namespaces", async () => {
    const { sqlite, db } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const cutoff = now - 30 * 86_400;
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)");
    for (const [key, clock] of [
      ["cron:event:old:failure", cutoff - 1],
      ["cron:budget-surface:old", cutoff - 1],
      ["ops:d1-capacity:v1", cutoff - 1],
      ["ops:d1-table-growth:v1", cutoff - 1],
      ["cron:event:boundary:failure", cutoff],
      ["cron:budget-surface:fresh", now],
      ["mint-burn-flows:v1:aggregate:24", now],
      ["mint-burn-flows:v2:coin:usdt:24", now],
      ["mint-burn-flows:v3:aggregate:24", now],
      ["blacklist:summary:producer:v1", now],
      ["blacklist:summary:producer:v2", now],
      ["mint-burn-flows:v4:aggregate:24", cutoff - 1],
      ["blacklist:summary:producer:v3", cutoff - 1],
      ["blacklist:summary:producer:v4", cutoff - 1],
      ["blacklist:summary:producer:v2:unreviewed", cutoff - 1],
      ["ops:unreviewed", cutoff - 1],
      ["stablecoins", cutoff - 1],
      ["report-cards:v9", cutoff - 1],
      ["rpc:dwellir:credits:v1:2026-10", cutoff - 1],
    ] as const) insert.run(key, clock);
    const result = await runPruneDetailCache(db);
    expect(result.itemCount).toBe(9);
    expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all().map((row) => row.key)).toEqual([
      "blacklist:summary:producer:v2:unreviewed", "blacklist:summary:producer:v3",
      "blacklist:summary:producer:v4",
      "cron:budget-surface:fresh", "cron:event:boundary:failure",
      "mint-burn-flows:v4:aggregate:24", "ops:unreviewed", "report-cards:v9",
      "rpc:dwellir:credits:v1:2026-10", "stablecoins",
    ]);
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.cacheHygiene.retiredMintBurnV1).toEqual({ deleted: 1, retentionTruncated: false });
    expect(Object.keys(metadata.retentionTruncated)).toHaveLength(10);
  });

  it("caps each telemetry namespace and reports retained backlog", async () => {
    const { sqlite, db } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 10001)
      INSERT INTO cache (key, value, updated_at)
      SELECT printf('cron:event:old:%06d', id), '{}', ? FROM n`).run(now - 31 * 86_400);
    const result = await runPruneDetailCache(db);
    expect(result.itemCount).toBe(10_000);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      cacheHygiene: { cronEvents: { deleted: 10_000, retentionTruncated: true } },
      retentionTruncated: { cronEvents: true },
    });
    expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([{ key: "cron:event:old:010001" }]);
  });

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
