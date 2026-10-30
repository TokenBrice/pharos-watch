import { afterEach, describe, expect, it, vi } from "vitest";
import { runPruneDetailCache } from "../prune-detail-cache";
import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";

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
      ["blacklist:gap-metrics:v2:86400:core", now],
      ["blacklist:gap-metrics:producer:v2:3600:full", now],
      ["blacklist:summary:producer:v5", cutoff - 1],
      ["blacklist:gap-metrics:v3:86400:core", cutoff - 1],
      ["blacklist:gap-metrics:producer:v3:86400:full", cutoff - 1],
      ["blacklist:summary:producer:v2:unreviewed", cutoff - 1],
      ["ops:unreviewed", cutoff - 1],
      ["stablecoins", cutoff - 1],
      ["report-cards:v9", cutoff - 1],
      ["rpc:dwellir:credits:v1:2026-10", cutoff - 1],
    ] as const) insert.run(key, clock);
    const result = await runPruneDetailCache(db);
    expect(result.itemCount).toBe(13);
    expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all().map((row) => row.key)).toEqual([
      "blacklist:gap-metrics:producer:v3:86400:full", "blacklist:gap-metrics:v3:86400:core",
      "blacklist:summary:producer:v2:unreviewed", "blacklist:summary:producer:v5",
      "cron:budget-surface:fresh", "cron:event:boundary:failure",
      "mint-burn-flows:v4:aggregate:24", "ops:unreviewed", "report-cards:v9",
      "rpc:dwellir:credits:v1:2026-10", "stablecoins",
    ]);
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.cacheHygiene.retiredMintBurnV1).toEqual({ deleted: 1, retentionTruncated: false });
    expect(metadata.cacheHygiene.retiredBlacklistSummaryV4).toEqual({ deleted: 1, retentionTruncated: false });
    expect(metadata.cacheHygiene.retiredBlacklistGapMetricsProducerV2).toEqual({ deleted: 1, retentionTruncated: false });
    expect(Object.keys(metadata.retentionTruncated)).toHaveLength(14);
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

  it.each([
    { name: "fresh generation", replacementAgeDays: 0 },
    { name: "different stale generation", replacementAgeDays: 9 },
  ])("keeps a $name published after the stale scan and counts only applied deletes", async ({ replacementAgeDays }) => {
    const nowSec = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const liveIds = [...ACTIVE_IDS];
    const refreshedKey = `detail:${liveIds[0]}`;
    const staleKey = `detail:${liveIds[1]}`;
    const { sqlite } = createTestDb();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)");
    insert.run(refreshedKey, nowSec - 8 * 86_400);
    insert.run(staleKey, nowSec - 8 * 86_400);
    insert.run("detail:orphan", nowSec);
    const replacementAt = nowSec - replacementAgeDays * 86_400;
    let refreshed = false;
    const db = createSqliteD1(sqlite, { onAll: (sql) => {
      if (!refreshed && sql.startsWith("SELECT key, updated_at FROM cache")) {
        refreshed = true;
        sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
          .run('{"generation":"replacement"}', replacementAt, refreshedKey);
      }
    } });

    const result = await runPruneDetailCache(db);
    expect(result.itemCount).toBe(2);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      scanned: 3, orphansDeleted: 1, staleDeleted: 1, retentionTruncated: { detail: false },
    });
    expect(sqlite.prepare("SELECT key, value, updated_at FROM cache WHERE key LIKE 'detail:%'").all()).toEqual([
      { key: refreshedKey, value: '{"generation":"replacement"}', updated_at: replacementAt },
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
