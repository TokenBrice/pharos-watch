import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeYieldRanking, makeAltYieldSource } from "@shared/test-utils/yield-ranking-fixtures";
import { DexLiquidityCoinResponseSchema, DexLiquidityMapSchema, DexLiquidityTableMapSchema, DexLiquidityTableRowSchema } from "@shared/types/market";
import { RedemptionBackstopCoinResponseSchema, RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { YieldRankingsCoinResponseSchema, YieldRankingsResponseSchema } from "@shared/types/yield";
import { makeDexLiquidityRow } from "../../test-helpers/__shared/fixtures";
import { makeRedemptionRow, completedRun } from "./redemption-backstops.test-support";
import { handleDexLiquidity, handleDexLiquidityCoin, handleDexLiquidityTable } from "../dex-liquidity";
import { handleRedemptionBackstops, handleRedemptionBackstopCoin } from "../redemption-backstops";
import { handleYieldRankings, handleYieldRankingsCoin } from "../yield-rankings-cache";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { conditionalGetResponse, scopeResponseEtag } from "../../lib/api-response";

vi.mock("../../lib/safety-score-index", () => ({
  loadActiveSafetyScoreIndex: vi.fn(async () => ({ kind: "error", reason: "safety-score-index-unavailable", snapshot: null })),
}));

function insert(sqlite: DatabaseSync, table: string, row: Record<string, unknown>) {
  const entries = Object.entries(row);
  const values = entries.map(([, value]) => {
    if (value === null || typeof value === "number" || typeof value === "string") return value;
    throw new Error("Unexpected fixture SQL value");
  });
  sqlite.prepare(`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`).run(...values);
}

const now = 1_790_000_000;
const staleAge = Math.max(API_FRESHNESS_MAX_AGE_SEC.dexLiquidity, API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops) * FRESHNESS_RATIOS.FRESH + 1;
const coinUrl = (path: string, id: string) => new URL(`https://site-api.pharos.watch/api/${path}?stablecoin=${id}`);
afterEach(() => vi.restoreAllMocks());

describe("site-only coin projections", () => {
  it.each([false, true])("matches DEX full-row values, nulls and warnings with invalid coverage=%s", async (invalidCoverage) => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insert(sqlite, "dex_liquidity", { symbol: "USDT", ...makeDexLiquidityRow({ updated_at: now - 100_000,
        ...(invalidCoverage ? { coverage_class: "primary", coverage_confidence: 2 } : {}),
      }) });
      insert(sqlite, "dex_liquidity", { symbol: "USDC", ...makeDexLiquidityRow({ stablecoin_id: "usdc-circle", updated_at: now - 100_000 }) });
      const full = await handleDexLiquidity(db);
      const fullBody = DexLiquidityMapSchema.parse(await full.json());
      const projected = await handleDexLiquidityCoin(db, coinUrl("dex-liquidity-coin", "usdt-tether"));
      const body = DexLiquidityCoinResponseSchema.parse(await projected.json());
      expect(Object.keys(body.coins)).toEqual(["usdt-tether"]);
      expect(body.coins["usdt-tether"]).toEqual(fullBody["usdt-tether"]);
      expect(body.projection).toMatchObject({ totalCount: 2, updatedAt: now - 100_000,
        unavailableReason: invalidCoverage ? "invalid-coverage-evidence" : null });
      expect(projected.headers.get("X-Data-Updated-At")).toBe(full.headers.get("X-Data-Updated-At"));
      expect(projected.headers.get("Warning")).toBe(full.headers.get("Warning"));
      const table = DexLiquidityTableMapSchema.parse(await (await handleDexLiquidityTable(db)).json());
      for (const [id, row] of Object.entries(fullBody)) expect(table[id]).toEqual(DexLiquidityTableRowSchema.parse(row));
      expect(table["usdt-tether"]).not.toHaveProperty("topPools");
      const missing = DexLiquidityCoinResponseSchema.parse(await (await handleDexLiquidityCoin(db, coinUrl("dex-liquidity-coin", "dai-makerdao"))).json());
      expect(missing.coins).toEqual({});
      expect(missing.projection).toMatchObject({ unavailableReason: "row-not-published", generationId: null, updatedAt: null, totalCount: 2 });
    } finally { sqlite.close(); }
  });

  it.each([false, true])("binds DEX row, census and producer clock across publication rollover (legacy=%s)", async (legacy) => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    let switched = false;
    const { sqlite, db } = createLatestSchemaSqlite({ onAll: (sql) => {
      if (switched || !sql.includes("projection_total_count")) return;
      switched = true;
      sqlite.prepare("UPDATE dex_liquidity SET updated_at = ?, publication_generation_id = ?").run(now, legacy ? null : "G2");
    } });
    try {
      for (const generation of ["G1", "G2"]) {
        insert(sqlite, "dex_liquidity_publication_generations", { generation_id: generation, started_at: now, state: "published", expected_row_count: 2, created_at: now });
      }
      insert(sqlite, "dex_liquidity", { symbol: "USDT", ...makeDexLiquidityRow({ updated_at: now - staleAge }), publication_generation_id: legacy ? null : "G1" });
      insert(sqlite, "dex_liquidity", { symbol: "USDC", ...makeDexLiquidityRow({ stablecoin_id: "usdc-circle", updated_at: now }), publication_generation_id: legacy ? null : "G1" });
      const response = await handleDexLiquidityCoin(db, coinUrl("dex-liquidity-coin", "usdt-tether"));
      const body = DexLiquidityCoinResponseSchema.parse(await response.json());
      expect(switched).toBe(true);
      expect(body.projection).toMatchObject({ generationId: legacy ? null : "G1", updatedAt: now - staleAge, totalCount: 2 });
      expect(body.coins["usdt-tether"].updatedAt).toBe(now - staleAge);
      expect(response.headers.get("X-Data-Updated-At")).toBe(String(now - staleAge));
      expect(response.headers.get("X-Data-Age")).toBe(String(staleAge));
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } finally { sqlite.close(); }
  });

  it.each([false, true])("uses the DEX publication clock without hiding ancient row evidence (table=%s)", async (table) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const ancientUpdatedAt = now - 174 * 86_400;
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insert(sqlite, "dex_liquidity", { symbol: "USDT", ...makeDexLiquidityRow({ updated_at: ancientUpdatedAt }) });
      insert(sqlite, "dex_liquidity", { symbol: "USDC", ...makeDexLiquidityRow({ stablecoin_id: "usdc-circle", updated_at: now }) });
      const path = table ? "dex-liquidity-table" : "dex-liquidity";
      const response = await (table ? handleDexLiquidityTable(db) : handleDexLiquidity(db));
      const body = (table ? DexLiquidityTableMapSchema : DexLiquidityMapSchema).parse(await response.clone().json());
      expect(body["usdt-tether"].updatedAt).toBe(ancientUpdatedAt);
      expect(body["usdt-tether"].warning).toContain("110");
      expect(body["usdc-circle"].updatedAt).toBe(now);
      expect(body["usdc-circle"].warning).toBeNull();
      expect(response.headers.get("X-Data-Updated-At")).toBe(String(now));
      expect(response.headers.get("X-Data-Age")).toBe("0");
      expect(response.headers.get("Warning")).toBeNull();
      expect(response.headers.get("Cache-Control")).not.toBe("no-store");

      const cached = scopeResponseEtag(response, path, true);
      const etag = cached.headers.get("ETag");
      expect(etag).toBeTruthy();
      const request = new Request(`https://site-api.pharos.watch/api/${path}`, {
        headers: { "If-None-Match": etag! },
      });
      const notModified = conditionalGetResponse(request, cached.clone());
      expect(notModified.status).toBe(304);
      for (const name of ["ETag", "Date", "Cache-Control", "X-Data-Updated-At", "X-Data-Freshness-Budget"]) {
        expect(notModified.headers.get(name)).toBe(cached.headers.get(name));
      }
      clock.mockReturnValue((now + 86_400) * 1000);
      expect(conditionalGetResponse(request, cached).status).toBe(200);

      clock.mockReturnValue(now * 1000);
      const coinResponse = scopeResponseEtag(
        await handleDexLiquidityCoin(db, coinUrl("dex-liquidity-coin", "usdt-tether")),
        "dex-liquidity-coin?stablecoin=usdt-tether", true,
      );
      const coin = DexLiquidityCoinResponseSchema.parse(await coinResponse.clone().json());
      expect(coin.coins["usdt-tether"].updatedAt).toBe(ancientUpdatedAt);
      expect(coin.projection.updatedAt).toBe(ancientUpdatedAt);
      expect(coinResponse.headers.get("X-Data-Updated-At")).toBe(String(ancientUpdatedAt));
      expect(coinResponse.headers.get("Warning")).toContain("110");
      expect(coinResponse.headers.get("Cache-Control")).toBe("no-store");
      expect(coinResponse.headers.get("ETag")).toBeNull();
      expect(conditionalGetResponse(request, coinResponse).status).toBe(200);
    } finally { sqlite.close(); }
  });

  it("retains the admitted redemption generation clock and the selected row's own evidence clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const run = completedRun("unequal-clocks", { expected_count: 2, written_count: 2, min_updated_at: now - staleAge, max_updated_at: now });
      insert(sqlite, "redemption_backstop_runs", { ...run, started_at: run.min_updated_at, status: "completed" });
      insert(sqlite, "redemption_backstop_run_rows", makeRedemptionRow({ snapshot_run_id: run.run_id, updated_at: now - staleAge }));
      insert(sqlite, "redemption_backstop_run_rows", makeRedemptionRow({ stablecoin_id: "usdc-circle", snapshot_run_id: run.run_id, updated_at: now }));
      const full = await handleRedemptionBackstops(db);
      const fullBody = RedemptionBackstopsResponseSchema.parse(await full.json());
      expect(fullBody.updatedAt).toBe(now);
      expect(fullBody.coins["cusd-cap"].updatedAt).toBe(now - staleAge);
      expect(full.headers.get("X-Data-Updated-At")).toBe(String(now));
      expect(full.headers.get("Warning")).toBeNull();
      expect(full.headers.get("Cache-Control")).not.toBe("no-store");
      const response = await handleRedemptionBackstopCoin(db, coinUrl("redemption-backstop-coin", "cusd-cap"));
      const body = RedemptionBackstopCoinResponseSchema.parse(await response.json());
      expect(body.projection).toMatchObject({ generationId: run.run_id, totalCount: 2, updatedAt: now - staleAge });
      // Whole-run admission makes HTTP freshness follow the immutable manifest,
      // while projection/row evidence keeps its original per-coin timestamp.
      expect(body.updatedAt).toBe(now);
      expect(body.coins["cusd-cap"].updatedAt).toBe(now - staleAge);
      expect(response.headers.get("X-Data-Updated-At")).toBe(String(now));
      expect(response.headers.get("X-Data-Age")).toBe("0");
      expect(response.headers.get("Warning")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe(full.headers.get("Cache-Control"));
    } finally { sqlite.close(); }
  });

  it.each([null, 0, 10_000_000])("matches completed redemption row including nullable capacity %s", async (capacity) => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const run = completedRun("projection-run");
      insert(sqlite, "redemption_backstop_runs", { ...run, started_at: run.min_updated_at, status: "completed" });
      insert(sqlite, "redemption_backstop_run_rows", makeRedemptionRow({ snapshot_run_id: run.run_id, immediate_capacity_usd: capacity }));
      const full = await handleRedemptionBackstops(db);
      const fullBody = RedemptionBackstopsResponseSchema.parse(await full.json());
      const projected = await handleRedemptionBackstopCoin(db, coinUrl("redemption-backstop-coin", "cusd-cap"));
      const body = RedemptionBackstopCoinResponseSchema.parse(await projected.json());
      expect(body.coins["cusd-cap"]).toEqual(fullBody.coins["cusd-cap"]);
      expect(body.methodology).toEqual(fullBody.methodology);
      expect(body.projection).toMatchObject({ generationId: run.run_id, totalCount: 1, updatedAt: fullBody.updatedAt });
      expect(projected.headers.get("Warning")).toBe(full.headers.get("Warning"));
      const missingResponse = await handleRedemptionBackstopCoin(db, coinUrl("redemption-backstop-coin", "usdc-circle"));
      expect(missingResponse.status).toBe(200);
      const missing = RedemptionBackstopCoinResponseSchema.parse(await missingResponse.json());
      expect(missing.projection).toMatchObject({ generationId: run.run_id, updatedAt: null, totalCount: 1, unavailableReason: "row-not-published" });
    } finally { sqlite.close(); }
  });

  it.each([0, 100_000])("matches hydrated yield row and cohort warning/coverage at age %s", async (age) => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const updatedAt = now - age;
      const payload = { rankings: [makeYieldRanking({ altSources: [makeAltYieldSource()] }),
        makeYieldRanking({ id: "usdt-tether", safetyScore: null, safetyGrade: null, pharosYieldScore: null, altSources: [makeAltYieldSource()] })],
        riskFreeRate: 4, scalingFactor: 1, medianApy: null, updatedAt,
        publication: { generationId: "yield-projection-run", updatedAt, cutoffAt: updatedAt, schemaVersion: 1, status: "published" },
        warnings: [{ code: "test-input-warning", message: "Retained producer warning" }],
      };
      insert(sqlite, "cache", { key: "yield-rankings", value: JSON.stringify(payload), updated_at: updatedAt });
      const full = await handleYieldRankings(db);
      const fullBody = YieldRankingsResponseSchema.parse(await full.json());
      const projected = await handleYieldRankingsCoin(db, coinUrl("yield-rankings-coin", "usdc-circle"));
      const body = YieldRankingsCoinResponseSchema.parse(await projected.json());
      expect(body.rankings).toEqual(fullBody.rankings.filter((row) => row.id === "usdc-circle"));
      expect(body.warnings).toEqual(fullBody.warnings);
      expect(body.provenance).toEqual(fullBody.provenance);
      expect(body.publication).toEqual(fullBody.publication);
      expect(body.projection.totalCount).toBe(2);
      expect(projected.headers.get("Warning")).toBe(full.headers.get("Warning"));
    } finally { sqlite.close(); }
  });

  it("rejects a yield envelope whose producer clock does not match its selected publication", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insert(sqlite, "cache", { key: "yield-rankings", updated_at: now, value: JSON.stringify({
        rankings: [makeYieldRanking()], riskFreeRate: 4, scalingFactor: 1, medianApy: null, updatedAt: now - 1,
        publication: { generationId: "old-yield", updatedAt: now - 1, cutoffAt: now - 1, schemaVersion: 1, status: "published" },
      }) });
      const response = await handleYieldRankingsCoin(db, coinUrl("yield-rankings-coin", "usdc-circle"));
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ reason: "yield-rankings-malformed" });
    } finally { sqlite.close(); }
  });

  it("rejects missing and duplicate coin parameters before reading storage", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (const handler of [handleDexLiquidityCoin, handleRedemptionBackstopCoin, handleYieldRankingsCoin]) {
        for (const query of ["", "?stablecoin=usdc-circle&stablecoin=usdt-tether"]) {
          expect((await handler(db, new URL(`https://site-api.pharos.watch/api/projection${query}`))).status).toBe(400);
        }
      }
    } finally { sqlite.close(); }
  });
});
