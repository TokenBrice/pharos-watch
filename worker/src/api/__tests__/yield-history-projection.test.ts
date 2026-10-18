import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { handleYieldHistory } from "../yield-history";
import { readYieldRankingsCoinCache } from "../../lib/yield-rankings-coin-cache";
import { publishedYieldCache } from "./yield-history.test-support";
import { YieldHistoryResponseSchema } from "@shared/types/yield";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

describe("yield history scoped cache and indexed daily window", () => {
  it("retains source-risk generation identity while transferring only the requested coin", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const cached = publishedYieldCache(now, [
      { id: "usdt-tether", publicationGenerationId: "row-generation", provenance: { sourceKey: "selected" }, sourceRisk: { sourceRiskScore: 71 },
        altSources: [{ sourceKey: "alternate", sourceRisk: { sourceRiskScore: 42 } }] },
      { id: "usdc-circle", provenance: { sourceKey: "unrelated" }, altSources: [{ sourceKey: "large-unrelated-dossier", evidence: "x".repeat(10000) }] },
    ]);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(cached.key, cached.value, now);
    const scoped = await readYieldRankingsCoinCache(db, "usdt-tether");
    expect(scoped?.updatedAt).toBe(now);
    expect(JSON.parse(scoped!.value).rankings.map((row: { id: string }) => row.id)).toEqual(["usdt-tether"]);
    expect(scoped!.value).not.toContain("large-unrelated-dossier");
    sqlite.prepare(`INSERT INTO yield_history
      (stablecoin_id, source_key, recorded_at, is_best, apy, data_source, publication_generation_id, publication_state)
      VALUES ('usdt-tether', 'selected', ?, 1, 5, 'defillama', 'row-generation', 'published')`).run(now);
    const response = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=30&mode=best"));
    const body = YieldHistoryResponseSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(body.history[0]?.sourceRisk?.sourceRiskScore).toBe(71);
    expect(body.publication?.generationId).toBe("yield-published");
  });

  it("keeps malformed source bytes and their timestamp available to the existing cutoff failure path", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('yield-rankings', '{broken', ?)").run(now - 60);
    expect(await readYieldRankingsCoinCache(db, "usdt-tether")).toEqual({ value: "{broken", updatedAt: now - 60 });
    const response = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    const body = YieldHistoryResponseSchema.parse(await response.json());
    expect(body._meta?.reason).toBe("publication-cutoff-unavailable");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("bounds the daily tier through its existing coin/date index and retains recorded-at boundary checks", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Date.UTC(2026, 9, 18, 12) / 1000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const cached = publishedYieldCache(now);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(cached.key, cached.value, now);
    const prepare = vi.spyOn(db, "prepare");
    await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=90"));
    const sql = prepare.mock.calls.find(([query]) => query.includes("best-window-tiered"))![0];
    expect(sql).toContain("snapshot_date >= ? AND snapshot_date <= ?");
    expect(sql).toContain("recorded_at >= ? AND recorded_at < ?");
    const dailyPlan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT recorded_at FROM yield_history_daily
      WHERE stablecoin_id = ? AND snapshot_date >= ? AND snapshot_date <= ?
      AND recorded_at >= ? AND recorded_at < ? AND is_best = 1`).all("usdt-tether", now - 90 * 86400, now - 30 * 86400, now - 90 * 86400, now - 30 * 86400);
    expect(JSON.stringify(dailyPlan)).toContain("snapshot_date>?");
  });
});
